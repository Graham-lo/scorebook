//! Real SQL and chart geometry, deterministic local embedding fixtures. These
//! tests verify retrieval composition and evidence identity, not model quality.
mod common;
use scorebook::{
    adapters::{
        db::{Database, digest, hash_bytes},
        storage::Storage,
        vision::Vision,
    },
    application::{Services, calls, chart_search, jobs, knowledge_index, similarity},
};
use scorebook_core::knowledge_index::{MODEL, TextEncoder, TextEncoding, WEIGHTS};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;

struct Encoder(AtomicUsize);
impl TextEncoder for Encoder {
    fn configured(&self) -> bool {
        true
    }
    fn encode(&self, texts: Vec<String>) -> scorebook_core::ports::AppFuture<'_, TextEncoding> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let mut vector = vec![0.; 1024];
            vector[0] = 1.;
            Ok(TextEncoding {
                model_id: MODEL.into(),
                weights_sha256: WEIGHTS.into(),
                vectors: vec![vector; texts.len()],
            })
        })
    }
}
async fn setup() -> (Services, Uuid, tempfile::TempDir, Arc<Encoder>) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (owner, _) = db.create_user("chart-hybrid").await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let mut s = Services::new(db, Storage::new(temp.path()), Vision::new(None)).unwrap();
    let encoder = Arc::new(Encoder(AtomicUsize::new(0)));
    s.text = encoder.clone();
    (s, owner, temp, encoder)
}
fn chart(marker: u8) -> Vec<u8> {
    let start = "2024-01-01T00:00:00Z"
        .parse::<chrono::DateTime<chrono::Utc>>()
        .unwrap();
    let bars: Vec<_> = (0..64)
        .map(|i| {
            let p = 100. + i as f64 * 0.8 + (i as f64 * 0.4).sin() * 5.;
            scorebook::domain::criteria::Bar {
                start: start + chrono::Duration::hours(i),
                end: start + chrono::Duration::hours(i + 1),
                open: p.to_string(),
                high: (p + 2.).to_string(),
                low: (p - 1.).to_string(),
                close: (p + 0.5).to_string(),
                volume: None,
            }
        })
        .collect();
    let mut image = scorebook::domain::chart::raster(&bars).unwrap().to_rgb8();
    image.put_pixel(0, 0, image::Rgb([marker; 3]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut out, image::ImageFormat::Png)
        .unwrap();
    out.into_inner()
}
async fn image(s: &Services, owner: Uuid, marker: u8, kind: &str) -> Uuid {
    let saved = calls::upload(
        s,
        owner,
        &format!("image-{marker}"),
        chart(marker),
        kind.into(),
        None,
    )
    .await
    .unwrap();
    let id = serde_json::from_value(saved["id"].clone()).unwrap();
    if kind == "scene" {
        similarity::embed(s, owner, id, None, "candle-geometry-v2")
            .await
            .unwrap();
    } else {
        let read = chart_search::anchored(
            s,
            owner,
            &serde_json::from_value(json!({"attachment_id":id})).unwrap(),
        )
        .await
        .unwrap();
        let region = Some(read.geometry.quality.region);
        let vector = pgvector::Vector::from(vec![0.1f32; 384]);
        sqlx::query("INSERT INTO embedding_models(id,dimension,metadata) VALUES('dinov2-small-v1',384,'{}') ON CONFLICT DO NOTHING").execute(&s.db.pool).await.unwrap();
        sqlx::query("INSERT INTO image_embeddings(id,owner_id,attachment_id,model_id,region,region_hash,embedding,quality) VALUES($1,$2,$3,'dinov2-small-v1',$4,$5,$6,'{}')")
            .bind(Uuid::new_v4()).bind(owner).bind(id).bind(json!(region)).bind(digest(&region)).bind(vector).execute(&s.db.pool).await.unwrap();
    }
    id
}
async fn record(s: &Services, owner: Uuid, marker: u8) -> (Uuid, Uuid) {
    let attachment = image(s, owner, marker, "scene").await;
    let result = calls::create(s, owner, &format!("record-{marker}"), serde_json::from_value(json!({
        "original_text":format!("等待回踩确认，记录 {marker}"), "instrument":"BTCUSDT", "market":"usd_m", "timeframe":"1h", "attachments":[attachment]
    })).unwrap()).await.unwrap();
    (
        serde_json::from_value(result["id"].clone()).unwrap(),
        attachment,
    )
}
/// Populate an index from the exact source text; only the embedding is a stub.
async fn index_source(
    s: &Services,
    owner: Uuid,
    kind: &str,
    source: Uuid,
    semantic: bool,
) -> String {
    let evidence = knowledge_index::source(
        s,
        owner,
        serde_json::from_value(json!({"source_kind":kind,"source_id":source})).unwrap(),
    )
    .await
    .unwrap();
    let text = serde_json::to_string_pretty(&evidence["body"]).unwrap();
    let doc = Uuid::new_v4();
    let chunk = Uuid::new_v4();
    sqlx::query("INSERT INTO knowledge_documents(id,owner_id,source_kind,source_id,source_version,occurred_at,content,source_uri,indexed_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)")
        .bind(doc).bind(owner).bind(kind).bind(source).bind(evidence["source_version"].as_str().unwrap())
        .bind(evidence["occurred_at"].as_str().unwrap().parse::<chrono::DateTime<chrono::Utc>>().unwrap())
        .bind(&text).bind(evidence["source_uri"].as_str().unwrap()).execute(&s.db.pool).await.unwrap();
    sqlx::query("INSERT INTO knowledge_chunks(id,owner_id,document_id,ordinal,start_byte,end_byte,content,content_sha256) VALUES($1,$2,$3,0,0,$4,$5,$6)")
        .bind(chunk).bind(owner).bind(doc).bind(text.len() as i32).bind(&text).bind(hash_bytes(text.as_bytes())).execute(&s.db.pool).await.unwrap();
    if semantic {
        let mut vector = vec![0f32; 1024];
        vector[0] = 1.;
        sqlx::query("INSERT INTO knowledge_embeddings(owner_id,chunk_id,model_id,weights_sha256,embedding) VALUES($1,$2,$3,$4,$5)")
            .bind(owner).bind(chunk).bind(MODEL).bind(WEIGHTS).bind(pgvector::Vector::from(vector)).execute(&s.db.pool).await.unwrap();
    }
    sqlx::query(
        "DELETE FROM knowledge_dirty WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3",
    )
    .bind(owner)
    .bind(kind)
    .bind(source)
    .execute(&s.db.pool)
    .await
    .unwrap();
    evidence["source_version"].as_str().unwrap().into()
}
async fn search(
    s: &Services,
    owner: Uuid,
    query: Uuid,
    key: &str,
    text: Option<&str>,
    limit: usize,
    exclude: Vec<Uuid>,
) -> Value {
    // Embeddings are already fixtures: do not let queued index jobs consume them.
    sqlx::query("UPDATE jobs SET status='cancelled' WHERE owner_id=$1 AND status NOT IN ('succeeded','cancelled')").bind(owner).execute(&s.db.pool).await.unwrap();
    chart_search::create(s, owner, key, serde_json::from_value(json!({"attachment_id":query,"scope":"private","interval":"1h","query_text":text,"limit":limit,"exclude":exclude})).unwrap()).await.unwrap();
    let job = jobs::claim_for(s, Some(owner)).await.unwrap().unwrap();
    assert_eq!(job.kind, "chart.search");
    let result = chart_search::run(s, &job).await.unwrap();
    jobs::complete(s, &job, Ok(result.clone())).await.unwrap();
    result
}

#[tokio::test]
async fn hybrid_text_constrains_before_limit_and_exclude_and_keeps_exact_evidence() {
    let (s, owner, _temp, encoder) = setup().await;
    let query = image(&s, owner, 0, "query").await;
    let (first, first_image) = record(&s, owner, 1).await;
    let (second, second_image) = record(&s, owner, 2).await;
    let (unindexed, _) = record(&s, owner, 3).await;
    let version = index_source(&s, owner, "call", first, true).await;
    index_source(&s, owner, "call", second, true).await;
    let plain = search(&s, owner, query, "plain", None, 10, vec![]).await;
    assert_eq!(plain["items"].as_array().unwrap().len(), 3);
    assert_eq!(
        encoder.0.load(Ordering::SeqCst),
        0,
        "image-only must not call the text encoder"
    );
    let hybrid = search(&s, owner, query, "hybrid", Some(" 回踩 "), 10, vec![]).await;
    assert_eq!(hybrid["query_text"], "回踩");
    assert_eq!(hybrid["items"].as_array().unwrap().len(), 2);
    assert_eq!(hybrid["text_retrieval"]["generated"], false);
    for item in hybrid["items"].as_array().unwrap() {
        assert_ne!(item["call_id"], json!(unindexed));
        assert_eq!(item["text_match"]["source_id"], item["call_id"]);
        assert!(
            item["text_match"]["excerpt"]
                .as_str()
                .unwrap()
                .contains("回踩")
        );
        if item["call_id"] == json!(first) {
            assert_eq!(item["text_match"]["source_version"], version);
        }
        let prior = plain["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["call_id"] == item["call_id"])
            .unwrap();
        assert_eq!(
            prior["match"], item["match"],
            "text ranking must not alter image similarity or level"
        );
    }
    let excluded = search(
        &s,
        owner,
        query,
        "exclude",
        Some("回踩"),
        1,
        vec![first_image],
    )
    .await;
    assert_eq!(excluded["items"].as_array().unwrap().len(), 1);
    assert_eq!(excluded["items"][0]["attachment_id"], json!(second_image));
    let text_only = knowledge_index::search(
        &s,
        owner,
        serde_json::from_value(json!({"query":"回踩","limit":1})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(text_only["items"].as_array().unwrap().len(), 1);
    assert!(text_only.get("ranking").is_none());
    sqlx::query("INSERT INTO knowledge_dirty(owner_id,source_kind,source_id) VALUES($1,'call',$2)")
        .bind(owner)
        .bind(second)
        .execute(&s.db.pool)
        .await
        .unwrap();
    let stale = search(
        &s,
        owner,
        query,
        "dirty",
        Some("回踩"),
        10,
        vec![first_image],
    )
    .await;
    assert!(stale["items"].as_array().unwrap().is_empty());
    assert!(
        stale["text_retrieval"]["coverage"]["pending_sources"]
            .as_i64()
            .unwrap()
            > 0
    );
}

#[tokio::test]
async fn hybrid_review_outcome_and_attachment_sources_map_to_their_record() {
    let (s, owner, _temp, _) = setup().await;
    let query = image(&s, owner, 10, "query").await;
    let (review_call, _) = record(&s, owner, 11).await;
    let (outcome_call, _) = record(&s, owner, 12).await;
    let (attachment_call, attachment) = record(&s, owner, 13).await;
    let review = Uuid::new_v4();
    sqlx::query("INSERT INTO reviews(id,owner_id,call_id,body) VALUES($1,$2,$3,$4)")
        .bind(review)
        .bind(owner)
        .bind(review_call)
        .bind(json!({"note":"复盘里才记录了回踩"}))
        .execute(&s.db.pool)
        .await
        .unwrap();
    let outcome = Uuid::new_v4();
    let manifest = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO manifests(id,owner_id,call_id,body,digest) VALUES($1,$2,$3,'{}','fixture')",
    )
    .bind(manifest)
    .bind(owner)
    .bind(outcome_call)
    .execute(&s.db.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO outcomes(id,owner_id,call_id,claim_no,manifest_id,kind,result,digest) VALUES($1,$2,$3,1,$4,'original',$5,'fixture')").bind(outcome).bind(owner).bind(outcome_call).bind(manifest).bind(json!({"note":"回踩结果"})).execute(&s.db.pool).await.unwrap();
    // Lexical-only documents also join images; attachment metadata uses dense retrieval.
    index_source(&s, owner, "review", review, false).await;
    index_source(&s, owner, "outcome", outcome, false).await;
    index_source(&s, owner, "attachment", attachment, true).await;
    // A future review and another owner's call must never enter the pool.
    let future_review = Uuid::new_v4();
    sqlx::query("INSERT INTO reviews(id,owner_id,call_id,body,created_at) VALUES($1,$2,$3,$4,now()+interval '1 day')")
        .bind(future_review).bind(owner).bind(review_call).bind(json!({"note":"回踩的未来复盘"}))
        .execute(&s.db.pool).await.unwrap();
    index_source(&s, owner, "review", future_review, true).await;
    let (other, _) = s.db.create_user("other-chart-hybrid").await.unwrap();
    let other_call = calls::create(
        &s,
        other,
        "private",
        serde_json::from_value(json!({"original_text":"回踩，不属于当前用户"})).unwrap(),
    )
    .await
    .unwrap();
    index_source(
        &s,
        other,
        "call",
        serde_json::from_value(other_call["id"].clone()).unwrap(),
        true,
    )
    .await;
    let result = search(&s, owner, query, "sources", Some("回踩"), 10, vec![]).await;
    assert_eq!(result["text_retrieval"]["source_candidates"], 3);

    for (call, kind, source) in [
        (review_call, "review", review),
        (outcome_call, "outcome", outcome),
        (attachment_call, "attachment", attachment),
    ] {
        let item = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["call_id"] == json!(call))
            .unwrap_or_else(|| panic!("missing {kind}: {result}"));
        assert_eq!(item["text_match"]["source_kind"], kind);
        assert_eq!(item["text_match"]["source_id"], json!(source));
    }
}

#[tokio::test]
async fn hybrid_input_rejects_public_text_and_oversize_but_normalizes_blank_idempotently() {
    let (s, owner, _temp, _) = setup().await;
    let attachment = Uuid::new_v4();
    sqlx::query("INSERT INTO attachments(id,owner_id,sha256,mime,size,width,height,kind) VALUES($1,$2,'test','image/png',1,640,320,'query')").bind(attachment).bind(owner).execute(&s.db.pool).await.unwrap();
    let base = json!({"attachment_id":attachment,"scope":"private","interval":"1h"});
    let mut blank = base.clone();
    blank["query_text"] = json!(" \n\t ");
    let first = chart_search::create(&s, owner, "blank", serde_json::from_value(blank).unwrap())
        .await
        .unwrap();
    let repeat = chart_search::create(
        &s,
        owner,
        "blank",
        serde_json::from_value(base.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(first, repeat);
    for (scope, text, code) in [
        (
            "binance_history",
            "回踩".to_owned(),
            "chart_query_text_requires_private_scope",
        ),
        ("private", "中".repeat(1366), "chart_query_text_too_long"),
    ] {
        let mut body = base.clone();
        body["scope"] = json!(scope);
        body["query_text"] = json!(text);
        let error = chart_search::create(&s, owner, code, serde_json::from_value(body).unwrap())
            .await
            .unwrap_err();
        assert_eq!(error.kind, scorebook_core::error::ErrorKind::Invalid);
        assert_eq!(error.code, code);
    }
    let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1")
        .bind(owner)
        .fetch_one(&s.db.pool)
        .await
        .unwrap();
    assert_eq!(jobs, 1, "invalid requests must not queue work");
}

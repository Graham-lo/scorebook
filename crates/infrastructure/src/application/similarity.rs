use crate::{
    adapters::db::{Database, digest},
    application::Services,
    application::dto::*,
    error::{Error, Result},
};
use pgvector::Vector;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub async fn embed(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    region: Option<Region>,
    model: &str,
) -> Result<(Vector, Value, String)> {
    embed_mode(s, owner, id, region, model, true).await
}
pub async fn embed_mode(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    region: Option<Region>,
    model: &str,
    persist: bool,
) -> Result<(Vector, Value, String)> {
    crate::adapters::ann::space(model)?;
    let rh = digest(&region);
    // 裁剪出来的区域向量只说明那一块算过，代表不了整张原图，索引状态因此只认整图。
    let whole_image = region.is_none();
    let region_json = json!(region);
    let existing=sqlx::query("SELECT embedding,quality FROM image_embeddings WHERE owner_id=$1 AND attachment_id=$2 AND model_id=$3 AND region_hash=$4").bind(owner).bind(id).bind(model).bind(&rh).fetch_optional(&s.db.pool).await?;
    if let Some(r) = existing {
        return Ok((r.get("embedding"), r.get("quality"), rh));
    }
    // kind 顺带取出来：search 传进来的可能是搜完即弃的 query 图，它不属于记录库原图。
    let original = sqlx::query("SELECT sha256,kind FROM attachments WHERE owner_id=$1 AND id=$2")
        .bind(owner)
        .bind(id)
        .fetch_optional(&s.db.pool)
        .await?
        .ok_or_else(Error::not_found)?;
    let expected: String = original.get("sha256");
    let kind: String = original.get("kind");
    let loader = s.clone();
    let selected = model.to_string();
    let f = s
        .vision
        .singleflight(
            format!("{owner}:{id}:{rh}:{selected}:{expected}"),
            async move {
                loader
                    .vision
                    .stream_extract(
                        loader.images.open(owner, id).await?,
                        region,
                        &selected,
                        &expected,
                    )
                    .await
            },
        )
        .await?;
    let vector = Vector::from(f.vector);
    if !persist {
        return Ok((vector, f.quality, rh));
    }
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO embedding_models(id,dimension,metadata) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&f.model_id).bind(vector.as_slice().len()as i32).bind(&f.quality).execute(&mut *tx).await?;
    // A model ID has immutable weights/preprocessing; adapter verifies identity.
    sqlx::query("INSERT INTO image_embeddings(id,owner_id,attachment_id,model_id,region,region_hash,embedding,quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING").bind(Uuid::new_v4()).bind(owner).bind(id).bind(model).bind(region_json).bind(&rh).bind(&vector).bind(&f.quality).execute(&mut *tx).await?;
    // 向量是在这里落的库，索引状态却只有 reindex 会写，于是「现场截图算过特征没有」把这里算出来的
    // 全当没算过。状态跟向量同一个事务写，两边就不可能再各说各话。原图之外的图不进这张表：
    // 覆盖面按 kind='scene' 统计，给别的 kind 记状态只会让 ready 超过总数。
    if whole_image && kind == "scene" {
        sqlx::query("INSERT INTO image_index_status(owner_id,attachment_id,model_id,status,reason) VALUES($1,$2,$3,'ready',NULL) ON CONFLICT(owner_id,attachment_id,model_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,checked_at=now()").bind(owner).bind(id).bind(model).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok((vector, f.quality, rh))
}
pub async fn search_single_mode(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: SimilarityQuery,
    persist: bool,
) -> Result<Value> {
    scorebook_core::domain::chart_match::require_interval(input.timeframe.as_deref())?;
    let body = json!(input);
    // Query encoder work is outside the idempotency DB transaction.
    let (vector, quality, _) = embed_mode(
        s,
        owner,
        input.attachment_id,
        input.region.clone(),
        &input.model_id,
        persist,
    )
    .await?;
    let (mut tx, cached) = if persist {
        s.db.write(owner, "similarity.search", key, &body).await?
    } else {
        let mut tx = s.db.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        (tx, None)
    };
    if let Some(v) = cached {
        return Ok(v);
    }
    let cutoff = input.cutoff_at.unwrap_or_else(chrono::Utc::now);
    let limit = input.limit.unwrap_or(10).clamp(1, 50);
    let (model, dimension) = crate::adapters::ann::space(&input.model_id)?;
    crate::adapters::ann::configure(&mut tx).await?;
    // Keep eligibility as an index scan filter, then enrich a bounded image set.
    // OFFSET 0 prevents pull-up into a join/sort that defeats iterative HNSW ordering.
    //
    // 证据池的两道闸门都在下面这段 EXISTS 里，缺一不可：
    // 一、`l.superseded_at IS NULL`——只收生效的那一张。人换掉一张图就是说它不
    //     代表这条记录，被接替的图不该再替这条记录出来作证。
    // 二、`a.uploaded_at<=c.submitted_at`（连同 captured_at）——这道闸门一个字都
    //     不放松。放松了，换图就成了事后诸葛亮的后门：看完行情怎么走了再换一张
    //     「我当时看的是这个」。记录成立那一刻还不存在的图，不算「你当时看到
    //     的」，重温可以用它（那是给人看的），证据池不收。
    // 两道一起的后果是明说的：提交之后才换的图，这条记录在证据池里就不出现了。
    // 记录本身、旧图、blob 一个都没少，只是不再拿一张自己都不认的图去作证。
    let sql = format!(
        r#"WITH embedding_candidates AS MATERIALIZED (
       SELECT e.attachment_id,e.embedding::vector({dimension}) <=> $8::vector({dimension}) AS distance
       FROM image_embeddings e
       WHERE e.owner_id=$1 AND e.model_id='{model}' AND e.attachment_id<>$2
       AND EXISTS(SELECT 1 FROM attachments a JOIN call_attachments l ON l.owner_id=a.owner_id AND l.attachment_id=a.id
         JOIN calls c ON c.owner_id=l.owner_id AND c.id=l.call_id
         WHERE a.owner_id=e.owner_id AND a.id=e.attachment_id AND a.kind='scene' AND l.superseded_at IS NULL
         AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at)
         AND c.submitted_at<=$3 AND a.uploaded_at<=$3
         AND ($4::text IS NULL OR c.instrument=$4) AND ($5::text IS NULL OR c.market=$5) AND c.timeframe=$6 OFFSET 0)
       ORDER BY e.embedding::vector({dimension}) <=> $8::vector({dimension}) LIMIT $7
      ), candidates AS (
       SELECT e.attachment_id,a.sha256,c.id AS call_id,c.submitted_at,c.original_text,c.instrument,c.market,c.timeframe,e.distance,
         COALESCE((SELECT el.episode_id::text FROM episode_links el WHERE el.owner_id=c.owner_id AND el.call_id=c.id AND el.id=(SELECT x.id FROM episode_links x WHERE x.owner_id=c.owner_id AND x.call_id=c.id ORDER BY x.created_at DESC,x.id DESC LIMIT 1) AND el.status IN ('confirmed','explicit')),c.id::text) AS episode_key
       FROM embedding_candidates e JOIN attachments a ON a.owner_id=$1 AND a.id=e.attachment_id
       JOIN call_attachments l ON l.owner_id=a.owner_id AND l.attachment_id=a.id
       JOIN calls c ON c.owner_id=l.owner_id AND c.id=l.call_id
       WHERE a.kind='scene' AND l.superseded_at IS NULL AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at)
         AND c.submitted_at<=$3 AND a.uploaded_at<=$3
         AND ($4::text IS NULL OR c.instrument=$4) AND ($5::text IS NULL OR c.market=$5) AND c.timeframe=$6
      ), unique_files AS(SELECT DISTINCT ON(sha256) * FROM candidates ORDER BY sha256,distance,submitted_at,call_id),
      grouped AS(SELECT DISTINCT ON(episode_key) * FROM unique_files ORDER BY episode_key,distance,submitted_at,call_id)
      SELECT * FROM grouped ORDER BY distance,call_id LIMIT $9"#
    );
    let rows = sqlx::query(&sql)
        .bind(owner)
        .bind(input.attachment_id)
        .bind(cutoff)
        .bind(&input.instrument)
        .bind(&input.market)
        .bind(&input.timeframe)
        .bind(3000_i64)
        .bind(vector)
        .bind(limit)
        .fetch_all(&mut *tx)
        .await?;
    let corpus_version: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT max(created_at) FROM image_embeddings WHERE owner_id=$1 AND model_id=$2",
    )
    .bind(owner)
    .bind(model)
    .fetch_one(&mut *tx)
    .await?;
    let results:Vec<Value>=rows.iter().map(|r|json!({"attachment_id":r.get::<Uuid,_>("attachment_id"),"call_id":r.get::<Uuid,_>("call_id"),"submitted_at":r.get::<chrono::DateTime<chrono::Utc>,_>("submitted_at"),"original_text":r.get::<String,_>("original_text"),"instrument":r.get::<Option<String>,_>("instrument"),"market":r.get::<Option<String>,_>("market"),"timeframe":r.get::<Option<String>,_>("timeframe"),"cosine_distance":r.get::<f64,_>("distance"),"group_id":r.get::<String,_>("episode_key"),"source_uri":format!("scorebook://calls/{}",r.get::<Uuid,_>("call_id"))})).collect();
    let id = Uuid::new_v4();
    let v = json!({"session_id":id,"model_id":input.model_id,"cutoff_at":cutoff,"items":results,"retrieval":"hnsw_relaxed_resorted_v3","corpus_version":corpus_version,"candidate_budget":3000,"result_count_may_be_limited_by_candidate_budget":true,"grouping":"exact_image_then_confirmed_episode","query_quality":quality,"score_meaning":"similarity_not_probability","quality_validated":false});
    if !persist {
        tx.commit().await?;
        let mut v = v;
        v.as_object_mut().unwrap().remove("session_id");
        v["storage"] = json!("ephemeral");
        return Ok(v);
    }
    sqlx::query("INSERT INTO similarity_sessions(id,owner_id,body,results) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(&v)
        .execute(&mut *tx)
        .await?;
    super::search_sessions::references(&mut tx, owner, id, &body, &v).await?;
    Database::finish(&mut tx, owner, "similarity.search", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn feedback(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: SimilarityFeedback,
) -> Result<Value> {
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "similarity.feedback", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let results: Value =
        sqlx::query_scalar("SELECT results FROM similarity_sessions WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(Error::not_found)?;
    if !results["items"].as_array().is_some_and(|a| {
        a.iter()
            .any(|r| r["attachment_id"] == input.attachment_id.to_string())
    }) {
        return Err(Error::bad("not_a_search_result"));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO similarity_feedback(id,owner_id,session_id,attachment_id,relevant,reason) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(owner).bind(input.session_id).bind(input.attachment_id).bind(input.relevant).bind(input.reason).execute(&mut *tx).await?;
    let v = json!({"id":id});
    Database::finish(&mut tx, owner, "similarity.feedback", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

pub async fn search(s: &Services, owner: Uuid, key: &str, input: SimilarityQuery) -> Result<Value> {
    search_mode(s, owner, key, input, true).await
}
pub async fn search_mode(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: SimilarityQuery,
    persist: bool,
) -> Result<Value> {
    if input.model_id == "hybrid-v2" {
        super::hybrid_search::search(s, owner, key, input, persist).await
    } else {
        search_single_mode(s, owner, key, input, persist).await
    }
}

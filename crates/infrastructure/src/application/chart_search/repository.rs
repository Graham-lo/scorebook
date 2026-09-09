pub use super::super::jobs::fence;
use super::*;
use sqlx::Row;
pub async fn publish(s: &Services, j: &Job, value: &Value, complete: bool) -> Result<()> {
    let mut tx = fence(s, j).await?;
    sqlx::query("UPDATE chart_search_runs SET result=$3,completed_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(value).bind(complete).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO job_targets SELECT $1,$2,r.* FROM reference_ids($3) r ON CONFLICT DO NOTHING",
    )
    .bind(j.owner)
    .bind(j.id)
    .bind(value)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
pub async fn public_candidates(
    s: &Services,
    input: &ChartSearchInput,
    vector: Vec<f32>,
) -> Result<Vec<Value>> {
    let mut tx = s.db.pool.begin().await?;
    crate::adapters::ann::configure(&mut tx).await?;
    let rows=sqlx::query("WITH candidates AS MATERIALIZED (SELECT id,market,symbol,timeframe,start_at,end_at,bars_count,input_hash,embedding::vector(192) <=> $1::vector(192) AS distance FROM public_market.features WHERE model_id='candle-geometry-v2' AND published AND end_at<=$2 AND ($3::text IS NULL OR symbol=$3) AND ($4::text IS NULL OR market=$4) AND ($5::text IS NULL OR timeframe=$5) AND bars_count=ANY($6) ORDER BY embedding::vector(192) <=> $1::vector(192) LIMIT 3000) SELECT * FROM candidates ORDER BY distance+0,id LIMIT 1000")
        .bind(pgvector::Vector::from(vector)).bind(input.cutoff_at).bind(&input.symbol).bind(&input.market).bind(&input.interval).bind(vec![64i32,128,256]).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut selected: Vec<Value> = Vec::new();
    for r in rows {
        let at: DateTime<Utc> = r.get("start_at");
        let end: DateTime<Utc> = r.get("end_at");
        let market: String = r.get("market");
        let symbol: String = r.get("symbol");
        let tf: String = r.get("timeframe");
        if selected.iter().any(|v| {
            v["market"] == market
                && v["symbol"] == symbol
                && v["interval"] == tf
                && v["start_at"]
                    .as_str()
                    .and_then(|v| v.parse::<DateTime<Utc>>().ok())
                    .is_some_and(|v| (v - at).num_seconds().abs() < (end - at).num_seconds() / 2)
        }) {
            continue;
        }
        let id: Uuid = r.get("id");
        selected.push(json!({"id":id,"source_uri":format!("scorebook://history/windows/{id}"),"market":market,"symbol":symbol,"interval":tf,"start_at":at,"end_at":end,"bars_count":r.get::<i32,_>("bars_count"),"source_hash_at_index":r.get::<String,_>("input_hash"),"ann_distance":r.get::<f64,_>("distance")}));
        if selected.len() == 30 {
            break;
        }
    }
    Ok(selected)
}
pub async fn private_candidates(
    s: &Services,
    owner: Uuid,
    input: &ChartSearchInput,
    geometry: Vec<f32>,
    visual: pgvector::Vector,
) -> Result<Vec<Value>> {
    let mut candidates = std::collections::HashMap::<String, (f64, Value)>::new();
    for (model, dimension, vector) in [
        (chart_match::MODEL, 192, pgvector::Vector::from(geometry)),
        ("dinov2-small-v1", 384, visual),
    ] {
        let mut tx = s.db.pool.begin().await?;
        crate::adapters::ann::configure(&mut tx).await?;
        let sql = format!(
            r#"WITH candidates AS MATERIALIZED (
          SELECT e.attachment_id,e.embedding::vector({dimension}) <=> $1::vector({dimension}) AS distance FROM image_embeddings e
          WHERE e.owner_id=$2 AND e.model_id='{model}' AND e.attachment_id<>$3
          AND EXISTS(SELECT 1 FROM call_attachments l JOIN calls c ON c.owner_id=l.owner_id AND c.id=l.call_id JOIN attachments a ON a.owner_id=l.owner_id AND a.id=l.attachment_id WHERE l.owner_id=e.owner_id AND l.attachment_id=e.attachment_id AND c.submitted_at<=$4 AND a.kind='scene' AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7) OFFSET 0)
          ORDER BY e.embedding::vector({dimension}) <=> $1::vector({dimension}) LIMIT 3000), ranked AS (
          SELECT DISTINCT ON(a.sha256) e.attachment_id,c.id AS call_id,e.distance,a.sha256,
          COALESCE((SELECT el.episode_id::text FROM episode_links el WHERE el.owner_id=$2 AND el.call_id=c.id AND el.status IN ('confirmed','explicit') AND el.id=(SELECT l2.id FROM episode_links l2 WHERE l2.owner_id=$2 AND l2.call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)),c.id::text) AS group_id
          FROM candidates e JOIN attachments a ON a.owner_id=$2 AND a.id=e.attachment_id JOIN call_attachments l ON l.owner_id=$2 AND l.attachment_id=e.attachment_id JOIN calls c ON c.owner_id=$2 AND c.id=l.call_id
          WHERE c.submitted_at<=$4 AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7)
          ORDER BY a.sha256,e.distance,c.submitted_at,c.id)
          SELECT * FROM ranked ORDER BY distance+0,call_id LIMIT 1000"#
        );
        let rows = sqlx::query(&sql)
            .bind(vector)
            .bind(owner)
            .bind(input.attachment_id)
            .bind(input.cutoff_at)
            .bind(&input.symbol)
            .bind(&input.market)
            .bind(&input.interval)
            .fetch_all(&mut *tx)
            .await?;
        tx.commit().await?;
        for (rank, r) in rows.iter().enumerate() {
            let group: String = r.get("group_id");
            let a: Uuid = r.get("attachment_id");
            let c: Uuid = r.get("call_id");
            let item=candidates.entry(group.clone()).or_insert((0.,json!({"attachment_id":a,"call_id":c,"group_id":group,"source_uri":format!("scorebook://calls/{c}")})));
            item.0 += 1. / (61. + rank as f64);
        }
    }
    let mut items: Vec<_> = candidates.into_values().collect();
    items.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1["call_id"].as_str().cmp(&b.1["call_id"].as_str()))
    });
    Ok(items.into_iter().take(30).map(|(_, v)| v).collect())
}

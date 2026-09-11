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
/// 返回候选池，外加「因为来路证不出来而被丢掉的窗口条数」——那个数字要一路带到
/// 检索结果里，不能在这里咽掉。
pub async fn public_candidates(
    s: &Services,
    input: &ChartSearchInput,
    vector: Vec<f32>,
) -> Result<(Vec<Value>, usize)> {
    let mut tx = s.db.pool.begin().await?;
    crate::adapters::ann::configure(&mut tx).await?;
    // 排除写在 ANN 的那一层里，不是查完再在内存里滤：人否掉三条之后要补上三条
    // 新的，而不是把三条空位留在结果里。`<> ALL('{}')` 恒为真，所以不给排除
    // 列表时这一句什么都不做。
    let rows=sqlx::query("WITH candidates AS MATERIALIZED (SELECT id,market,symbol,timeframe,start_at,end_at,bars_count,input_hash,embedding::vector(192) <=> $1::vector(192) AS distance FROM public_market.features WHERE model_id='candle-geometry-v2' AND published AND end_at<=$2 AND ($3::text IS NULL OR symbol=$3) AND ($4::text IS NULL OR market=$4) AND ($5::text IS NULL OR timeframe=$5) AND bars_count=ANY($6) AND id<>ALL($7) ORDER BY embedding::vector(192) <=> $1::vector(192) LIMIT 3000) SELECT * FROM candidates ORDER BY distance+0,id LIMIT 1000")
        .bind(pgvector::Vector::from(vector)).bind(input.cutoff_at).bind(&input.symbol).bind(&input.market).bind(&input.interval).bind(vec![64i32,128,256]).bind(&input.exclude).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut selected: Vec<Value> = Vec::new();
    for r in rows {
        let at: DateTime<Utc> = r.get("start_at");
        let end: DateTime<Utc> = r.get("end_at");
        let market: String = r.get("market");
        let symbol: String = r.get("symbol");
        let tf: String = r.get("timeframe");
        // Keep several candidates per contract for exact reranking, while leaving
        // room for other contracts in the bounded candidate budget.
        if selected
            .iter()
            .filter(|v| v["market"] == market && v["symbol"] == symbol)
            .count()
            >= 3
        {
            continue;
        }
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
    let mut tx = s.db.pool.begin().await?;
    let unproven = super::super::history::attach_market_sources(&mut tx, &mut selected).await?;
    tx.commit().await?;
    Ok((selected, unproven))
}
/// 私有记录的证据池，闸门与 `similarity::search_single_mode` 逐字一致：只收生效
/// 的那一张场景图（`l.superseded_at IS NULL`，定义见 `record_changes` 模块头），
/// 并且这张图必须在记录提交之前就已经存在（`a.uploaded_at<=c.submitted_at`）。
/// 后一条一个字都不放松——记录成立那一刻还不存在的图，不算「你当时看到的」。
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
          WHERE e.owner_id=$2 AND e.model_id='{model}' AND e.attachment_id<>$3 AND e.attachment_id<>ALL($8)
          AND EXISTS(SELECT 1 FROM call_attachments l JOIN calls c ON c.owner_id=l.owner_id AND c.id=l.call_id JOIN attachments a ON a.owner_id=l.owner_id AND a.id=l.attachment_id WHERE l.owner_id=e.owner_id AND l.attachment_id=e.attachment_id AND c.submitted_at<=$4 AND a.kind='scene' AND l.superseded_at IS NULL AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7) OFFSET 0)
          ORDER BY e.embedding::vector({dimension}) <=> $1::vector({dimension}) LIMIT 3000), ranked AS (
          SELECT DISTINCT ON(a.sha256) e.attachment_id,c.id AS call_id,e.distance,a.sha256,c.timeframe,
          COALESCE((SELECT el.episode_id::text FROM episode_links el WHERE el.owner_id=$2 AND el.call_id=c.id AND el.status IN ('confirmed','explicit') AND el.id=(SELECT l2.id FROM episode_links l2 WHERE l2.owner_id=$2 AND l2.call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)),c.id::text) AS group_id
          FROM candidates e JOIN attachments a ON a.owner_id=$2 AND a.id=e.attachment_id JOIN call_attachments l ON l.owner_id=$2 AND l.attachment_id=e.attachment_id JOIN calls c ON c.owner_id=$2 AND c.id=l.call_id
          WHERE c.submitted_at<=$4 AND l.superseded_at IS NULL AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7)
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
            // 人否掉过的那几张图不再参加这一轮的 ANN 取数，理由同公开那一条。
            .bind(&input.exclude)
            .fetch_all(&mut *tx)
            .await?;
        tx.commit().await?;
        for (rank, r) in rows.iter().enumerate() {
            let group: String = r.get("group_id");
            let a: Uuid = r.get("attachment_id");
            let c: Uuid = r.get("call_id");
            // 不限周期时命中的可能是别的周期，得把这条记录自己的周期带出去。
            let tf: Option<String> = r.get("timeframe");
            let item=candidates.entry(group.clone()).or_insert((0.,json!({"attachment_id":a,"call_id":c,"group_id":group,"interval":tf,"source_uri":format!("scorebook://calls/{c}")})));
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

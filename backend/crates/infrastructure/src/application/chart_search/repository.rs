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
    // bars：图上数出来多少根蜡烛，只查最接近的两档窗口（§5.5-1）。
    bars: usize,
) -> Result<(Vec<Value>, usize)> {
    let (mut candidates, unproven) =
        public_candidates_guarded(s, input, vector, bars, None).await?;
    if input.symbol.is_none() {
        // Select the user's quote currency before any candidate OHLC is fetched.
        quote_variants::annotate(s, &mut candidates).await?;
        quote_variants::usdt_only(&mut candidates);
    }
    Ok((candidates, unproven))
}

pub(super) async fn public_candidates_guarded(
    s: &Services,
    input: &ChartSearchInput,
    vector: Vec<f32>,
    bars: usize,
    guard: Option<(&str, &str, DateTime<Utc>, DateTime<Utc>)>,
) -> Result<(Vec<Value>, usize)> {
    let mut tx = s.db.pool.begin().await?;
    crate::adapters::ann::configure(&mut tx).await?;
    // 排除写在 ANN 的那一层里，不是查完再在内存里滤：人否掉三条之后要补上三条
    // 新的，而不是把三条空位留在结果里。`<> ALL('{}')` 恒为真，所以不给排除
    // 列表时这一句什么都不做。
    let query_vector = vector.clone();
    let rows=sqlx::query("WITH candidates AS MATERIALIZED (SELECT id,market,symbol,timeframe,start_at,end_at,bars_count,input_hash,embedding,embedding::vector(192) <=> $1::vector(192) AS distance FROM public_market.features WHERE model_id='candle-geometry-v2' AND published AND end_at<=$2 AND ($3::text IS NULL OR symbol=$3) AND ($4::text IS NULL OR market=$4) AND ($5::text IS NULL OR timeframe=$5) AND bars_count=ANY($6) AND ($3::text IS NOT NULL OR market<>'usd_m' OR EXISTS(SELECT 1 FROM instrument_catalog c WHERE c.venue='binance' AND c.market=features.market AND c.symbol=features.symbol AND c.body->>'quoteAsset'='USDT')) AND id<>ALL($7) AND ($8::text IS NULL OR NOT(market=$8 AND symbol=$9 AND start_at<$10 AND end_at>$11)) ORDER BY embedding::vector(192) <=> $1::vector(192) LIMIT $12) SELECT * FROM candidates ORDER BY distance+0,id")
        .bind(pgvector::Vector::from(vector)).bind(input.cutoff_at).bind(&input.symbol).bind(&input.market).bind(&input.interval).bind(super::super::history::nearest_windows(bars)).bind(&input.exclude)
        .bind(guard.map(|g| g.0)).bind(guard.map(|g| g.1)).bind(guard.map(|g| g.2)).bind(guard.map(|g| g.3)).bind(recall::CANDIDATE_POOL as i64).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    // Align compressed shapes before discarding windows for per-contract diversity.
    // Source hashes and real OHLC are still checked by the unchanged exact reranker.
    let rows = tokio::task::spawn_blocking(move || {
        let mut scored: Vec<_> = rows
            .into_iter()
            .map(|r| {
                let feature: pgvector::Vector = r.get("embedding");
                let score = recall::distance(
                    &query_vector,
                    feature.as_slice(),
                    bars,
                    r.get::<i32, _>("bars_count") as usize,
                );
                (score, r)
            })
            .collect();
        scored.sort_by(|a, b| {
            a.0.total_cmp(&b.0)
                .then_with(|| {
                    a.1.get::<f64, _>("distance")
                        .total_cmp(&b.1.get::<f64, _>("distance"))
                })
                .then_with(|| a.1.get::<Uuid, _>("id").cmp(&b.1.get::<Uuid, _>("id")))
        });
        scored
    })
    .await
    .map_err(|_| Error::bad("chart_search_interrupted"))?;
    let mut selected: Vec<Value> = Vec::new();
    for (coarse_distance, r) in rows {
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
        selected.push(json!({"id":id,"source_uri":format!("scorebook://history/windows/{id}"),"market":market,"symbol":symbol,"interval":tf,"start_at":at,"end_at":end,"bars_count":r.get::<i32,_>("bars_count"),"source_hash_at_index":r.get::<String,_>("input_hash"),"ann_distance":r.get::<f64,_>("distance"),"coarse_alignment_distance":coarse_distance}));
        if selected.len() == budget(&ChartScope::BinanceHistory) {
            break;
        }
    }
    let mut tx = s.db.pool.begin().await?;
    let unproven = super::super::history::attach_market_sources(&mut tx, &mut selected).await?;
    tx.commit().await?;
    Ok((selected, unproven))
}
pub(super) struct PrivateTextContext {
    pub by_call: std::collections::HashMap<Uuid, Value>,
    pub metadata: Value,
}

pub(super) async fn private_text_context(
    s: &Services,
    owner: Uuid,
    input: &ChartSearchInput,
) -> Result<Option<PrivateTextContext>> {
    let Some(query) = input.query_text.as_ref() else {
        return Ok(None);
    };
    let retrieved =
        super::super::knowledge_index::search_for_chart(s, owner, query.clone(), input.cutoff_at)
            .await?;
    let sources = retrieved["items"]
        .as_array()
        .ok_or_else(|| Error::bad("invalid_knowledge_search_result"))?;
    // Link through owner-scoped source tables, not strings found inside text.
    // Recheck index freshness before carrying an excerpt into the image result.
    let links: Vec<(Uuid, i64)> = sqlx::query_as(r#"
        WITH hits AS (
            SELECT h.value->>'source_kind' AS kind,
                   (h.value->>'source_id')::uuid AS id, h.ordinality::bigint AS rank
            FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY h(value, ordinality)
            JOIN knowledge_documents d ON d.owner_id=$1
                AND d.source_kind=h.value->>'source_kind'
                AND d.source_id=(h.value->>'source_id')::uuid
                AND d.source_version=h.value->>'source_version'
            WHERE NOT EXISTS(SELECT 1 FROM knowledge_dirty q WHERE q.owner_id=d.owner_id
                AND q.source_kind=d.source_kind AND q.source_id=d.source_id)
        ), current_episode AS (
            SELECT DISTINCT ON(call_id) call_id, episode_id, id, status
            FROM episode_links WHERE owner_id=$1 AND ($3::timestamptz IS NULL OR created_at<=$3)
            ORDER BY call_id, created_at DESC, id DESC
        ), mapped AS (
            SELECT h.id AS call_id,h.rank FROM hits h WHERE h.kind IN ('call','submission_feedback')
            UNION ALL SELECT r.call_id,h.rank FROM hits h JOIN reviews r
                ON r.owner_id=$1 AND r.id=h.id WHERE h.kind='review'
            UNION ALL SELECT o.call_id,h.rank FROM hits h JOIN outcomes o
                ON o.owner_id=$1 AND o.id=h.id WHERE h.kind='outcome'
            UNION ALL SELECT l.call_id,h.rank FROM hits h JOIN call_attachments l
                ON l.owner_id=$1 AND l.attachment_id=h.id
                WHERE h.kind='attachment' AND l.superseded_at IS NULL
                    AND ($3::timestamptz IS NULL OR l.attached_at<=$3)
            UNION ALL SELECT e.call_id,h.rank FROM hits h JOIN current_episode e
                ON (h.kind='episode' AND e.episode_id=h.id) OR (h.kind='episode_link' AND e.id=h.id)
                WHERE e.status IN ('confirmed','explicit')
            UNION ALL SELECT r.call_id,h.rank FROM hits h JOIN episode_review_refs r
                ON r.owner_id=$1 AND r.review_id=h.id WHERE h.kind='episode_review'
            UNION ALL SELECT e.call_id,h.rank FROM hits h JOIN execution_links e
                ON e.owner_id=$1 AND e.id=h.id WHERE h.kind='execution_link' AND e.call_id IS NOT NULL
        )
        SELECT DISTINCT m.call_id,m.rank FROM mapped m JOIN calls c ON c.owner_id=$1 AND c.id=m.call_id
        WHERE ($3::timestamptz IS NULL OR c.submitted_at<=$3) ORDER BY m.rank,m.call_id
    "#).bind(owner).bind(json!(sources)).bind(input.cutoff_at).fetch_all(&s.db.pool).await?;
    let mut by_call = std::collections::HashMap::new();
    for (call, rank) in links {
        let source = &sources[rank as usize - 1];
        by_call.entry(call).or_insert_with(|| {
            json!({
                "source_kind":source["source_kind"], "source_id":source["source_id"],
                "source_version":source["source_version"], "source_uri":source["source_uri"],
                "excerpt":source["excerpt"], "retrieval_rank":rank,
                "rrf_score":source["rrf_score"],
            })
        });
    }
    let metadata = json!({"protocol":retrieved["protocol"], "model_id":retrieved["model_id"],
        "coverage":retrieved["coverage"], "source_candidates":sources.len(),
        "related_calls":by_call.len(), "candidate_budget":120,
        "score_interpretation":"retrieval_order_not_probability",
        "constraint":"indexed_related_record_text", "generated":false});
    Ok(Some(PrivateTextContext { by_call, metadata }))
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
    text: Option<&PrivateTextContext>,
) -> Result<Vec<Value>> {
    let text_calls: Option<Vec<Uuid>> = text.map(|v| v.by_call.keys().copied().collect());
    if text_calls.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Vec::new());
    }
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
          AND ('{model}' <> 'dinov2-small-v1' OR e.quality->>'crop_profile'='chart-pane-v1')
          AND EXISTS(SELECT 1 FROM call_attachments l JOIN calls c ON c.owner_id=l.owner_id AND c.id=l.call_id JOIN attachments a ON a.owner_id=l.owner_id AND a.id=l.attachment_id WHERE l.owner_id=e.owner_id AND l.attachment_id=e.attachment_id AND c.submitted_at<=$4 AND a.kind='scene' AND l.superseded_at IS NULL AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7) AND ($9::uuid[] IS NULL OR c.id=ANY($9)) OFFSET 0)
          ORDER BY e.embedding::vector({dimension}) <=> $1::vector({dimension}) LIMIT 3000), ranked AS (
          SELECT DISTINCT ON(a.sha256) e.attachment_id,c.id AS call_id,e.distance,a.sha256,c.timeframe,
          COALESCE((SELECT el.episode_id::text FROM episode_links el WHERE el.owner_id=$2 AND el.call_id=c.id AND el.status IN ('confirmed','explicit') AND el.id=(SELECT l2.id FROM episode_links l2 WHERE l2.owner_id=$2 AND l2.call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1)),c.id::text) AS group_id
          FROM candidates e JOIN attachments a ON a.owner_id=$2 AND a.id=e.attachment_id JOIN call_attachments l ON l.owner_id=$2 AND l.attachment_id=e.attachment_id JOIN calls c ON c.owner_id=$2 AND c.id=l.call_id
          WHERE c.submitted_at<=$4 AND l.superseded_at IS NULL AND a.uploaded_at<=c.submitted_at AND (a.captured_at IS NULL OR a.captured_at<=c.submitted_at) AND ($5::text IS NULL OR c.instrument=$5) AND ($6::text IS NULL OR c.market=$6) AND ($7::text IS NULL OR c.timeframe=$7) AND ($9::uuid[] IS NULL OR c.id=ANY($9))
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
            .bind(&text_calls)
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
    if let Some(text) = text {
        for (score, item) in &mut items {
            let call: Uuid = serde_json::from_value(item["call_id"].clone())
                .map_err(|_| Error::bad("invalid_candidate"))?;
            let evidence = text
                .by_call
                .get(&call)
                .ok_or_else(|| Error::bad("chart_text_evidence_missing"))?;
            *score += 1. / (60. + evidence["retrieval_rank"].as_f64().unwrap_or(120.));
            item["text_match"] = evidence.clone();
        }
    }
    items.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| a.1["call_id"].as_str().cmp(&b.1["call_id"].as_str()))
    });
    Ok(items
        .into_iter()
        .take(budget(&ChartScope::Private))
        .map(|(_, v)| v)
        .collect())
}

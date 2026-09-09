//! Historical index stores vectors + time coordinates only. Raw bars and rendered pixels stay in RAM.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    domain::{chart, criteria::Bar},
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
pub use scorebook_core::api::history::*;

use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub fn interval_seconds(tf: &str) -> Result<i64> {
    match tf {
        "1m" => Ok(60),
        "5m" => Ok(300),
        "15m" => Ok(900),
        "1h" => Ok(3600),
        "4h" => Ok(14400),
        "1d" => Ok(86400),
        _ => Err(Error::bad("unsupported_interval")),
    }
}
pub fn validate(input: &HistoryIndexRequest) -> Result<()> {
    let seconds = interval_seconds(&input.interval)?;
    if !matches!(input.market.as_str(), "usd_m" | "coin_m")
        || input.symbol.is_empty()
        || !input
            .symbol
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(Error::bad("invalid_contract"));
    }
    let bars = (input.end_at - input.start_at).num_seconds() / seconds;
    if input.start_at >= input.end_at
        || input.end_at > Utc::now()
        || !(32..=256).contains(&input.window_bars)
        || input.stride_bars == 0
        || input.stride_bars > 50000
        || bars > 50000
        || bars < input.window_bars as i64
        || (bars - input.window_bars as i64) / input.stride_bars as i64 + 1 > 1000
    {
        return Err(Error::bad(
            "history_request_exceeds_bounded_range;max_50000_bars_1000_windows",
        ));
    }
    if input.models.is_empty()
        || input.models.len() > 2
        || (input.models.len() == 2 && input.models[0] == input.models[1])
        || input
            .models
            .iter()
            .any(|m| !matches!(m.as_str(), "candle-geometry-v2" | "dinov2-small-v1"))
    {
        return Err(Error::bad("invalid_models"));
    }
    Ok(())
}
pub async fn request(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: HistoryIndexRequest,
) -> Result<Value> {
    validate(&input)?;
    if input.models.iter().any(|m| m == "dinov2-small-v1") && s.vision.url.is_none() {
        return Err(Error::bad("visual_model_not_configured"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "history.index", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = jobs::enqueue_tx(&mut tx, owner, "history.index", key, body.clone()).await?;
    let generation:Uuid=sqlx::query_scalar("INSERT INTO public_market.generations(id,request_hash,body) VALUES(md5($1::jsonb::text)::uuid,md5($1::jsonb::text),$1) ON CONFLICT(request_hash) DO UPDATE SET request_hash=EXCLUDED.request_hash RETURNING id").bind(&body).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO history_indexes(id,owner_id,body,generation_id,status) VALUES($1,$2,$3,$4,'queued') ON CONFLICT DO NOTHING").bind(id).bind(owner).bind(&body).bind(generation).execute(&mut *tx).await?;
    let v = json!({"job_id":id,"index_id":id,"generation_id":generation,"status":"queued","raw_market_storage":"none"});
    Database::finish(&mut tx, owner, "history.index", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn build(s: &Services, j: &Job) -> Result<Value> {
    let input: HistoryIndexRequest =
        serde_json::from_value(j.body.clone()).map_err(|_| Error::bad("invalid_job"))?;
    validate(&input)?;
    let ready: Option<Value> = sqlx::query_scalar(
        "SELECT coverage FROM history_indexes WHERE owner_id=$1 AND id=$2 AND status='ready'",
    )
    .bind(j.owner)
    .bind(j.id)
    .fetch_optional(&s.db.pool)
    .await?;
    if let Some(v) = ready {
        return Ok(v);
    }
    let ready:Option<(Uuid,Value)>=sqlx::query_as("SELECT g.id,g.coverage FROM public_market.generations g JOIN history_indexes i ON i.generation_id=g.id WHERE i.owner_id=$1 AND i.id=$2 AND g.status='ready'").bind(j.owner).bind(j.id).fetch_optional(&s.db.pool).await?;
    if let Some((generation, coverage)) = ready {
        publish_index(s, j, generation, &coverage, None).await?;
        return Ok(coverage);
    }
    if input.source == HistorySource::MonthlyArchive {
        return super::history_catalog::archives::build(s, j, &input).await;
    }
    let payload = s
        .market
        .klines(
            &input.market,
            &input.symbol,
            &input.interval,
            input.start_at,
            input.end_at,
        )
        .await?;
    let bars: Vec<Bar> = serde_json::from_value(payload["bars"].clone())
        .map_err(|_| Error::bad("invalid_provider_bars"))?;
    let result = index_bars(s, j, &input, &bars, payload["coverage_complete"] == true).await?;
    // payload, bars and raster images are dropped here. Nothing writes them to disk/DB.
    Ok(result)
}
pub async fn index_bars(
    s: &Services,
    j: &Job,
    input: &HistoryIndexRequest,
    bars: &[Bar],
    complete: bool,
) -> Result<Value> {
    validate(input)?;
    let generation: Uuid =
        sqlx::query_scalar("SELECT generation_id FROM history_indexes WHERE owner_id=$1 AND id=$2")
            .bind(j.owner)
            .bind(j.id)
            .fetch_one(&s.db.pool)
            .await?;
    if let Some(coverage) = sqlx::query_scalar::<_, Value>(
        "SELECT coverage FROM public_market.generations WHERE id=$1 AND status='ready'",
    )
    .bind(generation)
    .fetch_optional(&s.db.pool)
    .await?
    {
        publish_index(s, j, generation, &coverage, None).await?;
        return Ok(coverage);
    }
    let mut reservation = fenced_tx(s, j).await?;
    let reserved:Option<Uuid>=sqlx::query_scalar("UPDATE public_market.generations g SET producer_job=$2,producer_lease=$3,status='running' WHERE id=$1 AND status<>'ready' AND (producer_job IS NULL OR producer_job=$2 OR NOT EXISTS(SELECT 1 FROM jobs active WHERE active.id=g.producer_job AND active.lease_owner=g.producer_lease AND active.status='running' AND active.lease_until>now())) RETURNING id").bind(generation).bind(j.id).bind(j.lease).fetch_optional(&mut *reservation).await?;
    if reserved.is_none() {
        return Err(Error::deferred(
            "shared_index_build_in_progress",
            crate::error::RetryDirective::After(10),
        ));
    }
    reservation.commit().await?;
    let step = interval_seconds(&input.interval)?;
    let prior:Vec<(DateTime<Utc>,String,String)>=sqlx::query_as("SELECT f.start_at,f.model_id,f.input_hash FROM public_market.features f JOIN public_market.generation_features l ON l.feature_id=f.id WHERE l.generation_id=$1").bind(generation).fetch_all(&s.db.pool).await?;
    let prior: std::collections::HashSet<_> = prior.into_iter().collect();
    let mut retained = Vec::new();
    let mut pending = Vec::new();
    let mut skipped = 0usize;
    let mut feature_rows = 0usize;
    let mut batches = 0usize;
    let windows: Vec<_> = bars
        .windows(input.window_bars)
        .step_by(input.stride_bars)
        .collect();
    for block in windows.chunks(8) {
        let mut slices = vec![];
        for slice in block {
            if slice.windows(2).any(|w| w[0].end != w[1].start)
                || slice
                    .iter()
                    .any(|b| (b.end - b.start).num_seconds() != step)
            {
                skipped += 1;
                continue;
            }
            slices.push(*slice);
        }
        for model in &input.models {
            let mut coordinates = vec![];
            let mut work = vec![];
            for slice in &slices {
                let hash = digest(slice);
                feature_rows += 1;
                retained
                    .push(json!({"start_at":slice[0].start,"model_id":model,"input_hash":hash}));
                if prior.contains(&(slice[0].start, model.clone(), hash.clone())) {
                    continue;
                }
                coordinates.push((slice[0].start, slice.last().unwrap().end, hash));
                work.push(slice.to_vec());
            }
            if work.is_empty() {
                continue;
            }
            let features = if model == scorebook_core::domain::chart_match::MODEL {
                tokio::task::spawn_blocking(move || work.iter().map(|w| {
                    let candles=scorebook_core::domain::chart_match::from_bars(w)?;
                    Ok(crate::adapters::vision::Features{vector:scorebook_core::domain::chart_match::descriptor(&candles)?,quality:json!({"protocol":"chart-match-v2","source":"direct_ohlc","quality_validated":false}),model_id:"candle-geometry-v2".into()})
                }).collect::<Result<Vec<_>>>()).await.map_err(|_|Error::bad("geometry_processing_failed"))??
            } else {
                let images = tokio::task::spawn_blocking(move || {
                    work.iter()
                        .map(|w| chart::raster(w).map_err(Error::bad))
                        .collect::<Result<Vec<_>>>()
                })
                .await
                .map_err(|_| Error::bad("chart_render_failed"))??;
                s.vision.extract_batch(images, model).await?
            };
            for ((start, end, hash), feature) in coordinates.into_iter().zip(features) {
                pending.push(json!({"market":input.market,"symbol":input.symbol,"timeframe":input.interval,"start_at":start,"end_at":end,"bars_count":input.window_bars,"model_id":model,"embedding":format!("{:?}",feature.vector),"input_hash":hash,"render_version":if model=="candle-geometry-v2"{"ohlc-geometry-resample64-v2"}else{"candles-raster-v1"}}));
                if pending.len() == 500 {
                    write_feature_block(s, j, generation, &pending).await?;
                    pending.clear();
                    batches += 1;
                }
            }
        }
    }
    if !pending.is_empty() {
        write_feature_block(s, j, generation, &pending).await?;
        batches += 1;
    }
    let coverage = json!({"generation_id":generation,"symbol":input.symbol,"market":input.market,"interval":input.interval,"requested_start":input.start_at,"requested_end":input.end_at,"actual_start":bars.first().map(|b|b.start),"actual_end":bars.last().map(|b|b.end),"source_bars_fetched":bars.len(),"source_range_complete":complete,"feature_rows":feature_rows,"windows_skipped_for_gaps":skipped,"window_bars":input.window_bars,"stride_bars":input.stride_bars,"models":input.models,"feature_write_statements":batches*2,"raw_market_storage":"none","system_chart_storage":"none"});
    publish_index(s, j, generation, &coverage, Some(&json!(retained))).await?;
    Ok(coverage)
}
async fn fenced_tx<'a>(s: &'a Services, j: &Job) -> Result<sqlx::Transaction<'a, sqlx::Postgres>> {
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(j.owner.to_string())
        .execute(&mut *tx)
        .await?;
    let active:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND owner_id=$2 AND lease_owner=$3 AND generation=$4 AND status='running' AND lease_until>now() FOR UPDATE").bind(j.id).bind(j.owner).bind(j.lease).bind(j.generation).fetch_optional(&mut *tx).await?;
    if active.is_none() {
        return Err(Error::conflict("lease_lost"));
    }
    Ok(tx)
}
pub async fn write_feature_block(
    s: &Services,
    j: &Job,
    generation: Uuid,
    rows: &[Value],
) -> Result<()> {
    if rows.len() > 500
        || serde_json::to_vec(rows)
            .map_err(|_| Error::bad("invalid_feature_block"))?
            .len()
            > 4 * 1024 * 1024
    {
        return Err(Error::bad("feature_block_too_large"));
    }
    let mut tx = fenced_tx(s, j).await?;
    let producer:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM public_market.generations WHERE id=$1 AND producer_job=$2 AND producer_lease=$3 AND status='running')").bind(generation).bind(j.id).bind(j.lease).fetch_one(&mut *tx).await?;
    if !producer {
        return Err(Error::conflict("generation_lease_lost"));
    }
    sqlx::query(r#"WITH source AS MATERIALIZED (
      SELECT md5(jsonb_build_array(market,symbol,timeframe,start_at,end_at,bars_count,model_id,input_hash,render_version)::text)::uuid AS id,r.*
      FROM jsonb_to_recordset($1) AS r(market text,symbol text,timeframe text,start_at timestamptz,end_at timestamptz,bars_count int,model_id text,embedding vector,input_hash text,render_version text)
    ), located AS (
      INSERT INTO public_market.feature_locator SELECT id,market,timeframe FROM source ON CONFLICT DO NOTHING RETURNING id
    ), inserted AS (
      INSERT INTO public_market.features(id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version)
      SELECT * FROM source ON CONFLICT DO NOTHING RETURNING id
    ) INSERT INTO public_market.generation_features(generation_id,feature_id) SELECT $2,id FROM source ON CONFLICT DO NOTHING"#).bind(json!(rows)).bind(generation).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
async fn publish_index(
    s: &Services,
    j: &Job,
    generation: Uuid,
    coverage: &Value,
    retained: Option<&Value>,
) -> Result<()> {
    let mut tx = fenced_tx(s, j).await?;
    let status: String =
        sqlx::query_scalar("SELECT status FROM public_market.generations WHERE id=$1 FOR UPDATE")
            .bind(generation)
            .fetch_one(&mut *tx)
            .await?;
    if status != "ready" {
        if let Some(retained) = retained {
            // A provider correction or new gap after a retry must not publish abandoned checkpoint windows.
            sqlx::query("DELETE FROM public_market.generation_features l USING public_market.features f WHERE l.generation_id=$1 AND l.feature_id=f.id AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($2) AS r(start_at timestamptz,model_id text,input_hash text) WHERE r.start_at=f.start_at AND r.model_id=f.model_id AND r.input_hash=f.input_hash)").bind(generation).bind(retained).execute(&mut *tx).await?;
        }
        let changed=sqlx::query("UPDATE public_market.generations SET status='ready',published_at=now(),coverage=$4 WHERE id=$1 AND producer_job=$2 AND producer_lease=$3").bind(generation).bind(j.id).bind(j.lease).bind(coverage).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(Error::conflict("generation_lease_lost"));
        }
        // Serialize publication for an instrument/interval, then replace active
        // exact-window versions atomically. Saved historical IDs remain resolvable.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,12))")
            .bind(format!(
                "{}:{}:{}",
                coverage["market"], coverage["symbol"], coverage["interval"]
            ))
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE public_market.features old SET published=false FROM public_market.features fresh JOIN public_market.generation_features l ON l.feature_id=fresh.id AND l.generation_id=$1 WHERE old.published AND old.id<>fresh.id AND old.market=fresh.market AND old.symbol=fresh.symbol AND old.timeframe=fresh.timeframe AND old.start_at=fresh.start_at AND old.end_at=fresh.end_at AND old.bars_count=fresh.bars_count AND old.model_id=fresh.model_id AND old.render_version=fresh.render_version").bind(generation).execute(&mut *tx).await?;
        sqlx::query("UPDATE public_market.features f SET published=true WHERE NOT published AND EXISTS(SELECT 1 FROM public_market.generation_features l WHERE l.generation_id=$1 AND l.feature_id=f.id)").bind(generation).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO public_market.coverage_segments(generation_id,market,symbol,timeframe,start_at,end_at,actual_start,actual_end,status) VALUES($1,$2->>'market',$2->>'symbol',$2->>'interval',($2->>'requested_start')::timestamptz,($2->>'requested_end')::timestamptz,($2->>'actual_start')::timestamptz,($2->>'actual_end')::timestamptz,CASE WHEN ($2->>'source_range_complete')::boolean THEN 'complete' ELSE 'partial' END) ON CONFLICT(generation_id) DO NOTHING").bind(generation).bind(coverage).execute(&mut *tx).await?;
    sqlx::query("UPDATE history_indexes SET status='ready',completed_at=now(),coverage=$3 WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(coverage).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn search(s: &Services, owner: Uuid, key: &str, input: HistorySearch) -> Result<Value> {
    search_mode(s, owner, key, input, true).await
}
pub async fn search_mode(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: HistorySearch,
    persist: bool,
) -> Result<Value> {
    let body = json!(input);
    let (vector, quality, _) = super::similarity::embed_mode(
        s,
        owner,
        input.attachment_id,
        input.region.clone(),
        &input.model_id,
        persist,
    )
    .await?;
    let (mut tx, cached) = if persist {
        s.db.write(owner, "history.search", key, &body).await?
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
    let cutoff = input.cutoff_at.unwrap_or_else(Utc::now);
    let limit = input.limit.unwrap_or(10).clamp(1, 50) as usize;
    let (model, dimension) = crate::adapters::ann::space(&input.model_id)?;
    crate::adapters::ann::configure(&mut tx).await?;
    let sql = format!(
        "WITH ann_candidates AS MATERIALIZED (SELECT id,market,symbol,timeframe,start_at,end_at,bars_count,input_hash,embedding::vector({dimension}) <=> $5::vector({dimension}) AS distance FROM public_market.features WHERE published AND model_id='{model}' AND end_at<=$1 AND ($2::text IS NULL OR symbol=$2) AND ($3::text IS NULL OR market=$3) AND ($4::text IS NULL OR timeframe=$4) ORDER BY embedding::vector({dimension}) <=> $5::vector({dimension}) LIMIT 3000) SELECT * FROM ann_candidates ORDER BY distance+0,id LIMIT 1000"
    );
    let rows = sqlx::query(&sql)
        .bind(cutoff)
        .bind(&input.symbol)
        .bind(&input.market)
        .bind(&input.interval)
        .bind(vector)
        .fetch_all(&mut *tx)
        .await?;
    let mut selected: Vec<Value> = vec![];
    for r in rows {
        let start: DateTime<Utc> = r.get("start_at");
        let end: DateTime<Utc> = r.get("end_at");
        let symbol: String = r.get("symbol");
        let tf: String = r.get("timeframe");
        let market: String = r.get("market");
        if selected.iter().any(|s| {
            s["symbol"] == symbol
                && s["market"] == market
                && s["interval"] == tf
                && s["end_at"]
                    .as_str()
                    .and_then(|x| x.parse::<DateTime<Utc>>().ok())
                    .is_some_and(|at| {
                        (at - end).num_seconds().abs() < (end - start).num_seconds() / 2
                    })
        }) {
            continue;
        }
        let id: Uuid = r.get("id");
        selected.push(json!({"id":id,"source":"binance_history","source_uri":format!("scorebook://history/windows/{id}"),"symbol":symbol,"market":market,"interval":tf,"start_at":start,"end_at":end,"bars_count":r.get::<i32,_>("bars_count"),"cosine_distance":r.get::<f64,_>("distance"),"source_hash_at_index":r.get::<String,_>("input_hash"),"chart_request":{"symbol":symbol,"market":market,"interval":tf,"start_at":start,"end_at":end},"chart_storage":"refetch_and_redraw"}));
        if selected.len() >= limit {
            break;
        }
    }
    attach_market_sources(&mut tx, &mut selected).await?;
    let coverage:Vec<Value>=sqlx::query_scalar("SELECT coverage FROM public_market.generations WHERE status='ready' AND ($1::text IS NULL OR body->>'symbol'=$1) AND ($2::text IS NULL OR body->>'market'=$2) AND ($3::text IS NULL OR body->>'interval'=$3) AND body->'models' ? $4 AND (body->>'start_at')::timestamptz<$5 ORDER BY published_at DESC,id DESC LIMIT 100").bind(&input.symbol).bind(&input.market).bind(&input.interval).bind(&input.model_id).bind(cutoff).fetch_all(&mut *tx).await?;
    let corpus_version: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(published_at) FROM public_market.generations WHERE status='ready'",
    )
    .fetch_one(&mut *tx)
    .await?;
    let id = Uuid::new_v4();
    let result = json!({"session_id":id,"items":selected,"model_id":input.model_id,"cutoff_at":cutoff,"query_quality":quality,"coverage":coverage,"coverage_list_limit":100,"scope":"only_ready_indexes;not_all_binance_history","coverage_url":"/v1/history/coverage","coverage_is_capped_by_query_cutoff":true,"quality_validated":false,"ranking":"hnsw_relaxed_resorted_v3;half_window_spacing","corpus_version":corpus_version,"candidate_budget":3000,"deduplication_budget":1000,"score_meaning":"similarity_not_probability"});
    if !persist {
        tx.commit().await?;
        let mut result = result;
        result.as_object_mut().unwrap().remove("session_id");
        result["storage"] = json!("ephemeral");
        return Ok(result);
    }
    sqlx::query("INSERT INTO similarity_sessions(id,owner_id,body,results) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
    super::search_sessions::references(&mut tx, owner, id, &body, &result).await?;
    Database::finish(&mut tx, owner, "history.search", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn indexes(s: &Services, owner: Uuid, cursor: Option<Uuid>) -> Result<Value> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(i)-'owner_id' FROM history_indexes i WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 101").bind(owner).bind(cursor).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(json!({"next_cursor":if more{items.last().map(|x|x["id"].clone())}else{None},"items":items}))
}

/// Public, derived-market coverage only; never exposes the tenants who requested each generation.
pub async fn coverage(s: &Services, input: CoverageFilter) -> Result<Value> {
    if let Some(model) = &input.model_id {
        crate::adapters::ann::space(model)?;
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('generation_id',id,'coverage',coverage,'published_at',published_at) FROM public_market.generations WHERE status='ready' AND ($1::text IS NULL OR body->>'symbol'=$1) AND ($2::text IS NULL OR body->>'market'=$2) AND ($3::text IS NULL OR body->>'interval'=$3) AND ($4::text IS NULL OR body->'models' ? $4) AND ($5::timestamptz IS NULL OR (body->>'start_at')::timestamptz<$5) AND ($6::uuid IS NULL OR id>$6) ORDER BY id LIMIT 101").bind(input.symbol).bind(input.market).bind(input.interval).bind(input.model_id).bind(input.cutoff_at).bind(input.cursor).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    let next = if more {
        items.last().map(|v| v["generation_id"].clone())
    } else {
        None
    };
    Ok(
        json!({"items":items,"next_cursor":next,"order":"generation_id_asc","scope":"published_derived_market_only","cutoff_at":input.cutoff_at}),
    )
}

/// Explicit source revision: a fresh producer must refetch/reverify the same scope.
/// Cached generations remain historical evidence and cannot silently be rewritten.
pub async fn revalidate(s: &Services, owner: Uuid, id: Uuid, key: &str) -> Result<Value> {
    let body = json!({"index_id":id});
    let (mut tx, cached) = s.db.write(owner, "history.revalidate", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let (request,prior):(Value,Uuid)=sqlx::query_as("SELECT body,generation_id FROM history_indexes WHERE owner_id=$1 AND id=$2 AND status='ready'").bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(Error::not_found)?;
    let next = jobs::enqueue_tx(
        &mut tx,
        owner,
        "history.index",
        &format!("revalidate:{key}"),
        request.clone(),
    )
    .await?;
    let generation = Uuid::new_v4();
    sqlx::query("INSERT INTO public_market.generations(id,request_hash,body,supersedes) VALUES($1,$2,$3,$4)").bind(generation).bind(digest(&json!([request,generation]))).bind(&request).bind(prior).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO history_indexes(id,owner_id,body,generation_id,status) VALUES($1,$2,$3,$4,'queued')").bind(next).bind(owner).bind(request).bind(generation).execute(&mut *tx).await?;
    let result = json!({"index_id":next,"job_id":next,"generation_id":generation,"supersedes_generation":prior,"status":"queued","source_policy":"explicit_refetch_and_checksum_verification"});
    Database::finish(&mut tx, owner, "history.revalidate", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn attach_market_sources(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    items: &mut [Value],
) -> Result<()> {
    if items.len() > 50 {
        return Err(Error::bad("market_source_lookup_budget"));
    }
    let ids: Vec<Uuid> = items
        .iter()
        .map(|v| {
            serde_json::from_value(v["id"].clone())
                .map_err(|_| Error::bad("invalid_window_identity"))
        })
        .collect::<Result<_>>()?;
    let rows:Vec<(Uuid,String)>=sqlx::query_as("SELECT DISTINCT ON(l.feature_id) l.feature_id,g.body->>'source' FROM public_market.generation_features l JOIN public_market.generations g ON g.id=l.generation_id WHERE l.feature_id=ANY($1) AND g.status='ready' ORDER BY l.feature_id,g.published_at DESC,g.id DESC").bind(ids).fetch_all(&mut **tx).await?;
    let sources: std::collections::HashMap<_, _> = rows.into_iter().collect();
    for item in items {
        let id: Uuid = serde_json::from_value(item["id"].clone())
            .map_err(|_| Error::bad("invalid_window_identity"))?;
        let source = sources
            .get(&id)
            .filter(|v| matches!(v.as_str(), "rest" | "monthly_archive"))
            .ok_or_else(|| Error::bad("indexed_window_source_unproven"))?;
        item["market_source"] = json!(source);
        if let Some(chart) = item.get_mut("chart_request") {
            chart["source"] = json!(source);
        }
    }
    Ok(())
}

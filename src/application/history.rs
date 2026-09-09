//! Historical index stores vectors + time coordinates only. Raw bars and rendered pixels stay in RAM.
use super::{
    Services,
    dto::Region,
    jobs::{self, Job},
};
use crate::{
    adapters::{
        binance::Binance,
        db::{Database, digest},
    },
    domain::{chart, criteria::Bar},
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use pgvector::Vector;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryIndexRequest {
    pub symbol: String,
    #[serde(default = "market")]
    pub market: String,
    pub interval: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    #[serde(default = "window")]
    pub window_bars: usize,
    #[serde(default = "stride")]
    pub stride_bars: usize,
    #[serde(default = "models")]
    pub models: Vec<String>,
}
fn market() -> String {
    "usd_m".into()
}
fn window() -> usize {
    64
}
fn stride() -> usize {
    16
}
fn models() -> Vec<String> {
    vec!["candle-profile-v1".into()]
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistorySearch {
    pub attachment_id: Uuid,
    pub region: Option<Region>,
    #[serde(default = "model")]
    pub model_id: String,
    pub symbol: Option<String>,
    pub market: Option<String>,
    pub interval: Option<String>,
    pub cutoff_at: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}
fn model() -> String {
    "candle-profile-v1".into()
}
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
            .any(|m| !matches!(m.as_str(), "candle-profile-v1" | "dinov2-small-v1"))
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
    sqlx::query(
        "INSERT INTO history_indexes(id,owner_id,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(owner)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    let v = json!({"job_id":id,"index_id":id,"status":"queued","raw_market_storage":"none"});
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
    let payload = Binance::new()?
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
    let step = interval_seconds(&input.interval)?;
    let mut rows = vec![];
    let mut skipped = 0;
    for slice in bars.windows(input.window_bars).step_by(input.stride_bars) {
        if slice.windows(2).any(|w| w[0].end != w[1].start)
            || slice
                .iter()
                .any(|b| (b.end - b.start).num_seconds() != step)
        {
            skipped += 1;
            continue;
        }
        let raster = chart::raster(slice).map_err(Error::bad)?;
        let mut png = std::io::Cursor::new(Vec::new());
        raster
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|_| Error::bad("chart_render_failed"))?;
        for model in &input.models {
            let feature = s.vision.extract(png.get_ref().clone(), None, model).await?;
            rows.push((
                slice[0].start,
                slice.last().unwrap().end,
                model.clone(),
                Vector::from(feature.vector),
                digest(&slice),
            ));
        }
    }
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(j.owner.to_string())
        .execute(&mut *tx)
        .await?;
    let active: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND lease_until>now() FOR UPDATE",
    )
    .bind(j.id)
    .bind(j.lease)
    .fetch_optional(&mut *tx)
    .await?;
    if active.is_none() {
        return Err(Error::conflict("lease_lost"));
    }
    for (start, end, model, vector, hash) in &rows {
        sqlx::query("INSERT INTO history_windows(id,owner_id,index_id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'candles-raster-v1') ON CONFLICT DO NOTHING").bind(Uuid::new_v4()).bind(j.owner).bind(j.id).bind(&input.market).bind(&input.symbol).bind(&input.interval).bind(start).bind(end).bind(input.window_bars as i32).bind(model).bind(vector).bind(hash).execute(&mut *tx).await?;
    }
    let coverage = json!({"index_id":j.id,"symbol":input.symbol,"market":input.market,"interval":input.interval,"requested_start":input.start_at,"requested_end":input.end_at,"actual_start":bars.first().map(|b|b.start),"actual_end":bars.last().map(|b|b.end),"source_bars_fetched":bars.len(),"source_range_complete":complete,"feature_rows":rows.len(),"windows_skipped_for_gaps":skipped,"window_bars":input.window_bars,"stride_bars":input.stride_bars,"models":input.models,"raw_market_storage":"none","system_chart_storage":"none"});
    sqlx::query("UPDATE history_indexes SET status='ready',completed_at=now(),coverage=$3 WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(&coverage).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(coverage)
}
pub async fn search(s: &Services, owner: Uuid, key: &str, input: HistorySearch) -> Result<Value> {
    let body = json!(input);
    let (vector, quality, _) = super::similarity::embed(
        s,
        owner,
        input.attachment_id,
        input.region.clone(),
        &input.model_id,
    )
    .await?;
    let (mut tx, cached) = s.db.write(owner, "history.search", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let cutoff = input.cutoff_at.unwrap_or_else(Utc::now);
    let limit = input.limit.unwrap_or(10).clamp(1, 50) as usize;
    let rows=sqlx::query("WITH eligible AS MATERIALIZED (SELECT w.* FROM history_windows w JOIN history_indexes i ON i.owner_id=w.owner_id AND i.id=w.index_id WHERE w.owner_id=$1 AND i.status='ready' AND model_id=$2 AND end_at<=$3 AND ($4::text IS NULL OR symbol=$4) AND ($5::text IS NULL OR market=$5) AND ($6::text IS NULL OR timeframe=$6)) SELECT id,index_id,market,symbol,timeframe,start_at,end_at,bars_count,input_hash,embedding <=> $7 AS distance FROM eligible ORDER BY distance,id LIMIT 1000").bind(owner).bind(&input.model_id).bind(cutoff).bind(&input.symbol).bind(&input.market).bind(&input.interval).bind(vector).fetch_all(&mut *tx).await?;
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
        selected.push(json!({"id":id,"index_id":r.get::<Uuid,_>("index_id"),"source":"binance_history","source_uri":format!("scorebook://history/windows/{id}"),"symbol":symbol,"market":market,"interval":tf,"start_at":start,"end_at":end,"bars_count":r.get::<i32,_>("bars_count"),"cosine_distance":r.get::<f64,_>("distance"),"source_hash_at_index":r.get::<String,_>("input_hash"),"chart_request":{"symbol":symbol,"market":market,"interval":tf,"start_at":start,"end_at":end},"chart_storage":"refetch_and_redraw"}));
        if selected.len() >= limit {
            break;
        }
    }
    let coverage:Vec<Value>=sqlx::query_scalar("SELECT coverage FROM history_indexes WHERE owner_id=$1 AND status='ready' AND ($2::text IS NULL OR body->>'symbol'=$2) AND ($3::text IS NULL OR body->>'market'=$3) AND ($4::text IS NULL OR body->>'interval'=$4) ORDER BY completed_at DESC LIMIT 100").bind(owner).bind(&input.symbol).bind(&input.market).bind(&input.interval).fetch_all(&mut *tx).await?;
    let id = Uuid::new_v4();
    let result = json!({"session_id":id,"items":selected,"model_id":input.model_id,"cutoff_at":cutoff,"query_quality":quality,"coverage":coverage,"coverage_list_limit":100,"scope":"only_ready_indexes;not_all_binance_history","coverage_url":"/v1/history/indexes","quality_validated":false,"ranking":"exact_filtered_cosine;half_window_spacing","score_meaning":"similarity_not_probability"});
    sqlx::query("INSERT INTO similarity_sessions(id,owner_id,body,results) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
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

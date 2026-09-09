//! Analysis and bounded, cancellable search; the worker dispatches this use case only.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use scorebook_core::{api::chart_search::*, domain::chart_match};
use serde_json::{Value, json};
use uuid::Uuid;
mod analysis;
pub mod reindex;
mod repository;
pub async fn geometry(
    s: &Services,
    owner: Uuid,
    input: &ChartAnalysisInput,
) -> Result<chart_match::Geometry> {
    use tokio::io::AsyncReadExt;
    let hash: String =
        sqlx::query_scalar("SELECT sha256 FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
    let _permit = s.vision.acquire().await?;
    let mut bytes = Vec::new();
    s.images
        .open(owner, input.attachment_id)
        .await?
        .take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 20 * 1024 * 1024 || crate::adapters::db::hash_bytes(&bytes) != hash {
        return Err(Error::bad("attachment_integrity_failure"));
    }
    let input = input.clone();
    tokio::task::spawn_blocking(move || {
        let (im, _) = crate::adapters::storage::Storage::decode(&bytes)?;
        chart_match::detect(&im, input.region, input.red_up).map_err(Into::into)
    })
    .await
    .map_err(|_| Error::bad("chart_analysis_interrupted"))?
}
pub async fn analyze(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ChartAnalysisInput,
) -> Result<Value> {
    let body = json!(input);
    let (tx, cached) = s.db.write(owner, "chart.analyze", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    tx.commit().await?;
    let (geometry, ocr, recognized) = analysis::evidence(s, owner, &input).await?;
    let (mut tx, cached) = s.db.write(owner, "chart.analyze", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let rh = digest(&body);
    let id = Uuid::new_v4();
    let value = json!({"id":id,"attachment_id":input.attachment_id,"geometry":geometry.quality,"recognized":recognized,"ocr":ocr,"ocr_status":"complete","chart_type":"ordinary_candlestick_candidate","quality_validated":false});
    let value:Value=sqlx::query_scalar("INSERT INTO chart_analyses(id,owner_id,attachment_id,region_hash,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,attachment_id,region_hash) DO UPDATE SET region_hash=EXCLUDED.region_hash RETURNING body").bind(id).bind(owner).bind(input.attachment_id).bind(rh).bind(value).fetch_one(&mut *tx).await?;
    Database::finish(&mut tx, owner, "chart.analyze", key, &body, &value).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn create(
    s: &Services,
    owner: Uuid,
    key: &str,
    mut input: ChartSearchInput,
) -> Result<Value> {
    if input.limit.is_some_and(|v| v == 0 || v > 30)
        || input
            .market
            .as_ref()
            .is_some_and(|v| !matches!(v.as_str(), "usd_m" | "coin_m"))
    {
        return Err(Error::bad("invalid_chart_search"));
    }
    if let Some(tf) = &input.interval {
        super::history::interval_seconds(tf)?;
    }
    let original = json!(input);
    let (mut tx, cached) = s.db.write(owner, "chart.search", key, &original).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    input.cutoff_at = Some(input.cutoff_at.unwrap_or_else(Utc::now));
    let body = json!(input);
    let id = jobs::enqueue_tx(&mut tx, owner, "chart.search", key, body.clone()).await?;
    sqlx::query(
        "INSERT INTO chart_search_runs(id,owner_id,attachment_id,body) VALUES($1,$2,$3,$4)",
    )
    .bind(id)
    .bind(owner)
    .bind(input.attachment_id)
    .bind(body)
    .execute(&mut *tx)
    .await?;
    let v =
        json!({"search_run_id":id,"job_id":id,"status":"queued","protocol":chart_match::PROTOCOL});
    Database::finish(&mut tx, owner, "chart.search", key, &original, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT (to_jsonb(r)-'owner_id') || jsonb_build_object('status',j.status,'generation',j.generation,'error_code',j.error_code) FROM chart_search_runs r JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
pub async fn cancel(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: SearchRunControl,
) -> Result<Value> {
    let body = json!({"search_run_id":id,"expected_generation":input.expected_generation});
    let (mut tx, cached) = s.db.write(owner, "chart.cancel", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let result=sqlx::query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_until=NULL,lease_owner=NULL WHERE owner_id=$1 AND id=$2 AND kind='chart.search' AND generation=$3 AND status NOT IN ('cancelled','succeeded')").bind(owner).bind(id).bind(input.expected_generation).execute(&mut *tx).await?;
    if result.rows_affected() != 1 {
        return Err(Error::conflict("search_generation_conflict"));
    }
    let v =
        json!({"search_run_id":id,"status":"cancelled","generation":input.expected_generation+1});
    Database::finish(&mut tx, owner, "chart.cancel", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn run(s: &Services, j: &Job) -> Result<Value> {
    let input: ChartSearchInput =
        serde_json::from_value(j.body.clone()).map_err(|_| Error::bad("invalid_search_job"))?;
    let (query, _, _) = analysis::evidence(
        s,
        j.owner,
        &ChartAnalysisInput {
            attachment_id: input.attachment_id,
            region: input.region.clone(),
            red_up: input.red_up,
        },
    )
    .await?;
    let query_candles = if input.reverse {
        chart_match::normalized(&query.candles, true)?
            .into_iter()
            .map(chart_match::Candle)
            .collect()
    } else {
        query.candles.clone()
    };
    let vector = chart_match::descriptor(&query_candles)?;
    let candidates = if input.scope == ChartScope::BinanceHistory {
        repository::public_candidates(s, &input, vector).await?
    } else {
        let (visual, _, _) = super::similarity::embed_mode(
            s,
            j.owner,
            input.attachment_id,
            input.region.clone(),
            "dinov2-small-v1",
            false,
        )
        .await?;
        repository::private_candidates(s, j.owner, &input, vector, visual).await?
    };
    repository::publish(s,j,&json!({"status":"provisional","items":candidates,"protocol":chart_match::PROTOCOL,"quality_validated":false}),false).await?;
    let mut ranked = Vec::new();
    let mut excluded = Vec::new();
    for mut item in candidates {
        repository::fence(s, j).await?.commit().await?;
        let candidate = if input.scope == ChartScope::Private {
            let attachment_id = serde_json::from_value(item["attachment_id"].clone())
                .map_err(|_| Error::bad("invalid_candidate"))?;
            match geometry(
                s,
                j.owner,
                &ChartAnalysisInput {
                    attachment_id,
                    region: None,
                    red_up: false,
                },
            )
            .await
            {
                Ok(v) => v.candles,
                Err(e) if e.kind == scorebook_core::error::ErrorKind::Invalid => {
                    excluded.push(json!({"attachment_id":attachment_id,"reason":e.code}));
                    continue;
                }
                Err(e) => return Err(e),
            }
        } else {
            let string = |k: &str| {
                item[k]
                    .as_str()
                    .ok_or_else(|| Error::bad("invalid_candidate"))
            };
            let start = string("start_at")?
                .parse()
                .map_err(|_| Error::bad("invalid_candidate"))?;
            let end = string("end_at")?
                .parse()
                .map_err(|_| Error::bad("invalid_candidate"))?;
            let payload = s
                .market
                .klines(
                    string("market")?,
                    string("symbol")?,
                    string("interval")?,
                    start,
                    end,
                )
                .await?;
            let bars: Vec<scorebook_core::domain::criteria::Bar> =
                serde_json::from_value(payload["bars"].clone())
                    .map_err(|_| Error::bad("invalid_provider_bars"))?;
            if payload["coverage_complete"] != true
                || digest(&bars) != item["source_hash_at_index"].as_str().unwrap_or("")
            {
                excluded.push(json!({"id":item["id"],"reason":"source_changed_or_incomplete"}));
                continue;
            }
            item["chart_request"] = json!({"market":item["market"],"symbol":item["symbol"],"interval":item["interval"],"start_at":start,"end_at":end});
            chart_match::from_bars(&bars)?
        };
        let score = chart_match::rerank(&query.candles, &candidate, input.reverse)?;
        item["match"] = json!(score);
        item["stage"] = json!("reranked");
        ranked.push(item);
    }
    ranked.sort_by(|a, b| {
        b["match"]["score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["match"]["score"].as_f64().unwrap_or(0.))
    });
    ranked.truncate(input.limit.unwrap_or(10));
    let result = json!({"search_run_id":j.id,"protocol":chart_match::PROTOCOL,"status":"final","items":ranked,"excluded_candidates":excluded,"scope":input.scope,"cutoff_at":input.cutoff_at,"quality_validated":false,"query_quality":query.quality,"coverage":"published_geometry_v2_only","candidate_budget":3000,"rerank_budget":30,"raw_market_storage":"none"});
    repository::publish(s, j, &result, true).await?;
    Ok(result)
}

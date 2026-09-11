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
/// 只读图上那行字的识别：定位面板拿它当「这张图默认是哪个品种」。
pub use analysis::read as read_labels;
pub mod reindex;
mod repository;
mod rerank;
mod visual_query;
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
/// 周期由策略决定：默认必须挑一个周期；显式选了「不限」就不许再带周期，
/// 免得「用户选了不限」和「前端漏传周期」这两件事混成同一个请求。
fn check_interval(input: &ChartSearchInput) -> Result<()> {
    match input.interval_policy {
        IntervalPolicy::SameInterval => {
            chart_match::require_interval(input.interval.as_deref())?;
        }
        IntervalPolicy::AnyInterval => {
            if input
                .interval
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty())
            {
                return Err(Error::bad("chart_interval_conflict"));
            }
        }
    }
    Ok(())
}

/// 人一轮否掉三条，累加到一百条就是三十几轮：再多不是「继续找」，是这张图根本
/// 不该在这里找。给它一个上限，免得一条 SQL 里绑进无限长的数组。
pub const MAX_EXCLUDE: usize = 100;

fn check_exclude(exclude: &[Uuid]) -> Result<()> {
    if exclude.len() > MAX_EXCLUDE {
        return Err(Error::bad("chart_exclude_too_many"));
    }
    Ok(())
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
    check_exclude(&input.exclude)?;
    check_interval(&input)?;
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
    check_interval(&input)?;
    check_exclude(&input.exclude)?;
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
        let visual = visual_query::encode(s, j.owner, &input, &query.quality.region).await?;
        repository::private_candidates(s, j.owner, &input, vector, visual).await?
    };
    repository::publish(s,j,&json!({"status":"provisional","items":candidates,"protocol":chart_match::PROTOCOL,"quality_validated":false}),false).await?;
    let (ranked, excluded) = rerank::run(s, j, &input, &query.candles, candidates).await?;
    // One window per contract only makes sense while the contract is still in
    // question; a search already restricted to one returns its best windows.
    let grouped = input.scope == ChartScope::BinanceHistory && input.symbol.is_none();
    let interval_policy = match input.interval_policy {
        IntervalPolicy::SameInterval => "same_interval_only",
        IntervalPolicy::AnyInterval => "any_interval",
    };
    let ranked = best_matches(ranked, grouped, input.limit.unwrap_or(3));
    let result = json!({"search_run_id":j.id,"protocol":chart_match::PROTOCOL,"status":"final","items":ranked,"excluded_candidates":excluded,"scope":input.scope,"interval":input.interval,"interval_policy":interval_policy,"rejected_by_hand":input.exclude.len(),"cutoff_at":input.cutoff_at,"quality_validated":false,"query_quality":query.quality,"coverage":"published_geometry_v2_only","candidate_budget":3000,"rerank_budget":30,"grouping":if grouped {"best_verified_window_per_contract"} else if input.scope == ChartScope::BinanceHistory {"best_verified_windows_of_the_named_contract"} else {"exact_image_then_confirmed_episode"},"raw_market_storage":"none"});
    repository::publish(s, j, &result, true).await?;
    Ok(result)
}

fn best_matches(mut ranked: Vec<Value>, grouped: bool, limit: usize) -> Vec<Value> {
    ranked.sort_by(|a, b| {
        b["match"]["score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["match"]["score"].as_f64().unwrap_or(0.))
    });
    if grouped {
        let mut seen = std::collections::HashSet::new();
        ranked.retain(|v| {
            seen.insert((
                v["market"].clone().to_string(),
                v["symbol"].clone().to_string(),
            ))
        });
    }
    ranked.truncate(limit);
    ranked
}

#[cfg(test)]
mod result_tests {
    use super::*;
    #[test]
    fn historical_results_keep_the_best_verified_window_for_each_contract() {
        let make = |s: &str, score| json!({"market":"usd_m","symbol":s,"match":{"score":score}});
        let input = vec![
            make("BTCUSDT", 0.7),
            make("ETHUSDT", 0.8),
            make("BTCUSDT", 0.9),
            make("SOLUSDT", 0.6),
        ];
        let result = best_matches(input.clone(), true, 3);
        assert_eq!(
            result
                .iter()
                .map(|v| v["symbol"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        );
        assert_eq!(result[0]["match"]["score"], 0.9);
        assert_eq!(best_matches(input, false, 3)[2]["symbol"], "BTCUSDT");
    }
}

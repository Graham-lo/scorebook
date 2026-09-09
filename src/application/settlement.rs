//! Provider evidence assembly is separate from the pure evaluator.
use super::{Services, jobs::Job};
use crate::{
    adapters::{binance::Binance, db::digest},
    domain::criteria::{self, Bar, Criteria, EvaluationInput, Template, Trade},
    error::{Error, Result},
};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub async fn settle(s: &Services, j: &Job) -> Result<Value> {
    let id: Uuid =
        serde_json::from_value(j.body["call_id"].clone()).map_err(|_| Error::bad("invalid_job"))?;
    let n = j.body["claim_no"]
        .as_u64()
        .ok_or_else(|| Error::bad("invalid_job"))? as usize;
    let row = sqlx::query("SELECT submitted_at,body FROM calls WHERE owner_id=$1 AND id=$2")
        .bind(j.owner)
        .bind(id)
        .fetch_optional(&s.db.pool)
        .await?
        .ok_or_else(Error::not_found)?;
    let submitted: DateTime<Utc> = row.get("submitted_at");
    let body: Value = row.get("body");
    let c: Criteria = if body["criteria"].as_array().is_none_or(|x| x.is_empty()) {
        Criteria::default()
    } else {
        serde_json::from_value(body["criteria"][n].clone())
            .map_err(|_| Error::bad("invalid_claim"))?
    };
    let mut input = EvaluationInput {
        criteria: c.clone(),
        start: submitted,
        evaluated_at: Utc::now(),
        base: None,
        atr0: None,
        bars: vec![],
        trades: vec![],
        coverage_complete: false,
        endpoint_proven: false,
        end_price: None,
    };
    let mut evidence = json!({"assembly_version":"binance-boundary-v1","price_policy":"asof_last_eligible_trade","calendar":"crypto-natural-hours-v1","instrument":body["instrument"],"market":body["market"],"source_identity":"historical_reconstruction","provider_error":null});
    if criteria::validate(&c).is_ok()
        && c.template != Template::T0
        && let (Some(market), Some(symbol)) = (body["market"].as_str(), body["instrument"].as_str())
        && matches!(market, "spot" | "usd_m" | "coin_m")
    {
        match assemble(market, symbol, &mut input).await {
            Ok(v) => evidence["market"] = v,
            Err(e) => {
                evidence["provider_error"] = json!(e.code);
                input.base = None;
                input.bars.clear();
                input.trades.clear();
                input.coverage_complete = false;
                input.endpoint_proven = false;
            }
        }
    }
    let computed_result = criteria::evaluate(&input);
    let manifest = json!({"criteria":input.criteria,"start":input.start,"evaluated_at":input.evaluated_at,"market_input_sha256":digest(&input),"provider_evidence_sha256":digest(&evidence),"market_input_storage":"not_persisted","replay_verification":"requires_provider_refetch"});
    let mid = j.id;
    let oid = j.id;
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
    // Stable IDs fence crash retries. Original results can never be replaced by rule exploration.
    sqlx::query("INSERT INTO manifests(id,owner_id,call_id,digest,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING").bind(mid).bind(j.owner).bind(id).bind(digest(&manifest)).bind(&manifest).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO outcomes(id,owner_id,call_id,claim_no,manifest_id,kind,result,digest) VALUES($1,$2,$3,$4,$5,'original',$6,$7) ON CONFLICT DO NOTHING").bind(oid).bind(j.owner).bind(id).bind(n as i32).bind(mid).bind(json!(computed_result)).bind(digest(&json!({"manifest":manifest,"result":computed_result}))).execute(&mut *tx).await?;
    let frozen_result: criteria::Evaluation = serde_json::from_value(
        sqlx::query_scalar::<_, Value>("SELECT result FROM outcomes WHERE owner_id=$1 AND id=$2")
            .bind(j.owner)
            .bind(oid)
            .fetch_one(&mut *tx)
            .await?,
    )
    .map_err(|_| Error::bad("invalid_stored_outcome"))?;
    crate::adapters::db::event(
        &mut tx,
        j.owner,
        Some(id),
        "evaluation.completed",
        json!({"outcome_id":oid,"state":frozen_result.state}),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"outcome_id":oid,"state":frozen_result.state,"reason":frozen_result.reason}))
}
async fn assemble(market: &str, symbol: &str, i: &mut EvaluationInput) -> Result<Value> {
    let provider = Binance::new()?;
    let c = &i.criteria;
    let end = i.start + Duration::hours(c.horizon_hours.unwrap_or(72).into());
    if c.template == Template::T3 {
        return Err(Error::bad("conditional_provider_monitor_not_implemented"));
    }
    if end > Utc::now() {
        return Err(Error::bad("not_due"));
    }
    let base_data = provider
        .trades(market, symbol, i.start - Duration::minutes(1), i.start)
        .await?;
    let end_data = provider
        .trades(market, symbol, end - Duration::minutes(1), end)
        .await?;
    let end_ms = |v: &Value| {
        v["raw"]
            .as_array()
            .and_then(|a| a.last())
            .and_then(|x| x["p"].as_str())
            .map(str::to_string)
    };
    i.base = end_ms(&base_data);
    i.end_price = end_ms(&end_data);
    i.endpoint_proven = base_data["coverage_complete"] == true
        && end_data["coverage_complete"] == true
        && i.base.is_some()
        && i.end_price.is_some();
    let minute_after =
        DateTime::from_timestamp((i.start.timestamp().div_euclid(60) + 1) * 60, 0).unwrap();
    let minute_before = DateTime::from_timestamp(end.timestamp().div_euclid(60) * 60, 0).unwrap();
    let interior = provider
        .klines(market, symbol, "1m", minute_after, minute_before)
        .await?;
    i.bars = serde_json::from_value(interior["bars"].clone())
        .map_err(|_| Error::bad("invalid_provider_bars"))?;
    let start_partial = provider
        .trades(market, symbol, i.start, minute_after)
        .await?;
    let end_partial = if minute_before == end {
        json!({"coverage_complete":true,"raw":[],"empty_interval":true})
    } else {
        provider.trades(market, symbol, minute_before, end).await?
    };
    for v in [&start_partial, &end_partial] {
        for tr in v["raw"]
            .as_array()
            .ok_or_else(|| Error::bad("invalid_trades"))?
        {
            let at = DateTime::from_timestamp_millis(
                tr["T"]
                    .as_i64()
                    .ok_or_else(|| Error::bad("invalid_trade_time"))?,
            )
            .ok_or_else(|| Error::bad("invalid_trade_time"))?;
            i.trades.push(Trade {
                at,
                price: tr["p"]
                    .as_str()
                    .ok_or_else(|| Error::bad("invalid_trade_price"))?
                    .into(),
            });
        }
    }
    i.coverage_complete = interior["coverage_complete"] == true
        && start_partial["coverage_complete"] == true
        && end_partial["coverage_complete"] == true;
    let day = DateTime::from_timestamp(i.start.timestamp().div_euclid(86400) * 86400, 0).unwrap();
    let daily = provider
        .klines(market, symbol, "1d", day - Duration::days(121), day)
        .await?;
    let bars: Vec<Bar> = serde_json::from_value(daily["bars"].clone())
        .map_err(|_| Error::bad("invalid_atr_bars"))?;
    i.atr0 = if daily["coverage_complete"] == true {
        criteria::atr14(&bars, i.start).ok()
    } else {
        None
    };
    Ok(
        json!({"base":base_data,"end":end_data,"interior":interior,"start_boundary":start_partial,"end_boundary":end_partial,"atr_daily":daily}),
    )
}

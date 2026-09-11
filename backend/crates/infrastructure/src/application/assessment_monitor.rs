//! One resumable assessment. Inputs expire in memory; the sole checkpoint is a
//! constant-size business reduction, atomically fenced with the trigger event.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::digest,
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Duration, Utc};
use scorebook_core::domain::{
    criteria::{self, Bar, Criteria, Evaluation, OutcomeState, Template, Trade},
    watch::Watch,
};
use serde_json::{Value, json};
use uuid::Uuid;
fn second(t: DateTime<Utc>, period: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(t.timestamp().div_euclid(period) * period, 0).unwrap()
}
fn bars(v: &Value) -> Result<Vec<Bar>> {
    serde_json::from_value(v["bars"].clone()).map_err(|_| Error::bad("invalid_provider_bars"))
}
fn complete(v: &Value) -> Result<()> {
    if v["coverage_complete"] != true {
        return Err(Error::deferred(
            "monitor_coverage_gap",
            RetryDirective::At(Utc::now() + Duration::seconds(30)),
        ));
    }
    Ok(())
}
fn rows(v: &Value) -> Result<Vec<(i64, Trade)>> {
    v["raw"]
        .as_array()
        .ok_or_else(|| Error::bad("invalid_provider_trades"))?
        .iter()
        .map(|t| {
            Ok((
                t["a"]
                    .as_i64()
                    .ok_or_else(|| Error::bad("invalid_trade_id"))?,
                Trade {
                    at: DateTime::from_timestamp_millis(
                        t["T"]
                            .as_i64()
                            .ok_or_else(|| Error::bad("invalid_trade_time"))?,
                    )
                    .ok_or_else(|| Error::bad("invalid_trade_time"))?,
                    price: t["p"]
                        .as_str()
                        .ok_or_else(|| Error::bad("invalid_trade_price"))?
                        .into(),
                },
            ))
        })
        .collect()
}
fn asof(v: &Value) -> Option<String> {
    v["raw"].as_array()?.last()?["p"]
        .as_str()
        .map(str::to_string)
}
fn identity(mut v: Value) -> Value {
    if let Some(m) = v.as_object_mut() {
        m.remove("received_at");
    }
    v
}
fn checkpoint_hash(w: &mut Watch, v: Value) {
    w.source_sha256 = digest(&json!([w.source_sha256, identity(v)]));
}
fn retention(market: &str, at: DateTime<Utc>) -> Result<()> {
    if market == "usd_m" && at < Utc::now() - Duration::hours(48) {
        return Err(Error::deferred(
            "rest_trade_retention_exceeded_declare_archive_recovery",
            RetryDirective::AwaitInput,
        ));
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
pub async fn advance(
    s: &Services,
    j: &Job,
    call_id: Uuid,
    claim_no: usize,
    body: &Value,
    c: Criteria,
    submitted: DateTime<Utc>,
) -> Result<(Evaluation, String, String, DateTime<Utc>)> {
    let market = body["market"]
        .as_str()
        .filter(|m| matches!(*m, "usd_m" | "coin_m"))
        .ok_or_else(|| Error::deferred("contract_market_required", RetryDirective::AwaitInput))?;
    let symbol = body["instrument"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| Error::deferred("instrument_required", RetryDirective::AwaitInput))?;
    let cached:Option<(Value,Value)>=sqlx::query_as("SELECT result,checkpoint FROM trigger_watches WHERE owner_id=$1 AND id=$2 AND result IS NOT NULL").bind(j.owner).bind(j.id).fetch_optional(&s.db.pool).await?;
    if let Some((r, v)) = cached {
        let w: Watch =
            serde_json::from_value(v).map_err(|_| Error::bad("invalid_monitor_checkpoint"))?;
        let result: Evaluation =
            serde_json::from_value(r).map_err(|_| Error::bad("invalid_monitor_result"))?;
        return Ok((result, digest(&w), w.source_sha256.clone(), w.deadline()));
    }
    let stored: Option<(Value, i64, String)> = sqlx::query_as(
        "SELECT checkpoint,revision,source_plan FROM trigger_watches WHERE owner_id=$1 AND id=$2",
    )
    .bind(j.owner)
    .bind(j.id)
    .fetch_optional(&s.db.pool)
    .await?;
    let source: String = sqlx::query_scalar(
        "SELECT source_plan FROM assessment_source_plans WHERE owner_id=$1 AND job_id=$2",
    )
    .bind(j.owner)
    .bind(j.id)
    .fetch_optional(&s.db.pool)
    .await?
    .unwrap_or_else(|| "rest_continuous_v1".into());
    let (mut w, revision) = if let Some((v, r, source)) = stored {
        if source != "rest_continuous_v1" && source != "daily_archive_v1" {
            return Err(Error::bad("invalid_assessment_source_plan"));
        }
        (
            serde_json::from_value::<Watch>(v)
                .map_err(|_| Error::bad("invalid_monitor_checkpoint"))?,
            r,
        )
    } else {
        let (price, base) = if source == "daily_archive_v1" {
            archive::reference(s, market, symbol, submitted).await?
        } else {
            retention(market, submitted - Duration::minutes(1))?;
            let base = s
                .market
                .trades(market, symbol, submitted - Duration::minutes(1), submitted)
                .await?;
            complete(&base)?;
            let price = asof(&base).ok_or_else(|| {
                Error::deferred(
                    "submission_reference_price_unproven",
                    RetryDirective::AwaitInput,
                )
            })?;
            (price, base)
        };
        let needs_atr = matches!(c.template, Template::T1 | Template::T2 | Template::T3)
            && c.threshold_ratio.is_none()
            || c.template == Template::T5;
        let mut daily = json!({"atr_required":false});
        let atr = if needs_atr {
            let day = second(submitted, 86400);
            daily = s
                .market
                .klines(market, symbol, "1d", day - Duration::days(121), day)
                .await?;
            complete(&daily)?;
            Some(criteria::atr14(&bars(&daily)?, submitted).map_err(|_| {
                Error::deferred("submission_atr_unproven", RetryDirective::AwaitInput)
            })?)
        } else {
            None
        };
        let mut w = Watch::new(c, submitted, price, atr).map_err(Error::bad)?;
        checkpoint_hash(&mut w, json!([identity(base), identity(daily)]));
        save(
            s, j, call_id, claim_no, market, symbol, &source, &w, None, None,
        )
        .await?;
        (w, 0)
    };
    let target = (Utc::now() - Duration::seconds(3)).min(w.deadline());
    if target <= w.through {
        return Err(Error::deferred(
            "monitor_waiting_for_closed_evidence",
            RetryDirective::At(
                (w.through + Duration::seconds(15)).max(Utc::now() + Duration::seconds(3)),
            ),
        ));
    }
    let mut endpoint = None;
    if w.start.is_none() && w.criteria.trigger.as_ref().unwrap().kind == "bar_close" {
        let period = i64::from(
            w.criteria
                .trigger
                .as_ref()
                .unwrap()
                .interval_seconds
                .unwrap_or(60),
        );
        // `trigger.interval_seconds` 只有秒数，所以这条路径只支持固定长度周期：
        // 3m/30m/2h/6h/8h/12h/3d/1w 现在都能触发，月线（1M）没有固定秒数，永远查不
        // 到，按原错误码 `trigger_interval_not_supported` 拒绝。周期表仍只有
        // domain::interval 一份。
        let interval = scorebook_core::domain::interval::Interval::from_fixed_seconds(period)
            .ok_or_else(|| {
                Error::deferred("trigger_interval_not_supported", RetryDirective::AwaitInput)
            })?
            .as_str();
        let start = second(w.through, period);
        let end = second(target, period).min(start + Duration::seconds(period * 500));
        if end > start {
            let data = s
                .market
                .klines(market, symbol, interval, start, end)
                .await?;
            complete(&data)?;
            w.bars(start, end, &bars(&data)?).map_err(Error::bad)?;
            checkpoint_hash(&mut w, data);
        }
        if w.start.is_none()
            && target == w.deadline()
            && second(w.through, period) == second(target, period)
        {
            w.through = target;
        }
    } else if source == "daily_archive_v1" {
        (w, endpoint) = archive::advance(s, market, symbol, w, target).await?;
    } else if w.start.is_none()
        || w.through != second(w.through, 60)
        || second(target, 60) <= w.through
    {
        let end = if w.start.is_none() {
            target.min(w.through + Duration::minutes(5))
        } else {
            target.min(second(w.through, 60) + Duration::minutes(1))
        };
        retention(market, w.through)?;
        let data = s.market.trades(market, symbol, w.through, end).await?;
        complete(&data)?;
        w.trades(w.through, end, &rows(&data)?)
            .map_err(Error::bad)?;
        checkpoint_hash(&mut w, data);
    } else {
        let end = second(target, 60).min(w.through + Duration::hours(8));
        let data = s
            .market
            .klines(market, symbol, "1m", w.through, end)
            .await?;
        complete(&data)?;
        w.bars(w.through, end, &bars(&data)?).map_err(Error::bad)?;
        checkpoint_hash(&mut w, data);
    }
    if w.start.is_some() && w.through >= w.deadline() {
        if source == "daily_archive_v1" {
            if endpoint.is_none() {
                let (price, proof) = archive::reference(s, market, symbol, w.deadline()).await?;
                endpoint = Some(price);
                checkpoint_hash(&mut w, proof);
            }
        } else {
            retention(market, w.deadline() - Duration::minutes(1))?;
            let data = s
                .market
                .trades(
                    market,
                    symbol,
                    w.deadline() - Duration::minutes(1),
                    w.deadline(),
                )
                .await?;
            complete(&data)?;
            endpoint = asof(&data);
            checkpoint_hash(&mut w, data);
        }
        if endpoint.is_none() {
            return Err(Error::deferred(
                "end_reference_price_unproven",
                RetryDirective::AwaitInput,
            ));
        }
    }
    let result = w
        .result(endpoint.clone(), endpoint.is_some())
        .map_err(|code| Error::deferred(&code, RetryDirective::AwaitInput))?;
    let terminal = !matches!(
        result.state,
        OutcomeState::Pending | OutcomeState::InsufficientData
    );
    save(
        s,
        j,
        call_id,
        claim_no,
        market,
        symbol,
        &source,
        &w,
        Some(revision),
        if terminal { Some(&result) } else { None },
    )
    .await?;
    if !terminal {
        let at = if w.through < target {
            Utc::now() + Duration::seconds(1)
        } else {
            (second(w.through, 60) + Duration::seconds(63))
                .min(w.deadline() + Duration::seconds(3))
                .max(Utc::now() + Duration::seconds(3))
        };
        return Err(Error::deferred(
            if w.start.is_none() {
                "waiting_for_trigger"
            } else {
                "observing"
            },
            RetryDirective::At(at),
        ));
    }
    Ok((result, digest(&w), w.source_sha256.clone(), w.deadline()))
}
#[allow(clippy::too_many_arguments)]
async fn save(
    s: &Services,
    j: &Job,
    call_id: Uuid,
    claim_no: usize,
    market: &str,
    symbol: &str,
    source: &str,
    w: &Watch,
    expected: Option<i64>,
    result: Option<&Evaluation>,
) -> Result<()> {
    let mut tx = jobs::fence(s, j).await?;
    if let Some(r) = expected {
        let n=sqlx::query("UPDATE trigger_watches SET checkpoint=$3,revision=revision+1,status=$5,result=$6,updated_at=now() WHERE owner_id=$1 AND id=$2 AND revision=$4").bind(j.owner).bind(j.id).bind(json!(w)).bind(r).bind(if result.is_some(){"completed"}else{"observing"}).bind(result.map(|r|json!(r))).execute(&mut *tx).await?.rows_affected();
        if n != 1 {
            return Err(Error::conflict("monitor_checkpoint_conflict"));
        }
    } else {
        sqlx::query("INSERT INTO trigger_watches(id,owner_id,call_id,claim_no,market,symbol,source_plan,checkpoint) VALUES($1,$2,$3,$4,$5,$6,$8,$7)").bind(j.id).bind(j.owner).bind(call_id).bind(claim_no as i32).bind(market).bind(symbol).bind(json!(w)).bind(source).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO trigger_checkpoints(owner_id,watch_id,through_at,source_sha256,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,watch_id) DO UPDATE SET through_at=EXCLUDED.through_at,source_sha256=EXCLUDED.source_sha256,revision=EXCLUDED.revision").bind(j.owner).bind(j.id).bind(w.through).bind(&w.source_sha256).bind(expected.map(|v|v+1).unwrap_or(0)).execute(&mut *tx).await?;
    if let (Some(at), Some(price)) = (w.trigger_at, &w.trigger_price) {
        sqlx::query("INSERT INTO trigger_events(owner_id,watch_id,at,price,body) VALUES($1,$2,$3,$4::text::numeric,$5) ON CONFLICT DO NOTHING").bind(j.owner).bind(j.id).bind(at).bind(price).bind(json!({"trigger":w.criteria.trigger,"actual_price":price,"atr_at_submission":w.atr_at_submission,"due_at":w.deadline(),"source_sha256":w.source_sha256})).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

mod archive;
pub mod control;

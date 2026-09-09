//! Evidence is ephemeral. Only a successful, fenced computation can publish an outcome.
use super::{Services, jobs::Job};
use crate::{
    adapters::db::{Database, digest},
    domain::criteria::{self, Bar, Criteria, EvaluationInput, Template, Trade},
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Duration, Utc};
pub use scorebook_core::api::settlement::*;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub async fn request_revision(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: RevisionRequest,
) -> Result<Value> {
    if input.claim_no < 0 || input.reason.trim().is_empty() || input.reason.len() > 2000 {
        return Err(Error::bad("revision_reason_required"));
    }
    let body = json!({"call_id":id,"claim_no":input.claim_no,"expected_outcome_id":input.expected_outcome_id,"reason":input.reason});
    let (mut tx, cached) = s.db.write(owner, "outcomes.revise", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let head:Option<Uuid>=sqlx::query_scalar("SELECT outcome_id FROM outcome_heads WHERE owner_id=$1 AND call_id=$2 AND claim_no=$3 FOR UPDATE").bind(owner).bind(id).bind(input.claim_no).fetch_optional(&mut *tx).await?;
    if head != Some(input.expected_outcome_id) {
        return Err(Error::conflict("outcome_head_conflict"));
    }
    let jid = super::jobs::enqueue_tx(
        &mut tx,
        owner,
        "assess_revision",
        &input.expected_outcome_id.to_string(),
        body.clone(),
    )
    .await?;
    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id=$1")
        .bind(jid)
        .fetch_one(&mut *tx)
        .await?;
    let v = json!({"job_id":jid,"status":status,"supersedes":input.expected_outcome_id});
    Database::finish(&mut tx, owner, "outcomes.revise", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
// Provider receipt times describe an attempt, not the historical evidence's identity.
fn stable_evidence(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            map.remove("received_at");
            for child in map.values_mut() {
                *child = stable_evidence(child.take());
            }
        }
        Value::Array(values) => {
            for child in values {
                *child = stable_evidence(child.take());
            }
        }
        _ => {}
    }
    value
}
pub async fn settle(s: &Services, j: &Job) -> Result<Value> {
    let id: Uuid =
        serde_json::from_value(j.body["call_id"].clone()).map_err(|_| Error::bad("invalid_job"))?;
    let n = j.body["claim_no"]
        .as_u64()
        .filter(|n| *n < 20)
        .ok_or_else(|| Error::bad("invalid_job"))? as usize;
    // A committed result from this job is the only crash-recovery success path.
    if let Some(v)=sqlx::query_scalar::<_,Value>("SELECT jsonb_build_object('outcome_id',id,'state',result->'state','reason',result->'reason') FROM outcomes WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).fetch_optional(&s.db.pool).await? {return Ok(v)}
    let row = sqlx::query("SELECT submitted_at,body FROM calls WHERE owner_id=$1 AND id=$2")
        .bind(j.owner)
        .bind(id)
        .fetch_optional(&s.db.pool)
        .await?
        .ok_or_else(Error::not_found)?;
    let submitted: DateTime<Utc> = row.get("submitted_at");
    let body: Value = row.get("body");
    let c: Criteria = if body["criteria"].as_array().is_none_or(|x| x.is_empty()) && n == 0 {
        Criteria::default()
    } else {
        serde_json::from_value(body["criteria"][n].clone())
            .map_err(|_| Error::bad("invalid_claim"))?
    };
    if criteria::validate(&c).is_err() {
        return Err(Error::deferred(
            "criteria_need_confirmation",
            RetryDirective::AwaitInput,
        ));
    }
    if c.template == Template::T3 {
        return Err(Error::deferred(
            "conditional_provider_monitor_not_implemented",
            RetryDirective::AwaitCapability,
        ));
    }
    let due = if c.template == Template::T0 {
        submitted
    } else {
        submitted + Duration::hours(c.horizon_hours.unwrap_or(72).into())
    };
    if due > Utc::now() {
        return Err(Error::deferred("not_due", RetryDirective::At(due)));
    }
    let mut input = EvaluationInput {
        criteria: c.clone(),
        start: submitted,
        evaluated_at: due,
        base: None,
        atr0: None,
        bars: vec![],
        trades: vec![],
        coverage_complete: false,
        endpoint_proven: false,
        end_price: None,
    };
    let evidence = if c.template != Template::T0 {
        let market = body["market"]
            .as_str()
            .filter(|m| matches!(*m, "usd_m" | "coin_m"))
            .ok_or_else(|| {
                Error::deferred("contract_market_required", RetryDirective::AwaitInput)
            })?;
        let symbol = body["instrument"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| Error::deferred("instrument_required", RetryDirective::AwaitInput))?;
        assemble(s, market, symbol, &mut input).await?
    } else {
        json!({"criteria_only":true})
    };
    let result = criteria::evaluate(&input);
    if result.state == criteria::OutcomeState::InsufficientData {
        return Err(Error::deferred(
            "market_evidence_incomplete",
            RetryDirective::Backoff,
        ));
    }
    let supersedes: Option<Uuid> = if j.kind == "assess_revision" {
        Some(
            serde_json::from_value(j.body["expected_outcome_id"].clone())
                .map_err(|_| Error::bad("revision_head_required"))?,
        )
    } else {
        None
    };
    let manifest = json!({"assembly_version":"binance-boundary-v2","criteria":c,"start":submitted,"end":due,"evaluated_at":Utc::now(),"instrument":body["instrument"],"market":body["market"],"price_policy":"asof_last_eligible_trade","market_input_sha256":digest(&input),"provider_evidence_sha256":digest(&stable_evidence(evidence)),"market_input_storage":"not_persisted","replay_verification":"requires_provider_refetch","supersedes":supersedes,"revision_reason":j.body["reason"]});
    let business_digest = digest(
        &json!({"input":manifest["market_input_sha256"],"provider":manifest["provider_evidence_sha256"],"result":result,"supersedes":supersedes}),
    );
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(j.owner.to_string())
        .execute(&mut *tx)
        .await?;
    let active:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND owner_id=$2 AND lease_owner=$3 AND generation=$4 AND status='running' AND lease_until>now() FOR UPDATE").bind(j.id).bind(j.owner).bind(j.lease).bind(j.generation).fetch_optional(&mut *tx).await?;
    if active.is_none() {
        return Err(Error::conflict("lease_lost"));
    }
    // Serialize original publication and revisions for the same immutable claim.
    sqlx::query("SELECT id FROM calls WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(j.owner)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::not_found)?;
    let head:Option<Uuid>=sqlx::query_scalar("SELECT outcome_id FROM outcome_heads WHERE owner_id=$1 AND call_id=$2 AND claim_no=$3 FOR UPDATE").bind(j.owner).bind(id).bind(n as i32).fetch_optional(&mut *tx).await?;
    if head != supersedes {
        return Err(Error::conflict("outcome_head_conflict"));
    }
    sqlx::query("INSERT INTO manifests(id,owner_id,call_id,digest,body) VALUES($1,$2,$3,$4,$5)")
        .bind(j.id)
        .bind(j.owner)
        .bind(id)
        .bind(digest(&manifest))
        .bind(&manifest)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO outcomes(id,owner_id,call_id,claim_no,manifest_id,kind,result,digest,supersedes) VALUES($1,$2,$3,$4,$1,$5,$6,$7,$8)").bind(j.id).bind(j.owner).bind(id).bind(n as i32).bind(if supersedes.is_some(){"data_revision"}else{"original"}).bind(json!(result)).bind(business_digest).bind(supersedes).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO outcome_heads(owner_id,call_id,claim_no,outcome_id) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,call_id,claim_no) DO UPDATE SET outcome_id=EXCLUDED.outcome_id,revision=outcome_heads.revision+1").bind(j.owner).bind(id).bind(n as i32).bind(j.id).execute(&mut *tx).await?;
    super::review_projection::refresh(&mut tx, j.owner, id).await?;
    crate::adapters::db::event(
        &mut tx,
        j.owner,
        Some(id),
        "evaluation.completed",
        json!({"outcome_id":j.id,"state":result.state,"supersedes":supersedes}),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"outcome_id":j.id,"state":result.state,"reason":result.reason}))
}
async fn assemble(
    s: &Services,
    market: &str,
    symbol: &str,
    i: &mut EvaluationInput,
) -> Result<Value> {
    let provider = &s.market;
    let c = &i.criteria;
    let end = i.start + Duration::hours(c.horizon_hours.unwrap_or(72).into());
    if c.template == Template::T3 {
        return Err(Error::deferred(
            "conditional_provider_monitor_not_implemented",
            RetryDirective::AwaitCapability,
        ));
    }
    if end > Utc::now() {
        return Err(Error::deferred("not_due", RetryDirective::At(end)));
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

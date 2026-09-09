//! A durable, bounded planner. At most one child range is pending for each plan.
use super::{
    Services, history,
    jobs::{self, Job},
};
use crate::{
    adapters::db::Database,
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Duration, Utc};
pub use scorebook_core::api::history_plans::*;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

fn validate(input: &HistoryPlanRequest) -> Result<()> {
    if input.symbols.is_empty()
        || input.symbols.len() > 200
        || input.intervals.is_empty()
        || input.intervals.len() > 6
        || input.start_at >= input.end_at
        || input.start_at.timestamp() < 0
        || input.end_at > Utc::now()
        || !(32..=256).contains(&input.window_bars)
        || input.stride_bars == 0
        || input.stride_bars > input.window_bars
    {
        return Err(Error::bad("invalid_history_plan"));
    }
    for (symbol, start) in &input.symbol_start_at {
        if !input.symbols.contains(symbol) || *start < input.start_at || *start >= input.end_at {
            return Err(Error::bad("invalid_symbol_continuation"));
        }
    }
    for symbol in &input.symbols {
        for interval in &input.intervals {
            let seconds = history::interval_seconds(interval)?;
            if (input.end_at - input.start_at).num_seconds() < seconds * input.window_bars as i64 {
                return Err(Error::bad("history_plan_range_too_short"));
            }
            history::validate(&history::HistoryIndexRequest {
                source: input.source.clone(),
                symbol: symbol.clone(),
                market: input.market.clone(),
                interval: interval.clone(),
                start_at: input.start_at,
                end_at: input.start_at + Duration::seconds(seconds * input.window_bars as i64),
                window_bars: input.window_bars,
                stride_bars: input.stride_bars,
                models: input.models.clone(),
            })?;
        }
    }
    Ok(())
}
pub async fn create(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: HistoryPlanRequest,
) -> Result<Value> {
    validate(&input)?;
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "history.plan", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let v = create_tx(&mut tx, owner, key, input).await?;
    Database::finish(&mut tx, owner, "history.plan", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn create_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    key: &str,
    input: HistoryPlanRequest,
) -> Result<Value> {
    validate(&input)?;
    let body = json!(input);
    let id = jobs::enqueue_tx(tx, owner, "history.plan", key, body.clone()).await?;
    sqlx::query("INSERT INTO history_plans(id,owner_id,body,next_start) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
        .bind(id)
        .bind(owner)
        .bind(&body)
        .bind(input.start_at)
        .execute(&mut **tx)
        .await?;
    let v = json!({"plan_id":id,"job_id":id,"status":"running","scope":"requested_symbols_intervals_and_dates","raw_market_storage":"none","revision":0});
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(
        "SELECT to_jsonb(p)-'owner_id' FROM history_plans p WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)
}
pub async fn step(s: &Services, j: &Job) -> Result<Value> {
    let state = get(s, j.owner, j.id).await?;
    if state["status"] == "completed" {
        return Ok(state);
    }
    if state["status"] != "running" {
        return Err(Error::deferred(
            "history_plan_paused",
            RetryDirective::AwaitInput,
        ));
    }
    let input: HistoryPlanRequest =
        serde_json::from_value(state["body"].clone()).map_err(|_| Error::bad("invalid_plan"))?;
    let mut symbol = state["symbol_no"].as_u64().unwrap_or(0) as usize;
    let mut interval = state["interval_no"].as_u64().unwrap_or(0) as usize;
    let mut start: DateTime<Utc> = serde_json::from_value(state["next_start"].clone())
        .map_err(|_| Error::bad("invalid_plan_cursor"))?;
    let mut completed = state["completed_chunks"].as_i64().unwrap_or(0);
    if let Some(child) = state["child_job"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok())
    {
        let child = jobs::get(s, j.owner, child).await?;
        match child["status"].as_str() {
            Some("succeeded") => {
                completed += 1;
                let seconds = history::interval_seconds(&input.intervals[interval])?;
                let end: DateTime<Utc> = serde_json::from_value(child["body"]["end_at"].clone())
                    .map_err(|_| Error::bad("invalid_child_range"))?;
                start = end
                    - Duration::seconds((input.window_bars - input.stride_bars) as i64 * seconds);
            }
            Some("failed" | "needs_attention" | "blocked_capability" | "awaiting_input") => {
                sqlx::query("UPDATE history_plans SET status='needs_attention',updated_at=now() WHERE owner_id=$1 AND id=$2 AND status='running'").bind(j.owner).bind(j.id).execute(&s.db.pool).await?;
                return Err(Error::deferred(
                    "history_child_requires_attention",
                    RetryDirective::AwaitInput,
                ));
            }
            _ => {
                return Err(Error::deferred(
                    "history_chunk_in_progress",
                    RetryDirective::At(Utc::now() + Duration::seconds(10)),
                ));
            }
        }
    }
    let mut scope_end = input.end_at;
    while symbol < input.symbols.len() {
        let scope = super::history_catalog::boundaries::resolve(
            s,
            j,
            &input,
            &input.symbols[symbol],
            &input.intervals[interval],
        )
        .await?;
        start = start.max(scope.start_at);
        scope_end = scope.end_at;
        let seconds = history::interval_seconds(&input.intervals[interval])?;
        start = DateTime::from_timestamp(
            (start.timestamp() + seconds - 1).div_euclid(seconds) * seconds,
            0,
        )
        .ok_or_else(|| Error::bad("invalid_plan_time"))?;
        let available = (scope_end - start).num_seconds() / seconds;
        if available >= input.window_bars as i64 {
            break;
        }
        start = input.start_at;
        interval += 1;
        if interval == input.intervals.len() {
            interval = 0;
            symbol += 1;
        }
    }
    let mut tx = s.db.pool.begin().await?;
    let active:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND status='running' AND lease_until>now() FOR UPDATE").bind(j.id).bind(j.lease).bind(j.generation).fetch_optional(&mut *tx).await?;
    if active.is_none() {
        return Err(Error::conflict("lease_lost"));
    }
    let running: bool = sqlx::query_scalar(
        "SELECT status='running' FROM history_plans WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(j.owner)
    .bind(j.id)
    .fetch_one(&mut *tx)
    .await?;
    if !running {
        return Err(Error::conflict("plan_state_changed"));
    }
    if symbol == input.symbols.len() {
        sqlx::query("UPDATE history_plans SET status='completed',completed_chunks=$3,child_job=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(completed).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(
            json!({"plan_id":j.id,"status":"completed","completed_chunks":completed,"coverage":"inspect_public_generations_for_actual_gaps"}),
        );
    }
    let seconds = history::interval_seconds(&input.intervals[interval])?;
    let available = (scope_end - start).num_seconds() / seconds;
    let starts = ((available - input.window_bars as i64) / input.stride_bars as i64 + 1).min(512);
    let end = start
        + Duration::seconds(
            (input.window_bars as i64 + (starts - 1) * input.stride_bars as i64) * seconds,
        );
    let child = history::HistoryIndexRequest {
        source: input.source.clone(),
        symbol: input.symbols[symbol].clone(),
        market: input.market.clone(),
        interval: input.intervals[interval].clone(),
        start_at: start,
        end_at: end,
        window_bars: input.window_bars,
        stride_bars: input.stride_bars,
        models: input.models.clone(),
    };
    let body = json!(child);
    let child_id = jobs::enqueue_tx(
        &mut tx,
        j.owner,
        "history.index",
        &format!("{}:{completed}", j.id),
        body.clone(),
    )
    .await?;
    let generation:Uuid=sqlx::query_scalar("INSERT INTO public_market.generations(id,request_hash,body) VALUES(md5($1::jsonb::text)::uuid,md5($1::jsonb::text),$1) ON CONFLICT(request_hash) DO UPDATE SET request_hash=EXCLUDED.request_hash RETURNING id").bind(&body).fetch_one(&mut *tx).await?;
    sqlx::query("INSERT INTO history_indexes(id,owner_id,body,generation_id,status) VALUES($1,$2,$3,$4,'queued') ON CONFLICT DO NOTHING").bind(child_id).bind(j.owner).bind(&body).bind(generation).execute(&mut *tx).await?;
    sqlx::query("UPDATE history_plans SET symbol_no=$3,interval_no=$4,next_start=$5,completed_chunks=$6,child_job=$7,updated_at=now() WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(symbol as i32).bind(interval as i32).bind(start).bind(completed).bind(child_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Err(Error::deferred(
        "history_chunk_scheduled",
        RetryDirective::At(Utc::now() + Duration::seconds(10)),
    ))
}
pub async fn control(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: PlanControl,
) -> Result<Value> {
    if !matches!(input.action.as_str(), "pause" | "resume" | "cancel") {
        return Err(Error::bad("invalid_plan_action"));
    }
    let body = json!({"plan_id":id,"control":input});
    let (mut tx, cached) =
        s.db.write(owner, "history.plan.control", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    // Always acquire the same job-before-plan lock order as a running planner.
    sqlx::query("SELECT id FROM jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::not_found)?;
    let row=sqlx::query("SELECT revision,status,child_job FROM history_plans WHERE owner_id=$1 AND id=$2 FOR UPDATE").bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(Error::not_found)?;
    if row.get::<i64, _>("revision") != input.expected_revision {
        return Err(Error::conflict("plan_revision_conflict"));
    }
    let prior: String = row.get("status");
    if matches!(prior.as_str(), "completed" | "cancelled")
        || (input.action == "resume" && !matches!(prior.as_str(), "paused" | "needs_attention"))
    {
        return Err(Error::conflict("plan_state_conflict"));
    }
    let (state, job_state) = match input.action.as_str() {
        "pause" => ("paused", "awaiting_input"),
        "resume" => ("running", "queued"),
        _ => ("cancelled", "cancelled"),
    };
    let child: Option<Uuid> = row.get("child_job");
    sqlx::query("UPDATE jobs SET status=$3,generation=generation+1,cycle_attempt=0,lease_owner=NULL,lease_until=NULL,run_after=now(),error_code=NULL WHERE owner_id=$1 AND (id=$2 OR id=$4) AND status<>'succeeded'").bind(owner).bind(id).bind(job_state).bind(child).execute(&mut *tx).await?;
    sqlx::query("UPDATE history_plans SET status=$3,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).bind(state).execute(&mut *tx).await?;
    let result = json!({"plan_id":id,"status":state,"revision":input.expected_revision+1});
    Database::finish(&mut tx, owner, "history.plan.control", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}

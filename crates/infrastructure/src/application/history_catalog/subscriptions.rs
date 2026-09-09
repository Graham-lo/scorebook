use super::*;
use sqlx::Row;
pub async fn create(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: HistorySubscriptionInput,
) -> Result<Value> {
    let body = json!(input);
    let (tx, cached) = s.db.write(owner, "history.subscribe", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    tx.commit().await?;
    let symbols = resolve_symbols(s, &input.market, &input.symbols).await?;
    let end = cycle_end(&input.source)?;
    let estimate = super::estimate(
        s,
        HistoryEstimateInput {
            market: input.market.clone(),
            symbols: symbols.clone(),
            intervals: input.intervals.clone(),
            start_at: input.start_at,
            end_at: end,
        },
    )
    .await?;
    if input.max_vectors == 0
        || estimate["upper_bound_vectors"]
            .as_u64()
            .is_none_or(|v| v > input.max_vectors)
    {
        return Err(Error::bad("history_capacity_budget_exceeded"));
    }
    let (mut tx, cached) = s.db.write(owner, "history.subscribe", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = Uuid::new_v4();
    let stored = json!({"definition":input,"resolved_symbols":symbols});
    sqlx::query("INSERT INTO history_subscriptions(id,owner_id,body,status,cycle_end) VALUES($1,$2,$3,'active',$4)").bind(id).bind(owner).bind(stored).bind(end).execute(&mut *tx).await?;
    let job = jobs::enqueue_tx(
        &mut tx,
        owner,
        "history.subscription",
        &format!("{id}:0"),
        json!({"subscription_id":id}),
    )
    .await?;
    let result = json!({"subscription_id":id,"job_id":job,"revision":0,"status":"active","estimate":estimate});
    Database::finish(&mut tx, owner, "history.subscribe", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
fn cycle_end(source: &HistorySource) -> Result<DateTime<Utc>> {
    let now = Utc::now();
    match source {
        HistorySource::Rest => DateTime::from_timestamp(now.timestamp().div_euclid(60) * 60, 0)
            .ok_or_else(|| Error::bad("invalid_date")),
        HistorySource::MonthlyArchive => {
            chrono::NaiveDate::from_ymd_opt(now.year(), now.month(), 1)
                .and_then(|v| v.and_hms_opt(0, 0, 0))
                .map(|v| v.and_utc())
                .ok_or_else(|| Error::bad("invalid_date"))
        }
    }
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(
        "SELECT to_jsonb(s)-'owner_id' FROM history_subscriptions s WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)
}
pub async fn step(s: &Services, j: &Job) -> Result<Value> {
    let id: Uuid = serde_json::from_value(j.body["subscription_id"].clone())
        .map_err(|_| Error::bad("invalid_subscription_job"))?;
    let state = get(s, j.owner, id).await?;
    if state["status"] != "active" {
        return Err(Error::deferred(
            "subscription_not_active",
            RetryDirective::AwaitInput,
        ));
    }
    let input: HistorySubscriptionInput =
        serde_json::from_value(state["body"]["definition"].clone())
            .map_err(|_| Error::bad("invalid_subscription_definition"))?;
    let symbols: Vec<String> = serde_json::from_value(state["body"]["resolved_symbols"].clone())
        .map_err(|_| Error::bad("invalid_subscription_symbols"))?;
    let mut plan_no = state["plan_no"].as_u64().unwrap_or(0) as usize;
    let cycle = state["cycle"]
        .as_i64()
        .ok_or_else(|| Error::bad("invalid_subscription_cycle"))?;
    if let Some(child) = state["child_plan"].as_str() {
        let child: Uuid = child
            .parse()
            .map_err(|_| Error::bad("invalid_subscription_child"))?;
        let plan = super::super::history_plans::get(s, j.owner, child).await?;
        if plan["status"] != "completed" {
            if plan["status"] != "running" {
                return Err(Error::deferred(
                    "subscription_child_requires_attention",
                    RetryDirective::AwaitInput,
                ));
            }
            return Err(Error::deferred(
                "subscription_plan_in_progress",
                RetryDirective::At(Utc::now() + Duration::seconds(20)),
            ));
        }
        let gaps:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM history_indexes i JOIN jobs j ON j.id=i.id WHERE i.owner_id=$1 AND j.dedupe_key LIKE $2 AND COALESCE((i.coverage->>'source_range_complete')::boolean,false)=false)").bind(j.owner).bind(format!("{child}:%")).fetch_one(&s.db.pool).await?;
        if gaps {
            sqlx::query("UPDATE history_subscriptions SET status='needs_attention',last_error='source_coverage_gaps' WHERE id=$1 AND cycle=$2").bind(id).bind(cycle).execute(&s.db.pool).await?;
            return Err(Error::deferred(
                "source_coverage_gaps",
                RetryDirective::AwaitInput,
            ));
        }
        plan_no += 1;
    }
    let end: DateTime<Utc> = serde_json::from_value(state["cycle_end"].clone())
        .map_err(|_| Error::bad("invalid_subscription_end"))?;
    let total = symbols.len().div_ceil(200) * input.intervals.len() * 3;
    if plan_no >= total {
        let mut tx = jobs::fence(s, j).await?;
        sqlx::query("UPDATE history_subscriptions SET watermark=$3,plan_no=0,child_plan=NULL,cycle=cycle+1,next_run_at=now()+interval '1 hour',cycle_end=NULL,last_error=NULL WHERE id=$1 AND cycle=$2 AND status='active'").bind(id).bind(cycle).bind(end).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(
            json!({"subscription_id":id,"cycle":cycle,"watermark":end,"status":"cycle_complete","resolution":"64_128_256_windows_quarter_stride"}),
        );
    }
    let batch = plan_no / (input.intervals.len() * 3);
    let tf = input.intervals[(plan_no / 3) % input.intervals.len()].clone();
    let window = [64usize, 128, 256][plan_no % 3];
    let stride = window / 4;
    let seconds = super::super::history::interval_seconds(&tf)?;
    let start = state["watermark"]
        .as_str()
        .and_then(|v| v.parse::<DateTime<Utc>>().ok())
        .map(|v| v - Duration::seconds((window - stride) as i64 * seconds))
        .unwrap_or(input.start_at);
    if (end - start).num_seconds() < window as i64 * seconds {
        return Err(Error::deferred(
            "subscription_waiting_for_closed_window",
            RetryDirective::At(Utc::now() + Duration::hours(1)),
        ));
    }
    let mut tx = jobs::fence(s, j).await?;
    let plan = super::super::history_plans::create_tx(
        &mut tx,
        j.owner,
        &format!("subscription:{id}:{cycle}:{plan_no}"),
        scorebook_core::api::history_plans::HistoryPlanRequest {
            source: input.source,
            market: input.market,
            symbols: symbols[batch * 200..((batch + 1) * 200).min(symbols.len())].to_vec(),
            intervals: vec![tf],
            start_at: start,
            end_at: end,
            window_bars: window,
            stride_bars: stride,
            models: vec!["candle-geometry-v2".into()],
        },
    )
    .await?;
    let child: Uuid = serde_json::from_value(plan["plan_id"].clone())
        .map_err(|_| Error::bad("invalid_child_plan"))?;
    let active: bool = sqlx::query_scalar(
        "SELECT status='active' FROM history_subscriptions WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if !active {
        return Err(Error::conflict("subscription_state_changed"));
    }
    sqlx::query("INSERT INTO history_subscription_plans(owner_id,subscription_id,cycle,plan_no,plan_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(j.owner).bind(id).bind(cycle).bind(plan_no as i32).bind(child).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE history_subscriptions SET child_plan=$3,plan_no=$4 WHERE id=$1 AND cycle=$2",
    )
    .bind(id)
    .bind(cycle)
    .bind(child)
    .bind(plan_no as i32)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Err(Error::deferred(
        "subscription_plan_scheduled",
        RetryDirective::At(Utc::now() + Duration::seconds(20)),
    ))
}
pub async fn schedule(s: &Services) -> Result<()> {
    let mut tx = s.db.pool.begin().await?;
    let rows=sqlx::query("SELECT id,owner_id,cycle,body,watermark FROM history_subscriptions WHERE status='active' AND next_run_at<=now() AND cycle_end IS NULL ORDER BY next_run_at,id LIMIT 10 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let owner: Uuid = row.get("owner_id");
        let body: Value = row.get("body");
        let input: HistorySubscriptionInput = serde_json::from_value(body["definition"].clone())
            .map_err(|_| Error::bad("invalid_subscription_definition"))?;
        let end = cycle_end(&input.source)?;
        let watermark: Option<DateTime<Utc>> = row.get("watermark");
        if watermark.is_some_and(|v| v >= end) {
            continue;
        }
        let job = jobs::enqueue_tx(
            &mut tx,
            owner,
            "history.subscription",
            &format!("{id}:{}", row.get::<i64, _>("cycle")),
            json!({"subscription_id":id}),
        )
        .await?;
        sqlx::query("UPDATE history_subscriptions SET cycle_end=$2 WHERE id=$1")
            .bind(id)
            .bind(end)
            .execute(&mut *tx)
            .await?;
        let _ = job;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn control(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: scorebook_core::api::history_plans::PlanControl,
) -> Result<Value> {
    if !matches!(input.action.as_str(), "pause" | "resume" | "cancel") {
        return Err(Error::bad("invalid_subscription_action"));
    }
    let body = json!({"subscription_id":id,"control":input});
    let (mut tx, cached) =
        s.db.write(owner, "history.subscription.control", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    // Match the worker's job-before-subscription lock order. Child publication also
    // takes a job row lock, so cancellation fences every producer in this tree.
    sqlx::query("SELECT id FROM jobs WHERE owner_id=$1 AND kind='history.subscription' AND body->>'subscription_id'=$2 FOR UPDATE").bind(owner).bind(id.to_string()).fetch_all(&mut *tx).await?;
    let row=sqlx::query("SELECT revision,status,cycle FROM history_subscriptions WHERE owner_id=$1 AND id=$2 FOR UPDATE").bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(Error::not_found)?;
    if row.get::<i64, _>("revision") != input.expected_revision
        || row.get::<String, _>("status") == "cancelled"
    {
        return Err(Error::conflict("subscription_revision_conflict"));
    }
    let target = match input.action.as_str() {
        "resume" => "active",
        "pause" => "paused",
        _ => "cancelled",
    };
    sqlx::query("UPDATE history_subscriptions SET status=$3,revision=revision+1,next_run_at=now() WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).bind(target).execute(&mut *tx).await?;
    if input.action == "resume" {
        sqlx::query("UPDATE jobs SET status='queued',generation=generation+1,cycle_attempt=0,run_after=now(),error_code=NULL WHERE owner_id=$1 AND kind='history.subscription' AND body->>'subscription_id'=$2 AND status<>'succeeded'").bind(owner).bind(id.to_string()).execute(&mut *tx).await?;
    } else {
        sqlx::query("UPDATE jobs SET status=$3,generation=generation+1,lease_owner=NULL,lease_until=NULL WHERE owner_id=$1 AND kind='history.subscription' AND body->>'subscription_id'=$2 AND status<>'succeeded'").bind(owner).bind(id.to_string()).bind(if target=="cancelled"{"cancelled"}else{"awaiting_input"}).execute(&mut *tx).await?;
    }
    // A paused subscription lets an already-started bounded child finish; cancellation
    // fences child plans and their range producers. Resume never silently resets failures.
    if input.action == "cancel" {
        let plans:Vec<Uuid>=sqlx::query_scalar("SELECT plan_id FROM history_subscription_plans WHERE owner_id=$1 AND subscription_id=$2").bind(owner).bind(id).fetch_all(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL WHERE owner_id=$1 AND status<>'succeeded' AND (id=ANY($2) OR id IN(SELECT child_job FROM history_plans WHERE owner_id=$1 AND id=ANY($2)))").bind(owner).bind(&plans).execute(&mut *tx).await?;
        sqlx::query("UPDATE history_plans SET status='cancelled',revision=revision+1 WHERE owner_id=$1 AND id=ANY($2) AND status<>'completed'").bind(owner).bind(plans).execute(&mut *tx).await?;
    }
    let v = json!({"subscription_id":id,"revision":input.expected_revision+1,"status":target});
    Database::finish(
        &mut tx,
        owner,
        "history.subscription.control",
        key,
        &body,
        &v,
    )
    .await?;
    tx.commit().await?;
    Ok(v)
}

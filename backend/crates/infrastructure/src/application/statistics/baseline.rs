//! B1 uses declared closed-minute endpoints, proven by a nonempty closed kline.
//! A sample ends before submission; its ATR uses only bars already closed then.
use super::*;
use crate::error::RetryDirective;
use chrono::{DateTime, Duration, Utc};
use scorebook_core::domain::criteria::{
    self, AggregateInput, Bar, Criteria, PathAggregate, Template,
};
const SOURCE: &str = "rest_closed_minute_endpoints_v1";
pub async fn create(s: &Services, owner: Uuid, key: &str, input: BaselineInput) -> Result<Value> {
    if input.source_plan != SOURCE || input.calendar != "natural_hours" {
        return Err(Error::bad("unsupported_baseline_source_or_calendar"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "baseline.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let ready: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM set_runs WHERE owner_id=$1 AND id=$2 AND status='ready')",
    )
    .bind(owner)
    .bind(input.statistics_run_id)
    .fetch_one(&mut *tx)
    .await?;
    if !ready {
        return Err(Error::conflict("statistics_snapshot_not_ready"));
    }
    let id = jobs::enqueue_tx(&mut tx, owner, "baseline.build", key, body.clone()).await?;
    sqlx::query(
        "INSERT INTO baseline_runs(id,owner_id,statistics_run_id,body) VALUES($1,$2,$3,$4)",
    )
    .bind(id)
    .bind(owner)
    .bind(input.statistics_run_id)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO job_targets SELECT DISTINCT owner_id,$2,'call',call_id FROM set_sample_members WHERE owner_id=$1 AND run_id=$3 ON CONFLICT DO NOTHING").bind(owner).bind(id).bind(input.statistics_run_id).execute(&mut *tx).await?;
    let v = json!({"baseline_run_id":id,"status":"queued","protocol":"B1-T1-v1","source_plan":SOURCE,"lookback_days":250,"sample_clock":"utc_minute_close_on_prior_calendar_days","price_policy":"asof_last_eligible_trade","weighting":"equal_per_call_within_comparable_group"});
    Database::finish(&mut tx, owner, "baseline.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT (to_jsonb(r)-'owner_id')||jsonb_build_object('job_status',j.status,'error_code',j.error_code) FROM baseline_runs r JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
pub async fn samples(s: &Services, owner: Uuid, id: Uuid, f: MemberFilter) -> Result<Value> {
    // Stable source members are indexed by ordinal; per-call sample date paging.
    let ready: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM baseline_runs WHERE owner_id=$1 AND id=$2 AND status='ready')",
    )
    .bind(owner)
    .bind(id)
    .fetch_one(&s.db.pool)
    .await?;
    if !ready {
        return Err(Error::conflict("baseline_snapshot_not_ready"));
    }
    let ordinal = f.cursor.unwrap_or(0);
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('ordinal',row_no,'sample',body) FROM(SELECT row_number() OVER(ORDER BY b.call_id,b.claim_no,b.at) AS row_no,to_jsonb(b)-'owner_id' AS body FROM baseline_samples b WHERE owner_id=$1 AND run_id=$2) q WHERE row_no>$3 ORDER BY row_no LIMIT 101").bind(owner).bind(id).bind(ordinal).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(
        json!({"baseline_run_id":id,"items":items,"next_cursor":if more{Some(ordinal+100)}else{None}}),
    )
}
fn floor(at: DateTime<Utc>, seconds: i64) -> DateTime<Utc> {
    DateTime::from_timestamp(at.timestamp().div_euclid(seconds) * seconds, 0).unwrap()
}
fn decode(v: &Value) -> Result<Vec<Bar>> {
    serde_json::from_value(v["bars"].clone()).map_err(|_| Error::bad("invalid_baseline_bars"))
}
fn endpoint(v: &Value) -> Option<String> {
    let bar = v["raw"].as_array()?.last()?.as_array()?;
    if v["coverage_complete"] != true || bar.get(8)?.as_i64()? <= 0 {
        return None;
    }
    bar.get(4)?.as_str().map(str::to_string)
}
pub async fn build(s: &Services, j: &Job) -> Result<Value> {
    let row=sqlx::query("SELECT statistics_run_id,next_ordinal,next_day,status FROM baseline_runs WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).fetch_one(&s.db.pool).await?;
    if row.get::<String, _>("status") == "ready" {
        return get(s, j.owner, j.id).await;
    }
    let run: Uuid = row.get("statistics_run_id");
    let cursor: i64 = row.get("next_ordinal");
    let day: i32 = row.get("next_day");
    let member:Option<(i64,Uuid,i32,DateTime<Utc>,Value)>=sqlx::query_as("SELECT ordinal,call_id,claim_no,submitted_at,body FROM set_sample_members WHERE owner_id=$1 AND run_id=$2 AND ordinal>=$3 AND representative AND selected AND body->'criteria'->>'template'='T1' ORDER BY ordinal LIMIT 1").bind(j.owner).bind(run).bind(cursor).fetch_optional(&s.db.pool).await?;
    let Some((ordinal, call, claim, submitted, body)) = member else {
        return finish(s, j, run).await;
    };
    let c: Criteria = serde_json::from_value(body["criteria"].clone())
        .map_err(|_| Error::bad("invalid_baseline_rule"))?;
    if c.template != Template::T1 {
        return Err(Error::bad("baseline_only_t1"));
    }
    let origin = floor(submitted, 60) + Duration::minutes(1)
        - Duration::milliseconds(1)
        - Duration::days(i64::from(day));
    let end = origin + Duration::hours(c.horizon_hours.unwrap().into());
    let market = body["market"]
        .as_str()
        .ok_or_else(|| Error::bad("baseline_market_missing"))?;
    let symbol = body["instrument"]
        .as_str()
        .ok_or_else(|| Error::bad("baseline_symbol_missing"))?;
    let mut result =
        json!({"state":"excluded","reason":"observation_not_entirely_before_submission"});
    let mut hash = digest(&json!([origin, end, submitted]));
    if end < submitted && origin >= submitted - Duration::days(250) {
        let base_data = s
            .market
            .klines(
                market,
                symbol,
                "1m",
                origin - Duration::seconds(59) - Duration::milliseconds(999),
                origin + Duration::milliseconds(1),
            )
            .await?;
        let end_data = s
            .market
            .klines(
                market,
                symbol,
                "1m",
                end - Duration::seconds(59) - Duration::milliseconds(999),
                end + Duration::milliseconds(1),
            )
            .await?;
        let day_start = floor(origin, 86400);
        let atr_data = s
            .market
            .klines(
                market,
                symbol,
                "1d",
                day_start - Duration::days(121),
                day_start,
            )
            .await?;
        if let (Some(base), Some(end_price)) = (endpoint(&base_data), endpoint(&end_data)) {
            let atr = if atr_data["coverage_complete"] == true {
                criteria::atr14(&decode(&atr_data)?, origin).ok()
            } else {
                None
            };
            let start = origin + Duration::milliseconds(1);
            let until = end + Duration::milliseconds(1);
            let h_start = (floor(start, 3600) + Duration::hours(1)).min(until);
            let h_end = floor(until, 3600).max(h_start);
            let mut ranges = Vec::new();
            if start < h_start {
                ranges.push(("1m", start, h_start));
            }
            if h_start < h_end {
                ranges.push(("1h", h_start, h_end));
            }
            if h_end < until {
                ranges.push(("1m", h_end, until));
            }
            let mut path = PathAggregate::new(&base).map_err(Error::bad)?;
            let mut complete = true;
            let mut chain = digest(&json!([base_data, end_data, atr_data]));
            for (interval, a, b) in ranges {
                let v = s.market.klines(market, symbol, interval, a, b).await?;
                complete &= v["coverage_complete"] == true;
                for bar in decode(&v)? {
                    path.observe(
                        &c,
                        &base,
                        &atr,
                        bar.start,
                        bar.end - Duration::milliseconds(1),
                        &bar.high,
                        &bar.low,
                    )
                    .map_err(Error::bad)?;
                }
                chain = digest(&json!([chain, v]));
            }
            let input = AggregateInput {
                criteria: c,
                start: origin,
                evaluated_at: end,
                base,
                atr0: atr,
                path,
                coverage_complete: complete,
                endpoint_proven: true,
                end_price: Some(end_price),
                trigger_at: None,
                trigger_price: None,
            };
            result = match criteria::evaluate_aggregate(&input) {
                Ok(v) => json!(v),
                Err(e) => json!({"state":"insufficient_data","reason":e}),
            };
            hash = digest(&json!([chain, input]));
        } else {
            result = json!({"state":"insufficient_data","reason":"nonempty_closed_minute_endpoint_unproven"});
            hash = digest(&json!([base_data, end_data, atr_data]));
        }
    }
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("INSERT INTO baseline_samples(owner_id,run_id,call_id,claim_no,at,end_at,result,input_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING").bind(j.owner).bind(j.id).bind(call).bind(claim).bind(origin).bind(end).bind(result).bind(hash).execute(&mut *tx).await?;
    sqlx::query("UPDATE baseline_runs SET next_ordinal=$3,next_day=$4,status='building' WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(if day==250{ordinal+1}else{ordinal}).bind(if day==250{1}else{day+1}).execute(&mut *tx).await?;
    tx.commit().await?;
    Err(Error::deferred(
        "baseline_progress",
        RetryDirective::At(Utc::now() + Duration::seconds(1)),
    ))
}
async fn finish(s: &Services, j: &Job, run: Uuid) -> Result<Value> {
    let mut tx = jobs::fence(s, j).await?;
    let groups:Vec<Value>=sqlx::query_scalar("WITH call_rates AS(SELECT m.signature,b.call_id,count(*) FILTER(WHERE b.result->>'state' IN ('realized','unrealized')) AS valid,count(*) FILTER(WHERE b.result->>'state'='realized') AS wins,count(*) AS attempted FROM baseline_samples b JOIN set_sample_members m ON m.owner_id=b.owner_id AND m.run_id=$3 AND m.call_id=b.call_id AND m.claim_no=b.claim_no WHERE b.owner_id=$1 AND b.run_id=$2 GROUP BY m.signature,b.call_id) SELECT jsonb_build_object('signature',signature,'valid_calls',count(*) FILTER(WHERE valid>0),'missing_calls',count(*) FILTER(WHERE valid=0),'valid_samples',sum(valid),'attempted_samples',sum(attempted),'equal_call_realization_rate',avg(CASE WHEN valid>0 THEN wins::numeric/valid ELSE NULL END)::text) FROM call_rates GROUP BY signature").bind(j.owner).bind(j.id).bind(run).fetch_all(&mut *tx).await?;
    let result = json!({"protocol":"B1-T1-v1","groups":groups,"other_templates":"not_applicable","future_data_allowed":false,"calendar":"natural_hours","source_plan":SOURCE,"rate_without_samples":null});
    sqlx::query("UPDATE baseline_runs SET status='ready',result=$3 WHERE owner_id=$1 AND id=$2")
        .bind(j.owner)
        .bind(j.id)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"baseline_run_id":j.id,"status":"ready","result":result}))
}

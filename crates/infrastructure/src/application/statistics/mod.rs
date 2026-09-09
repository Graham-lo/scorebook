//! Formal statistics own fixed source snapshots. All figures resolve against the
//! same normalized membership table; no model estimates the denominator.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result},
};
use scorebook_core::api::statistics::*;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub mod snapshot;
pub mod verdicts;
pub async fn create(s: &Services, owner: Uuid, key: &str, input: StatisticsInput) -> Result<Value> {
    if input.name.trim().is_empty()
        || input.name.len() > 200
        || input.comparison_policy != "exact_frozen_rule"
        || !matches!(input.grouping.as_str(), "episode_rule" | "call_rule")
        || input.calendar != "natural_hours"
        || input.outcome_policy != "current_formal_head"
    {
        return Err(Error::bad("unsupported_statistics_policy"));
    }
    let f = &input.filters;
    if f.start_at.zip(f.end_at).is_some_and(|(a, b)| a >= b)
        || f.tag_phase
            .as_deref()
            .is_some_and(|v| !matches!(v, "hot" | "cold"))
        || f.adoption
            .as_deref()
            .is_some_and(|v| !matches!(v, "planned" | "executed" | "not_executed" | "unknown"))
        || f.result_states.iter().any(|v| {
            !matches!(
                v.as_str(),
                "realized"
                    | "unrealized"
                    | "not_triggered"
                    | "pending"
                    | "no_criteria"
                    | "insufficient_data"
            )
        })
    {
        return Err(Error::bad("invalid_sample_filter"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "statistics.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let identity = digest(&json!([
        input.filters,
        input.comparison_policy,
        input.grouping,
        input.calendar,
        input.outcome_policy
    ]));
    let proposed = Uuid::new_v4();
    let definition:Uuid=sqlx::query_scalar("INSERT INTO set_definitions(id,owner_id,identity,body) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,identity) DO UPDATE SET identity=EXCLUDED.identity RETURNING id").bind(proposed).bind(owner).bind(identity).bind(&body).fetch_one(&mut *tx).await?;
    let id = jobs::enqueue_tx(
        &mut tx,
        owner,
        "statistics.build",
        key,
        json!({"definition_id":definition}),
    )
    .await?;
    sqlx::query(
        "INSERT INTO set_runs(id,owner_id,definition_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(owner)
    .bind(definition)
    .execute(&mut *tx)
    .await?;
    let v = json!({"statistics_run_id":id,"set_snapshot_id":id,"definition_id":definition,"status":"queued"});
    Database::finish(&mut tx, owner, "statistics.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT (to_jsonb(r)-'owner_id')||jsonb_build_object('set_snapshot_id',r.id,'definition',d.body,'job',jsonb_build_object('status',j.status,'error_code',j.error_code,'generation',j.generation)) FROM set_runs r JOIN set_definitions d ON d.owner_id=r.owner_id AND d.id=r.definition_id JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
pub async fn members(s: &Services, owner: Uuid, id: Uuid, f: MemberFilter) -> Result<Value> {
    let ready: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM set_runs WHERE owner_id=$1 AND id=$2 AND status='ready')",
    )
    .bind(owner)
    .bind(id)
    .fetch_one(&s.db.pool)
    .await?;
    if !ready {
        return Err(Error::conflict("statistics_snapshot_not_ready"));
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(m)-'owner_id' FROM set_sample_members m WHERE owner_id=$1 AND run_id=$2 AND ordinal>$3 AND ($4::text IS NULL OR signature=$4) AND ($5::text IS NULL OR state=$5) AND ($6::boolean IS NULL OR representative=$6) ORDER BY ordinal LIMIT 101").bind(owner).bind(id).bind(f.cursor.unwrap_or(0)).bind(f.group_signature).bind(f.state).bind(f.representative).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(
        json!({"set_snapshot_id":id,"next_cursor":if more{items.last().map(|v|v["ordinal"].clone())}else{None},"items":items}),
    )
}

pub mod baseline;

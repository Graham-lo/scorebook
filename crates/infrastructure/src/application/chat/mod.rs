use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Duration, Utc};
use scorebook_core::{access::Principal, api::chat::*, chat::*};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub mod citations;
pub mod runtime;
pub mod tools;
pub async fn create(
    s: &Services,
    principal: Principal,
    key: &str,
    input: ChatInput,
) -> Result<Value> {
    principal.require("knowledge.read")?;
    principal.require("search.save")?;
    if input.message.trim().is_empty()
        || input.message.len() > 50000
        || input.attachment_ids.len() > 4
        || input.approved_actions.len() > 12
        || input
            .approved_actions
            .iter()
            .any(|a| a.arguments_sha256.len() != 64 || a.user_intent.trim().is_empty())
    {
        return Err(Error::bad("invalid_chat_input"));
    }
    let owner = principal.owner;
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "chat.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM attachments WHERE owner_id=$1 AND id=ANY($2)")
            .bind(owner)
            .bind(&input.attachment_ids)
            .fetch_one(&mut *tx)
            .await?;
    if n as usize
        != input
            .attachment_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
    {
        return Err(Error::bad("invalid_chat_attachment"));
    }
    let id = jobs::enqueue_tx(
        &mut tx,
        owner,
        "chat.run",
        key,
        json!({"protocol":"chat-v1","attachment_ids":input.attachment_ids}),
    )
    .await?;
    sqlx::query("INSERT INTO chat_runs(id,owner_id,credential_id,permissions,model_id,body) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(owner).bind(principal.credential_id).bind(principal.permissions).bind(s.chat.model_id()).bind(&body).execute(&mut *tx).await?;
    emit(
        &mut tx,
        owner,
        id,
        "created",
        json!({"model_id":s.chat.model_id()}),
    )
    .await?;
    let v = json!({"chat_run_id":id,"job_id":id,"status":"queued","model_id":s.chat.model_id(),"events_url":format!("/v1/chat/runs/{id}/events"),"budgets":{"turns":12,"parallel_reads":4,"seconds":90}});
    Database::finish(&mut tx, owner, "chat.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT jsonb_build_object('chat_run_id',r.id,'status',r.status,'turn_no',r.turn_no,'model_id',r.model_id,'answer',r.answer,'error_code',COALESCE(r.error_code,j.error_code),'generation',j.generation,'job_status',j.status,'created_at',r.created_at) FROM chat_runs r JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
pub async fn events(s: &Services, owner: Uuid, id: Uuid, input: ChatEventFilter) -> Result<Value> {
    let state = get(s, owner, id).await?;
    let items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('sequence',sequence,'type',event_type,'data',body) FROM chat_events WHERE owner_id=$1 AND run_id=$2 AND sequence>$3 ORDER BY sequence LIMIT 101").bind(owner).bind(id).bind(input.after.unwrap_or(0)).fetch_all(&s.db.pool).await?;
    Ok(json!({"items":items,"state":state}))
}
pub async fn cancel(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: ChatCancel,
) -> Result<Value> {
    let body = json!({"chat_run_id":id,"expected_generation":input.expected_generation});
    let (mut tx, cached) = s.db.write(owner, "chat.cancel", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let n=sqlx::query("UPDATE jobs j SET status='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL WHERE j.owner_id=$1 AND j.id=$2 AND generation=$3 AND status IN ('queued','running','retry_wait','blocked_capability','awaiting_input') AND EXISTS(SELECT 1 FROM chat_runs r WHERE r.owner_id=j.owner_id AND r.id=j.id)").bind(owner).bind(id).bind(input.expected_generation).execute(&mut *tx).await?.rows_affected();
    if n != 1 {
        return Err(Error::conflict("chat_run_changed"));
    }
    sqlx::query("UPDATE chat_runs SET status='cancelled' WHERE owner_id=$1 AND id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    emit(&mut tx, owner, id, "cancelled", json!({})).await?;
    let v = json!({"chat_run_id":id,"status":"cancelled","generation":input.expected_generation+1});
    Database::finish(&mut tx, owner, "chat.cancel", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn emit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    id: Uuid,
    kind: &str,
    body: Value,
) -> Result<()> {
    sqlx::query("INSERT INTO chat_events(owner_id,run_id,event_type,body) VALUES($1,$2,$3,$4)")
        .bind(owner)
        .bind(id)
        .bind(kind)
        .bind(body)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

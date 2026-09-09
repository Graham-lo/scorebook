//! Knowledge decisions append evidence and explicit transitions; they never
//! rewrite a settled call or turn retrospective links into prior adoption.
use super::Services;
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result},
};
use scorebook_core::api::knowledge_workflow::*;
use serde_json::{Value, json};
use uuid::Uuid;
pub async fn transition(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: PlaybookTransition,
) -> Result<Value> {
    if !matches!(input.status.as_str(), "adopted" | "withdrawn" | "narrowed")
        || input.reason.trim().is_empty()
        || input.reason.len() > 100000
    {
        return Err(Error::bad("invalid_playbook_transition"));
    }
    let body = json!({"playbook_id":id,"transition":input});
    let (mut tx, cached) =
        s.db.write(owner, "playbooks.transition", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let found: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM playbooks WHERE owner_id=$1 AND id=$2 FOR UPDATE")
            .bind(owner)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    if found.is_none() {
        return Err(Error::not_found());
    }
    let (current,status):(Uuid,String)=sqlx::query_as("SELECT id,status FROM playbook_events WHERE owner_id=$1 AND playbook_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1").bind(owner).bind(id).fetch_one(&mut *tx).await?;
    if current != input.expected_event_id {
        return Err(Error::conflict("playbook_state_changed"));
    }
    if status == input.status || status == "withdrawn" {
        return Err(Error::bad("playbook_transition_requires_new_version"));
    }
    let event = Uuid::new_v4();
    sqlx::query("INSERT INTO playbook_events(id,owner_id,playbook_id,status) VALUES($1,$2,$3,$4)")
        .bind(event)
        .bind(owner)
        .bind(id)
        .bind(&input.status)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO playbook_transition_details VALUES($1,$2,$3,$4)")
        .bind(owner)
        .bind(event)
        .bind(current)
        .bind(&body)
        .execute(&mut *tx)
        .await?;
    let v = json!({"playbook_id":id,"event_id":event,"status":input.status,"previous_event_id":current});
    Database::finish(&mut tx, owner, "playbooks.transition", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
async fn evidence(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    id: Uuid,
) -> Result<Vec<Value>> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('call_id',c.id,'call_revision',st.revision,'episode_link_id',el.id,'outcome_ids',COALESCE((SELECT jsonb_agg(h.outcome_id ORDER BY h.claim_no) FROM outcome_heads h WHERE h.owner_id=c.owner_id AND h.call_id=c.id),'[]')) FROM calls c JOIN call_state st ON st.owner_id=c.owner_id AND st.call_id=c.id JOIN LATERAL(SELECT id,episode_id,status FROM episode_links WHERE owner_id=c.owner_id AND call_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) el ON el.episode_id=$2 AND el.status IN ('explicit','confirmed') WHERE c.owner_id=$1 ORDER BY c.submitted_at,c.id LIMIT 10001").bind(owner).bind(id).fetch_all(&mut **tx).await?;
    if rows.len() > 10000 {
        return Err(Error::bad("episode_evidence_budget_exceeded"));
    }
    Ok(rows)
}
pub async fn episode_context(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM episodes WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    let rows = evidence(&mut tx, owner, id).await?;
    tx.commit().await?;
    Ok(json!({"episode_id":id,"evidence_sha256":digest(&rows),"members":rows}))
}
pub async fn review_episode(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: EpisodeReview,
) -> Result<Value> {
    if input.note.trim().is_empty()
        || input.note.len() > 100000
        || input.better_play.as_ref().is_some_and(|v| v.len() > 100000)
    {
        return Err(Error::bad("invalid_episode_review"));
    }
    let body = json!({"episode_id":id,"review":input});
    let (mut tx, cached) = s.db.write(owner, "episodes.review", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    sqlx::query("SELECT id FROM episodes WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::not_found)?;
    // Serialize the evidence CAS against all participating calls' head and link changes.
    let calls:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT call_id FROM episode_links WHERE owner_id=$1 AND episode_id=$2 ORDER BY call_id LIMIT 10001").bind(owner).bind(id).fetch_all(&mut *tx).await?;
    if calls.len() > 10000 {
        return Err(Error::bad("episode_evidence_budget_exceeded"));
    }
    sqlx::query("SELECT id FROM calls WHERE owner_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE")
        .bind(owner)
        .bind(&calls)
        .fetch_all(&mut *tx)
        .await?;
    let rows = evidence(&mut tx, owner, id).await?;
    let hash = digest(&rows);
    if hash != input.expected_evidence_sha256 {
        return Err(Error::conflict("episode_evidence_changed"));
    }
    let review = Uuid::new_v4();
    sqlx::query("INSERT INTO episode_reviews(id,owner_id,episode_id,body,evidence_sha256) VALUES($1,$2,$3,$4,$5)").bind(review).bind(owner).bind(id).bind(json!({"review":input,"evidence":rows})).bind(&hash).execute(&mut *tx).await?;
    let ids: Vec<Uuid> = rows
        .iter()
        .filter_map(|v| serde_json::from_value(v["call_id"].clone()).ok())
        .collect();
    sqlx::query("INSERT INTO episode_review_refs SELECT $1,$2,unnest($3::uuid[])")
        .bind(owner)
        .bind(review)
        .bind(&ids)
        .execute(&mut *tx)
        .await?;
    let v =
        json!({"episode_review_id":review,"episode_id":id,"evidence_sha256":hash,"call_ids":ids});
    Database::finish(&mut tx, owner, "episodes.review", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn revise_tag(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: TagRevision,
) -> Result<Value> {
    if input.name.trim().is_empty()
        || input.name.len() > 200
        || input.definition.len() > 100000
        || input.aliases.len() > 100
        || input.aliases.iter().any(|a| a.is_empty() || a.len() > 200)
        || input.reason.trim().is_empty()
    {
        return Err(Error::bad("invalid_tag_revision"));
    }
    let body = json!({"tag_id":id,"revision":input});
    let (mut tx, cached) = s.db.write(owner, "tags.revise", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let root: Uuid = sqlx::query_scalar(
        "SELECT root_id FROM tag_revisions WHERE owner_id=$1 AND tag_id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(Error::not_found)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM tag_revisions WHERE owner_id=$1 AND parent_id=$2)",
    )
    .bind(owner)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if exists {
        return Err(Error::conflict("tag_revision_head_changed"));
    }
    let new = super::knowledge::create_tag_tx(
        &mut tx,
        owner,
        &input.name,
        &input.definition,
        &input.aliases,
    )
    .await?;
    sqlx::query("INSERT INTO tag_revisions(owner_id,tag_id,root_id,parent_id,reason) VALUES($1,$2,$3,$4,$5)").bind(owner).bind(new).bind(root).bind(id).bind(&input.reason).execute(&mut *tx).await?;
    let v = json!({"tag_id":new,"root_id":root,"parent_id":id,"existing_call_classification":"retains_frozen_tag_id"});
    Database::finish(&mut tx, owner, "tags.revise", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn submission(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    call: Uuid,
    playbook: Option<Uuid>,
) -> Result<()> {
    let state: Option<Value> = if let Some(id) = playbook {
        sqlx::query_scalar("SELECT jsonb_build_object('playbook_id',p.id,'version_created_at',p.created_at,'event_id',e.id,'status',e.status,'forming_call_ids',p.body->'evidence_call_ids') FROM playbooks p JOIN LATERAL(SELECT id,status FROM playbook_events WHERE owner_id=p.owner_id AND playbook_id=p.id ORDER BY created_at DESC,id DESC LIMIT 1) e ON true WHERE p.owner_id=$1 AND p.id=$2").bind(owner).bind(id).fetch_optional(&mut **tx).await?
    } else {
        None
    };
    sqlx::query("INSERT INTO submission_feedback(owner_id,call_id,body) VALUES($1,$2,$3)").bind(owner).bind(call).bind(json!({"playbook_at_submission":state,"adoption":"planned_only","execution_status":"unknown","feedback_policy":"frozen_at_submission_v1"})).execute(&mut **tx).await?;
    Ok(())
}

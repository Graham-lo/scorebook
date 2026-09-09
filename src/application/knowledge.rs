//! Reviews, versioned classification, fixed episodes and model-readable source bundles.
use super::{Services, calls};
use crate::{
    adapters::db::{Database, event},
    application::dto::*,
    error::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;
pub async fn review(s: &Services, owner: Uuid, key: &str, input: Review) -> Result<Value> {
    if !matches!(input.vs_last.as_str(), "did" | "did_not" | "new" | "keep") {
        return Err(Error::bad("invalid_review_action"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "reviews.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, input.call_id).await?;
    calls::bump(&mut tx, owner, input.call_id, input.expected_revision).await?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO reviews(id,owner_id,call_id,body) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(input.call_id)
        .bind(&body)
        .execute(&mut *tx)
        .await?;
    event(
        &mut tx,
        owner,
        Some(input.call_id),
        "review.created",
        json!({"review_id":id}),
    )
    .await?;
    let v = json!({"id":id,"revision":input.expected_revision+1});
    Database::finish(&mut tx, owner, "reviews.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn tag(s: &Services, owner: Uuid, key: &str, input: TagInput) -> Result<Value> {
    if input.name.trim().is_empty() || input.name.len() > 200 {
        return Err(Error::bad("invalid_tag"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "tags.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,3))")
        .bind(format!("{owner}:{}", input.name))
        .execute(&mut *tx)
        .await?;
    let version: i64 = sqlx::query_scalar(
        "SELECT COALESCE(max(version),0)+1 FROM tags WHERE owner_id=$1 AND name=$2",
    )
    .bind(owner)
    .bind(&input.name)
    .fetch_one(&mut *tx)
    .await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tags(id,owner_id,name,definition,aliases,version) VALUES($1,$2,$3,$4,$5,$6)",
    )
    .bind(id)
    .bind(owner)
    .bind(input.name)
    .bind(input.definition)
    .bind(input.aliases)
    .bind(version)
    .execute(&mut *tx)
    .await?;
    let v = json!({"id":id,"version":version});
    Database::finish(&mut tx, owner, "tags.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn tag_link(s: &Services, owner: Uuid, key: &str, input: TagLink) -> Result<Value> {
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "tags.link", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, input.call_id).await?;
    calls::bump(&mut tx, owner, input.call_id, input.expected_revision).await?;
    sqlx::query("INSERT INTO call_tags VALUES($1,$2,$3,'cold') ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(input.call_id)
        .bind(input.tag_id)
        .execute(&mut *tx)
        .await?;
    event(
        &mut tx,
        owner,
        Some(input.call_id),
        "tag.added",
        body.clone(),
    )
    .await?;
    let v = json!({"revision":input.expected_revision+1});
    Database::finish(&mut tx, owner, "tags.link", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn playbook(s: &Services, owner: Uuid, key: &str, input: PlaybookInput) -> Result<Value> {
    if input.name.trim().is_empty() || input.change.trim().is_empty() {
        return Err(Error::bad("playbook_details_required"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "playbooks.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    for id in &input.evidence_call_ids {
        calls::require_call(&mut tx, owner, *id).await?;
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO playbooks(id,owner_id,parent_id,body) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(input.parent_id)
        .bind(&body)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO playbook_events(id,owner_id,playbook_id,status) VALUES($1,$2,$3,'candidate')",
    )
    .bind(Uuid::new_v4())
    .bind(owner)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let v = json!({"id":id,"status":"candidate"});
    Database::finish(&mut tx, owner, "playbooks.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn link(s: &Services, owner: Uuid, key: &str, input: EpisodeLink) -> Result<Value> {
    if !matches!(input.status.as_str(), "confirmed" | "explicit" | "rejected") {
        return Err(Error::bad("invalid_link_status"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "episodes.link", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, input.call_id).await?;
    calls::bump(&mut tx, owner, input.call_id, input.expected_revision).await?;
    let compatible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM episodes e JOIN calls c ON c.owner_id=e.owner_id AND c.instrument=e.instrument AND c.market=e.market WHERE e.owner_id=$1 AND e.id=$2 AND c.id=$3)").bind(owner).bind(input.episode_id).bind(input.call_id).fetch_one(&mut *tx).await?;
    if !compatible {
        return Err(Error::bad("incompatible_episode"));
    }
    sqlx::query(
        "INSERT INTO episode_links(id,owner_id,episode_id,call_id,status) VALUES($1,$2,$3,$4,$5)",
    )
    .bind(Uuid::new_v4())
    .bind(owner)
    .bind(input.episode_id)
    .bind(input.call_id)
    .bind(input.status)
    .execute(&mut *tx)
    .await?;
    event(
        &mut tx,
        owner,
        Some(input.call_id),
        "episode.linked",
        body.clone(),
    )
    .await?;
    let v = json!({"revision":input.expected_revision+1});
    Database::finish(&mut tx, owner, "episodes.link", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn collection(
    s: &Services,
    owner: Uuid,
    kind: &str,
    after: Option<Uuid>,
) -> Result<Value> {
    // Fixed allow-list; never pass model/user text into an SQL identifier.
    let table = match kind {
        "tags" => "tags",
        "playbooks" => "playbooks",
        "episodes" => "episodes",
        "verdicts" => "verdicts",
        _ => return Err(Error::not_found()),
    };
    let rows:Vec<Value>=sqlx::query_scalar(&format!("SELECT to_jsonb(t)-'owner_id' FROM {table} t WHERE owner_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 101")).bind(owner).bind(after).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    let next = if more {
        items.last().map(|x| x["id"].clone())
    } else {
        None
    };
    Ok(json!({"items":items,"next_cursor":next}))
}
pub async fn queue(s: &Services, owner: Uuid) -> Result<Value> {
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('call_id',c.id,'submitted_at',c.submitted_at,'original_text',c.original_text,'reason','not_reviewed') FROM calls c WHERE owner_id=$1 AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.owner_id=c.owner_id AND r.call_id=c.id) ORDER BY submitted_at,id LIMIT 100").bind(owner).fetch_all(&s.db.pool).await?;
    Ok(json!({"items":rows,"queue_policy":"unreviewed_v1","limit":100}))
}
pub async fn events(s: &Services, owner: Uuid, after: i64) -> Result<Value> {
    let rows=sqlx::query("SELECT sequence,to_jsonb(e)-'owner_id' AS body FROM events e WHERE owner_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100").bind(owner).bind(after).fetch_all(&s.db.pool).await?;
    let cursor = rows
        .last()
        .map(|r| r.get::<i64, _>("sequence"))
        .unwrap_or(after);
    Ok(
        json!({"items":rows.iter().map(|r|r.get::<Value,_>("body")).collect::<Vec<_>>(),"cursor":cursor,"transport":"poll"}),
    )
}
pub async fn episode(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    let e: Value = sqlx::query_scalar(
        "SELECT to_jsonb(e)-'owner_id' FROM episodes e WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)?;
    let links:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(l)-'owner_id' FROM episode_links l WHERE owner_id=$1 AND episode_id=$2 ORDER BY created_at,id").bind(owner).bind(id).fetch_all(&s.db.pool).await?;
    Ok(json!({"episode":e,"links":links}))
}
// Kept as a stable application entry point; all model tool logic has its own module.
pub async fn tool(s: &Services, owner: Uuid, input: ToolCall) -> Result<Value> {
    super::model_access::call(s, owner, input).await
}

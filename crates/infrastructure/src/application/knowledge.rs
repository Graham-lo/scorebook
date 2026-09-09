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
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "reviews.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let v = review_tx(&mut tx, owner, &input).await?;
    Database::finish(&mut tx, owner, "reviews.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn review_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    input: &Review,
) -> Result<Value> {
    if !matches!(input.vs_last.as_str(), "did" | "did_not" | "new" | "keep") {
        return Err(Error::bad("invalid_review_action"));
    }
    if (input.note.trim().is_empty()
        && input
            .better_play
            .as_ref()
            .is_none_or(|v| v.trim().is_empty()))
        || input.note.len() > 100_000
        || input
            .better_play
            .as_ref()
            .is_some_and(|v| v.len() > 100_000)
    {
        return Err(Error::bad("review_content_required_or_too_large"));
    }
    calls::require_call(tx, owner, input.call_id).await?;
    calls::bump(tx, owner, input.call_id, input.expected_revision).await?;
    // The same immutable call lock serializes head publication and recording what the trader reviewed.
    sqlx::query("SELECT id FROM calls WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(input.call_id)
        .fetch_one(&mut **tx)
        .await?;
    let heads: Vec<Uuid> = sqlx::query_scalar(
        "SELECT outcome_id FROM outcome_heads WHERE owner_id=$1 AND call_id=$2 ORDER BY outcome_id",
    )
    .bind(owner)
    .bind(input.call_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut expected = input.expected_outcome_ids.clone();
    expected.sort();
    if expected != heads {
        return Err(Error::conflict("review_outcomes_changed"));
    }

    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO reviews(id,owner_id,call_id,body) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(input.call_id)
        .bind(json!(input))
        .execute(&mut **tx)
        .await?;
    sqlx::query("INSERT INTO review_outcome_refs SELECT $1,$2,outcome_id FROM outcome_heads WHERE owner_id=$1 AND call_id=$3").bind(owner).bind(id).bind(input.call_id).execute(&mut **tx).await?;
    sqlx::query("UPDATE review_preferences SET snoozed_until=NULL,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND call_id=$2")
        .bind(owner)
        .bind(input.call_id)
        .execute(&mut **tx)
        .await?;
    super::review_projection::refresh(tx, owner, input.call_id).await?;
    event(
        tx,
        owner,
        Some(input.call_id),
        "review.created",
        json!({"review_id":id}),
    )
    .await?;
    Ok(json!({"id":id,"revision":input.expected_revision+1,"saved_at":chrono::Utc::now()}))
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
    let id = create_tag_tx(
        &mut tx,
        owner,
        &input.name,
        &input.definition,
        &input.aliases,
    )
    .await?;
    let version: i64 = sqlx::query_scalar("SELECT version FROM tags WHERE owner_id=$1 AND id=$2")
        .bind(owner)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let prior:Option<(Uuid,Uuid)>=sqlx::query_as("SELECT t.id,r.root_id FROM tags t JOIN tag_revisions r ON r.owner_id=t.owner_id AND r.tag_id=t.id WHERE t.owner_id=$1 AND t.name=$2 AND t.id<>$3 ORDER BY t.version DESC LIMIT 1").bind(owner).bind(&input.name).bind(id).fetch_optional(&mut *tx).await?;
    sqlx::query("INSERT INTO tag_revisions(owner_id,tag_id,root_id,parent_id,reason) VALUES($1,$2,$3,$4,'explicit_tag_definition')").bind(owner).bind(id).bind(prior.map(|v|v.1).unwrap_or(id)).bind(prior.map(|v|v.0)).execute(&mut *tx).await?;
    let v = json!({"id":id,"version":version});
    Database::finish(&mut tx, owner, "tags.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn create_tag_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    name: &str,
    definition: &str,
    aliases: &[String],
) -> Result<Uuid> {
    if name.trim().is_empty()
        || name.len() > 200
        || definition.len() > 100000
        || aliases.len() > 100
        || aliases.iter().any(|a| a.is_empty() || a.len() > 200)
    {
        return Err(Error::bad("invalid_tag"));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,3))")
        .bind(format!("{owner}:{name}"))
        .execute(&mut **tx)
        .await?;
    let version: i64 = sqlx::query_scalar(
        "SELECT COALESCE(max(version),0)+1 FROM tags WHERE owner_id=$1 AND name=$2",
    )
    .bind(owner)
    .bind(name)
    .fetch_one(&mut **tx)
    .await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tags(id,owner_id,name,definition,aliases,version) VALUES($1,$2,$3,$4,$5,$6)",
    )
    .bind(id)
    .bind(owner)
    .bind(name)
    .bind(definition)
    .bind(aliases)
    .bind(version)
    .execute(&mut **tx)
    .await?;
    Ok(id)
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
    sqlx::query("SELECT id FROM episodes WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(input.episode_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::not_found)?;
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
    let links:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(l)-'owner_id' FROM episode_links l WHERE owner_id=$1 AND episode_id=$2 ORDER BY created_at DESC,id DESC LIMIT 101").bind(owner).bind(id).fetch_all(&s.db.pool).await?;
    Ok(json!({"episode":e,"links":links}))
}
// Kept as a stable application entry point; all model tool logic has its own module.
pub async fn tool(s: &Services, owner: Uuid, input: ToolCall) -> Result<Value> {
    super::model_access::call(s, owner, input).await
}

//! Resumable review work. Draft saves never edit the original call or a published review.
use super::{Services, calls, dto::Review, knowledge};
use crate::{
    adapters::db::Database,
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
pub use scorebook_core::api::review_workflow::*;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

pub async fn draft(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    let v:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('call_revision',st.revision,'draft_revision',st.draft_revision,'current_outcome_ids',(SELECT COALESCE(jsonb_agg(outcome_id ORDER BY outcome_id),'[]') FROM outcome_heads h WHERE h.owner_id=st.owner_id AND h.call_id=st.call_id),'draft',(SELECT to_jsonb(d)-'owner_id' FROM review_drafts d WHERE d.owner_id=st.owner_id AND d.call_id=st.call_id)) FROM call_state st WHERE owner_id=$1 AND call_id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?;
    v.ok_or_else(Error::not_found)
}
pub async fn save(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: DraftInput,
) -> Result<Value> {
    if input.note.len() > 100_000
        || input
            .better_play
            .as_ref()
            .is_some_and(|v| v.len() > 100_000)
        || input
            .vs_last
            .as_ref()
            .is_some_and(|v| !matches!(v.as_str(), "did" | "did_not" | "new" | "keep"))
    {
        return Err(Error::bad("invalid_review_draft"));
    }
    let body = json!({"call_id":id,"draft":input});
    let (mut tx, cached) = s.db.write(owner, "review_draft.save", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    // A monotonic clock on the parent survives deletion of a published draft.
    let revision:Option<i64>=sqlx::query_scalar("UPDATE call_state SET draft_revision=draft_revision+1 WHERE owner_id=$1 AND call_id=$2 AND draft_revision=$3 RETURNING draft_revision").bind(owner).bind(id).bind(input.expected_draft_revision).fetch_optional(&mut *tx).await?;
    let revision = revision.ok_or_else(|| Error::conflict("draft_revision_conflict"))?;
    let saved:Value=sqlx::query_scalar("INSERT INTO review_drafts(owner_id,call_id,body,revision) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,call_id) DO UPDATE SET body=EXCLUDED.body,revision=EXCLUDED.revision,updated_at=now() RETURNING to_jsonb(review_drafts)-'owner_id'-'body'").bind(owner).bind(id).bind(json!({"note":input.note,"better_play":input.better_play,"vs_last":input.vs_last})).bind(revision).fetch_one(&mut *tx).await?;
    super::review_projection::refresh(&mut tx, owner, id).await?;
    Database::finish(&mut tx, owner, "review_draft.save", key, &body, &saved).await?;
    tx.commit().await?;
    Ok(saved)
}
pub async fn publish(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: PublishDraft,
) -> Result<Value> {
    let body = json!({"call_id":id,"publish":input});
    let (mut tx, cached) =
        s.db.write(owner, "review_draft.publish", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    sqlx::query("SELECT revision FROM call_state WHERE owner_id=$1 AND call_id=$2 FOR UPDATE")
        .bind(owner)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::not_found)?;
    let row = sqlx::query(
        "SELECT revision,body FROM review_drafts WHERE owner_id=$1 AND call_id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(Error::not_found)?;
    if row.get::<i64, _>("revision") != input.expected_draft_revision {
        return Err(Error::conflict("draft_revision_conflict"));
    }
    let draft: Value = row.get("body");
    let review = Review {
        expected_outcome_ids: input.expected_outcome_ids,
        call_id: id,
        expected_revision: input.expected_call_revision,
        note: draft["note"].as_str().unwrap_or("").into(),
        better_play: draft["better_play"].as_str().map(str::to_string),
        vs_last: draft["vs_last"]
            .as_str()
            .ok_or_else(|| Error::bad("review_action_required"))?
            .into(),
    };
    let mut result = knowledge::review_tx(&mut tx, owner, &review).await?;
    let next:i64=sqlx::query_scalar("UPDATE call_state SET draft_revision=draft_revision+1 WHERE owner_id=$1 AND call_id=$2 RETURNING draft_revision").bind(owner).bind(id).fetch_one(&mut *tx).await?;
    result["draft_revision"] = json!(next);
    sqlx::query("DELETE FROM review_drafts WHERE owner_id=$1 AND call_id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    super::review_projection::refresh(&mut tx, owner, id).await?;
    Database::finish(&mut tx, owner, "review_draft.publish", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn snooze(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: SnoozeInput,
) -> Result<Value> {
    if input
        .until
        .is_some_and(|v| v <= Utc::now() || v > Utc::now() + chrono::Duration::days(365))
    {
        return Err(Error::bad("invalid_review_reminder_time"));
    }
    let body = json!({"call_id":id,"preference":input});
    let (mut tx, cached) = s.db.write(owner, "review.snooze", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    sqlx::query("SELECT revision FROM call_state WHERE owner_id=$1 AND call_id=$2 FOR UPDATE")
        .bind(owner)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(Error::not_found)?;
    let prior: Option<i64> = sqlx::query_scalar(
        "SELECT revision FROM review_preferences WHERE owner_id=$1 AND call_id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if prior.unwrap_or(0) != input.expected_revision {
        return Err(Error::conflict("review_preference_conflict"));
    }
    let result:Value=sqlx::query_scalar("INSERT INTO review_preferences(owner_id,call_id,snoozed_until) VALUES($1,$2,$3) ON CONFLICT(owner_id,call_id) DO UPDATE SET snoozed_until=EXCLUDED.snoozed_until,revision=review_preferences.revision+1,updated_at=now() RETURNING to_jsonb(review_preferences)-'owner_id'").bind(owner).bind(id).bind(input.until).fetch_one(&mut *tx).await?;
    super::review_projection::refresh(&mut tx, owner, id).await?;
    Database::finish(&mut tx, owner, "review.snooze", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn queue(s: &Services, owner: Uuid, filter: QueueFilter) -> Result<Value> {
    let bucket = filter.bucket.as_deref().unwrap_or("needs_review");
    if !matches!(
        bucket,
        "needs_review" | "in_progress" | "completed" | "snoozed" | "all"
    ) {
        return Err(Error::bad("invalid_review_bucket"));
    }
    let cursor: Option<(DateTime<Utc>, Uuid)> = filter
        .cursor
        .as_ref()
        .map(|v| serde_json::from_str(v).map_err(|_| Error::bad("invalid_cursor")))
        .transpose()?;
    let limit = filter.limit.unwrap_or(20).clamp(1, 100);
    let selection = match bucket {
        "all" => "true".to_string(),
        "snoozed" => "p.snoozed_until>now()".to_string(),
        _ => format!(
            "p.base_bucket='{bucket}' AND (p.snoozed_until IS NULL OR p.snoozed_until<=now())"
        ),
    };
    let sql = format!(
        r#"SELECT jsonb_build_object('id',c.id,'submitted_at',c.submitted_at,'original_text',left(c.original_text,500),'instrument',c.instrument,'timeframe',c.timeframe,'revision',st.revision,
        'draft_revision',p.draft_revision,'draft_saved_at',p.draft_saved_at,'snoozed_until',p.snoozed_until,'preference_revision',p.preference_revision,
        'latest_review_id',p.latest_review_id,'reviewed_at',p.reviewed_at,'bucket',CASE WHEN p.snoozed_until>now() THEN 'snoozed' ELSE p.base_bucket END,
        'reason',CASE WHEN p.base_bucket='in_progress' THEN 'continue_draft' WHEN p.latest_review_id IS NULL THEN 'first_review' WHEN p.base_bucket='needs_review' THEN 'new_outcome' ELSE 'reviewed' END,
        'assessments',(SELECT COALESCE(jsonb_agg(jsonb_build_object('claim_no',a.claim_no,'state',a.state,'due_at',a.due_at) ORDER BY a.claim_no),'[]') FROM assessments a WHERE a.owner_id=p.owner_id AND a.call_id=p.call_id))
        FROM review_queue_projection p JOIN calls c ON c.owner_id=p.owner_id AND c.id=p.call_id JOIN call_state st ON st.owner_id=p.owner_id AND st.call_id=p.call_id
        WHERE p.owner_id=$1 AND NOT p.voided AND ({selection}) AND ($2::timestamptz IS NULL OR (p.submitted_at,p.call_id)<($2,$3))
        ORDER BY p.submitted_at DESC,p.call_id DESC LIMIT $4"#
    );
    let rows: Vec<Value> = sqlx::query_scalar(&sql)
        .bind(owner)
        .bind(cursor.map(|v| v.0))
        .bind(cursor.map(|v| v.1))
        .bind(limit + 1)
        .fetch_all(&s.db.pool)
        .await?;
    let more = rows.len() > limit as usize;
    let items: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let next = if more {
        items
            .last()
            .map(|v| json!([v["submitted_at"], v["id"]]).to_string())
    } else {
        None
    };
    Ok(
        json!({"items":items,"next_cursor":next,"bucket":bucket,"order":"newest_submission_first","refresh_on_status_change":true}),
    )
}

pub async fn discard(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: DiscardDraft,
) -> Result<Value> {
    let body = json!({"call_id":id,"discard":input});
    let (mut tx, cached) =
        s.db.write(owner, "review_draft.discard", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    let next:Option<i64>=sqlx::query_scalar("UPDATE call_state st SET draft_revision=draft_revision+1 WHERE owner_id=$1 AND call_id=$2 AND draft_revision=$3 AND EXISTS(SELECT 1 FROM review_drafts d WHERE d.owner_id=st.owner_id AND d.call_id=st.call_id) RETURNING draft_revision").bind(owner).bind(id).bind(input.expected_draft_revision).fetch_optional(&mut *tx).await?;
    let next = next.ok_or_else(|| Error::conflict("draft_revision_conflict"))?;
    sqlx::query("DELETE FROM review_drafts WHERE owner_id=$1 AND call_id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let v = json!({"call_id":id,"draft":null,"draft_revision":next});
    super::review_projection::refresh(&mut tx, owner, id).await?;
    Database::finish(&mut tx, owner, "review_draft.discard", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

//! Additions never rewrite the original record or silently rescore it.
use super::{Services, calls};
use crate::{
    adapters::db::{Database, event},
    error::{Error, Result},
};
pub use scorebook_core::api::record_changes::*;
use serde_json::{Value, json};
use uuid::Uuid;

pub async fn supplement(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: AttachmentLink,
) -> Result<Value> {
    let body = json!(input);
    let op = format!("calls.supplement.{id}");
    let (mut tx, cached) = s.db.write(owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    calls::bump(&mut tx, owner, id, input.expected_revision).await?;
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_optional(&mut *tx)
            .await?;
    if !matches!(kind.as_deref(), Some("supplement" | "reference")) {
        return Err(Error::bad("supplement_or_reference_required"));
    }
    sqlx::query("INSERT INTO call_attachments VALUES($1,$2,$3) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(id)
        .bind(input.attachment_id)
        .execute(&mut *tx)
        .await?;
    event(&mut tx, owner, Some(id), "attachment.added", body.clone()).await?;
    let v = json!({"revision":input.expected_revision+1,"identity":"later_supplement","original_evidence_unchanged":true});
    Database::finish(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn correction(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: Correction,
) -> Result<Value> {
    if !matches!(
        input.category.as_str(),
        "metadata_evidence" | "parser_error" | "annotation"
    ) || input.explanation.trim().is_empty()
    {
        return Err(Error::bad(
            "invalid_correction; changed_prediction_requires_new_record",
        ));
    }
    let body = json!(input);
    let op = format!("calls.correction.{id}");
    let (mut tx, cached) = s.db.write(owner, &op, key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, id).await?;
    calls::bump(&mut tx, owner, id, input.expected_revision).await?;
    if let Some(a) = input.evidence_attachment {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)",
        )
        .bind(owner)
        .bind(a)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(Error::bad("invalid_evidence_reference"));
        }
    }
    event(
        &mut tx,
        owner,
        Some(id),
        "correction.requested",
        body.clone(),
    )
    .await?;
    let v = json!({"revision":input.expected_revision+1,"status":"recorded_for_review","automatic_rescore":false});
    Database::finish(&mut tx, owner, &op, key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

//! Explicit deletion and restoration are the only ways evidence leaves/enters the store.
use super::{Services, calls};
use crate::{
    adapters::db::{Database, event, hash_bytes},
    error::{Error, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeletePreview {
    pub call_id: Uuid,
    pub expected_revision: i64,
}
#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DeleteConfirm {
    pub request_id: Uuid,
    pub confirmation_token: String,
}
pub async fn preview(s: &Services, owner: Uuid, key: &str, input: DeletePreview) -> Result<Value> {
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "deletions.preview", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    calls::require_call(&mut tx, owner, input.call_id).await?;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM call_state WHERE owner_id=$1 AND call_id=$2")
            .bind(owner)
            .bind(input.call_id)
            .fetch_one(&mut *tx)
            .await?;
    if revision != input.expected_revision {
        return Err(Error::conflict("revision_conflict"));
    }
    let request = Uuid::new_v4();
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO deletion_requests(id,owner_id,call_id,expected_revision,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')").bind(request).bind(owner).bind(input.call_id).bind(revision).bind(hash_bytes(token.as_bytes())).execute(&mut *tx).await?;
    let v = json!({"request_id":request,"confirmation_token":token,"call_id":input.call_id,"effects":["original_record_and_reviews","outcomes_and_market_inputs","unshared_images_and_vectors","search_and_set_snapshots_containing_record","local_export_cache"],"retained":"minimal_tombstone; independently_referenced_images","external_exports":"cannot_recall_external_copies"});
    Database::finish(&mut tx, owner, "deletions.preview", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn confirm(s: &Services, owner: Uuid, key: &str, input: DeleteConfirm) -> Result<Value> {
    let body = json!(input);
    // Exclusive tenant maintenance lock serializes deletion with writes and logical exports.
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await?;
    let cached:Option<Value>=sqlx::query_scalar("SELECT response FROM requests WHERE owner_id=$1 AND operation='deletions.confirm' AND key=$2 AND digest=$3").bind(owner).bind(key).bind(crate::adapters::db::digest(&body)).fetch_optional(&mut *tx).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let request=sqlx::query("SELECT call_id,expected_revision FROM deletion_requests WHERE owner_id=$1 AND id=$2 AND token_hash=$3 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE").bind(owner).bind(input.request_id).bind(hash_bytes(input.confirmation_token.as_bytes())).fetch_optional(&mut *tx).await?.ok_or_else(||Error::bad("invalid_or_expired_confirmation"))?;
    let id: Uuid = request.get("call_id");
    calls::bump(&mut tx, owner, id, request.get("expected_revision")).await?;
    let images: Vec<Uuid> = sqlx::query_scalar(
        "SELECT attachment_id FROM call_attachments WHERE owner_id=$1 AND call_id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let pattern = format!("%{id}%");
    sqlx::query("DELETE FROM verdicts WHERE owner_id=$1 AND set_id IN (SELECT id FROM set_snapshots WHERE owner_id=$1 AND members::text LIKE $2)").bind(owner).bind(&pattern).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM set_snapshots WHERE owner_id=$1 AND members::text LIKE $2")
        .bind(owner)
        .bind(&pattern)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM similarity_sessions WHERE owner_id=$1 AND results::text LIKE $2")
        .bind(owner)
        .bind(&pattern)
        .execute(&mut *tx)
        .await?;
    let export_ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM jobs WHERE owner_id=$1 AND kind='export'")
            .bind(owner)
            .fetch_all(&mut *tx)
            .await?;
    sqlx::query("DELETE FROM jobs WHERE owner_id=$1 AND (body::text LIKE $2 OR kind='export')")
        .bind(owner)
        .bind(&pattern)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM calls WHERE owner_id=$1 AND id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let mut remove = vec![];
    for image in images {
        let shared: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM call_attachments WHERE owner_id=$1 AND attachment_id=$2)",
        )
        .bind(owner)
        .bind(image)
        .fetch_one(&mut *tx)
        .await?;
        if !shared {
            sqlx::query("DELETE FROM attachments WHERE owner_id=$1 AND id=$2")
                .bind(owner)
                .bind(image)
                .execute(&mut *tx)
                .await?;
            remove.push(image);
        }
    }
    // Preserve idempotency tombstones so an old client retry cannot recreate deleted evidence.
    sqlx::query("UPDATE requests SET response=jsonb_build_object('deleted',true,'reason','referenced_evidence_deleted') WHERE owner_id=$1 AND (response::text LIKE $2 OR operation IN ('exports.create','similarity.search','sets.resolve'))").bind(owner).bind(pattern).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO tombstones(id,owner_id,entity_type) VALUES($1,$2,'call')")
        .bind(id)
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE deletion_requests SET consumed_at=now() WHERE owner_id=$1 AND id=$2")
        .bind(owner)
        .bind(input.request_id)
        .execute(&mut *tx)
        .await?;
    let cleanup = super::jobs::enqueue_tx(
        &mut tx,
        owner,
        "purge_files",
        &id.to_string(),
        json!({"attachment_ids":remove,"export_ids":export_ids}),
    )
    .await?;
    event(&mut tx, owner, None, "call.deleted", json!({"id":id})).await?;
    let v = json!({"id":id,"deleted":true,"file_cleanup_job":cleanup,"physical_cleanup":"pending","external_exports":"not_recalled"});
    Database::finish(&mut tx, owner, "deletions.confirm", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

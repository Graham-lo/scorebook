//! Explicit deletion and restoration are the only ways evidence leaves/enters the store.
use super::{Services, calls};
use crate::{
    adapters::db::{Database, event, hash_bytes},
    error::{Error, Result},
};
pub use scorebook_core::api::lifecycle::*;
use serde_json::{Value, json};
use sqlx::Row;
use uuid::Uuid;

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
    let pinned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM export_artifacts a WHERE a.owner_id=$1 AND a.lease_until>now() AND (a.state='writing' OR (a.state='copying' AND EXISTS(SELECT 1 FROM export_refs r WHERE r.owner_id=a.owner_id AND r.export_id=a.id AND r.entity_type='call' AND r.entity_id=$2))))").bind(owner).bind(id).fetch_one(&mut *tx).await?;
    if pinned {
        return Err(Error::conflict("export_in_progress"));
    }
    calls::bump(&mut tx, owner, id, request.get("expected_revision")).await?;
    let images: Vec<Uuid> = sqlx::query_scalar(
        "SELECT attachment_id FROM call_attachments WHERE owner_id=$1 AND call_id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let remove:Vec<Uuid>=sqlx::query_scalar("SELECT a.id FROM attachments a WHERE a.owner_id=$1 AND a.id=ANY($2) AND NOT EXISTS(SELECT 1 FROM call_attachments l WHERE l.owner_id=$1 AND l.attachment_id=a.id AND l.call_id<>$3)").bind(owner).bind(&images).bind(id).fetch_all(&mut *tx).await?;
    let sets: Vec<Uuid> =
        sqlx::query_scalar("SELECT set_id FROM set_members WHERE owner_id=$1 AND call_id=$2")
            .bind(owner)
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let sessions:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT session_id FROM search_result_refs WHERE owner_id=$1 AND ((entity_type='call' AND entity_id=$2) OR (entity_type='attachment' AND entity_id=ANY($3)))").bind(owner).bind(id).bind(&remove).fetch_all(&mut *tx).await?;
    let export_ids:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT export_id FROM export_refs WHERE owner_id=$1 AND ((entity_type='call' AND entity_id=$2) OR (entity_type='attachment' AND entity_id=ANY($3)))").bind(owner).bind(id).bind(&remove).fetch_all(&mut *tx).await?;
    let target_jobs:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT job_id FROM job_targets WHERE owner_id=$1 AND ((entity_type='call' AND entity_id=$2) OR (entity_type='attachment' AND entity_id=ANY($3)))").bind(owner).bind(id).bind(&remove).fetch_all(&mut *tx).await?;
    sqlx::query("UPDATE requests q SET response=jsonb_build_object('deleted',true,'reason','referenced_evidence_deleted') WHERE q.owner_id=$1 AND EXISTS(SELECT 1 FROM request_refs r WHERE r.owner_id=q.owner_id AND r.operation=q.operation AND r.key=q.key AND ((r.entity_type='call' AND r.entity_id=$2) OR (r.entity_type='attachment' AND r.entity_id=ANY($3)) OR (r.entity_type='set' AND r.entity_id=ANY($4)) OR (r.entity_type='session' AND r.entity_id=ANY($5)) OR (r.entity_type IN ('job','export') AND (r.entity_id=ANY($6) OR r.entity_id=ANY($7)))))").bind(owner).bind(id).bind(&remove).bind(&sets).bind(&sessions).bind(&export_ids).bind(&target_jobs).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM verdicts WHERE owner_id=$1 AND set_id=ANY($2)")
        .bind(owner)
        .bind(&sets)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM set_snapshots WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&sets)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM similarity_sessions WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&sessions)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM jobs WHERE owner_id=$1 AND (id=ANY($2) OR id=ANY($3))")
        .bind(owner)
        .bind(&target_jobs)
        .bind(&export_ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE export_artifacts SET state='expired' WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&export_ids)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM calls WHERE owner_id=$1 AND id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM attachments WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&remove)
        .execute(&mut *tx)
        .await?;
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

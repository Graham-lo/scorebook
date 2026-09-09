//! Every cleanup transaction handles bounded batches. Original records and write identities never expire.
use super::Services;
use crate::error::Result;
use serde_json::{Value, json};
use uuid::Uuid;
pub async fn owner(s: &Services, owner: Uuid) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await?;
    // An active snapshot protects its rows and files from GC as well as explicit deletion.
    let pinned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM export_artifacts WHERE owner_id=$1 AND state IN ('writing','copying') AND lease_until>now()) OR EXISTS(SELECT 1 FROM backup_protections WHERE owner_id=$1 AND lease_until>now())").bind(owner).fetch_one(&mut *tx).await?;
    if pinned {
        return Ok(json!({"deferred":"export_in_progress"}));
    }
    let sessions:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM similarity_sessions WHERE owner_id=$1 AND NOT saved AND expires_at<=now() ORDER BY expires_at,id LIMIT 500 FOR UPDATE SKIP LOCKED").bind(owner).fetch_all(&mut *tx).await?;
    sqlx::query("UPDATE requests q SET response=jsonb_build_object('expired',true,'reason','search_session_expired') WHERE q.owner_id=$1 AND EXISTS(SELECT 1 FROM request_refs r WHERE r.owner_id=q.owner_id AND r.operation=q.operation AND r.key=q.key AND r.entity_type='session' AND r.entity_id=ANY($2))").bind(owner).bind(&sessions).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM similarity_sessions WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&sessions)
        .execute(&mut *tx)
        .await?;
    let images:Vec<Uuid>=sqlx::query_scalar("SELECT a.id FROM attachments a WHERE a.owner_id=$1 AND a.kind='query' AND a.uploaded_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM call_attachments l WHERE l.owner_id=a.owner_id AND l.attachment_id=a.id) AND NOT EXISTS(SELECT 1 FROM search_result_refs r WHERE r.owner_id=a.owner_id AND r.entity_type='attachment' AND r.entity_id=a.id) AND NOT EXISTS(SELECT 1 FROM job_targets t JOIN jobs j ON j.id=t.job_id WHERE t.owner_id=a.owner_id AND t.entity_type='attachment' AND t.entity_id=a.id AND j.status IN ('queued','running','retry_wait')) ORDER BY a.uploaded_at,a.id LIMIT 200 FOR UPDATE SKIP LOCKED").bind(owner).fetch_all(&mut *tx).await?;
    sqlx::query("UPDATE requests q SET response=jsonb_build_object('expired',true,'reason','query_image_expired') WHERE q.owner_id=$1 AND EXISTS(SELECT 1 FROM request_refs r WHERE r.owner_id=q.owner_id AND r.operation=q.operation AND r.key=q.key AND r.entity_type='attachment' AND r.entity_id=ANY($2))").bind(owner).bind(&images).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM attachments WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&images)
        .execute(&mut *tx)
        .await?;
    let orphans:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM storage_objects WHERE owner_id=$1 AND state='pending' AND created_at<now()-interval '24 hours' ORDER BY created_at,id LIMIT 200 FOR UPDATE SKIP LOCKED").bind(owner).fetch_all(&mut *tx).await?;
    let remove: Vec<_> = images.iter().chain(&orphans).copied().collect();
    sqlx::query("UPDATE storage_objects SET state='expired',updated_at=now() WHERE owner_id=$1 AND id=ANY($2)").bind(owner).bind(&remove).execute(&mut *tx).await?;
    let exports:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM export_artifacts WHERE owner_id=$1 AND ((state='ready' AND expires_at<=now()) OR (state IN ('writing','copying','failed') AND lease_until<now()-interval '1 day')) ORDER BY expires_at,id LIMIT 50 FOR UPDATE SKIP LOCKED").bind(owner).fetch_all(&mut *tx).await?;
    sqlx::query("UPDATE export_artifacts SET state='expired' WHERE owner_id=$1 AND id=ANY($2)")
        .bind(owner)
        .bind(&exports)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM export_pins WHERE owner_id=$1 AND export_id=ANY($2)")
        .bind(owner)
        .bind(&exports)
        .execute(&mut *tx)
        .await?;
    sqlx::query("WITH expired AS(SELECT operation,key FROM requests WHERE owner_id=$1 AND operation IN ('similarity.search','similarity.hybrid','history.search','review_draft.save') AND created_at<now()-interval '7 days' AND NOT response ? 'expired' AND NOT response ? 'deleted' ORDER BY created_at,operation,key LIMIT 500 FOR UPDATE SKIP LOCKED) UPDATE requests r SET response=jsonb_build_object('expired',true,'reason','transient_result_expired','session_id',response->'session_id') FROM expired e WHERE r.owner_id=$1 AND r.operation=e.operation AND r.key=e.key").bind(owner).execute(&mut *tx).await?;
    let attempts=sqlx::query("WITH expired AS(SELECT job_id,attempt FROM job_attempts WHERE owner_id=$1 AND finished_at<now()-interval '30 days' ORDER BY finished_at,job_id,attempt LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM job_attempts a USING expired e WHERE a.owner_id=$1 AND a.job_id=e.job_id AND a.attempt=e.attempt").bind(owner).execute(&mut *tx).await?.rows_affected();
    if !remove.is_empty() || !exports.is_empty() {
        super::jobs::enqueue_tx(
            &mut tx,
            owner,
            "purge_files",
            &Uuid::new_v4().to_string(),
            json!({"attachment_ids":remove,"export_ids":exports}),
        )
        .await?;
    }
    let runs:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('export_id',r.export_id,'token',r.token) FROM export_runs r JOIN export_artifacts a ON a.owner_id=r.owner_id AND a.id=r.export_id WHERE r.owner_id=$1 AND r.created_at<now()-interval '1 day' AND NOT(a.lease_token=r.token AND a.state IN ('writing','copying') AND a.lease_until>now()) ORDER BY r.created_at,r.export_id,r.token LIMIT 50 FOR UPDATE OF r SKIP LOCKED").bind(owner).fetch_all(&mut *tx).await?;
    if !runs.is_empty() {
        super::jobs::enqueue_tx(
            &mut tx,
            owner,
            "purge_staging",
            &Uuid::new_v4().to_string(),
            json!({"runs":runs}),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(
        json!({"expired_sessions":sessions.len(),"expired_queries":images.len(),"orphan_objects":orphans.len(),"expired_exports":exports.len(),"pruned_attempts":attempts}),
    )
}
pub async fn schedule(s: &Services) -> Result<()> {
    let mut tx = s.db.pool.begin().await?;
    // Detached incomplete public checkpoints are rebuildable, never user evidence. Bound each sweep.
    sqlx::query("WITH stale AS(SELECT id FROM public_market.features f WHERE NOT published AND created_at<now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM public_market.generation_features l WHERE l.feature_id=f.id) ORDER BY created_at,id LIMIT 500 FOR UPDATE SKIP LOCKED) DELETE FROM public_market.features f USING stale s WHERE f.id=s.id").execute(&mut *tx).await?;
    // Indexed round-robin over owners, including owners with no work: no global scan of stale evidence.
    let owners:Vec<Uuid>=sqlx::query_scalar("SELECT owner_id FROM gc_schedule g WHERE last_scheduled_at<now()-interval '5 minutes' AND (SELECT count(*) FROM jobs j WHERE j.owner_id=g.owner_id AND j.queue='maintenance' AND j.status IN ('queued','running','retry_wait'))<40 ORDER BY last_scheduled_at,owner_id LIMIT 20 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
    for owner in owners {
        super::jobs::enqueue_tx(
            &mut tx,
            owner,
            "maintenance.gc",
            &format!("gc:{}", chrono::Utc::now().timestamp().div_euclid(300)),
            json!({"scope":"tenant"}),
        )
        .await?;
        sqlx::query("UPDATE gc_schedule SET last_scheduled_at=now() WHERE owner_id=$1")
            .bind(owner)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

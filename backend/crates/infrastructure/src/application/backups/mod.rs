//! Encrypted recovery copies of a frozen logical archive. Operational credentials
//! and repository configuration are deliberately outside the user archive.
mod runner;
use super::{Services, jobs};
use crate::{
    adapters::db::Database,
    error::{Error, Result, RetryDirective},
};
pub use runner::{restore_snapshot, retention, step};
use scorebook_core::api::backups::*;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::path::Path;
use uuid::Uuid;

pub async fn validate(s: &Services, owner: Uuid, c: &BackupConfiguration) -> Result<()> {
    if !c
        .keychain_service
        .starts_with(&format!("scorebook.backup.{owner}."))
        || c.keychain_service.len() > 200
    {
        return Err(Error::bad(
            "owner_scoped_backup_keychain_reference_required",
        ));
    }
    match c.storage_kind.as_str() {
        "local" | "external_volume" => {
            let p = Path::new(&c.repository);
            if !p.is_absolute()
                || p.components()
                    .any(|x| matches!(x, std::path::Component::ParentDir))
            {
                return Err(Error::bad("absolute_backup_repository_required"));
            }
            let parent = p
                .parent()
                .ok_or_else(|| Error::bad("invalid_backup_repository"))?;
            let parent = tokio::fs::canonicalize(parent).await.map_err(|_| {
                Error::deferred("backup_target_unavailable", RetryDirective::AwaitInput)
            })?;
            let target = parent.join(
                p.file_name()
                    .ok_or_else(|| Error::bad("invalid_backup_repository"))?,
            );
            let root = tokio::fs::canonicalize(&s.storage.root).await?;
            if target.starts_with(&root) || root.starts_with(&target) {
                return Err(Error::bad("backup_repository_must_be_outside_live_storage"));
            }
            if c.storage_kind == "external_volume" {
                use std::os::unix::fs::MetadataExt;
                let mount = c
                    .external_mount
                    .as_ref()
                    .ok_or_else(|| Error::bad("external_mount_required"))?;
                let mount = tokio::fs::canonicalize(mount).await.map_err(|_| {
                    Error::deferred("backup_volume_unmounted", RetryDirective::AwaitInput)
                })?;
                let outer = mount
                    .parent()
                    .ok_or_else(|| Error::bad("invalid_external_mount"))?;
                if !target.starts_with(&mount)
                    || tokio::fs::metadata(&mount).await?.dev()
                        == tokio::fs::metadata(outer).await?.dev()
                    || tokio::fs::metadata(&mount).await?.dev()
                        == tokio::fs::metadata(root).await?.dev()
                {
                    return Err(Error::deferred(
                        "backup_target_is_not_separate_mounted_filesystem",
                        RetryDirective::AwaitInput,
                    ));
                }
            } else if c.external_mount.is_some() {
                return Err(Error::bad("unexpected_external_mount"));
            }
        }
        "s3" | "rest" => {
            if c.external_mount.is_some()
                || !c
                    .repository
                    .starts_with(&format!("{}:https://", c.storage_kind))
            {
                return Err(Error::bad("https_backup_repository_required"));
            }
            let u = reqwest::Url::parse(c.repository.split_once(':').unwrap().1)
                .map_err(|_| Error::bad("invalid_backup_repository"))?;
            if !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
            {
                return Err(Error::bad("backup_credentials_must_use_keychain"));
            }
        }
        _ => return Err(Error::bad("unsupported_backup_storage_kind")),
    }
    Ok(())
}
pub async fn create(s: &Services, owner: Uuid, key: &str, c: BackupConfiguration) -> Result<Value> {
    validate(s, owner, &c).await?;
    let body = json!(c);
    let (mut tx, cached) = s.db.write(owner, "backups.configure", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    if c.enabled {
        sqlx::query("UPDATE backup_configurations SET enabled=false WHERE owner_id=$1 AND enabled")
            .bind(owner)
            .execute(&mut *tx)
            .await?;
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO backup_configurations(id,owner_id,body,enabled) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(owner)
        .bind(body.clone())
        .bind(c.enabled)
        .execute(&mut *tx)
        .await?;
    let v = json!({"configuration_id":id,"initialized":false,"enabled":c.enabled,"recovery_domain":if c.storage_kind=="local" {"same_machine"} else {"operator_selected_external_target"}});
    Database::finish(&mut tx, owner, "backups.configure", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn configuration(
    s: &Services,
    owner: Uuid,
    id: Uuid,
) -> Result<(BackupConfiguration, Option<String>)> {
    let r = sqlx::query(
        "SELECT body,repository_id FROM backup_configurations WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)?;
    Ok((
        serde_json::from_value(r.get("body"))
            .map_err(|_| Error::bad("invalid_backup_configuration"))?,
        r.get("repository_id"),
    ))
}
pub async fn initialize(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    input: BackupInitialize,
) -> Result<Value> {
    let (c, known) = configuration(s, owner, id).await?;
    validate(s, owner, &c).await?;
    s.restic.version().await?;
    if known.is_some() {
        return Ok(json!({"configuration_id":id,"initialized":true}));
    }
    let args = match input.mode.as_str() {
        "create" => vec!["init".into()],
        "open" => vec!["cat".into(), "config".into()],
        _ => return Err(Error::bad("backup_initialize_mode_must_be_create_or_open")),
    };
    let rows = s
        .restic
        .execute(
            &c,
            s.secrets.load(c.keychain_service.clone()).await?,
            &args,
            None,
        )
        .await?;
    let repository = rows
        .iter()
        .find_map(|v| v["id"].as_str())
        .filter(|v| v.len() == 64 && v.bytes().all(|x| x.is_ascii_hexdigit()))
        .ok_or_else(|| Error::bad("backup_repository_identity_missing"))?;
    sqlx::query("UPDATE backup_configurations SET repository_id=$3,initialized_at=now() WHERE owner_id=$1 AND id=$2 AND repository_id IS NULL").bind(owner).bind(id).bind(repository).execute(&s.db.pool).await?;
    Ok(json!({"configuration_id":id,"initialized":true,"repository_id":repository}))
}
async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    id: Uuid,
    key: &str,
) -> Result<Value> {
    let prior:Option<Uuid>=sqlx::query_scalar("SELECT b.id FROM backup_runs b JOIN jobs j ON j.id=b.id WHERE b.owner_id=$1 AND b.configuration_id=$2 AND j.status IN ('queued','running','retry_wait') ORDER BY b.created_at LIMIT 1").bind(owner).bind(id).fetch_optional(&mut **tx).await?;
    if let Some(id) = prior {
        return Ok(json!({"backup_run_id":id,"job_id":id,"status":"already_pending"}));
    }
    let export = jobs::enqueue_tx(
        tx,
        owner,
        "export",
        &format!("backup:{id}:{key}"),
        json!({}),
    )
    .await?;
    let run = jobs::enqueue_tx(
        tx,
        owner,
        "backup.run",
        &format!("{id}:{key}"),
        json!({"configuration_id":id}),
    )
    .await?;
    sqlx::query("INSERT INTO backup_runs(id,owner_id,configuration_id,export_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING").bind(run).bind(owner).bind(id).bind(export).execute(&mut **tx).await?;
    sqlx::query("UPDATE backup_configurations SET next_run_at=now()+interval '30 minutes' WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).execute(&mut **tx).await?;
    Ok(json!({"backup_run_id":run,"job_id":run,"export_id":export,"status":"queued"}))
}
pub async fn request(s: &Services, owner: Uuid, id: Uuid, key: &str) -> Result<Value> {
    let (c, repository) = configuration(s, owner, id).await?;
    validate(s, owner, &c).await?;
    if repository.is_none() {
        return Err(Error::deferred(
            "backup_repository_not_initialized",
            RetryDirective::AwaitInput,
        ));
    }
    let body = json!({"configuration_id":id});
    let (mut tx, cached) = s.db.write(owner, "backups.run", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    sqlx::query("SELECT id FROM backup_configurations WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let v = enqueue(&mut tx, owner, id, key).await?;
    Database::finish(&mut tx, owner, "backups.run", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn schedule(s: &Services) -> Result<()> {
    let mut tx = s.db.pool.begin().await?;
    let rows=sqlx::query("SELECT id,owner_id FROM backup_configurations WHERE enabled AND initialized_at IS NOT NULL AND next_run_at<=now() ORDER BY next_run_at,id LIMIT 10 FOR UPDATE SKIP LOCKED").fetch_all(&mut *tx).await?;
    for row in rows {
        enqueue(
            &mut tx,
            row.get("owner_id"),
            row.get("id"),
            &format!(
                "scheduled:{}",
                chrono::Utc::now().timestamp().div_euclid(1800)
            ),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn status(s: &Services, owner: Uuid) -> Result<Value> {
    let configs:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(c)-'owner_id' FROM backup_configurations c WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100").bind(owner).fetch_all(&s.db.pool).await?;
    let runs:Vec<Value>=sqlx::query_scalar("SELECT (to_jsonb(b)-'owner_id')||jsonb_build_object('job_status',j.status,'error_code',j.error_code) FROM backup_runs b JOIN jobs j ON j.id=b.id WHERE b.owner_id=$1 ORDER BY b.created_at DESC,b.id DESC LIMIT 50").bind(owner).fetch_all(&s.db.pool).await?;
    Ok(
        json!({"configurations":configs,"recent_runs":runs,"schedule_minutes":30,"rpo_target_minutes":60,"rpo_status":"measured_from_last_verified_source_snapshot","restore_requires_separate_empty_database":true}),
    )
}

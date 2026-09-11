use super::super::exports;
use super::*;
use std::{os::unix::fs::PermissionsExt, path::Path};
async fn execute(
    s: &Services,
    c: &BackupConfiguration,
    args: &[String],
    cwd: Option<&Path>,
) -> Result<Vec<Value>> {
    s.restic
        .execute(
            c,
            s.secrets.load(c.keychain_service.clone()).await?,
            args,
            cwd,
        )
        .await
}
fn host(owner: Uuid) -> String {
    format!("scorebook-{owner}")
}
async fn identity(s: &Services, c: &BackupConfiguration, expected: &str) -> Result<()> {
    let rows = execute(s, c, &["cat".into(), "config".into()], None).await?;
    if !rows.iter().any(|v| v["id"] == expected) {
        return Err(Error::deferred(
            "backup_repository_identity_changed",
            RetryDirective::AwaitInput,
        ));
    }
    Ok(())
}
pub async fn step(s: &Services, j: &jobs::Job) -> Result<Value> {
    let r=sqlx::query("SELECT configuration_id,export_id,snapshot_id,status,result FROM backup_runs WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)?;
    if r.get::<String, _>("status") == "verified" {
        return Ok(r.get("result"));
    }
    let config = r.get("configuration_id");
    let export: Uuid = r.get("export_id");
    let (c, repo) = configuration(s, j.owner, config).await?;
    validate(s, j.owner, &c).await?;
    identity(
        s,
        &c,
        repo.as_deref()
            .ok_or_else(|| Error::bad("backup_not_initialized"))?,
    )
    .await?;
    let mut tx = jobs::fence(s, j).await?;
    let ready:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM export_artifacts WHERE owner_id=$1 AND id=$2 AND state='ready' AND expires_at>now())").bind(j.owner).bind(export).fetch_one(&mut *tx).await?;
    if !ready {
        let state: Option<String> =
            sqlx::query_scalar("SELECT status FROM jobs WHERE owner_id=$1 AND id=$2")
                .bind(j.owner)
                .bind(export)
                .fetch_optional(&mut *tx)
                .await?;
        return Err(
            if state
                .as_deref()
                .is_some_and(|x| matches!(x, "queued" | "running" | "retry_wait"))
            {
                Error::deferred(
                    "backup_waiting_for_export",
                    RetryDirective::At(chrono::Utc::now() + chrono::Duration::seconds(15)),
                )
            } else {
                Error::deferred("backup_export_requires_new_run", RetryDirective::AwaitInput)
            },
        );
    }
    sqlx::query("INSERT INTO backup_protections(owner_id,run_id,export_id,lease_until) VALUES($1,$2,$3,now()+interval '40 minutes') ON CONFLICT(owner_id,run_id) DO UPDATE SET lease_until=EXCLUDED.lease_until").bind(j.owner).bind(j.id).bind(export).execute(&mut *tx).await?;
    tx.commit().await?;
    // Each phase is bounded by 30 minutes, below its pin. Cancellation kills the child.
    let source = tokio::fs::canonicalize(exports::directory(s, j.owner, export)).await?;
    exports::verify(&source)
        .await
        .map_err(|_| Error::bad("backup_source_verification_failed"))?;
    let manifest = exports::read_manifest(&source)
        .await
        .map_err(|_| Error::bad("backup_manifest_invalid"))?;
    let hash = exports::hash_file(&source.join("manifest.json")).await?;
    let run_tag = format!("scorebook-run:{}", j.id);
    let hash_tag = format!("manifest:{hash}");
    let snapshot = if let Some(id) = r.get::<Option<String>, _>("snapshot_id") {
        id
    } else {
        let previous = execute(
            s,
            &c,
            &[
                "snapshots".into(),
                "--host".into(),
                host(j.owner),
                "--tag".into(),
                run_tag.clone(),
            ],
            None,
        )
        .await?;
        let found = previous.iter().find(|v| {
            v["tags"]
                .as_array()
                .is_some_and(|tags| tags.contains(&json!(hash_tag)))
        });
        let snapshot = if let Some(v) = found {
            v["id"]
                .as_str()
                .ok_or_else(|| Error::bad("backup_snapshot_id_missing"))?
                .to_string()
        } else {
            let output = execute(
                s,
                &c,
                &[
                    "backup".into(),
                    ".".into(),
                    "--host".into(),
                    host(j.owner),
                    "--tag".into(),
                    run_tag,
                    "--tag".into(),
                    hash_tag,
                    "--tag".into(),
                    "scorebook-v4".into(),
                ],
                Some(&source),
            )
            .await?;
            output
                .iter()
                .find_map(|v| v["snapshot_id"].as_str())
                .ok_or_else(|| Error::bad("backup_snapshot_id_missing"))?
                .to_string()
        };
        let mut tx = jobs::fence(s, j).await?;
        sqlx::query("UPDATE backup_runs SET snapshot_id=$3,status='uploaded',source_snapshot_at=$4 WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(&snapshot).bind(serde_json::from_value::<chrono::DateTime<chrono::Utc>>(manifest["source_snapshot_at"].clone()).map_err(|_|Error::bad("backup_snapshot_time_missing"))?).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM backup_protections WHERE owner_id=$1 AND run_id=$2")
            .bind(j.owner)
            .bind(j.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(Error::deferred(
            "backup_uploaded_verification_pending",
            RetryDirective::At(chrono::Utc::now() + chrono::Duration::seconds(1)),
        ));
    };
    let restored = s.storage.root.join("backup-checks").join(j.id.to_string());
    if tokio::fs::try_exists(&restored).await? {
        tokio::fs::remove_dir_all(&restored).await?;
    }
    let verified = restore_snapshot(s, j.owner, config, &snapshot, &restored).await;
    let _ = tokio::fs::remove_dir_all(&restored).await;
    let verified = verified?;
    let mut tx = jobs::fence(s, j).await?;
    let result = json!({"backup_run_id":j.id,"snapshot_id":snapshot,"manifest_sha256":hash,"verification":verified,"status":"verified","recovery_domain":if c.storage_kind=="local" {"same_machine"}else{"operator_selected_external_target"}});
    sqlx::query("UPDATE backup_runs SET status='verified',completed_at=now(),result=$3 WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(j.id).bind(&result).execute(&mut *tx).await?;
    sqlx::query("UPDATE backup_configurations SET last_success_at=now(),last_snapshot_id=$3 WHERE owner_id=$1 AND id=$2").bind(j.owner).bind(config).bind(&snapshot).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM backup_protections WHERE owner_id=$1 AND run_id=$2")
        .bind(j.owner)
        .bind(j.id)
        .execute(&mut *tx)
        .await?;
    jobs::enqueue_tx(
        &mut tx,
        j.owner,
        "backup.retention",
        &j.id.to_string(),
        json!({"configuration_id":config}),
    )
    .await?;
    tx.commit().await?;
    Ok(result)
}
/// Download to a new private directory, verify every archived row and original.
/// The separate existing `restore` command then publishes into an empty database.
pub async fn restore_snapshot(
    s: &Services,
    owner: Uuid,
    configuration_id: Uuid,
    snapshot: &str,
    destination: &Path,
) -> Result<Value> {
    if snapshot.len() != 64 || !snapshot.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::bad("full_snapshot_id_required"));
    }
    let (c, repo) = configuration(s, owner, configuration_id).await?;
    validate(s, owner, &c).await?;
    identity(
        s,
        &c,
        repo.as_deref()
            .ok_or_else(|| Error::bad("backup_not_initialized"))?,
    )
    .await?;
    if tokio::fs::try_exists(destination).await? {
        return Err(Error::conflict("restore_destination_must_not_exist"));
    }
    tokio::fs::create_dir_all(destination).await?;
    tokio::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700)).await?;
    execute(
        s,
        &c,
        &[
            "restore".into(),
            snapshot.into(),
            "--target".into(),
            destination.to_string_lossy().into_owned(),
            "--verify".into(),
        ],
        None,
    )
    .await?;
    let m = exports::read_manifest(destination)
        .await
        .map_err(|_| Error::bad("restored_manifest_invalid"))?;
    if m["owner_id"] != json!(owner) {
        return Err(Error::bad("restored_owner_mismatch"));
    }
    let report = exports::verify(destination)
        .await
        .map_err(|_| Error::bad("restored_archive_verification_failed"))?;
    Ok(
        json!({"snapshot_id":snapshot,"archive":report,"manifest_sha256":exports::hash_file(&destination.join("manifest.json")).await?}),
    )
}
pub async fn retention(s: &Services, j: &jobs::Job) -> Result<Value> {
    let id = serde_json::from_value(j.body["configuration_id"].clone())
        .map_err(|_| Error::bad("invalid_backup_job"))?;
    let (c, repo) = configuration(s, j.owner, id).await?;
    validate(s, j.owner, &c).await?;
    identity(
        s,
        &c,
        repo.as_deref()
            .ok_or_else(|| Error::bad("backup_not_initialized"))?,
    )
    .await?;
    // Fixed host grouping prevents each export UUID becoming an unbounded retention group.
    execute(
        s,
        &c,
        &[
            "forget",
            "--host",
            &host(j.owner),
            "--tag",
            "scorebook-v4",
            "--group-by",
            "host",
            "--keep-last",
            "48",
            "--keep-daily",
            "7",
            "--keep-weekly",
            "4",
            "--prune",
            "--max-unused",
            "10%",
        ]
        .iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>(),
        None,
    )
    .await?;
    Ok(json!({"status":"retention_applied","keep_last":48,"keep_daily":7,"keep_weekly":4}))
}

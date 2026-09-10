//! Chunked v2 archives. A fixed DB snapshot is streamed before copying pinned files.
use crate::{
    adapters::db::{Database, digest, hash_bytes},
    application::{Services, jobs::Job},
    error::{Error, Result},
};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use uuid::Uuid;
// Foreign-key dependency order. Credentials and rebuildable public market vectors are excluded.
pub(super) const TABLES: &[&str] = &[
    "rules",
    "embedding_models",
    "public_market.catalog_versions",
    "public_market.instrument_lifecycles",
    "public_market.history_availability",
    "public_market.source_revisions",
    "calls",
    "call_state",
    "attachments",
    "call_attachments",
    "events",
    "reviews",
    "episodes",
    "episode_links",
    "episode_reviews",
    "episode_review_refs",
    "submission_feedback",
    "playbooks",
    "playbook_events",
    "playbook_transition_details",
    "adoptions",
    "tags",
    "tag_revisions",
    "call_tags",
    "manifests",
    "outcomes",
    "outcome_heads",
    "assessments",
    "manifest_migrations",
    "image_embeddings",
    "image_index_status",
    "chart_analyses",
    "similarity_sessions",
    "search_result_refs",
    "similarity_feedback",
    "set_snapshots",
    "set_members",
    "verdicts",
    "exchange_connections",
    "trade_imports",
    "trade_fills",
    "trade_books",
    "account_ledger_entries",
    "account_asset_totals",
    "position_seeds",
    "trade_projection_runs",
    "trade_cycles",
    "trade_cycle_allocations",
    "trade_projection_heads",
    "trade_epoch_cycles",
    "trade_book_snapshots",
    "trade_projection_checkpoints",
    "trade_reconciliations",
    "execution_links",
    "execution_link_fills",
    "jobs",
    "assessment_source_plans",
    "assessment_source_decisions",
    "trigger_watches",
    "trigger_checkpoints",
    "trigger_events",
    "chat_runs",
    "chat_model_turns",
    "chat_tool_calls",
    "chat_events",
    "chat_source_refs",
    "set_definitions",
    "set_runs",
    "set_sample_members",
    "set_group_metrics",
    "verdict_requests",
    "verdict_events",
    "baseline_runs",
    "baseline_samples",
    "job_attempts",
    "job_targets",
    "chart_search_runs",
    "image_reindex_runs",
    "exchange_sync_runs",
    "exchange_export_runs",
    "exchange_export_reservations",
    "exchange_export_resolutions",
    "history_indexes",
    "history_plans",
    "history_plan_scopes",
    "history_subscriptions",
    "history_subscription_plans",
    "history_subscription_cursors",
    "review_drafts",
    "review_preferences",
    "review_outcome_refs",
    "attachment_locations",
    "chart_setups",
    "requests",
    "request_refs",
    "tombstones",
];
pub const ARCHIVE_SCHEMA: i64 = 43;
const CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub async fn request(s: &Services, owner: Uuid, key: &str) -> Result<Value> {
    let body = json!({});
    let (mut tx, cached) = s.db.write(owner, "exports.create", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let id = super::jobs::enqueue_tx(&mut tx, owner, "export", key, body.clone()).await?;
    let v = json!({"job_id":id,"status":"queued"});
    Database::finish(&mut tx, owner, "exports.create", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn export(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    create(s, owner, id, None).await
}
pub async fn export_job(s: &Services, j: &Job) -> Result<Value> {
    create(s, j.owner, j.id, Some(j)).await
}
pub(super) fn directory(s: &Services, owner: Uuid, id: Uuid) -> PathBuf {
    s.storage
        .root
        .join("exports")
        .join(owner.to_string())
        .join(id.to_string())
}
async fn heartbeat(s: &Services, id: Uuid, token: Uuid) -> Result<()> {
    let changed=sqlx::query("UPDATE export_artifacts SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state IN ('writing','copying')").bind(id).bind(token).execute(&s.db.pool).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::conflict("export_lease_lost"));
    }
    Ok(())
}
async fn create(s: &Services, owner: Uuid, id: Uuid, job: Option<&Job>) -> Result<Value> {
    let expired:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM export_artifacts WHERE owner_id=$1 AND id=$2 AND (state='expired' OR expires_at<=now()))").bind(owner).bind(id).fetch_one(&s.db.pool).await?;
    if expired {
        return Err(Error::conflict("export_expired_create_new_export"));
    }
    if let Some(hash)=sqlx::query_scalar::<_,String>("SELECT manifest_sha256 FROM export_artifacts WHERE owner_id=$1 AND id=$2 AND state='ready'").bind(owner).bind(id).fetch_optional(&s.db.pool).await? {return Ok(json!({"export_id":id,"manifest_sha256":hash,"status":"complete","format":"scorebook-logical-v2"}));}
    let token = Uuid::new_v4();
    let mut admission = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *admission)
        .await?;
    if let Some(j) = job {
        let active:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND owner_id=$2 AND lease_owner=$3 AND generation=$4 AND status='running' AND lease_until>now() FOR UPDATE").bind(j.id).bind(owner).bind(j.lease).bind(j.generation).fetch_optional(&mut *admission).await?;
        if active.is_none() {
            return Err(Error::conflict("lease_lost"));
        }
    }
    let reserved:Option<Uuid>=sqlx::query_scalar("INSERT INTO export_artifacts(id,owner_id,lease_token) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET state='writing',lease_token=$3,lease_until=now()+interval '5 minutes' WHERE export_artifacts.owner_id=$2 AND export_artifacts.state<>'ready' AND (export_artifacts.lease_until<now() OR $4) RETURNING id").bind(id).bind(owner).bind(token).bind(job.is_some()).fetch_optional(&mut *admission).await?;
    if reserved.is_none() {
        return Err(Error::conflict("export_in_progress"));
    }
    sqlx::query("INSERT INTO export_runs(owner_id,export_id,token) VALUES($1,$2,$3)")
        .bind(owner)
        .bind(id)
        .bind(token)
        .execute(&mut *admission)
        .await?;
    admission.commit().await?;
    let destination = directory(s, owner, id);
    if tokio::fs::try_exists(&destination).await? {
        // Resume publication of this exact v2 artifact after rename succeeded but DB commit did not.
        let expected: Option<String> = sqlx::query_scalar(
            "SELECT manifest_sha256 FROM export_artifacts WHERE id=$1 AND lease_token=$2",
        )
        .bind(id)
        .bind(token)
        .fetch_one(&s.db.pool)
        .await?;
        let manifest = read_manifest(&destination)
            .await
            .map_err(|_| Error::bad("export_integrity_failure"))?;
        let actual = hash_file(&destination.join("manifest.json")).await?;
        if expected.as_deref() != Some(actual.as_str())
            || manifest["owner_id"] != json!(owner)
            || manifest["export_id"] != json!(id)
        {
            return Err(Error::conflict("export_destination_identity_mismatch"));
        }
        verify(&destination)
            .await
            .map_err(|_| Error::bad("export_integrity_failure"))?;
        let mut tx = s.db.pool.begin().await?;
        let changed=sqlx::query("UPDATE export_artifacts SET state='ready' WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now()").bind(owner).bind(id).bind(token).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 {
            return Err(Error::conflict("export_lease_lost"));
        }
        sqlx::query("DELETE FROM export_pins WHERE owner_id=$1 AND export_id=$2")
            .bind(owner)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM export_runs WHERE owner_id=$1 AND export_id=$2 AND token=$3")
            .bind(owner)
            .bind(id)
            .bind(token)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(
            json!({"export_id":id,"manifest_sha256":actual,"status":"complete","format":"scorebook-logical-v2","publication_recovered":true}),
        );
    }
    let parent = s.storage.root.join("exports").join(owner.to_string());
    let stage = parent.join(format!(".{id}.{token}.staging"));
    tokio::fs::create_dir_all(stage.join("attachments")).await?;
    tokio::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).await?;
    tokio::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700)).await?;
    let mut manifest = json!({"format":"scorebook-logical-v2","schema_version":ARCHIVE_SCHEMA,"owner_id":owner,"export_id":id,"created_at":chrono::Utc::now(),"tables":{},"scope":"private_evidence_and_tasks;public_market_vectors_rebuildable;credentials_excluded"});
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='30min'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await?;
    manifest["source_snapshot_at"] = json!(
        sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>("SELECT transaction_timestamp()")
            .fetch_one(&mut *tx)
            .await?
    );
    sqlx::query("DELETE FROM export_refs WHERE owner_id=$1 AND export_id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO export_refs SELECT $1,$2,'call',id FROM calls WHERE owner_id=$1 UNION ALL SELECT $1,$2,'attachment',id FROM attachments WHERE owner_id=$1").bind(owner).bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM export_pins WHERE owner_id=$1 AND export_id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO export_pins SELECT $1,$2,id,sha256 FROM attachments WHERE owner_id=$1",
    )
    .bind(owner)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    for table in TABLES {
        let shared = shared_table(table);
        let columns:Vec<String>=sqlx::query_scalar("SELECT a.attname FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum WHERE c.conrelid=$1::regclass AND c.contype='p' ORDER BY k.n").bind(table).fetch_all(&mut *tx).await?;
        let order = columns
            .iter()
            .map(|c| format!("t.\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(",");
        if order.is_empty() {
            return Err(Error::bad("archive_table_requires_stable_identity"));
        }
        let sql = format!(
            "SELECT to_jsonb(t) FROM {table} t {} ORDER BY {order}",
            if shared { "" } else { "WHERE owner_id=$1" }
        );
        let query = sqlx::query_scalar::<_, Value>(&sql);
        let query = if shared { query } else { query.bind(owner) };
        let mut stream = query.fetch(&mut *tx);
        let mut chunks = vec![];
        let mut bytes = Vec::new();
        let mut rows = 0usize;
        let mut total = 0usize;
        while let Some(value) = stream.try_next().await? {
            let encoded = serde_json::to_vec(&value)
                .map_err(|_| Error::bad("export_serialization_failed"))?;
            if !bytes.is_empty() && (bytes.len() + encoded.len() + 1 > CHUNK_BYTES || rows == 1000)
            {
                chunks.push(write_chunk(&stage, table, chunks.len(), &bytes, rows).await?);
                bytes.clear();
                rows = 0;
                heartbeat(s, id, token).await?;
            }
            bytes.extend_from_slice(&encoded);
            bytes.push(b'\n');
            rows += 1;
            total += 1;
        }
        if !bytes.is_empty() {
            chunks.push(write_chunk(&stage, table, chunks.len(), &bytes, rows).await?);
        }
        manifest["tables"][*table] = json!({"rows":total,"chunks":chunks});
        heartbeat(s, id, token).await?;
    }
    tx.commit().await?; // File copies below do not hold a DB snapshot or transaction open.
    sqlx::query("UPDATE export_artifacts SET state='copying' WHERE id=$1 AND lease_token=$2 AND lease_until>now()").bind(id).bind(token).execute(&s.db.pool).await?;
    let mut cursor = Uuid::nil();
    let mut files = 0usize;
    loop {
        let rows=sqlx::query("SELECT attachment_id,sha256 FROM export_pins WHERE owner_id=$1 AND export_id=$2 AND attachment_id>$3 ORDER BY attachment_id LIMIT 100").bind(owner).bind(id).bind(cursor).fetch_all(&s.db.pool).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            cursor = row.get("attachment_id");
            let expected: String = row.get("sha256");
            let hash = copy_reader(
                s.images.open(owner, cursor).await?,
                &stage.join("attachments").join(cursor.to_string()),
            )
            .await?;
            if hash != expected {
                return Err(Error::bad("attachment_integrity_failure"));
            }
            files += 1;
            heartbeat(s, id, token).await?;
        }
    }
    manifest["attachment_files"] = json!(files);
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|_| Error::bad("export_serialization_failed"))?;
    let hash = hash_bytes(&bytes);
    durable_write(&stage.join("manifest.json"), &bytes).await?;
    durable_write(&stage.join("manifest.sha256"), hash.as_bytes()).await?;
    // Persist the identity before atomic rename; retry only accepts this exact complete archive.
    let prepared=sqlx::query("UPDATE export_artifacts SET manifest_sha256=$3 WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state='copying'").bind(id).bind(token).bind(&hash).execute(&s.db.pool).await?;
    if prepared.rows_affected() != 1 {
        return Err(Error::conflict("export_lease_lost"));
    }
    let mut tx = s.db.pool.begin().await?;
    let active:Option<Uuid>=sqlx::query_scalar("SELECT id FROM export_artifacts WHERE owner_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>now() AND state='copying' FOR UPDATE").bind(owner).bind(id).bind(token).fetch_optional(&mut *tx).await?;
    if active.is_none() {
        return Err(Error::conflict("export_lease_lost"));
    }
    if let Some(j) = job {
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=$1 AND lease_owner=$2 AND generation=$3 AND status='running' AND lease_until>now())").bind(j.id).bind(j.lease).bind(j.generation).fetch_one(&mut *tx).await?;
        if !active {
            return Err(Error::conflict("lease_lost"));
        }
    }
    let destination = directory(s, owner, id);
    if tokio::fs::try_exists(&destination).await? {
        return Err(Error::conflict("export_destination_exists"));
    }
    tokio::fs::rename(&stage, &destination).await?;
    sqlx::query(
        "UPDATE export_artifacts SET state='ready',manifest_sha256=$3 WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(id)
    .bind(&hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM export_pins WHERE owner_id=$1 AND export_id=$2")
        .bind(owner)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM export_runs WHERE owner_id=$1 AND export_id=$2 AND token=$3")
        .bind(owner)
        .bind(id)
        .bind(token)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(
        json!({"export_id":id,"manifest_sha256":hash,"status":"complete","files":files,"format":"scorebook-logical-v2","download_url":format!("/v1/exports/{id}/manifest")}),
    )
}
async fn durable_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .await?;
    file.write_all(bytes).await?;
    file.sync_all().await
}
async fn write_chunk(
    dir: &Path,
    table: &str,
    n: usize,
    bytes: &[u8],
    rows: usize,
) -> Result<Value> {
    let name = format!("{table}-{n:06}.ndjson");
    durable_write(&dir.join(&name), bytes).await?;
    Ok(json!({"file":name,"sha256":hash_bytes(bytes),"rows":rows,"bytes":bytes.len()}))
}
async fn copy_hash(source: &Path, dest: &Path) -> std::io::Result<String> {
    copy_reader(tokio::fs::File::open(source).await?, dest).await
}
async fn copy_reader(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    dest: &Path,
) -> std::io::Result<String> {
    let mut writer = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(dest)
        .await?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 65536];
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        writer.write_all(&buffer[..n]).await?;
    }
    writer.sync_all().await?;
    Ok(hex::encode(hash.finalize()))
}
pub(super) async fn hash_file(path: &Path) -> anyhow::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 65536];
    loop {
        let n = file.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
async fn regular_file(path: &Path, max: u64) -> anyhow::Result<()> {
    let meta = tokio::fs::symlink_metadata(path).await?;
    anyhow::ensure!(
        meta.file_type().is_file() && meta.len() <= max,
        "archive requires bounded regular files"
    );
    Ok(())
}
pub(super) async fn read_manifest(path: &Path) -> anyhow::Result<Value> {
    anyhow::ensure!(
        tokio::fs::symlink_metadata(path)
            .await?
            .file_type()
            .is_dir(),
        "archive root must be a directory"
    );
    regular_file(&path.join("manifest.json"), 32 * 1024 * 1024).await?;
    regular_file(&path.join("manifest.sha256"), 64).await?;
    anyhow::ensure!(
        tokio::fs::metadata(path.join("manifest.json")).await?.len() <= 32 * 1024 * 1024,
        "manifest too large"
    );
    let bytes = tokio::fs::read(path.join("manifest.json")).await?;
    anyhow::ensure!(bytes.len() <= 32 * 1024 * 1024, "manifest too large");
    let expected = tokio::fs::read_to_string(path.join("manifest.sha256")).await?;
    anyhow::ensure!(hash_bytes(&bytes) == expected, "manifest checksum mismatch");
    let manifest: Value = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        manifest["format"] == "scorebook-logical-v2",
        "unsupported export format; explicit offline migration required"
    );
    Ok(manifest)
}
fn chunk_path(dir: &Path, table: &str, index: usize, chunk: &Value) -> anyhow::Result<PathBuf> {
    let name = format!("{table}-{index:06}.ndjson");
    anyhow::ensure!(chunk["file"] == name, "invalid chunk path");
    Ok(dir.join(name))
}
pub async fn verify(path: &Path) -> anyhow::Result<Value> {
    let manifest = read_manifest(path).await?;
    anyhow::ensure!(
        manifest["schema_version"] == ARCHIVE_SCHEMA,
        "archive schema requires explicit offline upgrade"
    );
    verify_layout(path, TABLES).await
}
async fn verify_layout(path: &Path, tables: &[&str]) -> anyhow::Result<Value> {
    let manifest = read_manifest(path).await?;
    let recorded = manifest["tables"]
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("missing tables"))?;
    anyhow::ensure!(
        recorded.len() == tables.len() && tables.iter().all(|t| recorded.contains_key(*t)),
        "archive table catalog mismatch"
    );
    let mut rows = 0usize;
    let mut files = 0usize;
    let mut manifests = 0usize;
    let mut unverifiable = 0usize;
    let owner: Uuid = serde_json::from_value(manifest["owner_id"].clone())?;
    for table in tables {
        let chunks = manifest["tables"][*table]["chunks"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing table {table}"))?;
        let mut table_rows = 0usize;
        for (n, chunk) in chunks.iter().enumerate() {
            let chunk_file = chunk_path(path, table, n, chunk)?;
            regular_file(&chunk_file, 32 * 1024 * 1024).await?;
            anyhow::ensure!(
                tokio::fs::metadata(&chunk_file).await?.len() <= 32 * 1024 * 1024,
                "archive chunk exceeds v2 size bound"
            );
            anyhow::ensure!(
                hash_file(&chunk_file).await? == chunk["sha256"],
                "chunk checksum mismatch: {table}"
            );
            let mut lines = BufReader::new(tokio::fs::File::open(chunk_file).await?).lines();
            let mut count = 0usize;
            while let Some(line) = lines.next_line().await? {
                let value: Value = serde_json::from_str(&line)?;
                if !shared_table(table) {
                    anyhow::ensure!(
                        value["owner_id"] == json!(owner),
                        "cross-tenant archive row"
                    );
                }
                if *table == "attachments" {
                    let id: Uuid = serde_json::from_value(value["id"].clone())?;
                    anyhow::ensure!(
                        tokio::fs::symlink_metadata(path.join("attachments"))
                            .await?
                            .file_type()
                            .is_dir(),
                        "invalid attachment directory"
                    );
                    regular_file(
                        &path.join("attachments").join(id.to_string()),
                        20 * 1024 * 1024,
                    )
                    .await?;
                    anyhow::ensure!(
                        hash_file(&path.join("attachments").join(id.to_string())).await?
                            == value["sha256"],
                        "attachment digest mismatch"
                    );
                    files += 1;
                }
                if *table == "manifests" {
                    anyhow::ensure!(
                        digest(&value["body"]) == value["digest"],
                        "evidence manifest digest mismatch"
                    );
                    manifests += 1;
                    unverifiable +=
                        usize::from(value["body"]["market_input_storage"] == "not_persisted");
                }
                count += 1;
            }
            anyhow::ensure!(chunk["rows"] == count, "chunk row count mismatch");
            table_rows += count;
        }
        anyhow::ensure!(
            manifest["tables"][*table]["rows"] == table_rows,
            "table row count mismatch"
        );
        rows += table_rows;
    }
    anyhow::ensure!(
        manifest["attachment_files"] == files,
        "attachment count mismatch"
    );
    Ok(
        json!({"status":"verified","rows":rows,"files":files,"verified_manifests":manifests,"market_replay_unverifiable":unverifiable,"replayed_outcomes":0,"format":"scorebook-logical-v2"}),
    )
}
/// Restore files to a private staging directory before one atomic database publication.
pub async fn restore(s: &Services, path: &Path) -> anyhow::Result<Value> {
    let verification = verify(path).await?;
    let manifest = read_manifest(path).await?;
    let owner: Uuid = serde_json::from_value(manifest["owner_id"].clone())?;
    let source_hash = hash_file(&path.join("manifest.json")).await?;
    // An advisory transaction lock coordinates concurrent restores; data publication uses a separate transaction.
    let mut restore_lock = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,27))")
        .bind(owner.to_string())
        .execute(&mut *restore_lock)
        .await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
        .bind(owner)
        .fetch_one(&s.db.pool)
        .await?;
    if exists {
        let same:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM restore_receipts WHERE owner_id=$1 AND manifest_sha256=$2)").bind(owner).bind(&source_hash).fetch_one(&s.db.pool).await?;
        anyhow::ensure!(
            same,
            "restore requires an isolated database where source tenant does not exist"
        );
        return Ok(
            json!({"owner_id":owner,"status":"already_restored","manifest_sha256":source_hash}),
        );
    }
    let destination = s.storage.root.join("attachments").join(owner.to_string());
    let files_published = tokio::fs::try_exists(&destination).await?;
    let stage = if files_published {
        destination.clone()
    } else {
        s.storage
            .root
            .join("restore_staging")
            .join(format!("{owner}.{source_hash}"))
    };
    tokio::fs::create_dir_all(&stage).await?;
    tokio::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700)).await?;
    let marker = stage.join(".restore-manifest");
    if tokio::fs::try_exists(&marker).await? {
        anyhow::ensure!(
            tokio::fs::metadata(&marker).await?.len() == 64
                && tokio::fs::read_to_string(&marker).await? == source_hash,
            "restore destination identity mismatch"
        );
    } else {
        anyhow::ensure!(
            !files_published,
            "restore attachment destination already exists"
        );
        durable_write(&marker, source_hash.as_bytes()).await?;
    }
    for (n, chunk) in manifest["tables"]["attachments"]["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let mut lines = BufReader::new(
            tokio::fs::File::open(chunk_path(path, "attachments", n, chunk)?).await?,
        )
        .lines();
        while let Some(line) = lines.next_line().await? {
            let row: Value = serde_json::from_str(&line)?;
            let id: Uuid = serde_json::from_value(row["id"].clone())?;
            let file = stage.join(id.to_string());
            if tokio::fs::try_exists(&file).await? {
                if hash_file(&file).await? == row["sha256"] {
                    continue;
                }
                anyhow::ensure!(
                    !files_published,
                    "published restore attachment integrity failure"
                );
                // Only a partial file inside this exact archive's private staging directory is replaced.
                tokio::fs::remove_file(&file).await?;
            }
            anyhow::ensure!(
                copy_hash(&path.join("attachments").join(id.to_string()), &file).await?
                    == row["sha256"],
                "attachment changed during restore"
            );
        }
    }
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("INSERT INTO users(id,name) VALUES($1,'restored-user')")
        .bind(owner)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET CONSTRAINTS ALL DEFERRED")
        .execute(&mut *tx)
        .await?;
    sqlx::query("CREATE TEMP TABLE restore_stage(payload jsonb NOT NULL) ON COMMIT DROP")
        .execute(&mut *tx)
        .await?;
    let mut restored = 0usize;
    for table in TABLES {
        for (n, chunk) in manifest["tables"][*table]["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let file = chunk_path(path, table, n, chunk)?;
            anyhow::ensure!(
                hash_file(&file).await? == chunk["sha256"],
                "chunk changed during restore"
            );
            let mut lines = BufReader::new(tokio::fs::File::open(file).await?).lines();
            let mut pending = vec![];
            let mut size = 0usize;
            while let Some(line) = lines.next_line().await? {
                let row: Value = serde_json::from_str(&line)?;
                size += line.len();
                pending.push(row);
                if pending.len() == 500 || size >= CHUNK_BYTES {
                    restore_block(&mut tx, owner, table, &pending).await?;
                    restored += pending.len();
                    pending.clear();
                    size = 0;
                }
            }
            if !pending.is_empty() {
                restore_block(&mut tx, owner, table, &pending).await?;
                restored += pending.len();
            }
        }
    }
    if manifest.get("upgrade").is_some() {
        sqlx::query("WITH ordered AS(SELECT owner_id,id,first_value(id) OVER(PARTITION BY owner_id,name ORDER BY version) AS root,lag(id) OVER(PARTITION BY owner_id,name ORDER BY version) AS parent FROM tags WHERE owner_id=$1) INSERT INTO tag_revisions SELECT owner_id,id,root,parent,'explicit_archive_v19_upgrade' FROM ordered ON CONFLICT DO NOTHING").bind(owner).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO submission_feedback(owner_id,call_id,body) SELECT owner_id,id,'{\"status\":\"not_captured_at_submission\",\"reason\":\"historical_v19_archive\"}'::jsonb FROM calls WHERE owner_id=$1 ON CONFLICT DO NOTHING").bind(owner).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE chat_runs SET status='restored_requires_new_run' WHERE owner_id=$1 AND status NOT IN ('completed','cancelled','source_removed','budget_exhausted')").bind(owner).execute(&mut *tx).await?;
    sqlx::query("SELECT setval(pg_get_serial_sequence('chat_events','sequence'),GREATEST(COALESCE((SELECT max(sequence) FROM chat_events),0),1))").execute(&mut *tx).await?;
    // A restore is an explicit state transition: leases/exports are not resumed as successful work.
    sqlx::query("UPDATE jobs SET status=CASE WHEN kind IN ('export','purge_files','chat.run','backup.run') THEN 'cancelled' ELSE 'queued' END,generation=generation+1,cycle_attempt=0,lease_owner=NULL,lease_until=NULL,run_after=now() WHERE owner_id=$1 AND status IN ('running','queued','retry_wait')").bind(owner).execute(&mut *tx).await?;
    sqlx::query("UPDATE assessments a SET state='queued' FROM jobs j WHERE a.owner_id=$1 AND a.job_id=j.id AND j.status='queued'").bind(owner).execute(&mut *tx).await?;
    sqlx::query("UPDATE history_indexes i SET status='queued',coverage=NULL,completed_at=NULL FROM public_market.generations g WHERE i.owner_id=$1 AND i.generation_id=g.id AND g.status<>'ready'").bind(owner).execute(&mut *tx).await?;
    sqlx::query("UPDATE jobs j SET status='queued',run_after=now(),generation=generation+1 FROM history_indexes i WHERE i.owner_id=$1 AND i.id=j.id AND i.status='queued'").bind(owner).execute(&mut *tx).await?;
    if manifest.get("upgrade").is_some() {
        // Offline v19 migration applies the same explicit cutover as a live schema upgrade.
        sqlx::query("UPDATE history_indexes SET body=jsonb_set(body,'{source}','\"rest\"') WHERE owner_id=$1 AND NOT body ? 'source'").bind(owner).execute(&mut *tx).await?;
        sqlx::query("UPDATE history_plans SET body=jsonb_set(body,'{source}','\"rest\"') WHERE owner_id=$1 AND NOT body ? 'source'").bind(owner).execute(&mut *tx).await?;
        sqlx::query("UPDATE public_market.generations g SET body=jsonb_set(g.body,'{source}','\"rest\"') FROM history_indexes i WHERE i.owner_id=$1 AND i.generation_id=g.id AND NOT g.body ? 'source'").bind(owner).execute(&mut *tx).await?;
        sqlx::query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_owner=NULL,lease_until=NULL,error_code='retired_model_requires_v2_rebuild' WHERE owner_id=$1 AND status IN('queued','running','retry_wait','awaiting_input','blocked_capability') AND ((kind='embed' AND body->>'model_id'='candle-profile-v1') OR (kind IN('history.index','history.plan') AND body->'models' ? 'candle-profile-v1'))").bind(owner).execute(&mut *tx).await?;
        sqlx::query("UPDATE history_plans p SET status='cancelled' FROM jobs j WHERE p.owner_id=$1 AND p.id=j.id AND j.error_code='retired_model_requires_v2_rebuild'").bind(owner).execute(&mut *tx).await?;
        let reindex = super::jobs::enqueue_tx(
            &mut tx,
            owner,
            "images.reindex",
            "v19-archive-v4-cutover",
            json!({"protocol":"chart-match-v2"}),
        )
        .await
        .map_err(|e| anyhow::anyhow!(e.code))?;
        sqlx::query("INSERT INTO image_reindex_runs(id,owner_id) VALUES($1,$2)")
            .bind(reindex)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO storage_objects(owner_id,id,state,created_at) SELECT owner_id,id,'ready',uploaded_at FROM attachments WHERE owner_id=$1").bind(owner).execute(&mut *tx).await?;
    sqlx::query("SELECT setval(pg_get_serial_sequence('events','sequence'),GREATEST(COALESCE((SELECT max(sequence) FROM events),0),1))").execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO review_queue_projection SELECT * FROM review_queue_source WHERE owner_id=$1",
    )
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO restore_receipts(owner_id,manifest_sha256) VALUES($1,$2)")
        .bind(owner)
        .bind(&source_hash)
        .execute(&mut *tx)
        .await?;
    if !files_published {
        tokio::fs::create_dir_all(s.storage.root.join("attachments")).await?;
        tokio::fs::rename(&stage, &destination).await?;
    }
    tx.commit().await?;
    restore_lock.commit().await?;
    Ok(
        json!({"owner_id":owner,"restored_rows":restored,"verification":verification,"credentials":"not_imported; create_new_scoped_key","public_market_vectors":"rebuild_queued"}),
    )
}
async fn restore_block(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    owner: Uuid,
    table: &str,
    rows: &[Value],
) -> anyhow::Result<()> {
    let shared = shared_table(table);
    for row in rows {
        if !shared {
            anyhow::ensure!(
                row["owner_id"] == json!(owner),
                "cross-tenant row in restore"
            );
        }
    }
    if matches!(table, "rules" | "embedding_models") {
        let mismatch:bool=sqlx::query_scalar(&format!("SELECT EXISTS(SELECT 1 FROM jsonb_populate_recordset(NULL::{table},$1) x JOIN {table} t ON x.id=t.id WHERE to_jsonb(x)<>to_jsonb(t))")).bind(json!(rows)).fetch_one(&mut **tx).await?;
        anyhow::ensure!(!mismatch, "shared definition mismatch: {table}");
    }
    if table == "history_indexes" {
        sqlx::query("INSERT INTO public_market.generations(id,request_hash,body) SELECT (v->>'generation_id')::uuid,md5((v->'body')::text),v->'body' FROM jsonb_array_elements($1) v ON CONFLICT DO NOTHING").bind(json!(rows)).execute(&mut **tx).await?;
    }
    let conflict = if shared {
        " ON CONFLICT DO NOTHING"
    } else {
        ""
    };
    sqlx::query("TRUNCATE restore_stage")
        .execute(&mut **tx)
        .await?;
    let mut csv = String::new();
    for row in rows {
        csv.push('"');
        csv.push_str(&serde_json::to_string(row)?.replace('"', "\"\""));
        csv.push_str("\"\n");
    }
    let mut copy = tx
        .as_mut()
        .copy_in_raw("COPY restore_stage(payload) FROM STDIN WITH (FORMAT csv)")
        .await?;
    copy.send(csv.as_bytes()).await?;
    copy.finish().await?;
    sqlx::query(&format!("INSERT INTO {table} OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::{table},payload)).* FROM restore_stage{conflict}")).execute(&mut **tx).await?;
    Ok(())
}
pub async fn download_path(s: &Services, owner: Uuid, id: Uuid, name: &str) -> Result<PathBuf> {
    let ready:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM export_artifacts WHERE owner_id=$1 AND id=$2 AND state='ready' AND expires_at>now())").bind(owner).bind(id).fetch_one(&s.db.pool).await?;
    if !ready {
        return Err(Error::not_found());
    }
    let directory = directory(s, owner, id);
    if matches!(name, "manifest.json" | "manifest.sha256") {
        return Ok(directory.join(name));
    }
    if let Some(id) = name
        .strip_prefix("attachments/")
        .and_then(|v| Uuid::parse_str(v).ok())
    {
        return Ok(directory.join("attachments").join(id.to_string()));
    }
    let manifest = read_manifest(&directory)
        .await
        .map_err(|_| Error::bad("export_integrity_failure"))?;
    for table in TABLES {
        for chunk in manifest["tables"][*table]["chunks"]
            .as_array()
            .ok_or_else(|| Error::bad("export_integrity_failure"))?
        {
            if chunk["file"] == name {
                return Ok(directory.join(name));
            }
        }
    }
    Err(Error::not_found())
}

fn shared_table(table: &str) -> bool {
    matches!(
        table,
        "rules"
            | "embedding_models"
            | "public_market.catalog_versions"
            | "public_market.instrument_lifecycles"
            | "public_market.history_availability"
            | "public_market.source_revisions"
    )
}

pub mod upgrade;

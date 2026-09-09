//! Logical tenant export with a fixed DB snapshot and hash-verified immutable files.
use crate::{
    adapters::db::{Database, hash_bytes},
    application::Services,
    error::{Error, Result},
};
use serde_json::{Value, json};
use sqlx::Row;
use std::io::Write;
use uuid::Uuid;
const TABLES: &[&str] = &[
    "calls",
    "call_state",
    "attachments",
    "call_attachments",
    "events",
    "reviews",
    "episodes",
    "episode_links",
    "playbooks",
    "playbook_events",
    "adoptions",
    "tags",
    "call_tags",
    "manifests",
    "outcomes",
    "embedding_models",
    "image_embeddings",
    "similarity_sessions",
    "similarity_feedback",
    "set_snapshots",
    "verdicts",
    "history_indexes",
    "history_windows",
    "tombstones",
    "rules",
];
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
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
        .bind(owner.to_string())
        .execute(&mut *tx)
        .await?;
    let dir = s
        .storage
        .root
        .join("exports")
        .join(owner.to_string())
        .join(id.to_string());
    tokio::fs::create_dir_all(dir.join("attachments")).await?;
    let mut dump = json!({"format":"scorebook-logical-v1","app_version":env!("CARGO_PKG_VERSION"),"owner_id":owner,"created_at":chrono::Utc::now(),"tables":{},"files":[]});
    for table in TABLES {
        let shared = matches!(*table, "rules" | "embedding_models");
        let sql = format!(
            "SELECT to_jsonb(t) FROM {table} t {}",
            if shared { "" } else { "WHERE owner_id=$1" }
        );
        let rows: Vec<Value> = if shared {
            sqlx::query_scalar(&sql).fetch_all(&mut *tx).await?
        } else {
            sqlx::query_scalar(&sql)
                .bind(owner)
                .fetch_all(&mut *tx)
                .await?
        };
        dump["tables"][*table] = json!(rows);
    }
    let attachments = sqlx::query("SELECT id,sha256 FROM attachments WHERE owner_id=$1")
        .bind(owner)
        .fetch_all(&mut *tx)
        .await?;
    let mut files = vec![];
    for row in attachments {
        let aid: Uuid = row.get("id");
        let expected: String = row.get("sha256");
        let data = tokio::fs::read(s.storage.path(owner, aid)).await?;
        if hash_bytes(&data) != expected {
            return Err(Error::bad("attachment_integrity_failure"));
        }
        let dest = dir.join("attachments").join(aid.to_string());
        let bytes = data;
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            let mut f = std::fs::File::create(dest)?;
            f.write_all(&bytes)?;
            f.sync_all()
        })
        .await
        .map_err(|_| Error::bad("export_io_failed"))??;
        files.push(json!({"id":aid,"sha256":expected}));
    }
    dump["files"] = json!(files);
    let content = serde_json::to_vec_pretty(&dump).unwrap();
    let sum = hash_bytes(&content);
    let path = dir.join("manifest.json");
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut f = std::fs::File::create(path)?;
        f.write_all(&content)?;
        f.sync_all()
    })
    .await
    .map_err(|_| Error::bad("export_io_failed"))??;
    tx.commit().await?;
    Ok(
        json!({"export_id":id,"manifest_sha256":sum,"files":files.len(),"status":"complete","download_url":format!("/v1/exports/{id}/manifest"),"backup_scope":"local_copy"}),
    )
}
pub async fn verify(path: &std::path::Path) -> anyhow::Result<Value> {
    let bytes = tokio::fs::read(path.join("manifest.json")).await?;
    let dump: Value = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(
        dump["format"] == "scorebook-logical-v1",
        "unsupported export format"
    );
    let mut count = 0;
    for file in dump["files"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing file manifest"))?
    {
        let id: Uuid = serde_json::from_value(file["id"].clone())?;
        let data = tokio::fs::read(path.join("attachments").join(id.to_string())).await?;
        anyhow::ensure!(
            hash_bytes(&data) == file["sha256"].as_str().unwrap_or(""),
            "attachment digest mismatch"
        );
        count += 1;
    }
    let mut verified = 0;
    let mut unverifiable = 0;
    let mut legacy_redacted = 0;
    for m in dump["tables"]["manifests"].as_array().unwrap_or(&vec![]) {
        if m["body"]["market_input_storage"] == "not_persisted" {
            unverifiable += 1;
            // Migration 0005 redacted old raw inputs without rewriting their old digest.
            // New metadata-only manifests still have an independently verifiable digest.
            if m["body"]["market_input_sha256"].is_null() {
                legacy_redacted += 1;
                continue;
            }
        }
        anyhow::ensure!(
            crate::adapters::db::digest(&m["body"]) == m["digest"],
            "manifest digest mismatch"
        );
        verified += 1;
    }
    Ok(
        json!({"status":"verified","files":count,"replayed_outcomes":0,"verified_manifests":verified,"legacy_redacted_manifests":legacy_redacted,"market_replay_unverifiable":unverifiable,"manifest_sha256":hash_bytes(&bytes)}),
    )
}

/// Restore into a NEW tenant only. Existing data is never overwritten by an import.
pub async fn restore(s: &Services, path: &std::path::Path) -> anyhow::Result<Value> {
    let verification = verify(path).await?;
    let dump: Value = serde_json::from_slice(&tokio::fs::read(path.join("manifest.json")).await?)?;
    let old: Uuid = serde_json::from_value(dump["owner_id"].clone())?;
    let mut tx = s.db.pool.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE id=$1)")
        .bind(old)
        .fetch_one(&mut *tx)
        .await?;
    anyhow::ensure!(
        !exists,
        "restore requires an isolated database where source tenant does not exist"
    );
    sqlx::query("INSERT INTO users(id,name) VALUES($1,'restored-user')")
        .bind(old)
        .execute(&mut *tx)
        .await?;
    // Publish files before references. A failed transaction may leave collectible orphans.
    for file in dump["files"].as_array().unwrap() {
        let id: Uuid = serde_json::from_value(file["id"].clone())?;
        let data = tokio::fs::read(path.join("attachments").join(id.to_string())).await?;
        s.storage
            .publish(old, id, &data)
            .map_err(|e| anyhow::anyhow!(e.code))?;
    }
    let order = [
        "rules",
        "embedding_models",
        "calls",
        "call_state",
        "attachments",
        "call_attachments",
        "events",
        "reviews",
        "episodes",
        "episode_links",
        "playbooks",
        "playbook_events",
        "adoptions",
        "tags",
        "call_tags",
        "manifests",
        "outcomes",
        "image_embeddings",
        "similarity_sessions",
        "similarity_feedback",
        "set_snapshots",
        "verdicts",
        "history_indexes",
        "history_windows",
        "tombstones",
    ];
    let mut restored = 0usize;
    for table in order {
        let rows = dump["tables"][table]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("missing table {table}"))?;
        let mut pending = rows.clone();
        // Parent versions precede children; reject cyclic or missing parents.
        if table == "playbooks" {
            let mut ordered = vec![];
            let mut done = std::collections::HashSet::new();
            while !pending.is_empty() {
                let n = pending.len();
                let mut rest = vec![];
                for row in pending {
                    let parent = row["parent_id"].as_str();
                    if parent.is_none_or(|p| done.contains(p)) {
                        done.insert(row["id"].as_str().unwrap_or("").to_string());
                        ordered.push(row);
                    } else {
                        rest.push(row);
                    }
                }
                anyhow::ensure!(rest.len() < n, "cyclic or missing playbook parent");
                pending = rest;
            }
            pending = ordered;
        }
        for row in pending {
            if !matches!(table, "rules" | "embedding_models") {
                anyhow::ensure!(row["owner_id"] == json!(old), "cross-tenant row in export");
            }
            // Identifiers come only from the fixed table list, values remain bound JSON.
            let conflict = if matches!(table, "rules" | "embedding_models") {
                " ON CONFLICT DO NOTHING"
            } else {
                ""
            };
            sqlx::query(&format!("INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table},$1){conflict}")).bind(&row).execute(&mut *tx).await?;
            restored += 1;
        }
    }
    sqlx::query("SELECT setval(pg_get_serial_sequence('events','sequence'),GREATEST(COALESCE((SELECT max(sequence) FROM events),0),1))").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(
        json!({"owner_id":old,"restored_rows":restored,"verification":verification,"credentials":"not_imported; create_new_read_or_full_key"}),
    )
}

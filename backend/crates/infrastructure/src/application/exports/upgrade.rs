//! Explicit offline archive migration. The source artifact is never modified;
//! normal verification/restoration never silently accepts an older schema.
use super::*;
pub async fn v19(source: &Path, destination: &Path) -> anyhow::Result<Value> {
    let mut manifest = read_manifest(source).await?;
    anyhow::ensure!(
        manifest["schema_version"] == 19,
        "only the explicit v19 source schema is accepted"
    );
    let owned: Vec<String> =
        serde_json::from_str(include_str!("../../../../../docs/archive-schema-v19.json"))?;
    let old: Vec<&str> = owned.iter().map(String::as_str).collect();
    verify_layout(source, &old).await?;
    anyhow::ensure!(
        !tokio::fs::try_exists(destination).await?,
        "upgrade destination already exists"
    );
    tokio::fs::create_dir(destination).await?;
    tokio::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700)).await?;
    tokio::fs::create_dir(destination.join("attachments")).await?;
    for table in &old {
        for (n, chunk) in manifest["tables"][*table]["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
        {
            let path = chunk_path(source, table, n, chunk)?;
            let name = path.file_name().unwrap();
            let hash = copy_reader(
                Box::pin(tokio::fs::File::open(&path).await?),
                &destination.join(name),
            )
            .await?;
            anyhow::ensure!(hash == chunk["sha256"], "source changed during upgrade");
            if *table == "attachments" {
                let mut rows = BufReader::new(tokio::fs::File::open(path).await?).lines();
                while let Some(line) = rows.next_line().await? {
                    let v: Value = serde_json::from_str(&line)?;
                    let id: Uuid = serde_json::from_value(v["id"].clone())?;
                    let hash = copy_reader(
                        Box::pin(
                            tokio::fs::File::open(source.join("attachments").join(id.to_string()))
                                .await?,
                        ),
                        &destination.join("attachments").join(id.to_string()),
                    )
                    .await?;
                    anyhow::ensure!(hash == v["sha256"], "source image changed during upgrade");
                }
            }
        }
    }
    for table in TABLES {
        if manifest["tables"].get(*table).is_none() {
            manifest["tables"][*table] = json!({"rows":0,"chunks":[]});
        }
    }
    manifest["upgrade"] = json!({"from_schema":19,"to_schema":ARCHIVE_SCHEMA,"source_manifest_sha256":hash_file(&source.join("manifest.json")).await?,"policy":"new tables empty; restore explicitly builds missing lineage; original evidence unchanged"});
    manifest["schema_version"] = json!(ARCHIVE_SCHEMA);
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    durable_write(&destination.join("manifest.json"), &bytes).await?;
    durable_write(
        &destination.join("manifest.sha256"),
        hash_bytes(&bytes).as_bytes(),
    )
    .await?;
    let verified = verify(destination).await?;
    Ok(
        json!({"status":"upgraded","schema_version":ARCHIVE_SCHEMA,"source_untouched":true,"verification":verified}),
    )
}

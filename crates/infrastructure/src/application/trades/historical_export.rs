//! Explicit monthly quota reservations and uncertain-submission recovery. A
//! failed/ambiguous submission is never automatically submitted a second time.
use super::*;
use crate::error::RetryDirective;
use scorebook_core::exchange::AccountRead;
pub async fn create(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ExchangeExportInput,
) -> Result<Value> {
    if input.start_at >= input.end_at
        || input.end_at > Utc::now()
        || (input.end_at - input.start_at).num_days() > 365
        || !matches!(input.dataset.as_str(), "trades" | "ledger")
        || !matches!(input.format.as_str(), "csv" | "zip_csv")
    {
        return Err(Error::bad("invalid_historical_export_plan"));
    }
    super::csv_mapping::validate(&input.mapping, &input.dataset)?;
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "exchange.export", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM exchange_connections WHERE owner_id=$1 AND id=$2 AND disabled_at IS NULL)").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?;
    if !active {
        return Err(Error::not_found());
    }
    let run = jobs::enqueue_tx(&mut tx, owner, "trade.export", key, body.clone()).await?;
    sqlx::query(
        "INSERT INTO exchange_export_runs(id,owner_id,connection_id,body) VALUES($1,$2,$3,$4)",
    )
    .bind(run)
    .bind(owner)
    .bind(input.connection_id)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    let v = json!({"export_run_id":run,"job_id":run,"status":"prepared","quota_scope":"local_reservations_only;website_usage_is_shared","account_history_complete":false});
    Database::finish(&mut tx, owner, "exchange.export", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT (to_jsonb(r)-'owner_id')||jsonb_build_object('job_status',j.status,'generation',j.generation,'error_code',j.error_code) FROM exchange_export_runs r JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
pub async fn resolve(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: ExportResolve,
) -> Result<Value> {
    if input.download_id.is_empty()
        || input.download_id.len() > 64
        || !input.download_id.bytes().all(|b| b.is_ascii_digit())
        || input.evidence.trim().is_empty()
        || input.evidence.len() > 4000
    {
        return Err(Error::bad("verified_export_download_id_required"));
    }
    let body = json!({"export_run_id":id,"input":input});
    let (mut tx, cached) =
        s.db.write(owner, "exchange.export.resolve", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let row=sqlx::query("SELECT j.generation,r.status,r.imported_rows FROM jobs j JOIN exchange_export_runs r ON r.id=j.id WHERE j.owner_id=$1 AND j.id=$2 FOR UPDATE OF j,r").bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(Error::not_found)?;
    if row.get::<i64, _>("generation") != input.expected_generation
        || row.get::<i64, _>("imported_rows") > 0
        || !matches!(
            row.get::<String, _>("status").as_str(),
            "submitting" | "submission_unknown" | "polling"
        )
    {
        return Err(Error::conflict("export_resolution_conflict"));
    }
    sqlx::query(
        "INSERT INTO exchange_export_resolutions(id,owner_id,run_id,body) VALUES($1,$2,$3,$4)",
    )
    .bind(Uuid::new_v4())
    .bind(owner)
    .bind(id)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE exchange_export_runs SET download_id=$3,status='polling' WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).bind(input.download_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE jobs SET status='queued',generation=generation+1,cycle_attempt=0,run_after=now(),lease_owner=NULL,lease_until=NULL,error_code=NULL WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).execute(&mut *tx).await?;
    let v = json!({"export_run_id":id,"status":"polling","generation":input.expected_generation+1});
    Database::finish(&mut tx, owner, "exchange.export.resolve", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn step(s: &Services, j: &Job) -> Result<Value> {
    let state = get(s, j.owner, j.id).await?;
    if state["status"] == "complete" {
        return Ok(state);
    }
    let input: ExchangeExportInput = serde_json::from_value(state["body"].clone())
        .map_err(|_| Error::bad("invalid_export_definition"))?;
    let row=sqlx::query("SELECT c.market,k.keychain_service FROM exchange_connections c JOIN exchange_credentials k ON k.owner_id=c.owner_id AND k.connection_id=c.id WHERE c.owner_id=$1 AND c.id=$2 AND c.disabled_at IS NULL").bind(j.owner).bind(input.connection_id).fetch_optional(&s.db.pool).await?.ok_or_else(||Error::deferred("exchange_credentials_not_configured",RetryDirective::AwaitCapability))?;
    let market: String = row.get("market");
    let service: String = row.get("keychain_service");
    if state["status"] == "prepared" {
        let mut tx = jobs::fence(s, j).await?;
        sqlx::query("SELECT id FROM exchange_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE")
            .bind(j.owner)
            .bind(input.connection_id)
            .execute(&mut *tx)
            .await?;
        let used:i64=sqlx::query_scalar("SELECT count(*) FROM exchange_export_reservations WHERE owner_id=$1 AND connection_id=$2 AND dataset=$3 AND month=date_trunc('month',now() AT TIME ZONE 'UTC')::date").bind(j.owner).bind(input.connection_id).bind(&input.dataset).fetch_one(&mut *tx).await?;
        let cap = if market == "coin_m" { 8 } else { 5 };
        if used >= cap {
            return Err(Error::deferred(
                "monthly_export_quota_reserved",
                RetryDirective::AwaitInput,
            ));
        }
        // COIN-M's 1000 weight endpoint also has a hard two/minute IP limit.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('exchange-export-ip',31))")
            .execute(&mut *tx)
            .await?;
        let recent:i64=sqlx::query_scalar("SELECT count(*) FROM exchange_export_reservations WHERE created_at>now()-interval '60 seconds'").fetch_one(&mut *tx).await?;
        if recent >= 2 {
            return Err(Error::deferred(
                "export_submission_minute_budget",
                RetryDirective::After(60),
            ));
        }
        sqlx::query("INSERT INTO exchange_export_reservations(owner_id,connection_id,dataset,month,run_id) VALUES($1,$2,$3,date_trunc('month',now() AT TIME ZONE 'UTC')::date,$4)").bind(j.owner).bind(input.connection_id).bind(&input.dataset).bind(j.id).execute(&mut *tx).await?;
        sqlx::query(
            "UPDATE exchange_export_runs SET status='submitting' WHERE owner_id=$1 AND id=$2",
        )
        .bind(j.owner)
        .bind(j.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        let request = if input.dataset == "trades" {
            AccountRead::HistoryExport {
                start: input.start_at,
                end: input.end_at,
            }
        } else {
            AccountRead::IncomeExport {
                start: input.start_at,
                end: input.end_at,
            }
        };
        let result = s.accounts.read(&service, &market, request).await;
        if let Err(ref e) = result
            && matches!(
                e.code.as_str(),
                "capability_configuration_required"
                    | "provider_cooling_down"
                    | "provider_budget_exhausted"
                    | "keychain_item_unavailable"
                    | "invalid_exchange_credentials"
            )
        {
            // These adapter codes prove the HTTP request was not sent.
            let mut tx = jobs::fence(s, j).await?;
            sqlx::query("DELETE FROM exchange_export_reservations WHERE owner_id=$1 AND run_id=$2")
                .bind(j.owner)
                .bind(j.id)
                .execute(&mut *tx)
                .await?;
            sqlx::query(
                "UPDATE exchange_export_runs SET status='prepared' WHERE owner_id=$1 AND id=$2",
            )
            .bind(j.owner)
            .bind(j.id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Err(e.clone().into());
        }
        let download = result
            .as_ref()
            .ok()
            .and_then(|v| v["downloadId"].as_str())
            .filter(|v| !v.is_empty() && v.len() <= 64 && v.bytes().all(|x| x.is_ascii_digit()));
        let mut tx = jobs::fence(s, j).await?;
        sqlx::query(
            "UPDATE exchange_export_runs SET status=$3,download_id=$4 WHERE owner_id=$1 AND id=$2",
        )
        .bind(j.owner)
        .bind(j.id)
        .bind(if download.is_some() {
            "polling"
        } else {
            "submission_unknown"
        })
        .bind(download)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Err(if download.is_some() {
            Error::deferred(
                "export_processing",
                RetryDirective::At(Utc::now() + chrono::Duration::seconds(30)),
            )
        } else {
            Error::deferred(
                "export_submission_unknown_requires_download_id",
                RetryDirective::AwaitInput,
            )
        });
    }
    if matches!(
        state["status"].as_str(),
        Some("submitting" | "submission_unknown")
    ) {
        return Err(Error::deferred(
            "export_submission_unknown_requires_download_id",
            RetryDirective::AwaitInput,
        ));
    }
    let id = state["download_id"]
        .as_str()
        .ok_or_else(|| Error::bad("export_download_id_missing"))?
        .to_string();
    let request = if input.dataset == "trades" {
        AccountRead::HistoryDownload {
            download_id: id.clone(),
        }
    } else {
        AccountRead::IncomeDownload {
            download_id: id.clone(),
        }
    };
    let result = s.accounts.read(&service, &market, request).await?;
    if result["downloadId"] != id {
        return Err(Error::bad("export_download_identity_mismatch"));
    }
    if result["status"] == "processing" {
        return Err(Error::deferred(
            "export_processing",
            RetryDirective::At(Utc::now() + chrono::Duration::seconds(60)),
        ));
    }
    if result["status"] != "completed"
        || result["expirationTimestamp"]
            .as_i64()
            .is_some_and(|v| v > 0 && v <= Utc::now().timestamp_millis())
    {
        return Err(Error::deferred(
            "export_expired_or_failed_new_plan_required",
            RetryDirective::AwaitInput,
        ));
    }
    let bytes = s
        .accounts
        .download(
            result["url"]
                .as_str()
                .ok_or_else(|| Error::bad("export_link_missing"))?
                .to_string(),
        )
        .await?;
    let source_hash = crate::adapters::db::hash_bytes(&bytes);
    if state["source_hash"]
        .as_str()
        .is_some_and(|v| v != source_hash)
    {
        return Err(Error::deferred(
            "account_export_source_changed",
            RetryDirective::AwaitInput,
        ));
    }
    let format = input.format.clone();
    let bytes = tokio::task::spawn_blocking(move || super::csv_mapping::decode(bytes, &format))
        .await
        .map_err(|_| Error::bad("export_decode_failed"))??;
    import_file(
        s,
        j,
        &input,
        bytes,
        &source_hash,
        state["imported_rows"].as_i64().unwrap_or(0),
    )
    .await
}
async fn import_file(
    s: &Services,
    j: &Job,
    input: &ExchangeExportInput,
    bytes: Vec<u8>,
    hash: &str,
    imported: i64,
) -> Result<Value> {
    let mut reader = csv::Reader::from_reader(bytes.as_slice());
    let header = reader
        .headers()
        .map_err(|_| Error::bad("invalid_export_csv_header"))?
        .clone();
    if header.len() > 60
        || header.iter().any(|v| v.len() > 150)
        || header
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != header.len()
    {
        return Err(Error::bad("invalid_export_csv_header"));
    }
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query(
        "UPDATE exchange_export_runs SET source_hash=$3,header=$4 WHERE owner_id=$1 AND id=$2",
    )
    .bind(j.owner)
    .bind(j.id)
    .bind(hash)
    .bind(json!(header.iter().collect::<Vec<_>>()))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut fills = Vec::new();
    let mut ledger = Vec::new();
    let mut symbols = std::collections::BTreeSet::new();
    let mut all_symbols = std::collections::BTreeSet::new();
    let mut rows = 0i64;
    for record in reader.records() {
        let record = record.map_err(|_| Error::bad("invalid_export_csv_row"))?;
        rows += 1;
        if rows > 500000 {
            return Err(Error::bad("export_row_budget_exceeded"));
        }
        let row = super::csv_mapping::row(&header, &record, &input.mapping, &input.dataset)?;
        if let Some(symbol) = row["symbol"].as_str().filter(|s| !s.is_empty()) {
            all_symbols.insert(symbol.to_string());
            if rows > imported {
                symbols.insert(symbol.to_string());
            }
        }
        if rows <= imported {
            continue;
        }
        if input.dataset == "trades" {
            fills.push(
                serde_json::from_value(row)
                    .map_err(|_| Error::bad("csv_fill_fields_incomplete"))?,
            );
        } else {
            ledger.push(
                serde_json::from_value(row)
                    .map_err(|_| Error::bad("csv_ledger_fields_incomplete"))?,
            );
        }
        if fills.len() + ledger.len() == 1000 {
            batch(
                s,
                j,
                input,
                (
                    std::mem::take(&mut fills),
                    std::mem::take(&mut ledger),
                    std::mem::take(&mut symbols),
                ),
                rows,
                false,
            )
            .await?;
        }
    }
    if all_symbols.len() > 4000 {
        return Err(Error::bad("export_symbol_budget_exceeded"));
    }
    // The final receipt covers the file's entire declared range. Funding/transfer-only
    // CSVs use the explicit empty-symbol ledger policy, never an invented ticker.
    batch(s, j, input, (fills, ledger, all_symbols), rows, true).await?;
    Ok(
        json!({"export_run_id":j.id,"status":"complete","source_hash":hash,"rows":rows,"coverage":"provider_export_declared_range","account_history_complete":false}),
    )
}
async fn batch(
    s: &Services,
    j: &Job,
    i: &ExchangeExportInput,
    data: (
        Vec<FillInput>,
        Vec<LedgerEntryInput>,
        std::collections::BTreeSet<String>,
    ),
    rows: i64,
    complete: bool,
) -> Result<()> {
    let (fills, ledger_entries, symbols) = data;
    let input = TradeImportInput {
        dataset: if i.dataset == "trades" {
            ImportDataset::Trades
        } else {
            ImportDataset::Ledger
        },
        connection_id: i.connection_id,
        source: ImportSource::HistoricalExport,
        start_at: i.start_at,
        end_at: i.end_at,
        symbols: symbols.into_iter().collect(),
        fills,
        ledger_entries,
        declared_complete: complete,
    };
    super::import::ingest_export(
        s,
        j,
        &format!("export:{}:{rows}:{complete}", j.id),
        input,
        rows,
        complete,
    )
    .await?;
    Ok(())
}

pub async fn mapping(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: ExportMappingUpdate,
) -> Result<Value> {
    let state = get(s, owner, id).await?;
    super::csv_mapping::validate(
        &input.mapping,
        state["body"]["dataset"].as_str().unwrap_or(""),
    )?;
    let body = json!({"export_run_id":id,"mapping":input.mapping,"expected_generation":input.expected_generation});
    let (mut tx, cached) =
        s.db.write(owner, "exchange.export.mapping", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let changed=sqlx::query("UPDATE exchange_export_runs r SET body=jsonb_set(body,'{mapping}',$3) FROM jobs j WHERE r.owner_id=$1 AND r.id=$2 AND j.id=r.id AND j.generation=$4 AND r.imported_rows=0 AND r.status IN ('polling','prepared') AND j.status NOT IN ('running','succeeded','cancelled')").bind(owner).bind(id).bind(json!(input.mapping)).bind(input.expected_generation).execute(&mut *tx).await?;
    if changed.rows_affected() != 1 {
        return Err(Error::conflict("export_mapping_revision_conflict"));
    }
    sqlx::query(
        "INSERT INTO exchange_export_resolutions(id,owner_id,run_id,body) VALUES($1,$2,$3,$4)",
    )
    .bind(Uuid::new_v4())
    .bind(owner)
    .bind(id)
    .bind(&body)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE jobs SET status='queued',generation=generation+1,cycle_attempt=0,run_after=now(),error_code=NULL WHERE owner_id=$1 AND id=$2").bind(owner).bind(id).execute(&mut *tx).await?;
    let v = json!({"export_run_id":id,"generation":input.expected_generation+1,"status":"queued"});
    Database::finish(&mut tx, owner, "exchange.export.mapping", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}

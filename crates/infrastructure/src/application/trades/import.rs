use super::*;
use scorebook_core::domain::trade_ledger::{number, text, validate_fill};
use sqlx::{Postgres, Transaction};
pub(super) fn canonical(f: &mut FillInput) -> Result<()> {
    validate_fill(f)?;
    f.price = text(&number(&f.price)?);
    f.quantity = text(&number(&f.quantity)?);
    f.commission = text(&number(&f.commission)?);
    f.realized_pnl = f
        .realized_pnl
        .as_deref()
        .map(number)
        .transpose()?
        .as_ref()
        .map(text);
    f.trade_id = f
        .trade_id
        .parse::<u128>()
        .map_err(|_| Error::bad("invalid_trade_id"))?
        .to_string();
    Ok(())
}
pub async fn import(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: TradeImportInput,
) -> Result<Value> {
    if !matches!(input.source, ImportSource::Csv) {
        return Err(Error::bad("provider_source_requires_connector"));
    }
    ingest(s, owner, key, input, "user_declared").await
}
pub async fn ingest(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: TradeImportInput,
    provenance: &str,
) -> Result<Value> {
    ingest_with_checkpoint(s, owner, key, input, provenance, None).await
}
enum IngestCheckpoint<'a> {
    Manual,
    Sync(&'a super::sync::Checkpoint),
    Export {
        job: &'a Job,
        rows: i64,
        complete: bool,
    },
}
impl IngestCheckpoint<'_> {
    fn job(&self) -> Option<&Job> {
        match self {
            Self::Manual => None,
            Self::Sync(c) => Some(&c.job),
            Self::Export { job, .. } => Some(job),
        }
    }
    fn project(&self, changed: bool) -> bool {
        match self {
            Self::Manual => changed,
            Self::Sync(c) => c.phase == "complete",
            Self::Export { complete, .. } => *complete,
        }
    }
}
pub async fn ingest_export(
    s: &Services,
    j: &Job,
    key: &str,
    input: TradeImportInput,
    rows: i64,
    complete: bool,
) -> Result<Value> {
    apply(
        s,
        j.owner,
        key,
        input,
        "binance_historical_export",
        IngestCheckpoint::Export {
            job: j,
            rows,
            complete,
        },
    )
    .await
}
pub async fn ingest_with_checkpoint(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: TradeImportInput,
    provenance: &str,
    checkpoint: Option<&super::sync::Checkpoint>,
) -> Result<Value> {
    apply(
        s,
        owner,
        key,
        input,
        provenance,
        checkpoint.map_or(IngestCheckpoint::Manual, IngestCheckpoint::Sync),
    )
    .await
}
async fn apply(
    s: &Services,
    owner: Uuid,
    key: &str,
    mut input: TradeImportInput,
    provenance: &str,
    checkpoint: IngestCheckpoint<'_>,
) -> Result<Value> {
    if input.fills.len() + input.ledger_entries.len() > 10000
        || input.start_at >= input.end_at
        || input.end_at > Utc::now()
        || (input.symbols.is_empty()
            && !matches!(input.dataset, ImportDataset::Ledger)
            && !(matches!(input.source, ImportSource::HistoricalExport) && input.fills.is_empty()))
        || input.symbols.len() > 4000
    {
        return Err(Error::bad("invalid_trade_import_bounds"));
    }
    if matches!(input.dataset, ImportDataset::Trades) && !input.ledger_entries.is_empty()
        || matches!(input.dataset, ImportDataset::Ledger) && !input.fills.is_empty()
    {
        return Err(Error::bad("import_dataset_conflict"));
    }
    for symbol in &input.symbols {
        super::super::history_catalog::validate_symbol(symbol)?;
    }
    for fill in &mut input.fills {
        canonical(fill)?;
        if !input.symbols.contains(&fill.symbol)
            || fill.traded_at < input.start_at
            || fill.traded_at >= input.end_at
        {
            return Err(Error::bad("fill_outside_declared_coverage"));
        }
    }
    for entry in &mut input.ledger_entries {
        canonical_entry(entry, input.start_at, input.end_at)?;
    }
    input.fills.sort_by(|a, b| {
        a.symbol
            .cmp(&b.symbol)
            .then(a.traded_at.cmp(&b.traded_at))
            .then_with(|| a.trade_id.len().cmp(&b.trade_id.len()))
            .then(a.trade_id.cmp(&b.trade_id))
    });
    input.ledger_entries.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(a.transaction_id.cmp(&b.transaction_id))
    });
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "trade.import", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM exchange_connections WHERE owner_id=$1 AND id=$2 AND disabled_at IS NULL)").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(Error::not_found());
    }
    // Per-account lock, so concurrent overlapping uploads cannot both pass the
    // conflict check and silently discard a differing financial record.
    sqlx::query("SELECT id FROM exchange_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE")
        .bind(owner)
        .bind(input.connection_id)
        .fetch_one(&mut *tx)
        .await?;
    if let Some(c) = checkpoint.job() {
        let alive:Option<Uuid>=sqlx::query_scalar("SELECT id FROM jobs WHERE id=$1 AND owner_id=$2 AND generation=$3 AND lease_owner=$4 AND status='running' AND lease_until>now() FOR UPDATE").bind(c.id).bind(owner).bind(c.generation).bind(c.lease).fetch_optional(&mut *tx).await?;
        if alive.is_none() {
            return Err(crate::application::jobs::lease_lost());
        }
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO trade_imports(id,owner_id,connection_id,source,provenance,source_hash,start_at,end_at,symbols,declared_complete,status,dataset) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ingesting',$11)").bind(id).bind(owner).bind(input.connection_id).bind(match input.source{ImportSource::Csv=>"csv",ImportSource::AccountApi=>"account_api",ImportSource::HistoricalExport=>"historical_export"}).bind(provenance).bind(digest(&body)).bind(input.start_at).bind(input.end_at).bind(&input.symbols).bind(input.declared_complete).bind(match input.dataset{ImportDataset::Trades=>"trades",ImportDataset::Ledger=>"ledger",ImportDataset::Both=>"both"}).execute(&mut *tx).await?;
    sqlx::query("CREATE TEMP TABLE trade_stage(payload jsonb NOT NULL) ON COMMIT DROP")
        .execute(&mut *tx)
        .await?;
    let mut fills = 0u64;
    let mut entries = 0u64;
    for block in input.fills.chunks(1000) {
        copy_stage(&mut tx, block).await?;
        let conflict:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trade_stage s JOIN trade_fills f ON f.owner_id=$1 AND f.connection_id=$2 AND f.symbol=s.payload->>'symbol' AND f.trade_id=s.payload->>'trade_id' WHERE f.body<>s.payload) OR EXISTS(SELECT 1 FROM trade_stage GROUP BY payload->>'symbol',payload->>'trade_id' HAVING count(DISTINCT payload)>1)").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?;
        if conflict {
            return Err(Error::conflict("trade_source_conflict"));
        }
        fills+=sqlx::query("INSERT INTO trade_fills(id,owner_id,connection_id,import_id,symbol,trade_id,trade_sequence,order_id,position_side,side,traded_at,price,quantity,realized_pnl,settlement_asset,commission,commission_asset,body,ingested_revision) SELECT gen_random_uuid(),$1,$2,$3,payload->>'symbol',payload->>'trade_id',(payload->>'trade_id')::numeric,payload->>'order_id',payload->>'position_side',payload->>'side',(payload->>'traded_at')::timestamptz,(payload->>'price')::numeric,(payload->>'quantity')::numeric,(payload->>'realized_pnl')::numeric,payload->>'settlement_asset',(payload->>'commission')::numeric,payload->>'commission_asset',payload,(SELECT ledger_revision+1 FROM exchange_connections WHERE owner_id=$1 AND id=$2) FROM trade_stage ON CONFLICT(owner_id,connection_id,symbol,trade_id) DO NOTHING").bind(owner).bind(input.connection_id).bind(id).execute(&mut *tx).await?.rows_affected();
    }
    for block in input.ledger_entries.chunks(1000) {
        copy_stage(&mut tx, block).await?;
        let conflict:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM trade_stage s JOIN account_ledger_entries e ON e.owner_id=$1 AND e.connection_id=$2 AND e.kind=s.payload->>'kind' AND e.transaction_id=s.payload->>'transaction_id' WHERE e.body<>s.payload) OR EXISTS(SELECT 1 FROM trade_stage GROUP BY payload->>'kind',payload->>'transaction_id' HAVING count(DISTINCT payload)>1)").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?;
        if conflict {
            return Err(Error::conflict("ledger_source_conflict"));
        }
        entries+=sqlx::query("INSERT INTO account_ledger_entries(id,owner_id,connection_id,import_id,transaction_id,kind,symbol,asset,amount,occurred_at,trade_id,body) SELECT gen_random_uuid(),$1,$2,$3,payload->>'transaction_id',payload->>'kind',payload->>'symbol',payload->>'asset',(payload->>'amount')::numeric,(payload->>'occurred_at')::timestamptz,payload->>'trade_id',payload FROM trade_stage ON CONFLICT(owner_id,connection_id,kind,transaction_id) DO NOTHING").bind(owner).bind(input.connection_id).bind(id).execute(&mut *tx).await?.rows_affected();
    }
    sqlx::query("INSERT INTO trade_books SELECT DISTINCT owner_id,connection_id,symbol,position_side,settlement_asset FROM trade_fills WHERE owner_id=$1 AND import_id=$2 ON CONFLICT DO NOTHING").bind(owner).bind(id).execute(&mut *tx).await?;
    // Update account aggregates only from rows inserted by this batch, never from
    // replayed duplicates. Knowledge citations now read O(assets), not full ledgers.
    sqlx::query("INSERT INTO account_asset_totals SELECT owner_id,connection_id,'fill_realized_pnl',settlement_asset,COALESCE(sum(realized_pnl),0),count(*),count(*) FILTER(WHERE realized_pnl IS NULL) FROM trade_fills WHERE owner_id=$1 AND import_id=$2 GROUP BY owner_id,connection_id,settlement_asset UNION ALL SELECT owner_id,connection_id,'fill_commission',commission_asset,sum(commission),count(*),0 FROM trade_fills WHERE owner_id=$1 AND import_id=$2 GROUP BY owner_id,connection_id,commission_asset UNION ALL SELECT owner_id,connection_id,'income:'||kind,asset,sum(amount),count(*),0 FROM account_ledger_entries WHERE owner_id=$1 AND import_id=$2 GROUP BY owner_id,connection_id,kind,asset ON CONFLICT(owner_id,connection_id,kind,asset) DO UPDATE SET amount=account_asset_totals.amount+EXCLUDED.amount,entry_count=account_asset_totals.entry_count+EXCLUDED.entry_count,missing_count=account_asset_totals.missing_count+EXCLUDED.missing_count").bind(owner).bind(id).execute(&mut *tx).await?;
    let revision: i64 = if fills + entries > 0 {
        sqlx::query_scalar("UPDATE exchange_connections SET ledger_revision=ledger_revision+1 WHERE owner_id=$1 AND id=$2 RETURNING ledger_revision").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?
    } else {
        sqlx::query_scalar(
            "SELECT ledger_revision FROM exchange_connections WHERE owner_id=$1 AND id=$2",
        )
        .bind(owner)
        .bind(input.connection_id)
        .fetch_one(&mut *tx)
        .await?
    };

    sqlx::query("UPDATE trade_imports SET status='complete',inserted_fills=$2,inserted_entries=$3,completed_at=now() WHERE id=$1").bind(id).bind(fills as i64).bind(entries as i64).execute(&mut *tx).await?;
    let job = if checkpoint.project(fills + entries > 0) {
        Some(
            jobs::enqueue_tx(
                &mut tx,
                owner,
                "trade.project",
                &format!("{}:{revision}", input.connection_id),
                json!({"connection_id":input.connection_id,"ledger_revision":revision}),
            )
            .await?,
        )
    } else {
        None
    };
    let result = json!({"import_id":id,"connection_id":input.connection_id,"status":"complete","inserted_fills":fills,"duplicate_fills":input.fills.len()as u64-fills,"inserted_entries":entries,"ledger_revision":revision,"projection_job_id":job,"coverage":{"start_at":input.start_at,"end_at":input.end_at,"symbols":input.symbols,"declared_complete":input.declared_complete,"provenance":provenance,"entire_account_history_verified":false}});
    if let IngestCheckpoint::Sync(c) = &checkpoint {
        sqlx::query("UPDATE exchange_sync_runs SET next_start=$2,next_trade_id=$3,next_income_page=$4,phase=$5,symbol_no=$6,status=$7,last_page_hash=$9 WHERE id=$1 AND owner_id=$8").bind(c.job.id).bind(c.next_start).bind(&c.from_id).bind(c.page as i32).bind(&c.phase).bind(c.symbol_no as i32).bind(if c.phase=="complete"{"complete"}else{"running"}).bind(owner).bind(&c.page_hash).execute(&mut *tx).await?;
    }
    if let IngestCheckpoint::Export {
        job,
        rows,
        complete,
    } = checkpoint
    {
        sqlx::query("UPDATE exchange_export_runs SET imported_rows=$3,status=CASE WHEN $4 THEN 'complete' ELSE 'importing' END,completed_at=CASE WHEN $4 THEN now() ELSE NULL END WHERE owner_id=$1 AND id=$2").bind(owner).bind(job.id).bind(rows).bind(complete).execute(&mut *tx).await?;
    }
    Database::finish(&mut tx, owner, "trade.import", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
async fn copy_stage<T: serde::Serialize>(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[T],
) -> Result<()> {
    sqlx::query("TRUNCATE trade_stage")
        .execute(&mut **tx)
        .await?;
    let mut bytes = Vec::new();
    for row in rows {
        let line = serde_json::to_string(row).map_err(|_| Error::bad("invalid_import_row"))?;
        bytes.extend_from_slice(b"\"");
        bytes.extend_from_slice(line.replace('"', "\"\"").as_bytes());
        bytes.extend_from_slice(b"\"\n");
    }
    let mut copy = tx
        .copy_in_raw("COPY trade_stage(payload) FROM STDIN WITH (FORMAT csv)")
        .await?;
    copy.send(bytes).await?;
    copy.finish().await?;
    Ok(())
}
pub async fn csv(s: &Services, owner: Uuid, key: &str, input: CsvImportInput) -> Result<Value> {
    if input.schema != "scorebook_fills_v1" || input.csv.len() > 2 * 1024 * 1024 {
        return Err(Error::bad("unsupported_csv_schema_or_size"));
    }
    let mut reader = csv::Reader::from_reader(input.csv.as_bytes());
    let mut fills = Vec::new();
    for row in reader.deserialize::<FillInput>() {
        fills.push(row.map_err(|_| Error::bad("invalid_csv_row"))?);
        if fills.len() > 10000 {
            return Err(Error::bad("csv_row_limit_exceeded"));
        }
    }
    ingest(
        s,
        owner,
        key,
        TradeImportInput {
            dataset: ImportDataset::Trades,
            connection_id: input.connection_id,
            source: ImportSource::Csv,
            start_at: input.start_at,
            end_at: input.end_at,
            symbols: input.symbols,
            fills,
            ledger_entries: vec![],
            declared_complete: input.declared_complete,
        },
        "user_declared_csv",
    )
    .await
}

pub(super) fn canonical_entry(
    entry: &mut LedgerEntryInput,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<()> {
    entry.amount = text(&number(&entry.amount)?);
    if entry.transaction_id.is_empty()
        || entry.transaction_id.len() > 100
        || entry.kind.is_empty()
        || entry.kind.len() > 64
        || entry.asset.is_empty()
        || entry.asset.len() > 20
        || entry.occurred_at < start
        || entry.occurred_at >= end
    {
        return Err(Error::bad("invalid_ledger_entry"));
    }
    if let Some(symbol) = entry.symbol.as_deref().filter(|s| !s.is_empty()) {
        super::super::history_catalog::validate_symbol(symbol)?;
    }
    Ok(())
}

use super::*;
use crate::error::RetryDirective;
use scorebook_core::exchange::AccountRead;
pub struct Checkpoint {
    pub page_hash: Option<String>,
    pub job: Job,
    pub next_start: DateTime<Utc>,
    pub from_id: Option<String>,
    pub page: u32,
    pub phase: String,
    pub symbol_no: usize,
}
pub async fn create(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ExchangeSyncInput,
) -> Result<Value> {
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "exchange.sync", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let oldest = Utc::now()
        .checked_sub_months(chrono::Months::new(3))
        .ok_or_else(|| Error::bad("invalid_date"))?;
    if input.start_at < oldest
        || input.start_at >= input.end_at
        || input.end_at > Utc::now()
        || input.symbols.is_empty()
        || input.symbols.len() > 200
    {
        return Err(Error::bad(
            "recent_sync_requires_known_symbols_and_last_three_months",
        ));
    }
    for symbol in &input.symbols {
        super::super::history_catalog::validate_symbol(symbol)?;
    }
    let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM exchange_connections WHERE owner_id=$1 AND id=$2 AND disabled_at IS NULL)").bind(owner).bind(input.connection_id).fetch_one(&mut *tx).await?;
    if !exists {
        return Err(Error::not_found());
    }
    let id = jobs::enqueue_tx(&mut tx, owner, "trade.sync", key, body.clone()).await?;
    sqlx::query("INSERT INTO exchange_sync_runs(id,owner_id,connection_id,body,next_start) VALUES($1,$2,$3,$4,$5)").bind(id).bind(owner).bind(input.connection_id).bind(body.clone()).bind(input.start_at).execute(&mut *tx).await?;
    let result = json!({"sync_run_id":id,"job_id":id,"status":"queued","coverage":"declared_symbols_only","account_history_complete":false});
    Database::finish(&mut tx, owner, "exchange.sync", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar("SELECT (to_jsonb(r)-'owner_id')||jsonb_build_object('job_status',j.status,'error_code',j.error_code,'generation',j.generation) FROM exchange_sync_runs r JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)
}
pub async fn step(s: &Services, j: &Job) -> Result<Value> {
    let state = get(s, j.owner, j.id).await?;
    if state["status"] == "complete" {
        return Ok(state);
    }
    let input: ExchangeSyncInput = serde_json::from_value(state["body"].clone())
        .map_err(|_| Error::bad("invalid_sync_definition"))?;
    let row=sqlx::query("SELECT c.market,k.keychain_service FROM exchange_connections c LEFT JOIN exchange_credentials k ON k.owner_id=c.owner_id AND k.connection_id=c.id WHERE c.owner_id=$1 AND c.id=$2 AND c.disabled_at IS NULL").bind(j.owner).bind(input.connection_id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)?;
    let market: String = row.get("market");
    let service: String = row
        .get::<Option<String>, _>("keychain_service")
        .ok_or_else(|| {
            Error::deferred(
                "exchange_credentials_not_configured",
                RetryDirective::AwaitCapability,
            )
        })?;
    let symbol_no = state["symbol_no"].as_u64().unwrap_or(0) as usize;
    let start: DateTime<Utc> = serde_json::from_value(state["next_start"].clone())
        .map_err(|_| Error::bad("invalid_sync_cursor"))?;
    let end = (start + chrono::Duration::days(7)).min(input.end_at);
    let phase = state["phase"]
        .as_str()
        .ok_or_else(|| Error::bad("invalid_sync_phase"))?;
    let from_id = state["next_trade_id"].as_str().map(str::to_string);
    let page = state["next_income_page"].as_u64().unwrap_or(1) as u32;
    let mut checkpoint = Checkpoint {
        page_hash: None,
        job: j.clone(),
        next_start: start,
        from_id: from_id.clone(),
        page,
        phase: phase.into(),
        symbol_no,
    };
    let request = if phase == "trades" {
        AccountRead::Trades {
            symbol: input
                .symbols
                .get(symbol_no)
                .ok_or_else(|| Error::bad("invalid_sync_symbol_cursor"))?
                .clone(),
            start,
            end,
            from_id: from_id.clone(),
        }
    } else if phase == "income" {
        AccountRead::Income { start, end, page }
    } else {
        return Err(Error::bad("invalid_sync_phase"));
    };
    let payload = s.accounts.read(&service, &market, request).await?;
    let rows = payload
        .as_array()
        .filter(|v| v.len() <= 1000)
        .ok_or_else(|| Error::bad("invalid_exchange_page"))?;
    let page_hash = digest(&payload);
    if state["last_page_hash"].as_str() == Some(&page_hash) && rows.len() == 1000 {
        return Err(Error::bad("exchange_page_not_advancing"));
    }
    let mut fills = Vec::new();
    let mut entries = Vec::new();
    let mut finished = rows.len() < 1000;
    let mut last_id = None;
    let catalog_asset: Option<String> = if phase == "trades" {
        sqlx::query_scalar::<_,Option<String>>("SELECT body->>'marginAsset' FROM instrument_catalog WHERE venue='binance' AND market=$1 AND symbol=$2").bind(&market).bind(&input.symbols[symbol_no]).fetch_optional(&s.db.pool).await?.flatten()
    } else {
        None
    };
    if phase == "trades" {
        for row in rows {
            let at = at(row, "time")?;
            let id = exchange_id(row, "id")?;
            if last_id
                .as_ref()
                .is_some_and(|v: &String| v.parse::<u64>().ok() >= id.parse::<u64>().ok())
            {
                return Err(Error::bad("exchange_trade_cursor_not_advancing"));
            }
            last_id = Some(id.clone());
            if at >= end {
                finished = true;
                continue;
            }
            if at < start {
                return Err(Error::bad("exchange_trade_outside_window"));
            }
            let symbol = string(row, "symbol")?;
            if Some(&symbol) != input.symbols.get(symbol_no) {
                return Err(Error::bad("exchange_symbol_mismatch"));
            }
            let asset = if let Some(asset) = row["marginAsset"].as_str() {
                asset.to_string()
            } else {
                catalog_asset.clone().ok_or_else(|| {
                    Error::deferred(
                        "verified_settlement_asset_required",
                        RetryDirective::AwaitInput,
                    )
                })?
            };
            fills.push(FillInput {
                trade_id: id,
                order_id: Some(exchange_id(row, "orderId")?),
                symbol,
                side: serde_json::from_value(row["side"].clone())
                    .map_err(|_| Error::bad("invalid_exchange_side"))?,
                position_side: serde_json::from_value(row["positionSide"].clone())
                    .map_err(|_| Error::bad("invalid_exchange_position_side"))?,
                price: string(row, "price")?,
                quantity: string(row, "qty")?,
                realized_pnl: Some(string(row, "realizedPnl")?),
                settlement_asset: asset,
                commission: string(row, "commission")?,
                commission_asset: string(row, "commissionAsset")?,
                traded_at: at,
                liquidation: None,
            });
        }
        if finished {
            checkpoint.from_id = None;
            checkpoint.next_start = end;
            if end >= input.end_at {
                checkpoint.symbol_no += 1;
                checkpoint.next_start = input.start_at;
                if checkpoint.symbol_no == input.symbols.len() {
                    checkpoint.phase = "income".into();
                }
            }
        } else {
            let next = last_id
                .and_then(|v| v.parse::<u64>().ok())
                .and_then(|v| v.checked_add(1))
                .ok_or_else(|| Error::bad("exchange_cursor_overflow"))?
                .to_string();
            if Some(&next) == from_id.as_ref() {
                return Err(Error::bad("exchange_trade_cursor_not_advancing"));
            }
            checkpoint.from_id = Some(next);
        }
    } else {
        for row in rows {
            let occurred_at = at(row, "time")?;
            if occurred_at < start || occurred_at >= end {
                return Err(Error::bad("exchange_income_outside_window"));
            }
            entries.push(LedgerEntryInput {
                transaction_id: exchange_id(row, "tranId")?,
                kind: string(row, "incomeType")?,
                symbol: row["symbol"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .map(str::to_string),
                asset: string(row, "asset")?,
                amount: string(row, "income")?,
                occurred_at,
                trade_id: row["tradeId"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .map(str::to_string),
            });
        }
        if finished {
            checkpoint.next_start = end;
            checkpoint.page = 1;
            if end >= input.end_at {
                checkpoint.phase = "complete".into();
            }
        } else {
            checkpoint.page = page
                .checked_add(1)
                .ok_or_else(|| Error::bad("income_page_overflow"))?;
        }
    }
    checkpoint.page_hash = if finished { None } else { Some(page_hash) };
    let key = format!(
        "sync:{}:{phase}:{symbol_no}:{}:{}:{page}",
        j.id,
        start.timestamp_millis(),
        from_id.as_deref().unwrap_or("time")
    );
    let imported = super::import::ingest_with_checkpoint(
        s,
        j.owner,
        &key,
        TradeImportInput {
            connection_id: input.connection_id,
            dataset: if phase == "trades" {
                ImportDataset::Trades
            } else {
                ImportDataset::Ledger
            },
            source: ImportSource::AccountApi,
            start_at: start,
            end_at: end,
            symbols: if phase == "trades" {
                vec![input.symbols[symbol_no].clone()]
            } else {
                input.symbols.clone()
            },
            fills,
            ledger_entries: entries,
            declared_complete: finished,
        },
        "signed_binance_account_api",
        Some(&checkpoint),
    )
    .await?;
    if checkpoint.phase == "complete" {
        Ok(
            json!({"sync_run_id":j.id,"status":"complete","symbols":input.symbols,"start_at":input.start_at,"end_at":input.end_at,"last_import":imported,"entire_account_history_verified":false}),
        )
    } else {
        Err(Error::deferred(
            "exchange_next_page_scheduled",
            RetryDirective::At(Utc::now() + chrono::Duration::seconds(1)),
        ))
    }
}
fn string(row: &Value, key: &str) -> Result<String> {
    row[key]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| Error::bad("invalid_exchange_string"))
}
fn exchange_id(row: &Value, key: &str) -> Result<String> {
    if let Some(v) = row[key].as_u64() {
        Ok(v.to_string())
    } else {
        let v = string(row, key)?;
        if v.parse::<u64>().is_ok() {
            Ok(v)
        } else {
            Err(Error::bad("invalid_exchange_id"))
        }
    }
}
fn at(row: &Value, key: &str) -> Result<DateTime<Utc>> {
    row[key]
        .as_i64()
        .and_then(DateTime::from_timestamp_millis)
        .ok_or_else(|| Error::bad("invalid_exchange_timestamp"))
}

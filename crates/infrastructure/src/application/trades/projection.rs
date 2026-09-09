use super::*;
use futures_util::TryStreamExt;
use scorebook_core::domain::trade_ledger::CycleSummary;
pub async fn build(s: &Services, j: &Job) -> Result<Value> {
    let connection: Uuid = serde_json::from_value(j.body["connection_id"].clone())
        .map_err(|_| Error::bad("invalid_projection_job"))?;
    let (market, revision): (String, i64) = sqlx::query_as(
        "SELECT market,ledger_revision FROM exchange_connections WHERE owner_id=$1 AND id=$2",
    )
    .bind(j.owner)
    .bind(connection)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)?;
    if j.body["ledger_revision"].as_i64() != Some(revision) {
        return Ok(json!({"status":"superseded","connection_id":connection}));
    }
    let run = Uuid::new_v4();
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("INSERT INTO trade_projection_runs(id,owner_id,connection_id,ledger_revision,status) VALUES($1,$2,$3,$4,'building')").bind(run).bind(j.owner).bind(connection).bind(revision).execute(&mut *tx).await?;
    tx.commit().await?;
    let books:Vec<(String,String,String)>=sqlx::query_as("SELECT symbol,position_side,settlement_asset FROM trade_books WHERE owner_id=$1 AND connection_id=$2 ORDER BY symbol,position_side,settlement_asset LIMIT 10001").bind(j.owner).bind(connection).fetch_all(&s.db.pool).await?;
    if books.len() > 10000 {
        return Err(Error::bad("projection_book_budget_exceeded"));
    }
    let mut identities = std::collections::HashSet::new();
    if books
        .iter()
        .any(|(symbol, side, _)| !identities.insert((symbol, side)))
    {
        return Err(Error::bad("settlement_asset_change_requires_separate_book"));
    }
    let mut scanned_fills = 0u64;
    let mut modes = std::collections::BTreeMap::<String, u64>::new();
    for (symbol, position_side, asset) in books {
        let seed:Option<Value>=sqlx::query_scalar("SELECT body FROM position_seeds WHERE owner_id=$1 AND connection_id=$2 AND symbol=$3 AND position_side=$4 ORDER BY created_at DESC,id DESC LIMIT 1").bind(j.owner).bind(connection).bind(&symbol).bind(&position_side).fetch_optional(&s.db.pool).await?;
        let seed = if let Some(seed) = seed {
            serde_json::from_value(seed).map_err(|_| Error::bad("invalid_position_seed"))?
        } else {
            PositionSeedInput {
                connection_id: connection,
                symbol: symbol.clone(),
                position_side: serde_json::from_value(json!(position_side))
                    .map_err(|_| Error::bad("invalid_position_side"))?,
                effective_at: DateTime::UNIX_EPOCH,
                quantity: None,
                entry_price: None,
                contract_multiplier: "1".into(),
                settlement_asset: asset.clone(),
                evidence: "No verified opening position was supplied".into(),
            }
        };
        let mut resume = super::projection_incremental::prepare(
            s,
            j,
            run,
            connection,
            &seed,
            market == "coin_m",
        )
        .await?;
        *modes.entry(resume.mode.into()).or_default() += 1;
        if resume.mode == "unchanged_book" {
            continue;
        }
        let after = resume.projector.last_order();
        let mut rows=sqlx::query("SELECT id,body FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND symbol=$3 AND position_side=$4 AND settlement_asset=$5 AND ($6::timestamptz IS NULL OR (traded_at,trade_sequence)>($6,$7::text::numeric)) ORDER BY traded_at,trade_sequence").bind(j.owner).bind(connection).bind(&symbol).bind(&position_side).bind(&asset).bind(after.map(|v|v.0)).bind(after.map(|v|v.1.to_string())).fetch(&s.db.pool);
        let mut summaries = std::collections::BTreeMap::<u64, Value>::new();
        let mut allocations = Vec::new();
        while let Some(row) = rows.try_next().await? {
            let fill: FillInput = serde_json::from_value(row.get("body"))
                .map_err(|_| Error::bad("invalid_stored_fill"))?;
            let fill_id: Uuid = row.get("id");
            scanned_fills += 1;
            let step = resume.projector.push(&fill)?;
            for summary in step.completed {
                summaries.insert(summary.ordinal, cycle_row(run, connection, &summary));
            }
            if step.current.fills > 0 {
                summaries.insert(
                    step.current.ordinal,
                    cycle_row(run, connection, &step.current),
                );
            }
            for allocation in step.allocations {
                allocations.push(json!({"cycle_id":cycle_id(run,&symbol,&position_side,allocation.cycle_ordinal),"fill_id":fill_id,"quantity":allocation.quantity,"commission":allocation.commission,"portion":allocation.portion}));
            }
            if allocations.len() >= 1000 {
                flush(s, j, run, connection, &summaries, &allocations).await?;
                summaries.clear();
                allocations.clear();
            }
        }
        flush(s, j, run, connection, &summaries, &allocations).await?;
        super::projection_incremental::finish(s, j, run, &seed, &resume).await?;
    }
    let mut tx = jobs::fence(s, j).await?;
    let current: i64 = sqlx::query_scalar(
        "SELECT ledger_revision FROM exchange_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(j.owner)
    .bind(connection)
    .fetch_one(&mut *tx)
    .await?;
    if current != revision {
        sqlx::query(
            "UPDATE trade_projection_runs SET status='superseded',completed_at=now() WHERE id=$1",
        )
        .bind(run)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(json!({"run_id":run,"status":"superseded"}));
    }
    // Publish closed epochs only after checking the account revision under lock.
    // A superseded producer cannot contaminate the active append-only epoch.
    sqlx::query("INSERT INTO trade_epoch_cycles SELECT s.owner_id,s.epoch_id,s.symbol,s.position_side,c.ordinal,c.id FROM trade_book_snapshots s JOIN trade_cycles c ON c.owner_id=s.owner_id AND c.run_id=s.run_id AND c.symbol=s.symbol AND c.position_side=s.position_side WHERE s.owner_id=$1 AND s.run_id=$2 AND c.body->>'closed_at' IS NOT NULL ON CONFLICT DO NOTHING").bind(j.owner).bind(run).execute(&mut *tx).await?;
    sqlx::query("UPDATE trade_projection_runs SET status='ready',completed_at=now() WHERE id=$1")
        .bind(run)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO trade_projection_heads(owner_id,connection_id,run_id) VALUES($1,$2,$3) ON CONFLICT(owner_id,connection_id) DO UPDATE SET run_id=EXCLUDED.run_id").bind(j.owner).bind(connection).bind(run).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(
        json!({"projection_run_id":run,"connection_id":connection,"ledger_revision":revision,"processed_fills":scanned_fills,"book_modes":modes,"status":"ready","funding_allocation":"unallocated_ledger_entries"}),
    )
}
pub(super) fn cycle_id(run: Uuid, symbol: &str, side: &str, ordinal: u64) -> Uuid {
    let hash = digest(&json!([run, symbol, side, ordinal]));
    Uuid::parse_str(&hash[..32]).expect("SHA256 prefix UUID")
}
fn cycle_row(run: Uuid, connection: Uuid, c: &CycleSummary) -> Value {
    json!({"id":cycle_id(run,&c.symbol,super::side(&c.position_side),c.ordinal),"connection_id":connection,"symbol":c.symbol,"position_side":super::side(&c.position_side),"ordinal":c.ordinal,"body":c})
}
async fn flush(
    s: &Services,
    j: &Job,
    run: Uuid,
    connection: Uuid,
    summaries: &std::collections::BTreeMap<u64, Value>,
    allocations: &[Value],
) -> Result<()> {
    if allocations.is_empty() {
        return Ok(());
    }
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("INSERT INTO trade_cycles(id,owner_id,run_id,connection_id,symbol,position_side,ordinal,body) SELECT r.id,$1,$2,$3,r.symbol,r.position_side,r.ordinal,r.body FROM jsonb_to_recordset($4) r(id uuid,symbol text,position_side text,ordinal bigint,body jsonb) ON CONFLICT(run_id,symbol,position_side,ordinal) DO UPDATE SET body=EXCLUDED.body").bind(j.owner).bind(run).bind(connection).bind(json!(summaries.values().collect::<Vec<_>>())).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO trade_cycle_allocations(owner_id,cycle_id,fill_id,quantity,commission,portion) SELECT $1,r.* FROM jsonb_to_recordset($2) r(cycle_id uuid,fill_id uuid,quantity numeric,commission numeric,portion text) ON CONFLICT DO NOTHING").bind(j.owner).bind(json!(allocations)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
#[derive(serde::Serialize, serde::Deserialize)]
struct CycleCursor {
    runs: Vec<Uuid>,
    after: Uuid,
    filter_hash: String,
}
pub async fn list(s: &Services, owner: Uuid, input: TradeFilter) -> Result<Value> {
    let filter_hash = digest(&json!([
        input.connection_id,
        input.symbol,
        input.start_at,
        input.end_at
    ]));
    let cursor: Option<CycleCursor> = input
        .cursor
        .as_ref()
        .map(|v| serde_json::from_str(v))
        .transpose()
        .map_err(|_| Error::bad("invalid_cycle_cursor"))?;
    let (runs, after) = if let Some(c) = cursor {
        if c.runs.len() > 1000 || c.filter_hash != filter_hash {
            return Err(Error::bad("cycle_cursor_filter_mismatch"));
        }
        (c.runs, Some(c.after))
    } else {
        let runs:Vec<Uuid>=sqlx::query_scalar("SELECT run_id FROM trade_projection_heads WHERE owner_id=$1 AND ($2::uuid IS NULL OR connection_id=$2) ORDER BY connection_id LIMIT 1001").bind(owner).bind(input.connection_id).fetch_all(&s.db.pool).await?;
        if runs.len() > 1000 {
            return Err(Error::bad("connection_filter_required"));
        }
        (runs, None)
    };
    let rows:Vec<Value>=sqlx::query_scalar("WITH members AS(SELECT s.owner_id,s.run_id,c.cycle_id FROM trade_book_snapshots s JOIN trade_epoch_cycles c ON c.owner_id=s.owner_id AND c.epoch_id=s.epoch_id AND c.symbol=s.symbol AND c.position_side=s.position_side AND c.ordinal<=s.closed_through WHERE s.owner_id=$1 AND s.run_id=ANY($2) UNION ALL SELECT owner_id,run_id,open_cycle_id FROM trade_book_snapshots WHERE owner_id=$1 AND run_id=ANY($2) AND open_cycle_id IS NOT NULL), page AS MATERIALIZED(SELECT c.id,p.run_id FROM members p JOIN trade_cycles c ON c.owner_id=p.owner_id AND c.id=p.cycle_id JOIN trade_projection_runs r ON r.owner_id=p.owner_id AND r.id=p.run_id WHERE r.status='ready' AND ($3::text IS NULL OR c.symbol=$3) AND ($4::uuid IS NULL OR c.id>$4) AND ($5::timestamptz IS NULL OR COALESCE((c.body->>'closed_at')::timestamptz,'infinity')>=$5) AND ($6::timestamptz IS NULL OR COALESCE((c.body->>'opened_at')::timestamptz,'-infinity')<$6) ORDER BY c.id LIMIT 101) SELECT jsonb_build_object('id',c.id,'connection_id',c.connection_id,'projection_run_id',r.id,'cycle',c.body,'ledger_revision',r.ledger_revision,'stale',r.ledger_revision<>e.ledger_revision) FROM page p JOIN trade_cycles c ON c.owner_id=$1 AND c.id=p.id JOIN trade_projection_runs r ON r.owner_id=$1 AND r.id=p.run_id JOIN exchange_connections e ON e.owner_id=$1 AND e.id=c.connection_id ORDER BY c.id").bind(owner).bind(&runs).bind(input.symbol).bind(after).bind(input.start_at).bind(input.end_at).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    let next = if more {
        Some(
            serde_json::to_string(&CycleCursor {
                runs: runs.clone(),
                after: serde_json::from_value(items.last().unwrap()["id"].clone()).unwrap(),
                filter_hash,
            })
            .unwrap(),
        )
    } else {
        None
    };
    Ok(
        json!({"next_cursor":next,"items":items,"projection_run_ids":runs,"time_filter":"cycle_overlaps_half_open_range","pagination":"frozen_projection_runs"}),
    )
}

use crate::error::{Error, Result};
use scorebook_core::{api::review_trades::ReviewTrade, domain::trade_ledger::number};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

fn decimal(value: &Option<String>, positive: bool) -> Result<()> {
    if let Some(v) = value {
        if v.len() > 80 || v.trim().is_empty() {
            return Err(Error::bad("invalid_review_trade_number"));
        }
        let n = number(v).map_err(|_| Error::bad("invalid_review_trade_number"))?;
        if positive && n <= 0 {
            return Err(Error::bad("invalid_review_trade_number"));
        }
    }
    Ok(())
}

/// Resolve selected ledger positions inside the same transaction as the review.
/// Client-supplied exchange prices or P&L are never accepted.
pub(super) async fn snapshots(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    trades: &[ReviewTrade],
    publish: bool,
) -> Result<Vec<Value>> {
    if trades.len() > 20 {
        return Err(Error::bad("too_many_review_trades"));
    }
    let mut rows = Vec::new();
    let mut selected = std::collections::HashSet::new();
    for trade in trades {
        match trade {
            ReviewTrade::Manual {
                symbol,
                direction,
                opened_at,
                closed_at,
                quantity,
                quantity_unit,
                leverage,
                entry_price,
                exit_price,
                realized_pnl,
                settlement_asset,
                fees,
                margin_mode,
                note,
            } => {
                if symbol.len() > 80
                    || direction
                        .as_ref()
                        .is_some_and(|v| !matches!(v.as_str(), "long" | "short"))
                    || margin_mode
                        .as_ref()
                        .is_some_and(|v| !matches!(v.as_str(), "cross" | "isolated"))
                    || [quantity_unit, settlement_asset]
                        .iter()
                        .any(|v| v.as_ref().is_some_and(|s| s.len() > 30))
                    || note.as_ref().is_some_and(|s| s.len() > 10000)
                {
                    return Err(Error::bad("invalid_review_trade"));
                }
                for value in [quantity, leverage, entry_price, exit_price] {
                    decimal(value, true)?;
                }
                for value in [realized_pnl, fees] {
                    decimal(value, false)?;
                }
                if opened_at
                    .zip(*closed_at)
                    .is_some_and(|(start, end)| end < start)
                {
                    return Err(Error::bad("review_trade_time_order"));
                }
                if publish
                    && (symbol.trim().is_empty()
                        || direction.is_none()
                        || opened_at.is_none()
                        || quantity.is_none()
                        || quantity_unit.as_ref().is_none_or(|s| s.trim().is_empty()))
                {
                    return Err(Error::bad("review_trade_details_required"));
                }
                rows.push(json!({"source":"manual","trade":trade}));
            }
            ReviewTrade::Exchange {
                connection_id,
                cycle_id,
                leverage,
                note,
            } => {
                decimal(leverage, true)?;
                if !selected.insert(cycle_id) || note.as_ref().is_some_and(|s| s.len() > 10000) {
                    return Err(Error::bad("invalid_review_trade"));
                }
                let row: Value = sqlx::query_scalar("SELECT jsonb_build_object('source','exchange_ledger','connection_id',c.connection_id,'cycle_id',c.id,'account_name',e.name,'market',e.market,'cycle',c.body,'ledger_revision',r.ledger_revision,'projection_run_id',r.id) FROM trade_cycles c JOIN trade_projection_runs r ON r.owner_id=c.owner_id AND r.id=c.run_id JOIN exchange_connections e ON e.owner_id=c.owner_id AND e.id=c.connection_id WHERE c.owner_id=$1 AND c.id=$2 AND c.connection_id=$3 AND r.status='ready' FOR SHARE OF c,r")
                    .bind(owner).bind(cycle_id).bind(connection_id).fetch_optional(&mut **tx).await?.ok_or_else(||Error::bad("review_trade_position_unavailable"))?;
                let totals: Value=sqlx::query_scalar("WITH RECURSIVE ancestry AS(SELECT id,allocation_parent_id FROM trade_cycles WHERE owner_id=$1 AND id=$2 UNION SELECT c.id,c.allocation_parent_id FROM trade_cycles c JOIN ancestry a ON c.id=a.allocation_parent_id WHERE c.owner_id=$1) SELECT jsonb_build_object('opened_quantity',(sum(a.quantity) FILTER (WHERE a.portion='open'))::text,'closed_quantity',(sum(a.quantity) FILTER (WHERE a.portion='close'))::text,'exit_price',((sum(a.quantity*(f.body->>'price')::numeric) FILTER (WHERE a.portion='close'))/NULLIF(sum(a.quantity) FILTER (WHERE a.portion='close'),0))::text) FROM ancestry n JOIN trade_cycle_allocations a ON a.owner_id=$1 AND a.cycle_id=n.id JOIN trade_fills f ON f.owner_id=a.owner_id AND f.id=a.fill_id")
                    .bind(owner).bind(cycle_id).fetch_one(&mut **tx).await?;
                let mut row = row;
                row["totals"] = totals;
                row["leverage"] = json!(leverage);
                row["leverage_source"] = json!(if leverage.is_some() {
                    "manual_supplement"
                } else {
                    "not_provided"
                });
                row["note"] = json!(note);
                rows.push(row);
            }
        }
    }
    Ok(rows)
}

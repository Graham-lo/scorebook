use super::*;
use bigdecimal::{BigDecimal, Zero};
use scorebook_core::domain::trade_ledger::{number, text};
pub async fn reconcile(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ReconciliationInput,
) -> Result<Value> {
    if input.start_at >= input.end_at
        || input.statement.is_empty()
        || input.statement.len() > 100
        || input.evidence.trim().is_empty()
        || input.evidence.len() > 20000
    {
        return Err(Error::bad("invalid_reconciliation"));
    }
    let body = json!(input);
    let (mut tx, cached) = s.db.write(owner, "trade.reconcile", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let revision: i64 = sqlx::query_scalar(
        "SELECT ledger_revision FROM exchange_connections WHERE owner_id=$1 AND id=$2 FOR UPDATE",
    )
    .bind(owner)
    .bind(input.connection_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(Error::not_found)?;
    let rows:Vec<(String,String,String,String,i64)>=sqlx::query_as("WITH totals AS(SELECT settlement_asset AS asset,sum(realized_pnl) AS pnl,0::numeric AS fee,0::numeric AS funding,count(*) FILTER(WHERE realized_pnl IS NULL) AS missing FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND traded_at>=$3 AND traded_at<$4 GROUP BY settlement_asset UNION ALL SELECT commission_asset,0::numeric,sum(commission),0::numeric,0::bigint FROM trade_fills WHERE owner_id=$1 AND connection_id=$2 AND traded_at>=$3 AND traded_at<$4 GROUP BY commission_asset UNION ALL SELECT asset,0::numeric,0::numeric,sum(amount),0::bigint FROM account_ledger_entries WHERE owner_id=$1 AND connection_id=$2 AND occurred_at>=$3 AND occurred_at<$4 AND kind='FUNDING_FEE' GROUP BY asset) SELECT asset,COALESCE(sum(pnl),0)::text,COALESCE(sum(fee),0)::text,COALESCE(sum(funding),0)::text,sum(missing)::bigint FROM totals GROUP BY asset").bind(owner).bind(input.connection_id).bind(input.start_at).bind(input.end_at).fetch_all(&mut *tx).await?;
    // Trades are covered separately for every known/declared symbol. One symbol's
    // complete page cannot certify another symbol's missing history.
    let coverage:bool=sqlx::query_scalar("WITH symbols AS(SELECT DISTINCT unnest(symbols) AS symbol FROM trade_imports WHERE owner_id=$1 AND connection_id=$2 UNION SELECT DISTINCT symbol FROM trade_fills WHERE owner_id=$1 AND connection_id=$2), required AS(SELECT 'trades'::text AS kind,symbol FROM symbols UNION ALL SELECT 'ledger',NULL), covered AS(SELECT r.kind,r.symbol,range_agg(tstzrange(i.start_at,i.end_at,'[)')) AS periods FROM required r LEFT JOIN trade_imports i ON i.owner_id=$1 AND i.connection_id=$2 AND i.status='complete' AND i.declared_complete AND (i.dataset=r.kind OR i.dataset='both') AND (r.symbol IS NULL OR r.symbol=ANY(i.symbols)) GROUP BY r.kind,r.symbol) SELECT COALESCE(bool_and(COALESCE(periods @> tstzrange($3,$4,'[)'),false)),false) FROM covered").bind(owner).bind(input.connection_id).bind(input.start_at).bind(input.end_at).fetch_one(&mut *tx).await?;
    let mut results = Vec::new();
    let mut checked = std::collections::HashSet::new();
    let mut matched = true;
    for statement in &input.statement {
        if !checked.insert(&statement.asset) {
            return Err(Error::bad("duplicate_statement_asset"));
        }
        let tolerance = number(&statement.tolerance)?;
        if tolerance < BigDecimal::zero() {
            return Err(Error::bad("negative_tolerance"));
        }
        let found = rows.iter().find(|v| v.0 == statement.asset);
        let actual = found
            .map(|r| [r.1.as_str(), r.2.as_str(), r.3.as_str()])
            .unwrap_or(["0", "0", "0"]);
        let expected = [
            &statement.realized_pnl,
            &statement.commission,
            &statement.funding,
        ];
        let mut differences = Vec::new();
        for (i, name) in ["realized_pnl", "commission", "funding"].iter().enumerate() {
            let delta = number(actual[i])? - number(expected[i])?;
            let incomplete = i == 0 && found.is_some_and(|r| r.4 > 0);
            let okay = !incomplete && delta.abs() <= tolerance;
            matched &= okay;
            differences.push(json!({"metric":name,"actual":if incomplete{None}else{Some(actual[i])},"actual_known_sum":actual[i],"statement":expected[i],"difference":if incomplete{None}else{Some(text(&delta))},"within_tolerance":okay}));
        }
        let missing = found.map(|r| r.4).unwrap_or(0);
        matched &= missing == 0;
        results.push(json!({"asset":statement.asset,"items":differences,"fills_missing_realized_pnl":missing,"conversion_applied":false}));
    }
    let omitted: Vec<_> = rows
        .iter()
        .filter(|r| !checked.contains(&r.0))
        .map(|r| r.0.clone())
        .collect();
    if !omitted.is_empty() {
        matched = false;
    }
    let id = Uuid::new_v4();
    let result = json!({"reconciliation_id":id,"ledger_revision":revision,"status":if !coverage{"unverified_coverage"}else if matched{"matched_declared_range"}else{"differences"},"items":results,"assets_missing_from_statement":omitted,"funding_policy":"separate_from_fill_realized_pnl","income_realized_and_commission_not_double_counted":true,"declared_range_coverage_complete":coverage,"entire_account_history_verified":false});
    sqlx::query("INSERT INTO trade_reconciliations(id,owner_id,connection_id,ledger_revision,body,result) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(owner).bind(input.connection_id).bind(revision).bind(body.clone()).bind(&result).execute(&mut *tx).await?;
    Database::finish(&mut tx, owner, "trade.reconcile", key, &body, &result).await?;
    tx.commit().await?;
    Ok(result)
}

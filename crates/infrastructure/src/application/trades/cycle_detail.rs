//! Frozen cycle details include every inherited allocation across incremental runs.
use super::*;
pub async fn get(s: &Services, owner: Uuid, id: Uuid, input: CycleDetailFilter) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    let summary:Value=sqlx::query_scalar("SELECT jsonb_build_object('id',c.id,'cycle',c.body,'connection_id',c.connection_id,'projection_run_id',c.run_id,'ledger_revision',r.ledger_revision) FROM trade_cycles c JOIN trade_projection_runs r ON r.owner_id=c.owner_id AND r.id=c.run_id WHERE c.owner_id=$1 AND c.id=$2 AND r.status='ready'").bind(owner).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(Error::not_found)?;
    let rows:Vec<Value>=sqlx::query_scalar("WITH RECURSIVE ancestry AS(SELECT id,allocation_parent_id FROM trade_cycles WHERE owner_id=$1 AND id=$2 UNION SELECT c.id,c.allocation_parent_id FROM trade_cycles c JOIN ancestry a ON c.id=a.allocation_parent_id WHERE c.owner_id=$1) SELECT jsonb_build_object('fill_id',f.id,'allocation_quantity',a.quantity::text,'allocation_commission',a.commission::text,'portion',a.portion,'actual_fill',f.body) FROM ancestry n JOIN trade_cycle_allocations a ON a.owner_id=$1 AND a.cycle_id=n.id JOIN trade_fills f ON f.owner_id=a.owner_id AND f.id=a.fill_id WHERE ($3::uuid IS NULL OR f.id>$3) ORDER BY f.id LIMIT 101").bind(owner).bind(id).bind(input.cursor).fetch_all(&mut *tx).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    tx.commit().await?;
    Ok(
        json!({"cycle":summary,"items":items,"next_cursor":if more{items.last().map(|v|v["fill_id"].clone())}else{None},"allocation_scope":"complete_immutable_ancestry","funding":"separate_account_ledger"}),
    )
}
pub async fn ledger(s: &Services, owner: Uuid, input: TradeFilter) -> Result<Value> {
    let cursor = input
        .cursor
        .as_deref()
        .map(|v| {
            v.parse::<Uuid>()
                .map_err(|_| Error::bad("invalid_ledger_cursor"))
        })
        .transpose()?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'connection_id',connection_id,'import_id',import_id,'entry',body) FROM account_ledger_entries WHERE owner_id=$1 AND ($2::uuid IS NULL OR connection_id=$2) AND ($3::text IS NULL OR symbol=$3) AND ($4::timestamptz IS NULL OR occurred_at>=$4) AND ($5::timestamptz IS NULL OR occurred_at<$5) AND ($6::uuid IS NULL OR id>$6) ORDER BY id LIMIT 101").bind(owner).bind(input.connection_id).bind(input.symbol).bind(input.start_at).bind(input.end_at).bind(cursor).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(
        json!({"items":items,"next_cursor":if more{items.last().map(|v|v["id"].clone())}else{None},"amount_policy":"original_asset_decimal_no_fx"}),
    )
}

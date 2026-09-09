use scorebook_core::{api::trades::*, domain::trade_ledger::*};
use uuid::Uuid;
fn seed(quantity: Option<&str>, side: PositionSide) -> PositionSeedInput {
    PositionSeedInput {
        connection_id: Uuid::nil(),
        symbol: "BTCUSDT".into(),
        position_side: side,
        effective_at: chrono::DateTime::UNIX_EPOCH,
        quantity: quantity.map(str::to_string),
        entry_price: None,
        contract_multiplier: "1".into(),
        settlement_asset: "USDT".into(),
        evidence: "Verified opening statement".into(),
    }
}
fn fill(id: u64, side: TradeSide, q: &str, p: &str, pnl: &str, fee: &str) -> FillInput {
    FillInput {
        trade_id: id.to_string(),
        order_id: None,
        symbol: "BTCUSDT".into(),
        side,
        position_side: PositionSide::Both,
        price: p.into(),
        quantity: q.into(),
        realized_pnl: Some(pnl.into()),
        settlement_asset: "USDT".into(),
        commission: fee.into(),
        commission_asset: "USDT".into(),
        traded_at: chrono::DateTime::from_timestamp(1700000000 + id as i64, 0).unwrap(),
        liquidation: None,
    }
}
#[test]
fn reversal_splits_quantity_and_fees_without_double_counting_pnl() {
    let mut p = Projector::new(&seed(Some("0"), PositionSide::Both), false).unwrap();
    p.push(&fill(1, TradeSide::Buy, "2", "100", "0", "0.2"))
        .unwrap();
    let reverse = p
        .push(&fill(2, TradeSide::Sell, "3", "110", "20", "0.3"))
        .unwrap();
    assert_eq!(reverse.allocations.len(), 2);
    assert_eq!(
        reverse.completed[0].computed_realized_pnl.as_deref(),
        Some("20")
    );
    assert_eq!(reverse.completed[0].commissions["USDT"], "0.4");
    assert_eq!(reverse.current.remaining_quantity.as_deref(), Some("1"));
    assert_eq!(reverse.current.direction, "short");
    let close = p
        .push(&fill(3, TradeSide::Buy, "1", "105", "5", "0.1"))
        .unwrap();
    assert_eq!(
        close.completed[0].computed_realized_pnl.as_deref(),
        Some("5")
    );
    assert_eq!(close.completed[0].commissions["USDT"], "0.2");
    assert_eq!(
        close.completed[0].exchange_realized_pnl.as_deref(),
        Some("5")
    );
}
#[test]
fn unknown_opening_never_invents_a_cycle_or_cost() {
    let mut p = Projector::new(&seed(None, PositionSide::Both), false).unwrap();
    let r = p
        .push(&fill(1, TradeSide::Sell, "1", "110", "10", "0.1"))
        .unwrap();
    assert!(r.completed.is_empty());
    assert_eq!(r.current.status, "opening_unknown");
    assert!(r.current.computed_realized_pnl.is_none());
    assert!(r.current.remaining_quantity.is_none());
    assert_eq!(r.current.exchange_realized_pnl.as_deref(), Some("10"));
}
#[test]
fn inverse_contract_uses_reciprocal_prices() {
    let mut s = seed(Some("0"), PositionSide::Both);
    s.contract_multiplier = "100".into();
    let mut p = Projector::new(&s, true).unwrap();
    p.push(&fill(1, TradeSide::Buy, "2", "10000", "0", "0"))
        .unwrap();
    let r = p
        .push(&fill(2, TradeSide::Sell, "2", "11000", "0.00181818", "0"))
        .unwrap();
    let pnl = number(r.completed[0].computed_realized_pnl.as_ref().unwrap()).unwrap();
    let expected = number("0.001818181818181818181818181818181818").unwrap();
    assert!((pnl - expected).abs() < number("0.00000000000000000000000000000001").unwrap());
}
#[test]
fn hedge_positions_do_not_become_net_reversals() {
    let mut p = Projector::new(&seed(Some("0"), PositionSide::Short), false).unwrap();
    let mut open = fill(1, TradeSide::Sell, "2", "100", "0", "0");
    open.position_side = PositionSide::Short;
    p.push(&open).unwrap();
    let mut over = fill(2, TradeSide::Buy, "3", "90", "20", "0");
    over.position_side = PositionSide::Short;
    assert_eq!(
        p.push(&over).err().unwrap().code,
        "hedge_fill_exceeds_known_position"
    );
}

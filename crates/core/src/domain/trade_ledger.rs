//! Exact base-unit trading ledger. Accounting never substitutes Binance reference
//! candles for execution prices and never invents an unknown opening position.
use crate::{
    api::trades::*,
    error::{Error, Result},
};
use bigdecimal::{BigDecimal as D, RoundingMode, Zero};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, num::NonZeroU64};
pub fn number(s: &str) -> Result<D> {
    super::criteria::dec(s).map_err(Error::bad)
}
fn round(v: D) -> D {
    v.with_precision_round(NonZeroU64::new(34).unwrap(), RoundingMode::HalfEven)
}
pub fn text(v: &D) -> String {
    v.normalized().to_plain_string()
}
pub fn validate_fill(f: &FillInput) -> Result<()> {
    if f.trade_id.is_empty()
        || f.trade_id.len() > 38
        || !f.trade_id.chars().all(|c| c.is_ascii_digit())
        || f.symbol.is_empty()
        || f.symbol.len() > 40
        || !f
            .symbol
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(Error::bad("invalid_trade_identity"));
    }
    if number(&f.price)? <= D::zero() || number(&f.quantity)? <= D::zero() {
        return Err(Error::bad("invalid_trade_amount"));
    }
    number(&f.commission)?;
    if let Some(pnl) = &f.realized_pnl {
        number(pnl)?;
    }
    for asset in [&f.settlement_asset, &f.commission_asset] {
        if asset.is_empty()
            || asset.len() > 20
            || !asset
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        {
            return Err(Error::bad("invalid_trade_asset"));
        }
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CycleSummary {
    pub ordinal: u64,
    pub symbol: String,
    pub position_side: PositionSide,
    pub direction: String,
    pub status: String,
    pub opened_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub entry_price: Option<String>,
    pub remaining_quantity: Option<String>,
    pub computed_realized_pnl: Option<String>,
    pub exchange_realized_pnl: Option<String>,
    pub settlement_asset: String,
    pub commissions: BTreeMap<String, String>,
    pub fills: u64,
    pub opening_evidence: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FillAllocation {
    pub trade_id: String,
    pub cycle_ordinal: u64,
    pub quantity: String,
    pub commission: String,
    pub portion: String,
}
pub struct ProjectionStep {
    pub allocations: Vec<FillAllocation>,
    pub completed: Vec<CycleSummary>,
    pub current: CycleSummary,
}
#[derive(Serialize, Deserialize)]
pub struct Projector {
    symbol: String,
    side: PositionSide,
    inverse: bool,
    multiplier: D,
    asset: String,
    evidence: String,
    effective_at: DateTime<Utc>,
    known: bool,
    qty: D,
    cost: Option<D>,
    realized: D,
    exchange_pnl: Option<D>,
    commissions: BTreeMap<String, D>,
    ordinal: u64,
    opened: Option<DateTime<Utc>>,
    count: u64,
    #[serde(with = "checkpoint_order")]
    last_order: Option<(DateTime<Utc>, u128)>,
    direction: i32,
}
impl Projector {
    pub fn checkpoint(&self) -> Result<serde_json::Value> {
        Ok(
            serde_json::json!({"protocol":"trade-projector-v2","state":serde_json::to_value(self).map_err(|_|Error::bad("projection_checkpoint_encoding"))?}),
        )
    }
    pub fn resume(value: serde_json::Value) -> Result<Self> {
        if value["protocol"] != "trade-projector-v2" {
            return Err(Error::bad("projection_checkpoint_protocol_mismatch"));
        }
        serde_json::from_value(value["state"].clone())
            .map_err(|_| Error::bad("projection_checkpoint_invalid"))
    }
    pub fn last_order(&self) -> Option<(DateTime<Utc>, u128)> {
        self.last_order
    }
    pub fn new(seed: &PositionSeedInput, inverse: bool) -> Result<Self> {
        let qty = seed
            .quantity
            .as_deref()
            .map(number)
            .transpose()?
            .unwrap_or_else(D::zero);
        if seed.position_side != PositionSide::Both && qty < D::zero() {
            return Err(Error::bad("hedge_seed_quantity_must_be_nonnegative"));
        }
        if seed.quantity.is_some() && seed.evidence.trim().is_empty() {
            return Err(Error::bad("opening_position_evidence_required"));
        }
        let cost = seed.entry_price.as_deref().map(number).transpose()?;
        if cost.as_ref().is_some_and(|v| v <= &D::zero()) {
            return Err(Error::bad("invalid_opening_cost"));
        }
        let multiplier = number(&seed.contract_multiplier)?;
        if multiplier <= D::zero() {
            return Err(Error::bad("invalid_contract_multiplier"));
        }
        let signed = if seed.position_side == PositionSide::Short {
            -qty.clone()
        } else {
            qty.clone()
        };
        let direction = if signed < D::zero() { -1 } else { 1 };
        Ok(Self {
            symbol: seed.symbol.clone(),
            side: seed.position_side.clone(),
            inverse,
            multiplier,
            asset: seed.settlement_asset.clone(),
            evidence: seed.evidence.clone(),
            effective_at: seed.effective_at,
            known: seed.quantity.is_some(),
            qty: signed,
            cost,
            realized: D::zero(),
            exchange_pnl: Some(D::zero()),
            commissions: BTreeMap::new(),
            ordinal: 0,
            opened: if qty.is_zero() {
                None
            } else {
                Some(seed.effective_at)
            },
            count: 0,
            last_order: None,
            direction,
        })
    }
    fn clear(&mut self) {
        self.ordinal += 1;
        self.cost = None;
        self.realized = D::zero();
        self.exchange_pnl = Some(D::zero());
        self.commissions.clear();
        self.opened = None;
        self.count = 0;
    }
    pub fn current(&self, closed: Option<DateTime<Utc>>) -> CycleSummary {
        CycleSummary {
            ordinal: self.ordinal,
            symbol: self.symbol.clone(),
            position_side: self.side.clone(),
            direction: if self.direction > 0 { "long" } else { "short" }.into(),
            status: if !self.known {
                "opening_unknown"
            } else if closed.is_some() {
                "closed"
            } else {
                "open"
            }
            .into(),
            opened_at: self.opened,
            closed_at: closed,
            entry_price: self.cost.as_ref().map(text),
            remaining_quantity: if self.known {
                Some(text(&self.qty.abs()))
            } else {
                None
            },
            computed_realized_pnl: if self.known && self.cost.is_some() {
                Some(text(&self.realized))
            } else {
                None
            },
            exchange_realized_pnl: self.exchange_pnl.as_ref().map(text),
            settlement_asset: self.asset.clone(),
            commissions: self
                .commissions
                .iter()
                .map(|(k, v)| (k.clone(), text(v)))
                .collect(),
            fills: self.count,
            opening_evidence: self.evidence.clone(),
        }
    }
    pub fn push(&mut self, f: &FillInput) -> Result<ProjectionStep> {
        validate_fill(f)?;
        if self.known && f.traded_at < self.effective_at {
            return Err(Error::bad("opening_seed_does_not_cover_imported_history"));
        }
        if f.symbol != self.symbol
            || f.position_side != self.side
            || f.settlement_asset != self.asset
        {
            return Err(Error::bad("incompatible_trade_book"));
        }
        let sequence = f
            .trade_id
            .parse::<u128>()
            .map_err(|_| Error::bad("invalid_trade_sequence"))?;
        let ordering = (f.traded_at, sequence);
        if self.last_order.is_some_and(|v| v >= ordering) {
            return Err(Error::bad("trade_order_not_strict"));
        }
        self.last_order = Some(ordering);
        let quantity = number(&f.quantity)?;
        let delta = if f.side == TradeSide::Buy {
            quantity.clone()
        } else {
            -quantity.clone()
        };
        let price = number(&f.price)?;
        let fee = number(&f.commission)?;
        if !self.known {
            self.count += 1;
            *self
                .commissions
                .entry(f.commission_asset.clone())
                .or_default() += &fee;
            self.exchange_pnl = match (self.exchange_pnl.take(), &f.realized_pnl) {
                (Some(a), Some(b)) => Some(a + number(b)?),
                _ => None,
            };
            return Ok(ProjectionStep {
                allocations: vec![FillAllocation {
                    trade_id: f.trade_id.clone(),
                    cycle_ordinal: self.ordinal,
                    quantity: text(&quantity),
                    commission: text(&fee),
                    portion: "opening_unknown".into(),
                }],
                completed: vec![],
                current: self.current(None),
            });
        }
        let closing = !self.qty.is_zero() && (self.qty > D::zero()) != (delta > D::zero());
        let closed_qty = if closing {
            quantity.clone().min(self.qty.abs())
        } else {
            D::zero()
        };
        let open_qty = &quantity - &closed_qty;
        if self.side == PositionSide::Long && (&self.qty + &delta) < D::zero()
            || self.side == PositionSide::Short && (&self.qty + &delta) > D::zero()
        {
            return Err(Error::bad("hedge_fill_exceeds_known_position"));
        }
        let mut allocations = Vec::new();
        let mut completed = Vec::new();
        let close_fee = if closed_qty.is_zero() {
            D::zero()
        } else {
            round(&fee * &closed_qty / &quantity)
        };
        if !closed_qty.is_zero() {
            if let Some(cost) = &self.cost {
                let pnl = if self.inverse {
                    round(
                        &closed_qty
                            * &self.multiplier
                            * (round(D::from(1) / cost) - round(D::from(1) / &price))
                            * D::from(self.direction),
                    )
                } else {
                    round(
                        &closed_qty * &self.multiplier * (&price - cost) * D::from(self.direction),
                    )
                };
                self.realized += pnl;
            }
            self.exchange_pnl = match (self.exchange_pnl.take(), &f.realized_pnl) {
                (Some(a), Some(b)) => Some(a + number(b)?),
                _ => None,
            };
            *self
                .commissions
                .entry(f.commission_asset.clone())
                .or_default() += &close_fee;
            self.count += 1;
            allocations.push(FillAllocation {
                trade_id: f.trade_id.clone(),
                cycle_ordinal: self.ordinal,
                quantity: text(&closed_qty),
                commission: text(&close_fee),
                portion: "close".into(),
            });
            self.qty += if self.qty > D::zero() {
                -closed_qty.clone()
            } else {
                closed_qty.clone()
            };
            if self.qty.is_zero() {
                completed.push(self.current(Some(f.traded_at)));
                self.clear();
            }
        }
        if !open_qty.is_zero() {
            let before = self.qty.abs();
            let after = &before + &open_qty;
            self.cost = if before.is_zero() {
                Some(price.clone())
            } else {
                self.cost.as_ref().map(|cost| {
                    if self.inverse {
                        round(&after / (round(&before / cost) + round(&open_qty / &price)))
                    } else {
                        round((&before * cost + &open_qty * &price) / &after)
                    }
                })
            };
            if self.opened.is_none() {
                self.opened = Some(f.traded_at);
                self.direction = if delta > D::zero() { 1 } else { -1 };
            }
            self.qty += if delta > D::zero() {
                open_qty.clone()
            } else {
                -open_qty.clone()
            };
            let open_fee = &fee - &close_fee;
            *self
                .commissions
                .entry(f.commission_asset.clone())
                .or_default() += &open_fee;
            self.count += 1;
            // An opening fill with nonzero venue PnL is evidence of missing earlier
            // position data, never silently normalized to zero.
            if closed_qty.is_zero() {
                if let Some(pnl) = &f.realized_pnl {
                    if !number(pnl)?.is_zero() {
                        return Err(Error::bad("opening_position_conflicts_with_exchange_pnl"));
                    }
                } else {
                    self.exchange_pnl = None;
                }
            }
            allocations.push(FillAllocation {
                trade_id: f.trade_id.clone(),
                cycle_ordinal: self.ordinal,
                quantity: text(&open_qty),
                commission: text(&open_fee),
                portion: "open".into(),
            });
        }
        Ok(ProjectionStep {
            allocations,
            completed,
            current: self.current(None),
        })
    }
}

mod checkpoint_order {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        value: &Option<(DateTime<Utc>, u128)>,
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        value.map(|(at, id)| (at, id.to_string())).serialize(s)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<Option<(DateTime<Utc>, u128)>, D::Error> {
        let v = Option::<(DateTime<Utc>, String)>::deserialize(d)?;
        v.map(|(at, id)| {
            id.parse()
                .map(|id| (at, id))
                .map_err(serde::de::Error::custom)
        })
        .transpose()
    }
}

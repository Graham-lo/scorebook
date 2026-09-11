//! Pure deterministic rules. All prices are decimal strings; no clock, I/O or models.
use bigdecimal::{BigDecimal as D, RoundingMode, Zero};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::{num::NonZeroU64, str::FromStr};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeState {
    Realized,
    Unrealized,
    NotTriggered,
    Pending,
    NoCriteria,
    InsufficientData,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub enum Template {
    T0,
    T1,
    T2,
    T3,
    T4,
    T5,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Criteria {
    pub template: Template,
    #[serde(default = "rule_version")]
    pub version: String,
    pub selected_by: Option<String>,
    pub direction: Option<String>,
    pub horizon_hours: Option<u32>,
    pub threshold_ratio: Option<String>,
    pub atr_multiple: Option<String>,
    pub invalidation: Option<String>,
    pub boundary: Option<String>,
    pub boundary_kind: Option<String>,
    pub trigger: Option<Trigger>,
}
pub fn rule_version() -> String {
    "criteria-v1".into()
}
impl Default for Criteria {
    fn default() -> Self {
        Self {
            template: Template::T0,
            version: rule_version(),
            selected_by: None,
            direction: None,
            horizon_hours: None,
            threshold_ratio: None,
            atr_multiple: None,
            invalidation: None,
            boundary: None,
            boundary_kind: None,
            trigger: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Trigger {
    pub kind: String,
    pub comparator: String,
    pub price: String,
    pub window_hours: u32,
    pub interval_seconds: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Bar {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
    /// 成交量，与价格一样是 Decimal 字符串。缓存里的旧行和不带量的来源为 null，
    /// 判决从不读它，只有重温舞台的 VOL 副图画它。
    #[serde(default)]
    pub volume: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Trade {
    pub at: DateTime<Utc>,
    pub price: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EvaluationInput {
    pub criteria: Criteria,
    pub start: DateTime<Utc>,
    pub evaluated_at: DateTime<Utc>,
    pub base: Option<String>,
    pub atr0: Option<String>,
    pub bars: Vec<Bar>,
    #[serde(default)]
    pub trades: Vec<Trade>,
    pub coverage_complete: bool,
    pub endpoint_proven: bool,
    pub end_price: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub struct Evaluation {
    pub state: OutcomeState,
    pub reason: String,
    pub signed_return: Option<String>,
    pub mfe: Option<String>,
    pub mae: Option<String>,
    pub trigger_at: Option<DateTime<Utc>>,
    pub trigger_price: Option<String>,
    pub end_at: Option<DateTime<Utc>>,
    pub invalidation_hit: Option<bool>,
    pub first_threshold_interval: Option<(DateTime<Utc>, DateTime<Utc>)>,
}
fn out(state: OutcomeState, reason: &str) -> Evaluation {
    Evaluation {
        state,
        reason: reason.into(),
        signed_return: None,
        mfe: None,
        mae: None,
        trigger_at: None,
        trigger_price: None,
        end_at: None,
        invalidation_hit: None,
        first_threshold_interval: None,
    }
}
pub fn dec(s: &str) -> Result<D, String> {
    if s.len() > 96 {
        return Err("decimal_too_long".into());
    }
    let v = D::from_str(s).map_err(|_| "invalid_decimal")?;
    let (_, scale) = v.as_bigint_and_exponent();
    if scale.abs() > 64 {
        return Err("decimal_exponent_out_of_range".into());
    }
    Ok(v)
}
pub(crate) fn q(v: D) -> D {
    v.with_precision_round(NonZeroU64::new(34).unwrap(), RoundingMode::HalfEven)
}
fn ratio(a: D, b: D) -> D {
    q(a / b)
}
fn fmt(v: D) -> String {
    v.with_scale_round(12, RoundingMode::HalfEven).to_string()
}
fn positive(s: &Option<String>) -> bool {
    s.as_ref()
        .and_then(|s| dec(s).ok())
        .is_some_and(|v| v > D::zero())
}
pub fn validate(c: &Criteria) -> Result<(), String> {
    if c.version != "criteria-v1" {
        return Err("unknown_rule_version".into());
    }
    if c.template == Template::T0 {
        return Ok(());
    }
    if !matches!(
        c.selected_by.as_deref(),
        Some("explicit" | "default_visible")
    ) {
        return Err("criteria_not_selected".into());
    }
    if !c.horizon_hours.is_some_and(|h| h > 0 && h <= 87600) {
        return Err("invalid_horizon".into());
    }
    if matches!(c.template, Template::T1 | Template::T2 | Template::T3) {
        if !matches!(c.direction.as_deref(), Some("L" | "S")) {
            return Err("direction_missing".into());
        }
        if c.threshold_ratio.is_some() && c.atr_multiple.is_some() {
            return Err("ambiguous_threshold".into());
        }
        if c.threshold_ratio.is_some() && !positive(&c.threshold_ratio) {
            return Err("invalid_threshold".into());
        }
        if c.atr_multiple.is_some() && !positive(&c.atr_multiple) {
            return Err("invalid_atr_multiple".into());
        }
    }
    if c.invalidation.is_some() && !positive(&c.invalidation) {
        return Err("invalid_invalidation".into());
    }
    if c.template == Template::T2 && !positive(&c.invalidation) {
        return Err("invalidation_missing".into());
    }
    if c.template == Template::T4
        && (!positive(&c.boundary)
            || !matches!(
                c.boundary_kind.as_deref(),
                Some("lower_floor" | "upper_ceiling")
            ))
    {
        return Err("boundary_missing".into());
    }
    if c.template == Template::T5 && c.atr_multiple.is_some() && !positive(&c.atr_multiple) {
        return Err("invalid_atr_multiple".into());
    }
    if c.template == Template::T3 {
        let t = c.trigger.as_ref().ok_or("trigger_missing")?;
        if !matches!(t.kind.as_str(), "bar_close" | "trade_touch")
            || !matches!(t.comparator.as_str(), "gte" | "lte")
            || dec(&t.price)? <= D::zero()
            || t.window_hours == 0
            || t.window_hours > 87600
            || (t.kind == "bar_close" && t.interval_seconds.unwrap_or(60) == 0)
        {
            return Err("invalid_trigger".into());
        }
    }
    Ok(())
}
pub fn evaluate(i: &EvaluationInput) -> Evaluation {
    if let Err(e) = validate(&i.criteria) {
        return out(OutcomeState::NoCriteria, &e);
    }
    if i.criteria.template == Template::T0 {
        return out(OutcomeState::NoCriteria, "no_explicit_criteria");
    }
    match evaluate_valid(i) {
        Ok(x) => x,
        Err(e) => out(OutcomeState::InsufficientData, &e),
    }
}
fn evaluate_valid(i: &EvaluationInput) -> Result<Evaluation, String> {
    use OutcomeState::*;
    let c = &i.criteria;
    if i.start.timestamp() < -2208988800
        || i.evaluated_at.timestamp() > 7258118400
        || i.evaluated_at < i.start
    {
        return Err("invalid_evaluation_time".into());
    }
    for trade in &i.trades {
        if dec(&trade.price)? <= D::zero() {
            return Err("invalid_trade_price".into());
        }
    }

    let mut base = dec(i.base.as_ref().ok_or("base_missing")?)?;
    if base <= D::zero() {
        return Err("invalid_base".into());
    }
    let mut start = i.start;
    let mut trigger_price = None;
    let mut trigger_at = None;
    let mut bars = i.bars.clone();
    bars.sort_by_key(|b| b.start);
    if bars.windows(2).any(|w| w[0].end > w[1].start) {
        return Err("overlapping_bars".into());
    }
    for b in &bars {
        let (o, h, l, cl) = (dec(&b.open)?, dec(&b.high)?, dec(&b.low)?, dec(&b.close)?);
        if b.end <= b.start || l <= D::zero() || h < l || o < l || o > h || cl < l || cl > h {
            return Err("invalid_ohlc".into());
        }
    }
    if c.template == Template::T3 {
        let t = c.trigger.as_ref().unwrap();
        let p = dec(&t.price)?;
        let expiry = start + Duration::hours(t.window_hours.into());
        let compare = |v: &D| {
            if t.comparator == "gte" {
                v >= &p
            } else {
                v <= &p
            }
        };
        let mut found = None;
        if t.kind == "trade_touch" {
            if compare(&base) {
                found = Some((start, base.clone()));
            } else {
                let mut ts = i.trades.clone();
                ts.sort_by_key(|x| x.at);
                for tr in &ts {
                    if tr.at > start && tr.at <= expiry && tr.at <= i.evaluated_at {
                        let v = dec(&tr.price)?;
                        if compare(&v) {
                            found = Some((tr.at, v));
                            break;
                        }
                    }
                }
            }
        } else {
            for b in &bars {
                if b.end > start
                    && b.end <= expiry
                    && b.end <= i.evaluated_at
                    && (b.end - b.start).num_seconds()
                        == i64::from(t.interval_seconds.unwrap_or(60))
                {
                    let v = dec(&b.close)?;
                    if compare(&v) {
                        found = Some((b.end, v));
                        break;
                    }
                }
            }
        }
        // Even an observed trigger needs complete earlier coverage to prove it was first.
        if !i.coverage_complete {
            return Err("trigger_sequence_unproven".into());
        }
        if let Some((at, v)) = found {
            start = at;
            base = v;
            trigger_at = Some(at);
            trigger_price = Some(base.to_string());
        } else {
            let mut r = out(
                if i.evaluated_at >= expiry {
                    NotTriggered
                } else {
                    Pending
                },
                "waiting_for_trigger",
            );
            r.end_at = Some(expiry);
            return Ok(r);
        }
    }
    let end = start + Duration::hours(c.horizon_hours.unwrap().into());
    let through = i.evaluated_at.min(end);
    let mut highest = base.clone();
    let mut lowest = base.clone();
    let mut endpoint_crossed = false;
    let mut first_threshold = None;
    let directional = matches!(c.template, Template::T1 | Template::T2 | Template::T3);
    let atr = || -> Result<D, String> {
        let v = dec(i.atr0.as_ref().ok_or("atr_missing")?)?;
        if v <= D::zero() {
            return Err("invalid_atr".into());
        }
        Ok(v)
    };
    let threshold_result: Result<Option<D>, String> = (|| {
        if directional {
            Ok(Some(if let Some(p) = &c.threshold_ratio {
                q(base.clone() * dec(p)?)
            } else {
                q(atr()? * dec(c.atr_multiple.as_deref().unwrap_or("1"))?)
            }))
        } else {
            Ok(None)
        }
    })();
    let threshold = threshold_result.as_ref().ok().and_then(|v| v.clone());
    for b in &bars {
        if b.end <= start || b.start >= through {
            continue;
        }
        if b.start < start || b.end > through {
            endpoint_crossed = true;
            continue;
        }
        let hi = dec(&b.high)?;
        let lo = dec(&b.low)?;
        highest = highest.max(hi.clone());
        lowest = lowest.min(lo.clone());
        if let Some(t) = &threshold {
            let reached = if c.direction.as_deref() == Some("S") {
                base.clone() - lo >= *t
            } else {
                hi - base.clone() >= *t
            };
            if reached && first_threshold.is_none() {
                first_threshold = Some((b.start, b.end));
            }
        }
    }
    // trade points may supplement an exact interval, never fabricate bar order.
    for t in &i.trades {
        if t.at > start && t.at <= through {
            let p = dec(&t.price)?;
            highest = highest.max(p.clone());
            lowest = lowest.min(p);
        }
    }
    evaluate_aggregate(&AggregateInput {
        criteria: c.clone(),
        start,
        evaluated_at: i.evaluated_at,
        base: base.to_string(),
        atr0: i.atr0.clone(),
        path: PathAggregate {
            highest: highest.to_string(),
            lowest: lowest.to_string(),
            first_threshold_interval: first_threshold,
        },
        coverage_complete: i.coverage_complete && !endpoint_crossed,
        endpoint_proven: i.endpoint_proven,
        end_price: i.end_price.clone(),
        trigger_at,
        trigger_price,
    })
}
/// Constant-space business reduction for one assessment window. This is never a
/// bar store: no per-candle time series can be reconstructed from a checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PathAggregate {
    pub highest: String,
    pub lowest: String,
    pub first_threshold_interval: Option<(DateTime<Utc>, DateTime<Utc>)>,
}
impl PathAggregate {
    pub fn new(base: &str) -> Result<Self, String> {
        if dec(base)? <= D::zero() {
            return Err("invalid_base".into());
        }
        Ok(Self {
            highest: base.into(),
            lowest: base.into(),
            first_threshold_interval: None,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn observe(
        &mut self,
        c: &Criteria,
        base: &str,
        atr0: &Option<String>,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        high: &str,
        low: &str,
    ) -> Result<(), String> {
        let hi = dec(high)?;
        let lo = dec(low)?;
        if end < start || lo <= D::zero() || hi < lo {
            return Err("invalid_path_interval".into());
        }
        self.highest = dec(&self.highest)?.max(hi.clone()).to_string();
        self.lowest = dec(&self.lowest)?.min(lo.clone()).to_string();
        let base = dec(base)?;
        if let Ok(Some(t)) = threshold_for(c, &base, atr0) {
            let reached = if c.direction.as_deref() == Some("S") {
                base - lo >= t
            } else {
                hi - base >= t
            };
            if reached && self.first_threshold_interval.is_none() {
                self.first_threshold_interval = Some((start, end));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AggregateInput {
    pub criteria: Criteria,
    pub start: DateTime<Utc>,
    pub evaluated_at: DateTime<Utc>,
    pub base: String,
    pub atr0: Option<String>,
    pub path: PathAggregate,
    pub coverage_complete: bool,
    pub endpoint_proven: bool,
    pub end_price: Option<String>,
    pub trigger_at: Option<DateTime<Utc>>,
    pub trigger_price: Option<String>,
}
fn atr_value(atr0: &Option<String>) -> Result<D, String> {
    let v = dec(atr0.as_ref().ok_or("atr_missing")?)?;
    if v <= D::zero() {
        return Err("invalid_atr".into());
    }
    Ok(v)
}
pub(crate) fn threshold_for(
    c: &Criteria,
    base: &D,
    atr0: &Option<String>,
) -> Result<Option<D>, String> {
    if matches!(c.template, Template::T1 | Template::T2 | Template::T3) {
        Ok(Some(if let Some(p) = &c.threshold_ratio {
            q(base * dec(p)?)
        } else {
            q(atr_value(atr0)? * dec(c.atr_multiple.as_deref().unwrap_or("1"))?)
        }))
    } else {
        Ok(None)
    }
}
/// Same frozen criteria evaluator used for batch replay and live checkpoints.
pub fn evaluate_aggregate(i: &AggregateInput) -> Result<Evaluation, String> {
    use OutcomeState::*;
    let c = &i.criteria;
    validate(c)?;
    if c.template == Template::T0 {
        return Ok(out(NoCriteria, "no_explicit_criteria"));
    }
    let base = dec(&i.base)?;
    if base <= D::zero() {
        return Err("invalid_base".into());
    }
    if i.evaluated_at < i.start {
        return Err("invalid_evaluation_time".into());
    }
    let end = i.start + Duration::hours(c.horizon_hours.unwrap().into());
    let highest = dec(&i.path.highest)?;
    let lowest = dec(&i.path.lowest)?;
    if highest < base || lowest > base || lowest <= D::zero() {
        return Err("invalid_aggregate".into());
    }
    let first_threshold = i.path.first_threshold_interval;
    let directional = matches!(c.template, Template::T1 | Template::T2 | Template::T3);
    let threshold = threshold_for(c, &base, &i.atr0).ok().flatten();
    let atr0 = &i.atr0;
    let coverage_complete = i.coverage_complete;
    let evaluated_at = i.evaluated_at;
    let endpoint_proven = i.endpoint_proven;
    let end_price = &i.end_price;
    let trigger_at = i.trigger_at;
    let trigger_price = i.trigger_price.clone();
    let invalidation = if let Some(s) = &c.invalidation {
        let s = dec(s)?;
        Some(if c.direction.as_deref() == Some("S") {
            highest >= s
        } else {
            lowest <= s
        })
    } else {
        None
    };
    let boundary_hit = if c.template == Template::T4 {
        let b = dec(c.boundary.as_ref().unwrap())?;
        if c.boundary_kind.as_deref() == Some("lower_floor") {
            lowest <= b
        } else {
            highest >= b
        }
    } else {
        false
    };
    let mut r = out(Pending, "observing");
    r.end_at = Some(end);
    r.trigger_at = trigger_at;
    r.trigger_price = trigger_price;
    r.invalidation_hit = invalidation;
    r.first_threshold_interval = first_threshold;
    // Proven adverse touch survives unrelated gaps; success requires complete evidence.
    if invalidation == Some(true) || boundary_hit {
        r.state = Unrealized;
        r.reason = "boundary_or_invalidation_touched".into();
        return Ok(r);
    }
    if !coverage_complete {
        r.state = InsufficientData;
        r.reason = "path_coverage_unproven".into();
        r.invalidation_hit = None;
        return Ok(r);
    }
    threshold_for(c, &base, atr0)?;
    if directional {
        let (mf, ma) = if c.direction.as_deref() == Some("S") {
            (
                base.clone() - lowest.clone(),
                base.clone() - highest.clone(),
            )
        } else {
            (
                highest.clone() - base.clone(),
                lowest.clone() - base.clone(),
            )
        };
        r.mfe = Some(fmt(ratio(mf, base.clone()).max(D::zero())));
        r.mae = Some(fmt(ratio(ma, base.clone()).min(D::zero())));
    }
    if evaluated_at < end {
        return Ok(r);
    }
    let realized = match c.template {
        Template::T1 | Template::T2 | Template::T3 => {
            if !endpoint_proven {
                return Err("endpoint_unproven".into());
            }
            let p = dec(end_price.as_ref().ok_or("end_price_missing")?)?;
            if p <= D::zero() {
                return Err("invalid_endpoint".into());
            }
            let diff = if c.direction.as_deref() == Some("S") {
                base.clone() - p
            } else {
                p - base.clone()
            };
            r.signed_return = Some(fmt(ratio(diff.clone(), base.clone())));
            diff >= threshold.unwrap()
        }
        Template::T4 => true,
        Template::T5 => {
            highest - lowest
                >= q(atr_value(atr0)? * dec(c.atr_multiple.as_deref().unwrap_or("1.5"))?)
        }
        Template::T0 => unreachable!(),
    };
    r.state = if realized { Realized } else { Unrealized };
    r.reason = "window_completed".into();
    Ok(r)
}
pub fn atr14(bars: &[Bar], asof: DateTime<Utc>) -> Result<String, String> {
    let mut completed: Vec<_> = bars.iter().filter(|b| b.end <= asof).collect();
    completed.sort_by_key(|b| b.start);
    if completed.len() < 15 {
        return Err("atr_history_missing".into());
    }
    let start = completed.len().saturating_sub(121);
    let bs = &completed[start..];
    let mut atr = D::zero();
    for (j, pair) in bs.windows(2).enumerate() {
        let h = dec(&pair[1].high)?;
        let l = dec(&pair[1].low)?;
        let prev = dec(&pair[0].close)?;
        if h < l || l <= D::zero() {
            return Err("invalid_ohlc".into());
        }
        let tr = (h.clone() - l.clone())
            .max((h - prev.clone()).abs())
            .max((l - prev).abs());
        if j < 14 {
            atr = q(atr + tr);
            if j == 13 {
                atr = ratio(atr, D::from(14));
            }
        } else {
            atr = ratio(q(atr * D::from(13) + tr), D::from(14));
        }
    }
    Ok(atr.to_string())
}

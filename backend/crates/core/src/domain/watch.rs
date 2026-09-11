//! An assessment checkpoint contains reductions and event identity, never input bars/trades.
use super::criteria::{
    self, AggregateInput, Bar, Criteria, Evaluation, OutcomeState, PathAggregate, Template, Trade,
    dec,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Watch {
    pub protocol: String,
    pub criteria: Criteria,
    pub submitted_at: DateTime<Utc>,
    pub submission_base: String,
    pub atr_at_submission: Option<String>,
    pub through: DateTime<Utc>,
    pub start: Option<DateTime<Utc>>,
    pub base: Option<String>,
    pub path: Option<PathAggregate>,
    pub trigger_at: Option<DateTime<Utc>>,
    pub trigger_price: Option<String>,
    pub last_trade_id: Option<i64>,
    pub source_sha256: String,
}
impl Watch {
    pub fn new(
        criteria: Criteria,
        submitted_at: DateTime<Utc>,
        base: String,
        atr: Option<String>,
    ) -> Result<Self, String> {
        criteria::validate(&criteria)?;
        PathAggregate::new(&base)?;
        let mut w = Self {
            protocol: "assessment-stream-v1".into(),
            criteria,
            submitted_at,
            submission_base: base.clone(),
            atr_at_submission: atr,
            through: submitted_at,
            start: None,
            base: None,
            path: None,
            trigger_at: None,
            trigger_price: None,
            last_trade_id: None,
            source_sha256: String::new(),
        };
        if w.criteria.template != Template::T3
            || (w.criteria.trigger.as_ref().unwrap().kind == "trade_touch" && w.matches(&base)?)
        {
            w.begin(submitted_at, base)?;
        }
        Ok(w)
    }
    fn matches(&self, price: &str) -> Result<bool, String> {
        let t = self.criteria.trigger.as_ref().ok_or("trigger_missing")?;
        Ok(if t.comparator == "gte" {
            dec(price)? >= dec(&t.price)?
        } else {
            dec(price)? <= dec(&t.price)?
        })
    }
    fn begin(&mut self, at: DateTime<Utc>, price: String) -> Result<(), String> {
        if self.start.is_some() {
            return Err("trigger_already_confirmed".into());
        }
        self.path = Some(PathAggregate::new(&price)?);
        self.start = Some(at);
        self.base = Some(price.clone());
        if self.criteria.template == Template::T3 {
            self.trigger_at = Some(at);
            self.trigger_price = Some(price);
        }
        Ok(())
    }
    pub fn deadline(&self) -> DateTime<Utc> {
        if let Some(start) = self.start {
            start + Duration::hours(self.criteria.horizon_hours.unwrap().into())
        } else {
            self.submitted_at
                + Duration::hours(self.criteria.trigger.as_ref().unwrap().window_hours.into())
        }
    }
    /// Caller has already verified a contiguous, ordered provider page. Half-open
    /// progression (through, end] makes a repeated boundary harmless.
    pub fn trades(
        &mut self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        rows: &[(i64, Trade)],
    ) -> Result<(), String> {
        if start != self.through || end <= start || end > self.deadline() {
            return Err("watch_coverage_not_contiguous".into());
        }
        let mut last_at = start;
        for (id, tr) in rows {
            if tr.at < start || tr.at > end || tr.at < last_at {
                return Err("trade_time_order_unproven".into());
            }
            // The exact previous endpoint is repeated by the provider, including
            // all same-millisecond trades already included in that checkpoint.
            if tr.at == start {
                continue;
            }
            self.reduce_trade(*id, tr)?;
            last_at = tr.at;
        }
        self.through = end.min(self.deadline());
        Ok(())
    }
    /// Reduce one row from a provider whose entire file/page ordering and coverage
    /// are independently verified. `through` advances only after that verification.
    pub fn reduce_trade(&mut self, id: i64, tr: &Trade) -> Result<(), String> {
        if tr.at <= self.through || tr.at > self.deadline() {
            return Ok(());
        }
        if self.last_trade_id.is_some_and(|p| id <= p) {
            return Err("trade_order_unproven".into());
        }
        if let Some(p) = self.last_trade_id
            && id != p + 1
        {
            return Err("trade_id_gap".into());
        }
        self.last_trade_id = Some(id);
        if self.start.is_none()
            && self.criteria.trigger.as_ref().unwrap().kind == "trade_touch"
            && self.matches(&tr.price)?
        {
            self.begin(tr.at, tr.price.clone())?;
        }
        if self.start.is_some_and(|at| tr.at >= at) && tr.at <= self.deadline() {
            self.path.as_mut().unwrap().observe(
                &self.criteria,
                self.base.as_ref().unwrap(),
                &self.atr_at_submission,
                tr.at,
                tr.at,
                &tr.price,
                &tr.price,
            )?;
        }
        Ok(())
    }
    pub fn bars(
        &mut self,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        bars: &[Bar],
    ) -> Result<(), String> {
        if start > self.through || end <= self.through || end > self.deadline() {
            return Err("watch_coverage_not_contiguous".into());
        }
        let mut expected = start;
        for b in bars {
            let (o, h, l, c) = (dec(&b.open)?, dec(&b.high)?, dec(&b.low)?, dec(&b.close)?);
            if b.start != expected
                || b.end > end
                || b.end <= b.start
                || &l <= 0
                || h < l
                || o < l
                || o > h
                || c < l
                || c > h
            {
                return Err("invalid_contiguous_bars".into());
            }
            expected = b.end;
            if b.end <= self.through {
                continue;
            }
            if self.start.is_none() {
                let t = self.criteria.trigger.as_ref().unwrap();
                if t.kind != "bar_close"
                    || (b.end - b.start).num_seconds()
                        != i64::from(t.interval_seconds.unwrap_or(60))
                {
                    return Err("trigger_bar_interval_mismatch".into());
                }
                if self.matches(&b.close)? {
                    self.begin(b.end, b.close.clone())?;
                    self.through = b.end;
                    return Ok(());
                }
            } else {
                if b.start < self.through {
                    return Err("partial_bar_requires_trades".into());
                }
                self.path.as_mut().unwrap().observe(
                    &self.criteria,
                    self.base.as_ref().unwrap(),
                    &self.atr_at_submission,
                    b.start,
                    b.end,
                    &b.high,
                    &b.low,
                )?;
            }
        }
        if expected != end {
            return Err("bar_coverage_unproven".into());
        }
        self.through = end;
        self.last_trade_id = None;
        Ok(())
    }
    pub fn result(
        &self,
        end_price: Option<String>,
        endpoint_proven: bool,
    ) -> Result<Evaluation, String> {
        if self.start.is_none() {
            return Ok(Evaluation {
                state: if self.through >= self.deadline() {
                    OutcomeState::NotTriggered
                } else {
                    OutcomeState::Pending
                },
                reason: "waiting_for_trigger".into(),
                signed_return: None,
                mfe: None,
                mae: None,
                trigger_at: None,
                trigger_price: None,
                end_at: Some(self.deadline()),
                invalidation_hit: None,
                first_threshold_interval: None,
            });
        }
        criteria::evaluate_aggregate(&AggregateInput {
            criteria: self.criteria.clone(),
            start: self.start.unwrap(),
            evaluated_at: self.through,
            base: self.base.clone().unwrap(),
            atr0: self.atr_at_submission.clone(),
            path: self.path.clone().unwrap(),
            coverage_complete: true,
            endpoint_proven,
            end_price,
            trigger_at: self.trigger_at,
            trigger_price: self.trigger_price.clone(),
        })
    }
}

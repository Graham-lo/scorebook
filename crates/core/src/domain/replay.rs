//! Pure level arithmetic for the relive/replay view. No clock, I/O or storage.
//!
//! Every number here is derived with the exact same expressions
//! [`crate::domain::criteria::evaluate`] uses, so the replay stage draws the
//! lines the settlement path actually judges against.
use super::criteria::{Criteria, Template, dec, q, threshold_for, validate};
use bigdecimal::{BigDecimal as D, Signed};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub struct TriggerLevel {
    pub kind: String,
    pub comparator: String,
    pub price: String,
    pub window_end_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub struct Levels {
    pub template: Template,
    pub target_price: Option<String>,
    pub threshold_abs: Option<String>,
    pub invalidation_price: Option<String>,
    pub boundary_price: Option<String>,
    pub boundary_kind: Option<String>,
    pub trigger: Option<TriggerLevel>,
    pub horizon_end_at: Option<DateTime<Utc>>,
}

/// Exact value, without the 34-digit tail the quantiser leaves behind.
fn trim(v: &D) -> String {
    let s = v.to_string();
    if !s.contains('.') {
        return s;
    }
    let s = s.trim_end_matches('0');
    s.trim_end_matches('.').to_string()
}

fn empty(template: Template) -> Levels {
    Levels {
        template,
        target_price: None,
        threshold_abs: None,
        invalidation_price: None,
        boundary_price: None,
        boundary_kind: None,
        trigger: None,
        horizon_end_at: None,
    }
}

/// Levels of one criteria as of a judgment moment.
///
/// `base`/`atr0` are the frozen submission values (`submission_base` /
/// `atr_at_submission`); missing values simply leave the derived prices null.
/// For T3 the caller passes an already observed `trigger_at`/`trigger_price`;
/// like `evaluate`, the window then restarts at the trigger and the threshold is
/// measured from the trigger price.
pub fn levels(
    c: &Criteria,
    judgment_at: DateTime<Utc>,
    base: Option<&str>,
    atr0: &Option<String>,
    trigger_at: Option<DateTime<Utc>>,
    trigger_price: Option<&str>,
) -> Levels {
    let mut l = empty(c.template.clone());
    if validate(c).is_err() || c.template == Template::T0 {
        return l;
    }
    if c.template == Template::T3
        && let Some(t) = &c.trigger
    {
        l.trigger = Some(TriggerLevel {
            kind: t.kind.clone(),
            comparator: t.comparator.clone(),
            price: t.price.clone(),
            window_end_at: judgment_at + Duration::hours(t.window_hours.into()),
        });
    }
    if let Some(k) = &c.boundary_kind {
        l.boundary_kind = Some(k.clone());
    }
    if c.template == Template::T4 {
        l.boundary_price = c.boundary.clone();
    }
    l.invalidation_price = c.invalidation.clone();

    // evaluate() restarts the window at the trigger for T3.
    let (start, effective_base) = if c.template == Template::T3 {
        match (trigger_at, trigger_price) {
            (Some(at), Some(p)) => (Some(at), Some(p.to_string())),
            _ => (None, None),
        }
    } else {
        (Some(judgment_at), base.map(|b| b.to_string()))
    };
    if let (Some(start), Some(h)) = (start, c.horizon_hours) {
        l.horizon_end_at = Some(start + Duration::hours(h.into()));
    }
    let Some(base) = effective_base.as_deref().and_then(|b| dec(b).ok()) else {
        return l;
    };
    if !base.is_positive() {
        return l;
    }
    let Ok(Some(threshold)) = threshold_for(c, &base, atr0) else {
        return l;
    };
    l.threshold_abs = Some(trim(&threshold));
    let target = if c.direction.as_deref() == Some("S") {
        q(base - threshold)
    } else {
        q(base + threshold)
    };
    l.target_price = Some(trim(&target));
    l
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::criteria::{
        Bar, EvaluationInput, OutcomeState, Trigger, evaluate, rule_version,
    };

    fn base_criteria(template: Template) -> Criteria {
        Criteria {
            template,
            version: rule_version(),
            selected_by: Some("explicit".into()),
            direction: Some("L".into()),
            horizon_hours: Some(4),
            ..Default::default()
        }
    }

    fn bar(start: DateTime<Utc>, high: &str, low: &str, close: &str) -> Bar {
        Bar {
            start,
            end: start + Duration::hours(1),
            open: low.into(),
            high: high.into(),
            low: low.into(),
            close: close.into(),
            volume: None,
        }
    }

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn run(
        c: &Criteria,
        base: &str,
        atr0: Option<&str>,
        bars: Vec<Bar>,
    ) -> super::super::criteria::Evaluation {
        let start = t0();
        evaluate(&EvaluationInput {
            criteria: c.clone(),
            start,
            evaluated_at: start + Duration::hours(4),
            base: Some(base.into()),
            atr0: atr0.map(|s| s.to_string()),
            bars,
            trades: vec![],
            coverage_complete: true,
            endpoint_proven: true,
            end_price: Some("100".into()),
        })
    }

    /// The drawn target line is exactly where `evaluate` starts calling the
    /// threshold reached: one tick under it is not reached, touching it is.
    #[test]
    fn target_price_matches_evaluate_threshold_ratio() {
        let mut c = base_criteria(Template::T1);
        c.threshold_ratio = Some("0.025".into());
        let l = levels(&c, t0(), Some("100"), &None, None, None);
        assert_eq!(l.threshold_abs.as_deref(), Some("2.5"));
        assert_eq!(l.target_price.as_deref(), Some("102.5"));
        assert_eq!(l.horizon_end_at, Some(t0() + Duration::hours(4)));

        let target = dec(l.target_price.as_deref().unwrap()).unwrap();
        let below = (target.clone() - dec("0.001").unwrap()).to_string();
        assert!(
            run(&c, "100", None, vec![bar(t0(), &below, "100", "100")])
                .first_threshold_interval
                .is_none()
        );
        let at = target.to_string();
        assert_eq!(
            run(&c, "100", None, vec![bar(t0(), &at, "100", "100")]).first_threshold_interval,
            Some((t0(), t0() + Duration::hours(1)))
        );
    }

    #[test]
    fn target_price_matches_evaluate_atr_multiple_short() {
        let mut c = base_criteria(Template::T1);
        c.direction = Some("S".into());
        c.atr_multiple = Some("1.5".into());
        let atr = Some("3.2".to_string());
        let l = levels(&c, t0(), Some("200"), &atr, None, None);
        assert_eq!(l.threshold_abs.as_deref(), Some("4.8"));
        assert_eq!(l.target_price.as_deref(), Some("195.2"));

        let target = dec(l.target_price.as_deref().unwrap()).unwrap();
        let above = (target.clone() + dec("0.001").unwrap()).to_string();
        assert!(
            run(
                &c,
                "200",
                Some("3.2"),
                vec![bar(t0(), "200", &above, "200")]
            )
            .first_threshold_interval
            .is_none()
        );
        assert!(
            run(
                &c,
                "200",
                Some("3.2"),
                vec![bar(t0(), "200", &target.to_string(), "200")]
            )
            .first_threshold_interval
            .is_some()
        );
    }

    /// The realized/unrealized verdict flips exactly at the drawn target too.
    #[test]
    fn target_price_matches_evaluate_endpoint() {
        let mut c = base_criteria(Template::T1);
        c.threshold_ratio = Some("0.01".into());
        let l = levels(&c, t0(), Some("100"), &None, None, None);
        let target = l.target_price.as_deref().unwrap().to_string();
        let start = t0();
        let mut input = EvaluationInput {
            criteria: c.clone(),
            start,
            evaluated_at: start + Duration::hours(4),
            base: Some("100".into()),
            atr0: None,
            bars: vec![],
            trades: vec![],
            coverage_complete: true,
            endpoint_proven: true,
            end_price: Some(target.clone()),
        };
        assert_eq!(evaluate(&input).state, OutcomeState::Realized);
        input.end_price = Some((dec(&target).unwrap() - dec("0.001").unwrap()).to_string());
        assert_eq!(evaluate(&input).state, OutcomeState::Unrealized);
    }

    /// T3 restarts the window at the trigger, so both the horizon and the target
    /// hang off the trigger price, exactly like `evaluate` does.
    #[test]
    fn t3_levels_follow_the_trigger() {
        let mut c = base_criteria(Template::T3);
        c.threshold_ratio = Some("0.02".into());
        c.trigger = Some(Trigger {
            kind: "bar_close".into(),
            comparator: "gte".into(),
            price: "110".into(),
            window_hours: 2,
            interval_seconds: Some(3600),
        });
        let before = levels(&c, t0(), Some("100"), &None, None, None);
        assert_eq!(before.target_price, None);
        assert_eq!(before.horizon_end_at, None);
        assert_eq!(
            before.trigger.as_ref().unwrap().window_end_at,
            t0() + Duration::hours(2)
        );

        let bars = vec![
            bar(t0(), "111", "100", "111"),
            bar(t0() + Duration::hours(1), "111", "100", "111"),
            bar(t0() + Duration::hours(2), "113.22", "110", "113.22"),
            bar(t0() + Duration::hours(3), "113.22", "110", "113.22"),
        ];
        let e = run(&c, "100", None, bars);
        assert_eq!(e.trigger_price.as_deref(), Some("111"));
        let after = levels(
            &c,
            t0(),
            Some("100"),
            &None,
            e.trigger_at,
            e.trigger_price.as_deref(),
        );
        assert_eq!(after.threshold_abs.as_deref(), Some("2.22"));
        assert_eq!(after.target_price.as_deref(), Some("113.22"));
        assert_eq!(
            after.horizon_end_at,
            Some(e.trigger_at.unwrap() + Duration::hours(4))
        );
        // 113.22 is the first bar that reaches it, and evaluate agrees.
        assert_eq!(
            e.first_threshold_interval.map(|x| x.0),
            Some(t0() + Duration::hours(2))
        );
    }

    #[test]
    fn non_directional_and_invalid_templates_have_no_target() {
        let mut c = base_criteria(Template::T4);
        c.direction = None;
        c.boundary = Some("90".into());
        c.boundary_kind = Some("lower_floor".into());
        let l = levels(&c, t0(), Some("100"), &None, None, None);
        assert_eq!(l.target_price, None);
        assert_eq!(l.threshold_abs, None);
        assert_eq!(l.boundary_price.as_deref(), Some("90"));
        assert_eq!(l.boundary_kind.as_deref(), Some("lower_floor"));
        assert_eq!(l.horizon_end_at, Some(t0() + Duration::hours(4)));

        assert_eq!(
            levels(&Criteria::default(), t0(), Some("100"), &None, None, None),
            empty(Template::T0)
        );
        let mut broken = base_criteria(Template::T1);
        broken.horizon_hours = None;
        assert_eq!(
            levels(&broken, t0(), Some("100"), &None, None, None),
            empty(Template::T1)
        );
    }

    #[test]
    fn missing_base_leaves_prices_null_but_keeps_the_horizon() {
        let mut c = base_criteria(Template::T1);
        c.atr_multiple = Some("2".into());
        c.invalidation = Some("95".into());
        let l = levels(&c, t0(), None, &None, None, None);
        assert_eq!(l.target_price, None);
        assert_eq!(l.threshold_abs, None);
        assert_eq!(l.invalidation_price.as_deref(), Some("95"));
        assert_eq!(l.horizon_end_at, Some(t0() + Duration::hours(4)));
        // atr0 missing is just as null-safe as a missing base.
        assert_eq!(
            levels(&c, t0(), Some("100"), &None, None, None).target_price,
            None
        );
    }
}

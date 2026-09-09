use chrono::{DateTime, Duration, Utc};
use scorebook::domain::{calendar::*, criteria::*, parser};
fn t(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}
fn input(template: Template) -> EvaluationInput {
    EvaluationInput {
        criteria: Criteria {
            template,
            selected_by: Some("explicit".into()),
            direction: Some("L".into()),
            horizon_hours: Some(2),
            ..Criteria::default()
        },
        start: t("2026-09-01T00:00:00Z"),
        evaluated_at: t("2026-09-01T02:00:00Z"),
        base: Some("100".into()),
        atr0: Some("2".into()),
        bars: vec![
            Bar {
                start: t("2026-09-01T00:00:00Z"),
                end: t("2026-09-01T01:00:00Z"),
                open: "100".into(),
                high: "104".into(),
                low: "99".into(),
                close: "103".into(),
            },
            Bar {
                start: t("2026-09-01T01:00:00Z"),
                end: t("2026-09-01T02:00:00Z"),
                open: "103".into(),
                high: "103".into(),
                low: "100".into(),
                close: "102".into(),
            },
        ],
        trades: vec![],
        coverage_complete: true,
        endpoint_proven: true,
        end_price: Some("102".into()),
    }
}
#[test]
fn explicit_parser_does_not_guess_chinese_negation() {
    for text in [
        "暂时不看多，先观察。",
        "利空不是做空理由",
        "L 只是在自由文本中",
    ] {
        let p = parser::preview(text);
        assert_eq!(p.stance, "unknown");
        assert_eq!(p.path, "unknown");
        assert_eq!(p.criteria.template, Template::T0)
    }
}
#[test]
fn explicit_duplicates_preserve_words() {
    let p = parser::preview("/k L h=72 h=24 | 原话");
    assert!(!p.issues.is_empty());
    assert_eq!(p.criteria.template, Template::T0);
    assert!(p.original_text.contains("原话"))
}
#[test]
fn explicit_path_and_undecided_are_independent() {
    let p = parser::preview("/k ? | 观察");
    assert_eq!(p.path, "chart_first");
    assert_eq!(p.stance, "?");
    assert_eq!(p.criteria.template, Template::T0)
}
#[test]
fn threshold_units() {
    let mut i = input(Template::T1);
    assert_eq!(evaluate(&i).state, OutcomeState::Realized);
    i.end_price = Some("101.9".into());
    assert_eq!(evaluate(&i).state, OutcomeState::Unrealized)
}
#[test]
fn temporary_target_does_not_settle_t1() {
    let mut i = input(Template::T1);
    i.end_price = Some("100".into());
    let r = evaluate(&i);
    assert_eq!(r.state, OutcomeState::Unrealized);
    assert!(r.first_threshold_interval.is_some())
}
#[test]
fn t2_target_then_invalidation_is_failure() {
    let mut i = input(Template::T2);
    i.criteria.invalidation = Some("100".into());
    i.end_price = Some("110".into());
    assert_eq!(evaluate(&i).state, OutcomeState::Unrealized)
}
#[test]
fn missing_path_prevents_success() {
    let mut i = input(Template::T2);
    i.criteria.invalidation = Some("95".into());
    i.coverage_complete = false;
    assert_eq!(evaluate(&i).state, OutcomeState::InsufficientData)
}
#[test]
fn proven_invalidation_survives_gap() {
    let mut i = input(Template::T2);
    i.criteria.invalidation = Some("99".into());
    i.coverage_complete = false;
    assert_eq!(evaluate(&i).state, OutcomeState::Unrealized)
}
#[test]
fn partial_start_bar_cannot_trigger_stop() {
    let mut i = input(Template::T2);
    i.criteria.invalidation = Some("90".into());
    i.bars[0].start = i.start - Duration::minutes(1);
    i.bars[0].low = "80".into();
    assert_eq!(evaluate(&i).state, OutcomeState::InsufficientData)
}
#[test]
fn future_endpoint_bar_is_excluded() {
    let mut i = input(Template::T2);
    i.criteria.invalidation = Some("90".into());
    i.bars[1].end = i.evaluated_at + Duration::minutes(1);
    i.bars[1].low = "80".into();
    assert_eq!(evaluate(&i).state, OutcomeState::InsufficientData)
}
#[test]
fn t4_equality_includes_base() {
    let mut i = input(Template::T4);
    i.criteria.direction = None;
    i.criteria.boundary = Some("100".into());
    i.criteria.boundary_kind = Some("lower_floor".into());
    assert_eq!(evaluate(&i).state, OutcomeState::Unrealized)
}
#[test]
fn t5_is_range_and_has_no_directional_metrics() {
    let mut i = input(Template::T5);
    i.criteria.direction = None;
    let r = evaluate(&i);
    assert_eq!(r.state, OutcomeState::Realized);
    assert_eq!(r.mfe, None)
}
#[test]
fn short_mfe_positive_mae_negative() {
    let mut i = input(Template::T1);
    i.criteria.direction = Some("S".into());
    let r = evaluate(&i);
    assert_eq!(r.mfe, Some("0.010000000000".into()));
    assert_eq!(r.mae, Some("-0.040000000000".into()))
}
#[test]
fn missing_criteria_beats_missing_data() {
    let mut i = input(Template::T1);
    i.criteria.direction = None;
    i.base = None;
    assert_eq!(evaluate(&i).state, OutcomeState::NoCriteria)
}
#[test]
fn overlapping_bars_rejected() {
    let mut i = input(Template::T1);
    i.bars[1].start = i.start;
    assert_eq!(evaluate(&i).state, OutcomeState::InsufficientData)
}
#[test]
fn t3_jump_uses_actual_trade_and_new_expiry() {
    let mut i = input(Template::T3);
    i.criteria.trigger = Some(Trigger {
        kind: "trade_touch".into(),
        comparator: "gte".into(),
        price: "105".into(),
        window_hours: 1,
        interval_seconds: None,
    });
    i.trades = vec![Trade {
        at: i.start + Duration::minutes(10),
        price: "108".into(),
    }];
    i.bars.clear();
    i.evaluated_at = i.start + Duration::hours(3);
    i.end_price = Some("110".into());
    let r = evaluate(&i);
    assert_eq!(r.trigger_price, Some("108".into()));
    assert_eq!(r.end_at, Some(i.start + Duration::minutes(130)));
    assert_eq!(r.state, OutcomeState::Realized)
}
#[test]
fn t3_no_trigger_needs_coverage() {
    let mut i = input(Template::T3);
    i.criteria.trigger = Some(Trigger {
        kind: "bar_close".into(),
        comparator: "gte".into(),
        price: "110".into(),
        window_hours: 1,
        interval_seconds: Some(3600),
    });
    assert_eq!(evaluate(&i).state, OutcomeState::NotTriggered);
    i.coverage_complete = false;
    assert_eq!(evaluate(&i).state, OutcomeState::InsufficientData)
}
#[test]
fn t3_bar_close_never_triggers_from_submission_price() {
    let mut i = input(Template::T3);
    i.criteria.trigger = Some(Trigger {
        kind: "bar_close".into(),
        comparator: "gte".into(),
        price: "99".into(),
        window_hours: 1,
        interval_seconds: Some(3600),
    });
    let r = evaluate(&i);
    assert_eq!(r.trigger_at, Some(i.start + Duration::hours(1)));
    assert_eq!(r.state, OutcomeState::Pending)
}
#[test]
fn atr_excludes_unclosed_day() {
    let start = t("2026-01-01T00:00:00Z");
    let mut bs: Vec<_> = (0..16)
        .map(|j| Bar {
            start: start + Duration::days(j),
            end: start + Duration::days(j + 1),
            open: "100".into(),
            high: "102".into(),
            low: "98".into(),
            close: "100".into(),
        })
        .collect();
    let at = start + Duration::days(15);
    let expected = atr14(&bs, at).unwrap();
    bs[15].high = "1000".into();
    assert_eq!(atr14(&bs, at).unwrap(), expected);
    assert_eq!(dec(&expected).unwrap(), dec("4").unwrap())
}
#[test]
fn us_friday_3d_and_early_close_use_calendar() {
    let at = t("2026-09-04T17:00:00Z");
    let sessions = vec![
        TradingSession {
            date: "2026-09-08".parse().unwrap(),
            close: t("2026-09-08T20:00:00Z"),
        },
        TradingSession {
            date: "2026-09-09".parse().unwrap(),
            close: t("2026-09-09T17:00:00Z"),
        },
        TradingSession {
            date: "2026-09-10".parse().unwrap(),
            close: t("2026-09-10T20:00:00Z"),
        },
    ];
    assert_eq!(
        resolve_days(at, 2, "us_equity", &sessions).unwrap(),
        sessions[1].close
    );
    assert_eq!(
        resolve_days(at, 3, "spot", &[]).unwrap(),
        at + Duration::hours(72)
    )
}
#[test]
fn decimal_exponent_bound_prevents_unbounded_allocation() {
    assert!(dec("1e999999999").is_err());
    assert!(dec("NaN").is_err())
}
#[test]
fn replay_is_deterministic() {
    let i = input(Template::T1);
    assert_eq!(
        evaluate(&i),
        evaluate(&serde_json::from_str(&serde_json::to_string(&i).unwrap()).unwrap())
    )
}

#[test]
fn representative_is_first_not_best_and_replays_are_ineligible() {
    use scorebook::domain::statistics::*;
    use uuid::Uuid;
    let episode = Uuid::new_v4();
    let make = |day, state: &str, eligible| Sample {
        call_id: Uuid::new_v4(),
        claim_no: 0,
        submitted_at: t("2026-01-01T00:00:00Z") + Duration::days(day),
        episode_id: Some(episode),
        group_pending: false,
        signature: "same".into(),
        state: state.into(),
        eligible,
        voided: false,
    };
    let first = make(0, "unrealized", true);
    let later = make(1, "realized", true);
    let replay = make(-1, "realized", false);
    let r = summarize(&[first, later, replay], 0);
    assert_eq!(r["compatible_groups"]["same"]["numerator"], 0);
    assert_eq!(r["compatible_groups"]["same"]["denominator"], 1)
}
#[test]
fn pending_groups_never_become_formal_representatives() {
    use scorebook::domain::statistics::*;
    let s = Sample {
        call_id: uuid::Uuid::new_v4(),
        claim_no: 0,
        submitted_at: t("2026-01-01T00:00:00Z"),
        episode_id: None,
        group_pending: true,
        signature: "same".into(),
        state: "realized".into(),
        eligible: true,
        voided: false,
    };
    let r = summarize(&[s], 0);
    assert_eq!(r["pending_group_claims"], 1);
    assert_eq!(r["compatible_groups"], serde_json::json!({}))
}

use chrono::{DateTime, Duration, Utc};
use scorebook_core::domain::{criteria::*, watch::Watch};
fn t() -> DateTime<Utc> {
    DateTime::from_timestamp(1700000040, 0).unwrap()
}
fn c(kind: &str) -> Criteria {
    Criteria {
        template: Template::T3,
        selected_by: Some("explicit".into()),
        direction: Some("L".into()),
        horizon_hours: Some(1),
        threshold_ratio: Some("0.05".into()),
        trigger: Some(Trigger {
            kind: kind.into(),
            comparator: "gte".into(),
            price: "105".into(),
            window_hours: 2,
            interval_seconds: Some(60),
        }),
        ..Criteria::default()
    }
}
fn tr(id: i64, seconds: i64, p: &str) -> (i64, Trade) {
    (
        id,
        Trade {
            at: t() + Duration::seconds(seconds),
            price: p.into(),
        },
    )
}
fn bar(n: i64, p: &str) -> Bar {
    Bar {
        start: t() + Duration::minutes(n),
        end: t() + Duration::minutes(n + 1),
        open: p.into(),
        high: p.into(),
        low: p.into(),
        close: p.into(),
        volume: None,
    }
}
#[test]
fn jump_trigger_survives_checkpoint_and_excludes_pretrigger_low() {
    let mut w = Watch::new(c("trade_touch"), t(), "100".into(), None).unwrap();
    w.trades(
        t(),
        t() + Duration::seconds(30),
        &[tr(1, 1, "80"), tr(2, 10, "108"), tr(3, 10, "109")],
    )
    .unwrap();
    assert_eq!(w.trigger_price.as_deref(), Some("108"));
    assert_eq!(w.path.as_ref().unwrap().lowest, "108");
    assert_eq!(w.path.as_ref().unwrap().highest, "109");
    let mut restarted: Watch = serde_json::from_value(serde_json::to_value(w).unwrap()).unwrap();
    restarted
        .trades(
            t() + Duration::seconds(30),
            t() + Duration::minutes(1),
            &[tr(4, 31, "110")],
        )
        .unwrap();
    assert_eq!(restarted.trigger_at, Some(t() + Duration::seconds(10)));
    assert_eq!(restarted.deadline(), t() + Duration::seconds(3610));
    assert!(
        restarted
            .trades(t(), t() + Duration::minutes(1), &[])
            .is_err()
    );
}
#[test]
fn close_trigger_never_uses_preclose_high_and_never_uses_threshold_price() {
    let mut w = Watch::new(c("bar_close"), t(), "100".into(), None).unwrap();
    let mut first = bar(0, "102");
    first.high = "120".into();
    w.bars(t(), t() + Duration::minutes(2), &[first, bar(1, "110")])
        .unwrap();
    assert_eq!(w.trigger_at, Some(t() + Duration::minutes(2)));
    assert_eq!(w.trigger_price.as_deref(), Some("110"));
    assert_eq!(w.path.as_ref().unwrap().highest, "110");
}
#[test]
fn missing_and_out_of_order_events_cannot_prove_no_trigger() {
    let mut w = Watch::new(c("trade_touch"), t(), "100".into(), None).unwrap();
    assert!(
        w.trades(
            t(),
            t() + Duration::minutes(1),
            &[tr(2, 20, "100"), tr(1, 10, "100")]
        )
        .is_err()
    );
    let mut w = Watch::new(c("bar_close"), t(), "100".into(), None).unwrap();
    assert!(
        w.bars(t(), t() + Duration::minutes(2), &[bar(1, "100")])
            .is_err()
    );
    assert_eq!(w.result(None, false).unwrap().state, OutcomeState::Pending);
}
#[test]
fn aggregate_matches_batch_for_directional_completion() {
    let mut c = c("trade_touch");
    c.template = Template::T1;
    c.trigger = None;
    let bars: Vec<_> = (0..60)
        .map(|i| bar(i, if i < 30 { "110" } else { "107" }))
        .collect();
    let input = EvaluationInput {
        criteria: c.clone(),
        start: t(),
        evaluated_at: t() + Duration::hours(1),
        base: Some("100".into()),
        atr0: None,
        bars: bars.clone(),
        trades: vec![],
        coverage_complete: true,
        endpoint_proven: true,
        end_price: Some("107".into()),
    };
    let mut w = Watch::new(c, t(), "100".into(), None).unwrap();
    w.bars(t(), t() + Duration::minutes(30), &bars[..30])
        .unwrap();
    let mut w: Watch = serde_json::from_value(serde_json::to_value(w).unwrap()).unwrap();
    w.bars(
        t() + Duration::minutes(30),
        t() + Duration::hours(1),
        &bars[30..],
    )
    .unwrap();
    assert_eq!(
        evaluate(&input),
        w.result(Some("107".into()), true).unwrap()
    );
}

#[test]
fn daily_stream_stops_at_new_trigger_deadline_without_losing_same_ms_order() {
    let mut w = Watch::new(c("trade_touch"), t(), "100".into(), None).unwrap();
    w.trades(
        t(),
        t() + Duration::hours(2),
        &[
            tr(1, 10, "106"),
            tr(2, 10, "107"),
            tr(3, 3610, "109"),
            tr(4, 5000, "1000"),
        ],
    )
    .unwrap();
    assert_eq!(w.through, t() + Duration::seconds(3610));
    assert_eq!(w.path.as_ref().unwrap().highest, "109");
    assert_eq!(w.last_trade_id, Some(3));
}

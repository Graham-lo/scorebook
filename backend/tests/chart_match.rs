use scorebook::domain::chart_match::{self, Candle};
fn series(down: bool) -> Vec<Candle> {
    (0..64)
        .map(|i| {
            let v =
                100. + (i as f64 * 0.8 + (i as f64 * 0.4).sin() * 5.) * if down { -1. } else { 1. };
            Candle::new([v, v + 2., v - 1., v + 0.5])
        })
        .collect()
}
#[test]
fn geometry_invariant_to_price_units_but_not_direction() {
    let a = series(false);
    let b: Vec<_> = a
        .iter()
        .map(|c| Candle::new(c.shape.map(|v| v * 50. + 700.)))
        .collect();
    assert_eq!(chart_match::descriptor(&a).unwrap().len(), 192);
    assert!(chart_match::rerank(&a, &b, false).unwrap().score > 0.999);
    assert!(chart_match::rerank(&a, &series(true), false).unwrap().score < 0.4);
    assert!(chart_match::rerank(&a, &series(true), true).unwrap().score > 0.8);
}
#[test]
fn geometry_rejects_flat_and_invalid_ohlc() {
    assert!(chart_match::descriptor(&vec![Candle::new([1.; 4]); 64]).is_err());
    assert!(chart_match::descriptor(&vec![Candle::new([2., 1., 0., 2.]); 64]).is_err());
}
#[test]
fn display_contour_keeps_direction_and_every_candle_without_price_units() {
    let source = series(false);
    let scaled: Vec<_> = source
        .iter()
        .map(|c| Candle::new(c.shape.map(|v| 17. * v + 920.)))
        .collect();
    let a = chart_match::display_outline(&source).unwrap();
    let b = chart_match::display_outline(&scaled).unwrap();
    assert_eq!(a.len(), source.len());
    assert!(a.iter().zip(b).all(|(a, b)| (a - b).abs() < 1e-12));
    assert!(a.iter().all(|v| (0.0..=1.0).contains(v)));
    assert!(a.last().unwrap() > &a[0]);
    assert!(chart_match::display_outline(&vec![Candle::new([1.; 4]); 64]).is_err());
    assert_eq!(
        scorebook_core::access::route_permission("POST", "/v1/chart-analyses/outline"),
        "search.compute"
    );
}
#[test]
fn screenshot_to_direct_ohlc_alignment() {
    use chrono::{Duration, Utc};
    let start = Utc::now() - Duration::days(4);
    let candles = series(false);
    let bars: Vec<_> = candles
        .iter()
        .enumerate()
        .map(|(i, c)| scorebook::domain::criteria::Bar {
            start: start + Duration::hours(i as i64),
            end: start + Duration::hours(i as i64 + 1),
            open: c.shape[0].to_string(),
            high: c.shape[1].to_string(),
            low: c.shape[2].to_string(),
            close: c.shape[3].to_string(),
            volume: None,
        })
        .collect();
    let im = scorebook::domain::chart::raster(&bars).unwrap();
    let g = chart_match::detect(&im, None, false).unwrap();
    assert!((56..=72).contains(&g.quality.detected_candles));
    assert!(
        chart_match::rerank(&g.candles, &candles, false)
            .unwrap()
            .score
            > 0.85
    );
    // This is an in-memory generated image, not a semantic screenshot benchmark.
}

#[test]
fn followthrough_chart_marks_the_original_boundary_and_refuses_hidden_gaps() {
    use chrono::{Duration, Utc};
    let start = Utc::now() - Duration::days(7);
    let bars: Vec<_> = series(false)
        .iter()
        .enumerate()
        .map(|(i, c)| scorebook::domain::criteria::Bar {
            start: start + Duration::hours(i as i64),
            end: start + Duration::hours(i as i64 + 1),
            open: c.shape[0].to_string(),
            high: c.shape[1].to_string(),
            low: c.shape[2].to_string(),
            close: c.shape[3].to_string(),
            volume: None,
        })
        .collect();
    let boundary = bars[31].end;
    let svg =
        scorebook::domain::chart::svg_with_match(&bars, "BTCUSDT", "1h", Some(boundary)).unwrap();
    assert!(svg.contains("匹配片段"));
    assert!(svg.contains("后续走势 · 不参与匹配"));
    assert!(svg.contains("M560.00 44V502"));
    assert!(
        scorebook::domain::chart::svg_with_match(
            &bars,
            "BTCUSDT",
            "1h",
            Some(boundary + Duration::minutes(1))
        )
        .is_err()
    );
    let mut gap = bars.clone();
    gap.remove(35);
    assert_eq!(
        scorebook::domain::chart::svg_with_match(&gap, "BTCUSDT", "1h", Some(boundary))
            .unwrap_err(),
        "chart_followthrough_has_gaps"
    );
}

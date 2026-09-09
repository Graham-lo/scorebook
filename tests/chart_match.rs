use scorebook::domain::chart_match::{self, Candle};
fn series(down: bool) -> Vec<Candle> {
    (0..64)
        .map(|i| {
            let v =
                100. + (i as f64 * 0.8 + (i as f64 * 0.4).sin() * 5.) * if down { -1. } else { 1. };
            Candle([v, v + 2., v - 1., v + 0.5])
        })
        .collect()
}
#[test]
fn geometry_invariant_to_price_units_but_not_direction() {
    let a = series(false);
    let b: Vec<_> = a
        .iter()
        .map(|c| Candle(c.0.map(|v| v * 50. + 700.)))
        .collect();
    assert_eq!(chart_match::descriptor(&a).unwrap().len(), 192);
    assert!(chart_match::rerank(&a, &b, false).unwrap().score > 0.999);
    assert!(chart_match::rerank(&a, &series(true), false).unwrap().score < 0.4);
    assert!(chart_match::rerank(&a, &series(true), true).unwrap().score > 0.8);
}
#[test]
fn geometry_rejects_flat_and_invalid_ohlc() {
    assert!(chart_match::descriptor(&vec![Candle([1.; 4]); 64]).is_err());
    assert!(chart_match::descriptor(&vec![Candle([2., 1., 0., 2.]); 64]).is_err());
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
            open: c.0[0].to_string(),
            high: c.0[1].to_string(),
            low: c.0[2].to_string(),
            close: c.0[3].to_string(),
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

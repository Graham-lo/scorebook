//! Coarse recall must allow the same variable window length as exact OHLC reranking.
//! These descriptor coordinates only order candidates; they never become match scores.
pub const CANDIDATE_POOL: usize = 10_000;
const POINTS: usize = 32;
type Shape = [[f64; 2]; POINTS];

fn segment(vector: &[f32], start: f64, length: f64) -> Shape {
    let mut points = [[0.; 2]; POINTS];
    for (i, p) in points.iter_mut().enumerate() {
        let at = start + (length - 1.) * i as f64 / (POINTS - 1) as f64;
        let left = at.floor() as usize;
        let right = (left + 1).min(63);
        let t = at - left as f64;
        // Descriptor channels are center, half-range, derivative, up to one
        // positive scale factor. Translation and that factor cancel below.
        for (channel, value) in p.iter_mut().enumerate() {
            *value = f64::from(vector[left * 3 + channel]) * (1. - t)
                + f64::from(vector[right * 3 + channel]) * t;
        }
    }
    let low = points
        .iter()
        .map(|p| p[0] - p[1])
        .fold(f64::INFINITY, f64::min);
    let high = points
        .iter()
        .map(|p| p[0] + p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let range = (high - low).max(1e-9);
    for p in &mut points {
        p[0] = (p[0] - low) / range;
        p[1] /= range;
    }
    points
}

/// Recover scale-independent centers/ranges already in the published descriptor.
/// Scan the longer window, so a matching 108-bar section inside a 128-bar feature
/// is considered before symbol diversity and the expensive source verification cap.
pub fn distance(query: &[f32], candidate: &[f32], bars: usize, indexed_bars: usize) -> f64 {
    if query.len() != 192
        || candidate.len() != 192
        || bars == 0
        || indexed_bars == 0
        || query.iter().chain(candidate).any(|v| !v.is_finite())
    {
        return f64::INFINITY;
    }
    let q = segment(query, 0., 64.);
    let c = segment(candidate, 0., 64.);
    let mut best = f64::INFINITY;
    for percent in (85..=115).step_by(5) {
        let ratio = bars as f64 * percent as f64 / 100. / indexed_bars as f64;
        let (full, longer, fraction) = if ratio <= 1. {
            (&q, candidate, ratio)
        } else {
            (&c, query, 1. / ratio)
        };
        let length = (64. * fraction).clamp(16., 64.);
        let steps = ((64. - length) / 2.).ceil() as usize;
        for step in 0..=steps {
            let start = if steps == 0 {
                0.
            } else {
                (64. - length) * step as f64 / steps as f64
            };
            let part = segment(longer, start, length);
            let cost = full
                .iter()
                .zip(part)
                .map(|(a, b)| (a[0] - b[0]).abs() + 0.25 * (a[1] - b[1]).abs())
                .sum::<f64>()
                / POINTS as f64;
            best = best.min(cost);
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use scorebook_core::domain::chart_match::{self, Candle};
    #[test]
    fn an_embedded_matching_section_beats_a_different_full_window() {
        let candles: Vec<_> = (0..128)
            .map(|i| {
                let x = i as f64;
                let y = (x * 0.08).sin() + (x * 0.23).cos() * 0.3 + x * 0.005;
                Candle::new([y, y + 0.12, y - 0.08, y + 0.03])
            })
            .collect();
        let query = chart_match::descriptor(&candles[10..118]).unwrap();
        let indexed = chart_match::descriptor(&candles).unwrap();
        let other: Vec<_> = (0..128)
            .map(|i| {
                let y = (i as f64 * 0.18).sin();
                Candle::new([y, y + 0.2, y - 0.1, y + 0.03])
            })
            .collect();
        let different = chart_match::descriptor(&other).unwrap();
        let actual = distance(&query, &indexed, 108, 128);
        assert!(actual < 0.055, "{actual}");
        assert!(actual < distance(&query, &different, 108, 128));
        assert!(
            (actual
                - distance(
                    &query,
                    &indexed.iter().map(|v| v * 3.).collect::<Vec<_>>(),
                    108,
                    128
                ))
            .abs()
                < 1e-6
        );
    }
}

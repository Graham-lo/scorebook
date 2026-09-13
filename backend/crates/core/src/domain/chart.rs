//! Stateless system-chart rendering; floating-point conversion is display-only.
use super::criteria::Bar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChartRequest {
    #[serde(default)]
    pub source: crate::market::HistorySource,
    pub symbol: String,
    #[serde(default = "market")]
    pub market: String,
    pub interval: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    /// Display-only boundary. Bars after this instant never enter similarity ranking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_end_at: Option<DateTime<Utc>>,
}
fn market() -> String {
    "usd_m".into()
}
pub fn numbers(bars: &[Bar]) -> Result<Vec<[f64; 4]>, String> {
    if bars.is_empty() || bars.len() > 2000 {
        return Err("chart_requires_1_to_2000_bars".into());
    }
    bars.iter()
        .map(|b| {
            let mut p = [0.0f64; 4];
            for (j, s) in [&b.open, &b.high, &b.low, &b.close].iter().enumerate() {
                p[j] = s.parse().map_err(|_| "invalid_chart_price")?;
                if !p[j].is_finite() || p[j] <= 0.0 {
                    return Err("invalid_chart_price".into());
                }
            }
            if p[1] < p[0].max(p[3]) || p[2] > p[0].min(p[3]) {
                return Err("invalid_ohlc".into());
            }
            Ok(p)
        })
        .collect()
}
pub fn raster(bars: &[Bar]) -> Result<image::DynamicImage, String> {
    let prices = numbers(bars)?;
    let mut im = image::RgbImage::from_pixel(640, 320, image::Rgb([248, 249, 251]));
    let hi = prices
        .iter()
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let lo = prices.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
    let range = (hi - lo).max(hi * 1e-6);
    let y = |v: f64| ((1.0 - (v - lo) / range) * 260.0 + 30.0).clamp(0.0, 319.0) as u32;
    for (j, p) in prices.iter().enumerate() {
        let x = ((j as f64 + 0.5) * 620.0 / prices.len() as f64 + 10.0) as u32;
        let half = (620.0 / prices.len() as f64 * 0.3).max(1.0) as u32;
        let color = if p[3] >= p[0] {
            image::Rgb([20, 180, 100])
        } else {
            image::Rgb([225, 65, 78])
        };
        for yy in y(p[1])..=y(p[2]) {
            im.put_pixel(x.min(639), yy, color)
        }
        for xx in x.saturating_sub(half)..=(x + half).min(639) {
            for yy in y(p[0].max(p[3]))..=y(p[0].min(p[3])).max(y(p[0].max(p[3])) + 1).min(319) {
                im.put_pixel(xx, yy, color)
            }
        }
    }
    Ok(image::DynamicImage::ImageRgb8(im))
}
pub fn svg(bars: &[Bar], symbol: &str, interval: &str) -> Result<String, String> {
    svg_with_match(bars, symbol, interval, None)
}
pub fn svg_with_match(
    bars: &[Bar],
    symbol: &str,
    interval: &str,
    match_end_at: Option<DateTime<Utc>>,
) -> Result<String, String> {
    let p = numbers(bars)?;
    let split = match match_end_at {
        Some(at) => Some(
            bars.iter()
                .position(|b| b.end == at)
                .ok_or("match_boundary_not_in_chart")?
                + 1,
        ),
        None => None,
    };
    if split.is_some() && !bars.windows(2).all(|b| b[0].end == b[1].start) {
        return Err("chart_followthrough_has_gaps".into());
    }
    let hi = p.iter().map(|v| v[1]).fold(f64::NEG_INFINITY, f64::max);
    let lo = p.iter().map(|v| v[2]).fold(f64::INFINITY, f64::min);
    let range = (hi - lo).max(hi * 1e-6);
    let y = |v: f64| 54.0 + (hi - v) / range * 440.0;
    let escape = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let mut s = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="580" viewBox="0 0 1200 580"><rect width="1200" height="580" rx="20" fill="#f8f9fb"/><g font-family="system-ui,sans-serif" fill="#45474c"><text x="28" y="30" font-size="16">{} · {} · 币安 · UTC</text></g>"##,
        escape(symbol),
        escape(interval)
    );
    for k in 0..5 {
        let yy = 54.0 + k as f64 * 110.0;
        let value = hi - range * k as f64 / 4.0;
        s += &format!(
            r##"<path d="M24 {yy}H1100" stroke="#e3e5e9"/><text x="1110" y="{}" font-family="system-ui" font-size="12" fill="#81848b">{value:.4}</text>"##,
            yy + 4.0
        );
    }
    if let Some(n) = split {
        let x = 28.0 + n as f64 * 1064.0 / p.len() as f64;
        s += &format!(
            r##"<rect x="28" y="48" width="{:.2}" height="452" fill="#b39448" opacity="0.07"/><path d="M{x:.2} 44V502" stroke="#a18139" stroke-width="2" stroke-dasharray="5 5"/><text x="36" y="48" font-family="system-ui" font-size="12" fill="#8b703c">匹配片段</text><text x="1086" y="48" text-anchor="end" font-family="system-ui" font-size="12" fill="#6a7080">{}</text>"##,
            x - 28.0,
            if n < p.len() {
                "后续走势 · 不参与匹配"
            } else {
                "尚无后续已收盘 K 线"
            }
        );
    }
    for (j, v) in p.iter().enumerate() {
        let x = 28.0 + (j as f64 + 0.5) * 1064.0 / p.len() as f64;
        let w = (1064.0 / p.len() as f64 * 0.6).max(1.0);
        let color = if v[3] >= v[0] { "#14a877" } else { "#dc5b69" };
        s += &format!(
            r##"<path d="M{x:.2} {:.2}V{:.2}" stroke="{color}"/><rect x="{:.2}" y="{:.2}" width="{w:.2}" height="{:.2}" rx="0.8" fill="{color}"/>"##,
            y(v[1]),
            y(v[2]),
            x - w / 2.0,
            y(v[0].max(v[3])),
            (y(v[0]) - y(v[3])).abs().max(1.0)
        );
    }
    s += &format!(
        r##"<text x="28" y="529" font-family="system-ui" font-size="12" fill="#81848b">{}</text><text x="1090" y="529" text-anchor="end" font-family="system-ui" font-size="12" fill="#81848b">{}</text></svg>"##,
        bars[0].start.format("%Y-%m-%d %H:%M"),
        bars.last().unwrap().end.format("%Y-%m-%d %H:%M")
    );
    Ok(s)
}

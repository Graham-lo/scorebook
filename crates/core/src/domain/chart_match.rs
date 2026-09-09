//! chart-match-v2 geometry. Price samples live only in memory; public persistence uses
//! the fixed 192-dimensional descriptor, never this per-candle representation.
use crate::{
    api::dto::Region,
    error::{Error, Result},
};
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub const MODEL: &str = "candle-geometry-v2";
pub const PROTOCOL: &str = "chart-match-v2";
#[derive(Clone, Debug)]
pub struct Candle(pub [f64; 4]); // open/high/low/close; geometry coordinates, not inferred prices
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct GeometryQuality {
    pub protocol: String,
    pub model_id: String,
    pub region: Region,
    pub detected_candles: usize,
    pub spacing_consistency: f64,
    pub supported: bool,
    pub limitations: Vec<String>,
}
pub struct Geometry {
    pub candles: Vec<Candle>,
    pub quality: GeometryQuality,
}
fn color(p: image::Rgb<u8>) -> u8 {
    let [r, g, b] = p.0.map(f64::from);
    if r.max(g).max(b) - r.min(g).min(b) < 40. {
        return 0;
    }
    if r > g * 1.25 && r > b * 1.1 && r > 65. {
        1
    } else if g > r * 1.15 && g > b * 1.02 && g > 65. {
        2
    } else {
        0
    }
}
#[derive(Clone)]
struct Glyph {
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    body_top: usize,
    body_bottom: usize,
    color: u8,
}
pub fn detect(im: &DynamicImage, region: Option<Region>, red_up: bool) -> Result<Geometry> {
    let (iw, ih) = im.dimensions();
    let roi = region.unwrap_or(Region {
        x: 0,
        y: 0,
        width: iw,
        height: ih,
    });
    if roi.width < 64
        || roi.height < 32
        || roi.x.checked_add(roi.width).is_none_or(|v| v > iw)
        || roi.y.checked_add(roi.height).is_none_or(|v| v > ih)
    {
        return Err(Error::bad("invalid_region"));
    }
    let crop = im.crop_imm(roi.x, roi.y, roi.width, roi.height);
    let rgb = crop
        .resize(1600, 1600, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let mut mask: Vec<u8> = rgb.pixels().map(|p| color(*p)).collect();
    let mut glyphs = Vec::new();
    for root in 0..mask.len() {
        let class = mask[root];
        if class == 0 {
            continue;
        }
        mask[root] = 0;
        let mut stack = vec![root];
        let mut points = Vec::new();
        let (mut x0, mut x1, mut y0, mut y1) = (w, 0, h, 0);
        while let Some(p) = stack.pop() {
            let (x, y) = (p % w, p / w);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            points.push((x, y));
            for next in [
                if x > 0 { Some(p - 1) } else { None },
                if x + 1 < w { Some(p + 1) } else { None },
                if y > 0 { Some(p - w) } else { None },
                if y + 1 < h { Some(p + w) } else { None },
            ]
            .into_iter()
            .flatten()
            {
                if mask[next] == class {
                    mask[next] = 0;
                    stack.push(next);
                }
            }
        }
        let width = x1 - x0 + 1;
        let height = y1 - y0 + 1;
        if width < 2 || width > w / 24 || height < 3 || points.len() < 6 || height > h * 4 / 5 {
            continue;
        }
        let mut rows = vec![0usize; height];
        for (_, y) in &points {
            rows[*y - y0] += 1;
        }
        let threshold = (width * 2 / 3).max(2);
        let body: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, n)| **n >= threshold)
            .map(|(y, _)| y + y0)
            .collect();
        if body.is_empty() {
            continue;
        }
        glyphs.push(Glyph {
            x0,
            x1,
            y0,
            y1,
            body_top: body[0],
            body_bottom: *body.last().unwrap(),
            color: class,
        });
    }
    // Separate main candles from a volume pane sharing a common bottom baseline.
    // Isolated symbols/text cannot form a sufficiently long, regularly spaced series.
    if glyphs.len() > 4096 {
        return Err(Error::bad("chart_too_complex_select_region"));
    }
    glyphs.sort_by_key(|g| g.x0 + g.x1);
    let mut best = Vec::new();
    for seed in glyphs.iter().take(2048) {
        let center = (seed.y0 + seed.y1) as f64 / 2.;
        let mut row: Vec<_> = glyphs
            .iter()
            .filter(|g| {
                let gc = (g.y0 + g.y1) as f64 / 2.;
                (gc - center).abs() < h as f64 * 0.55
                    && g.x1 - g.x0 < (seed.x1 - seed.x0 + 1) * 3
                    && seed.x1 - seed.x0 < (g.x1 - g.x0 + 1) * 3
            })
            .cloned()
            .collect();
        row.dedup_by(|a, b| (a.x0 + a.x1).abs_diff(b.x0 + b.x1) < (a.x1 - a.x0 + b.x1 - b.x0 + 2));
        let common_bottom = row.iter().filter(|g| g.y1.abs_diff(seed.y1) <= 2).count();
        if common_bottom * 3 > row.len() * 2 {
            continue;
        }
        if row.len() > best.len() {
            best = row;
        }
    }
    if best.len() < 16 || best.len() > 512 {
        return Err(Error::bad("ordinary_candles_not_resolved"));
    }
    let mut gaps: Vec<f64> = best
        .windows(2)
        .map(|g| ((g[1].x0 + g[1].x1) - (g[0].x0 + g[0].x1)) as f64 / 2.)
        .collect();
    gaps.sort_by(f64::total_cmp);
    let median = gaps[gaps.len() / 2];
    let consistency = gaps
        .iter()
        .filter(|g| **g >= median * 0.6 && **g <= median * 1.5)
        .count() as f64
        / gaps.len() as f64;
    if consistency < 0.75 {
        return Err(Error::bad("chart_obstructed_or_unsupported"));
    }
    let left = best.iter().map(|g| g.x0).min().unwrap();
    let right = best.iter().map(|g| g.x1).max().unwrap();
    let top = best.iter().map(|g| g.y0).min().unwrap();
    let bottom = best.iter().map(|g| g.y1).max().unwrap();
    let scale_x = roi.width as f64 / w as f64;
    let scale_y = roi.height as f64 / h as f64;
    let region = Region {
        x: roi.x + (left as f64 * scale_x).floor() as u32,
        y: roi.y + (top as f64 * scale_y).floor() as u32,
        width: (((right - left + 1) as f64 * scale_x).ceil() as u32).min(roi.width),
        height: (((bottom - top + 1) as f64 * scale_y).ceil() as u32).min(roi.height),
    };
    let candles = best
        .iter()
        .map(|g| {
            let up = (g.color == 1) == red_up;
            let high = -(g.y0 as f64);
            let low = -(g.y1 as f64);
            let bt = -(g.body_top as f64);
            let bb = -(g.body_bottom as f64);
            Candle([
                if up { bb } else { bt },
                high,
                low,
                if up { bt } else { bb },
            ])
        })
        .collect();
    Ok(Geometry {
        candles,
        quality: GeometryQuality {
            protocol: PROTOCOL.into(),
            model_id: MODEL.into(),
            region,
            detected_candles: best.len(),
            spacing_consistency: consistency,
            supported: true,
            limitations: vec![
                "ordinary_red_green_candles_only".into(),
                "heikin_ashi_cannot_be_excluded_from_pixels_alone".into(),
                "symbol_and_interval_require_visible_text".into(),
                "semantic_quality_not_yet_validated".into(),
            ],
        },
    })
}
pub fn from_bars(bars: &[super::criteria::Bar]) -> Result<Vec<Candle>> {
    super::chart::numbers(bars)
        .map(|v| v.into_iter().map(Candle).collect())
        .map_err(Error::bad)
}
pub fn normalized(candles: &[Candle], reverse: bool) -> Result<Vec<[f64; 4]>> {
    if candles.len() < 16
        || candles.len() > 2000
        || candles.iter().any(|c| {
            c.0.iter().any(|v| !v.is_finite())
                || c.0[1] < c.0[0].max(c.0[3])
                || c.0[2] > c.0[0].min(c.0[3])
        })
    {
        return Err(Error::bad("invalid_candle_geometry"));
    }
    let hi = candles
        .iter()
        .map(|c| c.0[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let lo = candles.iter().map(|c| c.0[2]).fold(f64::INFINITY, f64::min);
    let range = hi - lo;
    if range <= f64::EPSILON {
        return Err(Error::bad("flat_chart_geometry"));
    }
    Ok((0..64)
        .map(|i| {
            let pos = i as f64 * (candles.len() - 1) as f64 / 63.;
            let a = pos.floor() as usize;
            let b = (a + 1).min(candles.len() - 1);
            let t = pos - a as f64;
            let mut p = [0.; 4];
            for (j, v) in p.iter_mut().enumerate() {
                *v = (candles[a].0[j] * (1. - t) + candles[b].0[j] * t - lo) / range;
            }
            if reverse {
                [1. - p[0], 1. - p[2], 1. - p[1], 1. - p[3]]
            } else {
                p
            }
        })
        .collect())
}
pub fn descriptor(candles: &[Candle]) -> Result<Vec<f32>> {
    let series = normalized(candles, false)?;
    let mut vector = Vec::with_capacity(192);
    for (i, p) in series.iter().enumerate() {
        let center = (p[0] + p[3]) / 2.;
        let prev = if i == 0 {
            center
        } else {
            (series[i - 1][0] + series[i - 1][3]) / 2.
        };
        vector.extend([
            (center - 0.5) as f32,
            ((p[1] - p[2]) * 0.5) as f32,
            ((center - prev) * 2.) as f32,
        ]);
    }
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm <= 1e-6 {
        return Err(Error::bad("flat_chart_geometry"));
    }
    for v in &mut vector {
        *v /= norm;
    }
    Ok(vector)
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct MatchScore {
    pub score: f64,
    pub alignment_cost: f64,
    pub direction_consistent: bool,
    pub reverse: bool,
    pub meaning: String,
}
pub fn rerank(query: &[Candle], candidate: &[Candle], reverse: bool) -> Result<MatchScore> {
    let a = normalized(query, reverse)?;
    let b = normalized(candidate, false)?;
    let direction = |v: &[[f64; 4]]| (v[63][3] - v[0][0]).signum();
    let consistent = direction(&a) == direction(&b)
        || (a[63][3] - a[0][0]).abs() < 0.08
        || (b[63][3] - b[0][0]).abs() < 0.08;
    let mut prev = [f64::INFINITY; 65];
    prev[0] = 0.;
    for i in 1usize..=64 {
        let mut row = [f64::INFINITY; 65];
        for j in i.saturating_sub(6).max(1)..=(i + 6).min(64) {
            let p = a[i - 1];
            let q = b[j - 1];
            let cost = (p[0] - q[0]).abs() * 0.25
                + (p[3] - q[3]).abs() * 0.35
                + (p[1] - q[1]).abs() * 0.2
                + (p[2] - q[2]).abs() * 0.2;
            row[j] = cost + (prev[j - 1]).min(prev[j] + 0.025).min(row[j - 1] + 0.025);
        }
        prev = row;
    }
    let cost = prev[64] / 64.;
    let score = (-6. * cost).exp() * if consistent { 1. } else { 0.25 };
    Ok(MatchScore {
        score,
        alignment_cost: cost,
        direction_consistent: consistent,
        reverse,
        meaning: "structural_similarity_not_probability".into(),
    })
}

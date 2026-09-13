//! Read explicit period text, then compare selection styling within its toolbar row.
//! No app-specific coordinates, fixed highlight hue, or default period.
use crate::adapters::ocr::OcrResult;
use image::RgbImage;
use scorebook_core::domain::interval::Interval;
use serde_json::{Value, json};

pub fn canonical(text: &str) -> Option<String> {
    let text: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let text = text.trim_matches(|c: char| ",;:，；：()[]".contains(c));
    let text = match text {
        "天" | "日" => "1d",
        "周" | "週" => "1w",
        "月" => "1M",
        _ => text,
    };
    let localized = [
        ("分钟", "m"),
        ("小时", "h"),
        ("小時", "h"),
        ("分", "m"),
        ("时", "h"),
        ("時", "h"),
        ("日", "d"),
        ("天", "d"),
        ("周", "w"),
        ("週", "w"),
        ("月", "M"),
    ]
    .iter()
    .find_map(|(suffix, unit)| {
        text.strip_suffix(suffix)
            .filter(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
            .map(|number| format!("{number}{unit}"))
    });
    let name = localized.as_deref().unwrap_or(text);
    Interval::from_binance(name)
        .or_else(|| Interval::from_binance(&name.to_lowercase()))
        .map(|iv| iv.as_str().to_owned())
}

/// Three distinct period labels on one row establish the end of chart controls.
/// Blank above it without changing image scaling: colored quotes are not candles.
pub fn chart_top(ocr: &OcrResult) -> Option<f64> {
    let labels: Vec<_> = ocr
        .observations
        .iter()
        .filter(|o| o.confidence >= 0.3 && o.r#box[1] < 0.4 && o.r#box[3] > 0.)
        .filter_map(|o| canonical(&o.text).map(|iv| (iv, o.r#box)))
        .collect();
    labels
        .iter()
        .filter_map(|(_, b)| {
            let row: Vec<_> = labels
                .iter()
                .filter(|(_, r)| (r[1] + r[3] / 2. - b[1] - b[3] / 2.).abs() < r[3].max(b[3]) * 0.7)
                .collect();
            let distinct: std::collections::BTreeSet<_> = row.iter().map(|r| &r.0).collect();
            (distinct.len() >= 3).then(|| row.iter().map(|r| r.1[1] + r.1[3]).fold(0., f64::max))
        })
        .max_by(f64::total_cmp)
}

type Color = [f64; 3];
fn distance(a: Color, b: Color) -> f64 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b).powi(2))
        .sum::<f64>()
        .sqrt()
}
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}
fn median_color(colors: &[Color]) -> Color {
    std::array::from_fn(|channel| {
        median(&mut colors.iter().map(|c| c[channel]).collect::<Vec<_>>())
    })
}
fn chroma(c: Color) -> f64 {
    c.into_iter().fold(0., f64::max) - c.into_iter().fold(255., f64::min)
}
fn pixels(image: &RgbImage, bounds: [f64; 4]) -> Vec<Color> {
    let [x, y, w, h] = bounds;
    let x0 = (x.max(0.) * image.width() as f64) as u32;
    let y0 = (y.max(0.) * image.height() as f64) as u32;
    let x1 = ((x + w).clamp(0., 1.) * image.width() as f64) as u32;
    let y1 = ((y + h).clamp(0., 1.) * image.height() as f64) as u32;
    let mut out = Vec::new();
    for py in (y0..y1).step_by(2) {
        for px in (x0..x1).step_by(2) {
            out.push(image.get_pixel(px, py).0.map(f64::from));
        }
    }
    out
}
struct Style {
    foreground: Color,
    background: Color,
    contrast: f64,
    underline: f64,
}
fn style(image: &RgbImage, bounds: [f64; 4]) -> Option<Style> {
    let [x, y, w, h] = bounds;
    let area = pixels(image, [x, y - h * 0.25, w, h * 1.5]);
    if area.len() < 12 {
        return None;
    }
    let background = median_color(&area);
    let mut glyphs = pixels(image, bounds);
    glyphs.sort_by(|a, b| distance(*b, background).total_cmp(&distance(*a, background)));
    if glyphs.len() < 12 {
        return None;
    }
    let foreground = median_color(&glyphs[..(glyphs.len() / 8).max(1)]);
    let below = pixels(image, [x, y + h, w, h * 1.2]);
    let underline = below
        .iter()
        .filter(|p| distance(**p, background) > 65.)
        .count() as f64
        / below.len().max(1) as f64;
    Some(Style {
        foreground,
        background,
        contrast: distance(foreground, background),
        underline,
    })
}

pub fn selected(image: &RgbImage, ocr: &OcrResult) -> Option<String> {
    let mut candidates = Vec::new();
    for o in &ocr.observations {
        if o.confidence < 0.3 || o.r#box[1] >= 0.4 || o.r#box[3] <= 0. || o.r#box[2] <= 0. {
            continue;
        }
        let Some(interval) = canonical(&o.text) else {
            continue;
        };
        // Full-image and toolbar OCR may describe the same label twice.
        if let Some(existing) =
            candidates
                .iter_mut()
                .find(|(iv, b, _, _): &&mut (String, [f64; 4], f32, Style)| {
                    *iv == interval
                        && (b[0] - o.r#box[0]).abs() < 0.025
                        && (b[1] - o.r#box[1]).abs() < 0.015
                })
        {
            if o.confidence > existing.2
                && let Some(s) = style(image, o.r#box)
            {
                *existing = (interval, o.r#box, o.confidence, s);
            }
            continue;
        }
        if let Some(s) = style(image, o.r#box) {
            candidates.push((interval, o.r#box, o.confidence, s));
        }
    }
    let mut winners = std::collections::BTreeSet::new();
    for (_, bounds, _, _) in &candidates {
        let row: Vec<_> = candidates
            .iter()
            .filter(|(_, b, _, _)| {
                (b[1] + b[3] / 2. - bounds[1] - bounds[3] / 2.).abs() < b[3].max(bounds[3]) * 0.7
            })
            .collect();
        if row.len() < 3 {
            continue;
        }
        let foreground = median_color(&row.iter().map(|c| c.3.foreground).collect::<Vec<_>>());
        let background = median_color(&row.iter().map(|c| c.3.background).collect::<Vec<_>>());
        let mut scores = Vec::new();
        for (index, c) in row.iter().enumerate() {
            let peers: Vec<_> = row
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != index)
                .map(|(_, c)| c)
                .collect();
            let peer_contrast = peers.iter().map(|c| c.3.contrast).fold(0., f64::max);
            let peer_line = peers.iter().map(|c| c.3.underline).fold(0., f64::max);
            let color = if chroma(c.3.foreground) > 35. {
                distance(c.3.foreground, foreground) / 50.
            } else {
                0.
            };
            let brightness = if c.3.contrast > peer_contrast * 1.35 {
                (c.3.contrast - peer_contrast) / 45.
            } else {
                0.
            };
            let fill = distance(c.3.background, background) / 35.;
            let underline = if c.3.underline > 0.12 {
                (c.3.underline - peer_line) / 0.12
            } else {
                0.
            };
            scores.push((color.max(brightness).max(fill).max(underline), c));
        }
        scores.sort_by(|a, b| b.0.total_cmp(&a.0));
        let (score, chosen) = scores[0];
        let corroborated = chosen.2 >= 0.5
            && ocr.observations.iter().any(|o| {
                o.confidence >= 0.3
                    && o.r#box[1] < 0.4
                    && (o.r#box[1] - chosen.1[1]).abs() > chosen.1[3] * 1.5
                    && o.text
                        .split_whitespace()
                        .filter_map(canonical)
                        .any(|iv| iv == chosen.0)
            });
        if (chosen.2 >= 0.9 || corroborated)
            && score >= 1.
            && score - scores[1].0 >= 0.7
            && score >= scores[1].0 * 1.5
        {
            winners.insert(chosen.0.clone());
        }
    }
    if winners.len() == 1 {
        winners.into_iter().next()
    } else {
        None
    }
}

/// Indicator names are optional visible evidence; MA/EMA periods are user defaults.
pub fn indicators(ocr: &OcrResult) -> Vec<Value> {
    let mut found = std::collections::BTreeMap::<String, Vec<u32>>::new();
    for o in &ocr.observations {
        if o.confidence < 0.9 {
            continue;
        }
        let text = o.text.to_uppercase();
        for token in text.split_whitespace() {
            let name = ["MACD", "MAVOL", "EMA", "BOLL", "RSI", "KDJ", "MA", "VOL"]
                .into_iter()
                .find(|name| {
                    token.starts_with(name)
                        && token[name.len()..]
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_digit() || "(:：".contains(c))
                });
            let Some(name) = name else {
                continue;
            };
            let rest = &token[name.len()..];
            let args = rest
                .trim_start_matches('(')
                .split([')', ':', '：'])
                .next()
                .unwrap_or("");
            let parameters: Vec<u32> = args
                .split(',')
                .filter_map(|v| v.parse().ok())
                .filter(|v| *v > 0 && *v <= 10000)
                .collect();
            let entry = found.entry(name.to_owned()).or_default();
            if entry.is_empty() || name == "MA" || name == "EMA" || name == "MAVOL" {
                entry.extend(parameters);
            }
        }
        if o.text.contains("持仓量") {
            found.entry("持仓量".into()).or_default();
        }
    }
    found.into_iter().map(|(name,mut parameters)| {
        if matches!(name.as_str(),"MA"|"EMA"|"MAVOL") {parameters.sort();parameters.dedup();}
        let parameter_source = match name.as_str() {
            "MA" => { parameters = vec![30, 120, 256]; "user_default" },
            "EMA" => { parameters = vec![12, 144, 169]; "user_default" },
            _ => "visible_text",
        };
        json!({"name":name,"parameters":parameters,"source":"visible_text","parameter_source":parameter_source})
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::ocr::Observation;
    use image::Rgb;

    fn ocr(items: &[&str]) -> OcrResult {
        OcrResult {
            model_id: "fixture".into(),
            revision: 3,
            system_version: "test".into(),
            observations: items
                .iter()
                .enumerate()
                .map(|(i, text)| Observation {
                    text: text.to_string(),
                    confidence: 1.,
                    r#box: [0.05 + i as f64 * 0.18, 0.1, 0.12, 0.04],
                })
                .collect(),
        }
    }
    fn row(
        bg: [u8; 3],
        fg: [u8; 3],
        selected_style: Option<(&str, [u8; 3])>,
        chosen: &[usize],
    ) -> (RgbImage, OcrResult) {
        let mut im = RgbImage::from_pixel(1000, 500, Rgb(bg));
        let reading = ocr(&["15分", "30分", "1时", "4时", "1日"]);
        for (index, o) in reading.observations.iter().enumerate() {
            let x = (o.r#box[0] * 1000.) as u32;
            let mut color = fg;
            if chosen.contains(&index)
                && let Some((kind, tint)) = selected_style
            {
                if kind == "fill" {
                    for py in 45..75 {
                        for px in x..x + 120 {
                            im.put_pixel(px, py, Rgb(tint));
                        }
                    }
                }
                if kind == "foreground" {
                    color = tint;
                }
                if kind == "underline" {
                    for py in 76..80 {
                        for px in x..x + 120 {
                            im.put_pixel(px, py, Rgb(tint));
                        }
                    }
                }
            }
            // Sparse glyph strokes with the supplied style, not solid label rectangles.
            for px in x..x + 120 {
                if (px - x) % 12 < 4 {
                    for py in 50..70 {
                        im.put_pixel(px, py, Rgb(color));
                    }
                }
            }
        }
        (im, reading)
    }
    #[test]
    fn localized_labels_keep_months_distinct_from_minutes() {
        for (text, expected) in [
            ("1时", "1h"),
            ("4 小时", "4h"),
            ("30分", "30m"),
            ("1月", "1M"),
            ("1M", "1M"),
            ("1D", "1d"),
        ] {
            assert_eq!(canonical(text).as_deref(), Some(expected));
        }
        for text in ["d", "w", "1时更多", "999h", "MA30", "15J"] {
            assert!(canonical(text).is_none());
        }
    }
    #[test]
    fn relative_style_handles_light_dark_brightness_background_and_underline() {
        for (bg, fg, kind, tint) in [
            (
                [250, 250, 250],
                [130, 130, 130],
                "foreground",
                [20, 105, 235],
            ),
            ([20, 20, 20], [130, 130, 130], "foreground", [245, 195, 20]),
            ([20, 20, 20], [100, 100, 100], "foreground", [250, 250, 250]),
            ([250, 250, 250], [130, 130, 130], "fill", [180, 210, 245]),
            ([20, 20, 20], [130, 130, 130], "underline", [230, 190, 20]),
        ] {
            let (im, reading) = row(bg, fg, Some((kind, tint)), &[2]);
            assert_eq!(
                selected(&im, &reading).as_deref(),
                Some("1h"),
                "{kind} {bg:?}"
            );
        }
    }
    #[test]
    fn ambiguity_and_low_confidence_are_not_guessed() {
        for choices in [vec![], vec![1, 2]] {
            let (im, reading) = row(
                [250, 250, 250],
                [130, 130, 130],
                Some(("foreground", [20, 105, 235])),
                &choices,
            );
            assert_eq!(selected(&im, &reading), None);
        }
        let (im, mut reading) = row(
            [250, 250, 250],
            [130, 130, 130],
            Some(("foreground", [20, 105, 235])),
            &[2],
        );
        reading.observations[2].confidence = 0.3;
        assert_eq!(selected(&im, &reading), None);
        reading.observations.push(Observation {
            text: "1时".into(),
            confidence: 1.,
            r#box: reading.observations[2].r#box,
        });
        assert_eq!(selected(&im, &reading).as_deref(), Some("1h"));
    }
    #[test]
    fn indicator_names_are_optional_and_ma_ema_use_requested_defaults() {
        let mut reading = ocr(&[
            "MA7:12 MA25:15 MA99:18",
            "EMA(5,20)",
            "MACD(10,30,9)",
            "MAVOL5:100",
            "MAGIC",
            "RSI(14)",
        ]);
        reading.observations[5].confidence = 0.3;
        let found = indicators(&reading);
        assert_eq!(
            found
                .iter()
                .map(|v| v["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["EMA", "MA", "MACD", "MAVOL"]
        );
        assert_eq!(found[0]["parameters"], json!([12, 144, 169]));
        assert_eq!(found[1]["parameters"], json!([30, 120, 256]));
        assert_eq!(found[1]["parameter_source"], "user_default");
        assert_eq!(found[2]["parameters"], json!([10, 30, 9]));
        assert!(indicators(&ocr(&["unknown", "价格:100"])).is_empty());
    }
    #[test]
    #[ignore = "requires explicitly supplied local screenshot and OCR fixture"]
    fn supplied_screenshot_has_selected_hour_and_ma_defaults() {
        let image_path = std::env::var("SCOREBOOK_TOOLBAR_IMAGE").unwrap();
        let ocr_path = std::env::var("SCOREBOOK_TOOLBAR_OCR").unwrap();
        let im = image::open(image_path).unwrap().to_rgb8();
        let reading: OcrResult = serde_json::from_slice(&std::fs::read(ocr_path).unwrap()).unwrap();
        assert_eq!(selected(&im, &reading).as_deref(), Some("1h"));
        let found = indicators(&reading);
        assert!(
            found
                .iter()
                .any(|v| v["name"] == "MA" && v["parameters"] == json!([30, 120, 256]))
        );
        println!("selected=1h; indicators={}", json!(found));
    }
}

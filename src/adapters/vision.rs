//! Local image processing. Deterministic profile is a baseline, not semantic understanding.
use crate::{
    application::dto::Region,
    error::{Error, Result},
};
use image::{DynamicImage, GenericImageView};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Semaphore;
#[derive(Clone)]
pub struct Vision {
    pub url: Option<String>,
    permits: Arc<Semaphore>,
}
pub struct Features {
    pub vector: Vec<f32>,
    pub quality: Value,
    pub model_id: String,
}
impl Vision {
    pub fn new(url: Option<String>) -> Self {
        Self {
            url,
            permits: Arc::new(Semaphore::new(2)),
        }
    }
    pub async fn extract(
        &self,
        bytes: Vec<u8>,
        region: Option<Region>,
        model_id: &str,
    ) -> Result<Features> {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| Error::bad("vision_stopped"))?;
        let model = model_id.to_string();
        let local_model = model.clone();
        let (im, baseline) =
            tokio::task::spawn_blocking(move || -> Result<(DynamicImage, Option<Features>)> {
                crate::adapters::storage::Storage::inspect(&bytes)?;
                let mut im =
                    image::load_from_memory(&bytes).map_err(|_| Error::bad("invalid_image"))?;
                if let Some(r) = region {
                    let (w, h) = im.dimensions();
                    if r.width < 16
                        || r.height < 16
                        || r.x.checked_add(r.width).is_none_or(|x| x > w)
                        || r.y.checked_add(r.height).is_none_or(|y| y > h)
                    {
                        return Err(Error::bad("invalid_region"));
                    }
                    im = im.crop_imm(r.x, r.y, r.width, r.height);
                }
                let f = if local_model == "candle-profile-v1" {
                    Some(structure(&im)?)
                } else {
                    None
                };
                Ok((im, f))
            })
            .await
            .map_err(|_| Error::bad("image_processing_failed"))??;
        if let Some(f) = baseline {
            return Ok(f);
        }
        if model != "dinov2-small-v1" {
            return Err(Error::bad("unknown_embedding_model"));
        }
        let url = self
            .url
            .as_ref()
            .ok_or_else(|| Error::bad("visual_model_not_configured"))?;
        let endpoint = reqwest::Url::parse(url).map_err(|_| Error::bad("invalid_vision_url"))?;
        if endpoint.scheme() != "http"
            || !matches!(
                endpoint.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]")
            )
        {
            return Err(Error::bad("vision_endpoint_must_be_local"));
        }
        let mut png = std::io::Cursor::new(Vec::new());
        im.write_to(&mut png, image::ImageFormat::Png)
            .map_err(|_| Error::bad("image_encoding_failed"))?;
        let response = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(90))
            .build()
            .map_err(anyhow::Error::from)?
            .post(format!("{url}/embed"))
            .header("content-type", "image/png")
            .body(png.into_inner())
            .send()
            .await
            .map_err(anyhow::Error::from)?
            .error_for_status()
            .map_err(anyhow::Error::from)?;
        let v: Value = response.json().await.map_err(anyhow::Error::from)?;
        let vector: Vec<f32> = serde_json::from_value(v["embedding"].clone())
            .map_err(|_| Error::bad("invalid_model_response"))?;
        if vector.len() != 384
            || vector.iter().any(|x| !x.is_finite())
            || vector.iter().map(|x| x * x).sum::<f32>() < 0.1
            || v["model_id"] != model
        {
            return Err(Error::bad("invalid_model_response"));
        }
        if v["provenance"]["weights_sha256"]
            != "ae1e99fcefd534ed978cdeb8326f08030c96e28b7a81ffcbc98a857c84d14be1"
            || v["provenance"]["preprocessing"] != "letterbox224-bicubic-imagenet-v1"
        {
            return Err(Error::bad("model_version_mismatch"));
        }
        Ok(Features {
            vector,
            quality: v["provenance"].clone(),
            model_id: model,
        })
    }
}
pub fn structure(im: &DynamicImage) -> Result<Features> {
    let rgb = im.to_rgb8();
    let (w, h) = rgb.dimensions();
    if w < 64 || h < 32 {
        return Err(Error::bad("chart_region_too_small"));
    }
    let mut bins = vec![Vec::<f32>::new(); 64];
    let mut pixels = 0usize;
    for (x, y, p) in rgb.enumerate_pixels() {
        let [r, g, b] = p.0;
        let (r, g, b) = (r as f32, g as f32, b as f32);
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        // Both red/green themes; no horizontal/vertical flips or OCR-derived prices.
        if max - min > 45.0
            && max > 65.0
            && ((r > g * 1.25 && r > b * 1.1) || (g > r * 1.15 && g > b * 1.05))
        {
            bins[(x as usize * 64 / w as usize).min(63)].push(1.0 - y as f32 / h as f32);
            pixels += 1;
        }
    }
    let active = bins.iter().filter(|v| v.len() >= 2).count();
    if active < 24 || pixels < 100 {
        return Err(Error::bad(
            "structure_not_detected_crop_chart_or_use_visual_model",
        ));
    }
    let mut centers = vec![None; 64];
    let mut spans = vec![0.0f32; 64];
    for (j, ys) in bins.iter_mut().enumerate() {
        if ys.len() >= 2 {
            ys.sort_by(|a, b| a.total_cmp(b));
            let lo = ys[ys.len() / 10];
            let hi = ys[ys.len() * 9 / 10];
            centers[j] = Some((hi + lo) / 2.0);
            spans[j] = hi - lo;
        }
    }
    for j in 0..64 {
        if centers[j].is_none() {
            let l = (0..j).rev().find_map(|k| centers[k].map(|v| (k, v)));
            let r = (j + 1..64).find_map(|k| centers[k].map(|v| (k, v)));
            centers[j] = Some(match (l, r) {
                (Some((a, x)), Some((b, y))) => x + (y - x) * (j - a) as f32 / (b - a) as f32,
                (Some((_, x)), _) => x,
                (_, Some((_, y))) => y,
                _ => 0.0,
            });
        }
    }
    let centers: Vec<f32> = centers.into_iter().map(Option::unwrap).collect();
    let mean = centers.iter().sum::<f32>() / 64.0;
    let scale = (centers.iter().map(|v| (v - mean).powi(2)).sum::<f32>() / 64.0)
        .sqrt()
        .max(0.025);
    let mut vector = Vec::with_capacity(192);
    for j in 0..64 {
        vector.push((centers[j] - mean) / scale);
        vector.push(spans[j] / scale * 0.25);
        vector.push(if j > 0 {
            (centers[j] - centers[j - 1]) / scale * 2.0
        } else {
            0.0
        });
    }
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm < 1e-6 {
        return Err(Error::bad("structure_not_detected"));
    }
    for v in &mut vector {
        *v /= norm
    }
    Ok(Features {
        vector,
        model_id: "candle-profile-v1".into(),
        quality: json!({"kind":"deterministic_structure_baseline","active_bins":active,"colored_pixels":pixels,"semantic_accuracy":"not_validated","crop_recommended":true,"prices_inferred":false}),
    })
}

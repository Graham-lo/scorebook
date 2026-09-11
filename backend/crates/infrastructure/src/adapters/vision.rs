//! Bounded image processing; all selected models have explicit identities.
use crate::{
    application::dto::Region,
    error::{Error, Result},
};
use image::{DynamicImage, GenericImageView};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
#[derive(Clone)]
pub struct Vision {
    pub url: Option<String>,
    permits: Arc<Semaphore>,
    client: reqwest::Client,
    flights: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Flight>>>,
}
type FeatureFuture =
    futures_util::future::Shared<futures_util::future::BoxFuture<'static, Result<Features>>>;
#[derive(Clone)]
struct Flight {
    id: uuid::Uuid,
    started: std::time::Instant,
    future: FeatureFuture,
}
#[derive(Clone)]
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
            client: reqwest::Client::new(),
            flights: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }
    pub async fn acquire(&self) -> Result<OwnedSemaphorePermit> {
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.permits.clone().acquire_owned(),
        )
        .await
        .map_err(|_| Error::deferred("image_queue_busy", crate::error::RetryDirective::After(2)))?
        .map_err(|_| Error::transient("vision_stopped"))
    }
    pub async fn singleflight(
        &self,
        key: String,
        work: impl std::future::Future<Output = Result<Features>> + Send + 'static,
    ) -> Result<Features> {
        use futures_util::FutureExt;
        let flight = {
            let mut flights = self.flights.lock().await;
            flights
                .retain(|_, entry| entry.started.elapsed() < std::time::Duration::from_secs(180));
            if flights.len() >= 256 {
                return Err(Error::deferred(
                    "image_queue_busy",
                    crate::error::RetryDirective::After(2),
                ));
            }
            flights
                .entry(key.clone())
                .or_insert_with(|| {
                    // The bounded task keeps running if its HTTP waiter disconnects, so permits cannot be stranded.
                    let task = tokio::spawn(work);
                    Flight {
                        id: uuid::Uuid::new_v4(),
                        started: std::time::Instant::now(),
                        future: async move {
                            task.await
                                .map_err(|_| Error::transient("image_processing_interrupted"))?
                        }
                        .boxed()
                        .shared(),
                    }
                })
                .clone()
        };
        let result = flight.future.await;
        let mut flights = self.flights.lock().await;
        if flights.get(&key).is_some_and(|v| v.id == flight.id) {
            flights.remove(&key);
        }
        result
    }
    pub async fn stream_extract(
        &self,
        reader: scorebook_core::ports::ImageReader,
        region: Option<Region>,
        model: &str,
        expected_sha256: &str,
    ) -> Result<Features> {
        use tokio::io::AsyncReadExt;
        let _permit = self.acquire().await?;
        let mut bytes = Vec::new();
        reader
            .take(20 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err(Error::bad("image_too_large"));
        }
        if crate::adapters::db::hash_bytes(&bytes) != expected_sha256 {
            return Err(Error::bad("attachment_integrity_failure"));
        }
        self.decode_and_extract(bytes, region, model).await
    }
    pub async fn extract(
        &self,
        bytes: Vec<u8>,
        region: Option<Region>,
        model: &str,
    ) -> Result<Features> {
        let _permit = self.acquire().await?;
        self.decode_and_extract(bytes, region, model).await
    }
    async fn decode_and_extract(
        &self,
        bytes: Vec<u8>,
        region: Option<Region>,
        model: &str,
    ) -> Result<Features> {
        let im = tokio::task::spawn_blocking(move || -> Result<DynamicImage> {
            let (mut im, _) = crate::adapters::storage::Storage::decode(&bytes)?;
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
            Ok(im)
        })
        .await
        .map_err(|_| Error::bad("image_processing_failed"))??;
        self.images(vec![im], model)
            .await?
            .pop()
            .ok_or_else(|| Error::transient("invalid_model_response"))
    }
    pub async fn extract_batch(
        &self,
        images: Vec<DynamicImage>,
        model: &str,
    ) -> Result<Vec<Features>> {
        let _permit = self.acquire().await?;
        if images.is_empty() || images.len() > 8 {
            return Err(Error::bad("invalid_image_batch_size"));
        }
        self.images(images, model).await
    }
    async fn images(&self, images: Vec<DynamicImage>, model: &str) -> Result<Vec<Features>> {
        if model == "candle-geometry-v2" {
            return tokio::task::spawn_blocking(move || {
                images
                    .iter()
                    .map(|im| {
                        let geometry =
                            scorebook_core::domain::chart_match::detect(im, None, false)?;
                        Ok(Features {
                            vector: scorebook_core::domain::chart_match::descriptor(
                                &geometry.candles,
                            )?,
                            quality: json!(geometry.quality),
                            model_id: model_v2(),
                        })
                    })
                    .collect()
            })
            .await
            .map_err(|_| Error::bad("image_processing_failed"))?;
        }
        if model != "dinov2-small-v1" {
            return Err(Error::bad("unknown_embedding_model"));
        }
        let url = self.url.as_ref().ok_or_else(|| {
            Error::deferred(
                "visual_model_not_configured",
                crate::error::RetryDirective::AwaitCapability,
            )
        })?;
        let endpoint = reqwest::Url::parse(url).map_err(|_| Error::bad("invalid_vision_url"))?;
        if endpoint.scheme() != "http"
            || !matches!(
                endpoint.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]")
            )
        {
            return Err(Error::bad("vision_endpoint_must_be_local"));
        }
        let count = images.len();
        let payload = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            let mut payload = Vec::new();
            payload.extend_from_slice(&(images.len() as u32).to_be_bytes());
            for im in images {
                let mut png = std::io::Cursor::new(Vec::new());
                im.write_to(&mut png, image::ImageFormat::Png)
                    .map_err(|_| Error::bad("image_encoding_failed"))?;
                let png = png.into_inner();
                payload.extend_from_slice(&(png.len() as u32).to_be_bytes());
                payload.extend_from_slice(&png);
                if payload.len() > 32 * 1024 * 1024 {
                    return Err(Error::bad("image_batch_too_large"));
                }
            }
            Ok(payload)
        })
        .await
        .map_err(|_| Error::bad("image_encoding_failed"))??;
        let response = self
            .client
            .post(format!("{url}/embed-batch"))
            .timeout(std::time::Duration::from_secs(90))
            .header("content-type", "application/octet-stream")
            .body(payload)
            .send()
            .await
            .map_err(anyhow::Error::from)?
            .error_for_status()
            .map_err(anyhow::Error::from)?;
        let v: Value = response.json().await.map_err(anyhow::Error::from)?;
        let values = v["features"]
            .as_array()
            .filter(|a| a.len() == count)
            .ok_or_else(|| Error::transient("invalid_model_response"))?;
        values
            .iter()
            .map(|v| {
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
                    model_id: model.into(),
                })
            })
            .collect()
    }
}

fn model_v2() -> String {
    scorebook_core::domain::chart_match::MODEL.into()
}

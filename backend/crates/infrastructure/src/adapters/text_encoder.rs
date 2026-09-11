use scorebook_core::{
    error::{Error, RetryDirective},
    knowledge_index::{MODEL, TextEncoder, TextEncoding, WEIGHTS},
    ports::AppFuture,
};
use serde_json::{Value, json};
#[derive(Clone)]
pub struct LocalTextEncoder {
    url: Option<String>,
    client: reqwest::Client,
}
impl LocalTextEncoder {
    pub fn new() -> anyhow::Result<Self> {
        let url = std::env::var("SCOREBOOK_TEXT_ENCODER_URL").ok();
        if let Some(v) = &url {
            let u = reqwest::Url::parse(v)?;
            anyhow::ensure!(
                u.scheme() == "http"
                    && u.host_str() == Some("127.0.0.1")
                    && u.username().is_empty()
                    && u.password().is_none()
                    && u.query().is_none(),
                "text_encoder_must_be_loopback"
            );
        }
        Ok(Self {
            url,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
}
impl TextEncoder for LocalTextEncoder {
    fn configured(&self) -> bool {
        self.url.is_some()
    }
    fn encode(&self, texts: Vec<String>) -> AppFuture<'_, TextEncoding> {
        Box::pin(async move {
            let url = self.url.as_ref().ok_or_else(|| {
                Error::deferred(
                    "text_encoder_not_configured",
                    RetryDirective::AwaitCapability,
                )
            })?;
            if texts.is_empty() || texts.len() > 4 {
                return Err(Error::bad("text_batch_limit"));
            }
            let response = self
                .client
                .post(format!("{}/embed", url.trim_end_matches('/')))
                .json(&json!({"texts":texts}))
                .send()
                .await
                .map_err(|_| Error::transient("text_encoder_unavailable"))?;
            if !response.status().is_success() {
                return Err(Error::transient("text_encoder_request_failed"));
            }
            let mut response = response;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| Error::transient("text_encoder_read_failed"))?
            {
                if bytes.len() + chunk.len() > 256 * 1024 {
                    return Err(Error::bad("text_encoder_response_too_large"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let v: Value = serde_json::from_slice(&bytes)
                .map_err(|_| Error::bad("invalid_text_encoder_response"))?;
            if v["provenance"]["model_id"] != MODEL
                || v["provenance"]["weights_sha256"] != WEIGHTS
                || v["provenance"]["pooling"] != "cls-l2"
                || v["provenance"]["precision"] != "float32"
            {
                return Err(Error::deferred(
                    "text_encoder_identity_mismatch",
                    RetryDirective::AwaitCapability,
                ));
            }
            let vectors: Vec<Vec<f32>> = serde_json::from_value(v["embeddings"].clone())
                .map_err(|_| Error::bad("invalid_text_vectors"))?;
            if vectors.len() != texts.len()
                || vectors.iter().any(|v| {
                    v.len() != 1024
                        || v.iter().any(|x| !x.is_finite())
                        || (v.iter().map(|x| x * x).sum::<f32>() - 1.).abs() > 0.01
                })
            {
                return Err(Error::bad("invalid_text_vector_norm"));
            }
            Ok(TextEncoding {
                model_id: MODEL.into(),
                weights_sha256: WEIGHTS.into(),
                vectors,
            })
        })
    }
}

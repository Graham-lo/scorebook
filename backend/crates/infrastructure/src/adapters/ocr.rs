//! Explicit local OCR process; image bytes use stdin and never a temporary file.
use crate::error::{Error, Result, RetryDirective};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub text: String,
    pub confidence: f32,
    pub r#box: [f64; 4],
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OcrResult {
    pub model_id: String,
    pub revision: i64,
    pub system_version: String,
    pub observations: Vec<Observation>,
}
pub async fn recognize(bytes: Vec<u8>) -> Result<OcrResult> {
    let path = std::env::var("SCOREBOOK_OCR_EXECUTABLE")
        .map_err(|_| Error::deferred("ocr_not_configured", RetryDirective::AwaitCapability))?;
    if !std::path::Path::new(&path).is_absolute() {
        return Err(Error::bad("ocr_path_must_be_absolute"));
    }
    let mut child = tokio::process::Command::new(path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            Error::deferred(
                "ocr_executable_unavailable",
                RetryDirective::AwaitCapability,
            )
        })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::transient("ocr_stdin_unavailable"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::transient("ocr_stdout_unavailable"))?;
    let task = async {
        let write = async move {
            stdin.write_all(&bytes).await?;
            stdin.shutdown().await?;
            drop(stdin); // ChildStdin shutdown does not close the pipe; OCR waits for EOF.
            Ok::<_, std::io::Error>(())
        };
        let read = async {
            let mut result = Vec::new();
            (&mut stdout)
                .take(128 * 1024 + 1)
                .read_to_end(&mut result)
                .await?;
            Ok::<_, std::io::Error>(result)
        };
        let (_, output) = tokio::try_join!(write, read)?;
        if output.len() > 128 * 1024 {
            return Err(Error::bad("ocr_response_too_large"));
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(Error::bad("ocr_failed"));
        }
        let result: OcrResult =
            serde_json::from_slice(&output).map_err(|_| Error::bad("invalid_ocr_response"))?;
        let expected = if cfg!(target_os = "macos") {
            ("apple-vision-text-r3", 3)
        } else {
            ("tesseract-5-eng-v1", 1)
        };
        if result.model_id != expected.0
            || result.revision != expected.1
            || result.observations.len() > 256
        {
            return Err(Error::bad("ocr_model_version_mismatch"));
        }
        Ok(result)
    };
    tokio::time::timeout(std::time::Duration::from_secs(25), task)
        .await
        .map_err(|_| Error::transient("ocr_timeout"))?
}

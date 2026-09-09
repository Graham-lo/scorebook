use crate::{error::Result, ports::AppFuture};
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct TextEncoding {
    pub model_id: String,
    pub weights_sha256: String,
    pub vectors: Vec<Vec<f32>>,
}
pub trait TextEncoder: Send + Sync {
    fn encode(&self, texts: Vec<String>) -> AppFuture<'_, TextEncoding>;
}
pub const MODEL: &str = "bge-m3-dense-v1";
pub const WEIGHTS: &str = "b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38";
/// Byte-bounded chunks preserve exact offsets, with overlap, without silently
/// truncating a document to the encoder context window.
pub fn chunks(text: &str) -> Result<Vec<(usize, usize, String)>> {
    if text.len() > 4_000_000 {
        return Err(crate::error::Error::bad("knowledge_document_too_large"));
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + 480).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        out.push((start, end, text[start..end].into()));
        if end == text.len() {
            break;
        }
        start = end.saturating_sub(96);
        while !text.is_char_boundary(start) {
            start += 1;
        }
    }
    Ok(out)
}

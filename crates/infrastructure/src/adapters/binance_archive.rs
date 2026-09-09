//! Official public archives. Compressed bytes are bounded RAM; ZIP entries are
//! streamed through CSV readers. Never extract/spool raw market data to a path.
use crate::{
    adapters::db::hash_bytes,
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Utc};
use scorebook_core::domain::criteria::Bar;
use serde::{Deserialize, Serialize};
use std::io::Read;
#[derive(Clone)]
pub struct BinanceArchive {
    trade_slots: std::sync::Arc<tokio::sync::Semaphore>,
    client: reqwest::Client,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Listing {
    #[serde(default)]
    pub is_truncated: bool,
    pub next_marker: Option<String>,
    #[serde(default)]
    pub common_prefixes: Vec<Prefix>,
    #[serde(default)]
    pub contents: Vec<Object>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Prefix {
    pub prefix: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct Object {
    pub key: String,
    pub size: u64,
}
pub struct ArchiveBars {
    pub bars: Vec<Bar>,
    pub source_key: String,
    pub sha256: String,
    pub size_bytes: u64,
}
impl BinanceArchive {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            trade_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
        })
    }
    pub async fn list(&self, prefix: &str, marker: Option<&str>) -> Result<Listing> {
        validate_key(prefix)?;
        if marker.is_some_and(|v| !v.starts_with(prefix) || v.len() > 300) {
            return Err(Error::bad("invalid_archive_cursor"));
        }
        let response = self
            .client
            .get("https://s3-ap-northeast-1.amazonaws.com/data.binance.vision")
            .query(&[
                ("delimiter", "/"),
                ("prefix", prefix),
                ("marker", marker.unwrap_or("")),
                ("max-keys", "1000"),
            ])
            .send()
            .await
            .map_err(|_| Error::transient("archive_catalog_unavailable"))?;
        let bytes = bounded(response, 2 * 1024 * 1024).await?;
        let list: Listing = quick_xml::de::from_reader(bytes.as_slice())
            .map_err(|_| Error::bad("invalid_archive_catalog"))?;
        if list.is_truncated
            && list
                .next_marker
                .as_deref()
                .is_none_or(|v| Some(v) == marker)
        {
            return Err(Error::bad("archive_cursor_not_advancing"));
        }
        Ok(list)
    }
    pub async fn klines(
        &self,
        key: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<ArchiveBars> {
        validate_key(key)?;
        if !key.ends_with(".zip") || !key.contains("/klines/") {
            return Err(Error::bad("invalid_kline_archive"));
        }
        let checksum = self
            .client
            .get(format!("https://data.binance.vision/{key}.CHECKSUM"))
            .send()
            .await
            .map_err(|_| Error::transient("archive_checksum_unavailable"))?;
        let checksum = bounded(checksum, 1024).await?;
        let checksum =
            std::str::from_utf8(&checksum).map_err(|_| Error::bad("invalid_archive_checksum"))?;
        let mut parts = checksum.split_whitespace();
        let hash = parts
            .next()
            .ok_or_else(|| Error::bad("invalid_archive_checksum"))?;
        if hash.len() != 64
            || !hash.chars().all(|v| v.is_ascii_hexdigit())
            || parts.next().map(|s| s.trim_start_matches('*')) != key.rsplit('/').next()
        {
            return Err(Error::bad("invalid_archive_checksum"));
        }
        let response = self
            .client
            .get(format!("https://data.binance.vision/{key}"))
            .send()
            .await
            .map_err(|_| Error::transient("archive_download_unavailable"))?;
        let bytes = bounded(response, 64 * 1024 * 1024).await?;
        let size_bytes = bytes.len() as u64;
        if hash_bytes(&bytes) != hash {
            return Err(Error::transient("archive_checksum_mismatch"));
        }
        let sha256 = hash.into();
        let source_key = key.into();
        let bars = tokio::task::spawn_blocking(move || parse_klines(bytes, start, end))
            .await
            .map_err(|_| Error::transient("archive_decode_interrupted"))??;
        Ok(ArchiveBars {
            bars,
            source_key,
            sha256,
            size_bytes,
        })
    }
}
fn validate_key(key: &str) -> Result<()> {
    if key.len() > 300
        || !(key.starts_with("data/futures/um/") || key.starts_with("data/futures/cm/"))
        || key.contains("..")
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-/ .".contains(c))
        || key.contains(' ')
    {
        return Err(Error::bad("invalid_archive_key"));
    }
    Ok(())
}
async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response.status().as_u16() == 404 {
        return Err(Error::deferred(
            "archive_not_available",
            RetryDirective::AwaitInput,
        ));
    }
    if !response.status().is_success() {
        return Err(Error::transient("archive_source_unavailable"));
    }
    if response.content_length().is_some_and(|v| v > limit as u64) {
        return Err(Error::bad("archive_memory_budget_exceeded"));
    }
    let started = std::time::Instant::now();
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::transient("archive_download_interrupted"))?
    {
        if data.len() + chunk.len() > limit {
            return Err(Error::bad("archive_memory_budget_exceeded"));
        }
        data.extend_from_slice(&chunk);
        let expected = std::time::Duration::from_secs_f64(data.len() as f64 / (2. * 1024. * 1024.));
        if expected > started.elapsed() {
            tokio::time::sleep(expected - started.elapsed()).await;
        }
    }
    Ok(data)
}
pub fn parse_klines(bytes: Vec<u8>, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<Vec<Bar>> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| Error::bad("invalid_archive_zip"))?;
    if archive.len() != 1 {
        return Err(Error::bad("unexpected_archive_entries"));
    }
    let entry = archive
        .by_index(0)
        .map_err(|_| Error::bad("invalid_archive_entry"))?;
    if !entry.name().ends_with(".csv") || entry.size() > 128 * 1024 * 1024 {
        return Err(Error::bad("archive_uncompressed_budget_exceeded"));
    }
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(entry.take(128 * 1024 * 1024 + 1));
    let mut bars = Vec::new();
    let mut previous = None;
    for (index, row) in reader.records().enumerate() {
        let r = row.map_err(|_| Error::bad("invalid_archive_csv"))?;
        if r.len() < 7 || r.as_slice().len() > 2048 {
            return Err(Error::bad("invalid_archive_row"));
        }
        if index == 0 && matches!(r.get(0), Some("open_time" | "openTime")) {
            continue;
        }
        let time = |i: usize| {
            r.get(i)
                .and_then(|v| v.parse::<i64>().ok())
                .and_then(DateTime::from_timestamp_millis)
                .ok_or_else(|| Error::bad("invalid_archive_timestamp"))
        };
        let at = time(0)?;
        let to = time(6)? + chrono::Duration::milliseconds(1);
        if previous.is_some_and(|v| at <= v) || at >= to {
            return Err(Error::bad("archive_timestamp_order"));
        }
        previous = Some(at);
        if at < start || to > end {
            continue;
        }
        for i in 1..=4 {
            scorebook_core::domain::criteria::dec(&r[i]).map_err(Error::bad)?;
        }
        bars.push(Bar {
            start: at,
            end: to,
            open: r[1].into(),
            high: r[2].into(),
            low: r[3].into(),
            close: r[4].into(),
        });
        if bars.len() > 50000 {
            return Err(Error::bad("archive_bar_budget_exceeded"));
        }
    }
    Ok(bars)
}

mod trades;

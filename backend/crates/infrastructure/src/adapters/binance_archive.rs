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
/// 同时在飞的 kline 月档下载数的唯一上限。
///
/// 为什么是「唯一」：在这之前没有任何一层拦着 `klines()`，实际并发是「分组并发 ×
/// 每组月份数 × 交互队列并发」乘出来的一个没人算过的积（按图找精排一次就能凑出
/// 六路分组 × 九个月 = 54 路同时在飞）。现在这个数字说了算，上面各层怎么排都只是
/// 在这个信号量前面排队。
///
/// 为什么是 24 而不是更小：实测单个月档只有 2–11 KB（1d 月档 2159 字节、4h 月档
/// 10812 字节），curl 量到 `ttfb` 约等于 `total`（0.32–0.48 秒），时间全是一次 HTTPS
/// 往返，传输量可以忽略。所以这个数管的是对 data.binance.vision 的礼貌和本地 socket
/// 压力，不是内存；`bounded(response, 64 * 1024 * 1024)` 那个天花板仍然留着当安全网。
///
/// 注意 `application/history_catalog/universe.rs` 的扇出建索引也直接调 `klines()`，
/// 它会跟着一起受这个信号量约束——这是故意的，不是漏了：建索引和交互检索抢的是
/// 同一个对象存储，总量该由同一个数字兜住。
const KLINE_SLOTS: usize = 24;
/// 单个月档最多尝试几次（即最多两次重试）。
///
/// 为什么要有这一层：没有它的时候，793 个文件里任意一个在传输层打嗝，`Error::transient`
/// 就让**整个作业**退避重跑，另外 792 个文件跟着重下一遍——粒度完全不对。冷启动实测
/// 一次 108 个文件的检索里有 2 个卡在连接阶段，代价是整个作业多花 30 秒重来。这一层
/// 只是替作业层挡掉单个文件的抖动；重试耗尽之后仍然原样抛出原来的错误码，作业层的
/// 退避一点没变。
const KLINE_ATTEMPTS: u32 = 3;
/// 单个月档失败之后值不值得就地再试一次。
///
/// 这是一张**白名单**：只有传输层没把字节送到的那几种才重试，没列进来的一律直接抛。
/// 两把锁是故意叠的——除了对上码表，还要求 `retry` 是可重试的那一档，这样以后谁用
/// 这几个码造了个 `Error::bad`（`RetryDirective::Never`）也不会被误当成抖动。
///
/// 绝不重试的两类，写清楚免得以后被人「顺手补全」：
/// - `archive_not_available`：404，上游本来就没有这个月。`universe.rs` 的扇出天天遇到
///   （200 个合约 × 上市之前的月份），重试等于把上游不存在的月份每个都打三遍。它的
///   `RetryDirective::AwaitInput` 也已经说明了这不是抖动。
/// - `archive_checksum_mismatch`：字节到了但对不上账。再下一次只会再错一次，而且真要
///   是上游数据坏了，安静地重试正是最不该做的事。
fn worth_retrying(e: &Error) -> bool {
    e.retry.retryable()
        && matches!(
            e.code.as_str(),
            "archive_checksum_unavailable"
                | "archive_download_unavailable"
                | "archive_download_interrupted"
                | "archive_source_unavailable"
        )
}
/// 第 `attempt` 次失败之后等多久：200ms、600ms 这个量级，外加 0–50% 的抖动错开同时
/// 醒来的那一批。刻意不用秒级——整件事省下来的就是这点往返时间。
///
/// 为什么要把 0 也接住：`attempt` 是 `u32`，`attempt - 1` 在 0 上就是下溢，debug 下
/// 当场 panic。今天没有调用方传 0（`klines()` 的循环从 1 起），但这是个私有纯函数，
/// 它唯一的保护就是调用点的那条约定，而约定没有写进类型里，迟早会被下一个调用点
/// 破坏。与其让一次退避计算成为崩溃点，不如 `clamp(1, 4)` 把两头都夹住：0 和 1 一样
/// 等最短的那一档。
fn retry_backoff(attempt: u32) -> std::time::Duration {
    let base = 200 * 3u64.pow(attempt.clamp(1, 4) - 1);
    std::time::Duration::from_millis(base + rand::random_range(0..base / 2))
}
#[derive(Clone)]
pub struct BinanceArchive {
    trade_slots: std::sync::Arc<tokio::sync::Semaphore>,
    kline_slots: std::sync::Arc<tokio::sync::Semaphore>,
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
            kline_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(KLINE_SLOTS)),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(180))
                // 整体那 180 秒是留给大文件慢传的；连接阶段用不着那么宽。月档只有
                // 2–11 KB，连接谈到十秒以上就只可能是连接根本建不起来——冷池上实测
                // 见过卡满 62–66 秒才报错的请求，早失败比那样晾着强得多。
                .connect_timeout(std::time::Duration::from_secs(10))
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
        // 一个月档的「两次 GET + 校验 + 解析」整段都占着一个槽，见 `KLINE_SLOTS`。
        // 重试也在槽里完成：放掉再抢的话，重试会排到队尾，等的比重下一次还久。
        let _slot = self
            .kline_slots
            .acquire()
            .await
            .map_err(|_| Error::transient("archive_pool_closed"))?;
        let mut attempt = 1;
        loop {
            let error = match self.download_klines(key, start, end).await {
                Ok(v) => return Ok(v),
                Err(e) => e,
            };
            if attempt >= KLINE_ATTEMPTS || !worth_retrying(&error) {
                return Err(error);
            }
            tokio::time::sleep(retry_backoff(attempt)).await;
            attempt += 1;
        }
    }
    /// 单个月档的一次尝试：两次 GET、校验、解析。调用方负责槽和重试。
    async fn download_klines(
        &self,
        key: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<ArchiveBars> {
        // `.CHECKSUM` 和 zip 同时发：两边都只是一次 HTTPS 往返（文件 2–11 KB，传输量
        // 可以忽略），串着发等于白等一整个往返。校验语义一点没松——`try_join!` 在
        // checksum 那一路出错时会直接丢掉 zip 那一路的结果，拿不到校验和就什么都不用。
        let (checksum, bytes) = tokio::try_join!(
            async {
                let response = self
                    .client
                    .get(format!("https://data.binance.vision/{key}.CHECKSUM"))
                    .send()
                    .await
                    .map_err(|_| Error::transient("archive_checksum_unavailable"))?;
                bounded(response, 1024).await
            },
            async {
                let response = self
                    .client
                    .get(format!("https://data.binance.vision/{key}"))
                    .send()
                    .await
                    .map_err(|_| Error::transient("archive_download_unavailable"))?;
                bounded(response, 64 * 1024 * 1024).await
            },
        )?;
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
        || !key.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || "_-/ .".contains(c)
                || scorebook_core::domain::instrument::symbol_character(c)
        })
        || key.contains(' ')
    {
        return Err(Error::bad("invalid_archive_key"));
    }
    Ok(())
}

#[cfg(test)]
mod retry_tests {
    use super::{KLINE_ATTEMPTS, retry_backoff, worth_retrying};
    use crate::error::{Error, RetryDirective};
    /// 这张表就是这一层的全部语义，也是最容易在以后被人「顺手补全」的地方。写死它。
    #[test]
    fn only_transport_hiccups_are_retried_and_a_missing_month_never_is() {
        for code in [
            "archive_checksum_unavailable",
            "archive_download_unavailable",
            "archive_download_interrupted",
            "archive_source_unavailable",
        ] {
            assert!(worth_retrying(&Error::transient(code)), "{code}");
        }
        // 404。`universe.rs` 的扇出天天遇到（200 个合约 × 上市之前的月份），一旦重试
        // 就是把上游本来就不存在的月份每个都打三遍。下面两条守的是不同的锁，不是
        // 同一件事写了两遍：
        // 这一条只让**码表**说话——`transient` 本身是能过 `retryable()` 那一关的，所以
        // 它把「有人顺手把 404 补进白名单」单独钉死；不写它的话，白名单里多出一个
        // `archive_not_available` 这整张表一声不吭。
        assert!(!worth_retrying(&Error::transient("archive_not_available")));
        // 这一条守的是另一头：今天 `bounded()` 给 404 配的就是 `AwaitInput`，而
        // `AwaitInput` 自己就过不了 `retryable()`。两把锁叠着，任一把还在 404 就重试
        // 不了。
        assert!(!worth_retrying(&Error::deferred(
            "archive_not_available",
            RetryDirective::AwaitInput
        )));
        // 字节到了但对不上账，再下一次也还是对不上。
        assert!(!worth_retrying(&Error::transient(
            "archive_checksum_mismatch"
        )));
        // 白名单之外的传输类错误也不重试：没列进来就是没想过。
        assert!(!worth_retrying(&Error::transient("archive_pool_closed")));
        assert!(!worth_retrying(&Error::transient(
            "archive_decode_interrupted"
        )));
        // 第二把锁：即便有人拿白名单上的码造了个 `Error::bad`，也不会被当成抖动。
        for code in [
            "archive_source_unavailable",
            "archive_memory_budget_exceeded",
            "invalid_archive_checksum",
        ] {
            assert!(!worth_retrying(&Error::bad(code)), "{code}");
        }
    }
    /// 退避必须是毫秒量级：这整件事省下来的就是这点往返时间，秒级退避会把它还回去。
    /// 从 0 起而不是从 1 起是故意的：调用点今天从 1 开始，但 `retry_backoff` 自己得能
    /// 接住 0，不然 `u32` 下溢会把一次退避计算变成 panic。
    #[test]
    fn backoff_stays_in_the_hundreds_of_milliseconds() {
        for attempt in 0..KLINE_ATTEMPTS {
            let wait = retry_backoff(attempt);
            assert!(wait >= std::time::Duration::from_millis(200), "{attempt}");
            assert!(wait < std::time::Duration::from_millis(900), "{attempt}");
        }
    }
}
#[cfg(test)]
mod key_tests {
    use super::validate_key;
    #[test]
    fn unicode_archive_identifiers_do_not_allow_path_or_url_injection() {
        assert!(
            validate_key(
                "data/futures/um/monthly/klines/币安人生USDT/1h/币安人生USDT-1h-2026-08.zip"
            )
            .is_ok()
        );
        for key in [
            "data/futures/um/../secret",
            "data/futures/um/币安%2FUSDT",
            "data/futures/um/币安?x=1",
            "https://example.com/data/futures/um/",
        ] {
            assert!(validate_key(key).is_err());
        }
    }
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
        if let Some(wait) = super::throttle(data.len(), 2. * 1024. * 1024., started.elapsed()) {
            tokio::time::sleep(wait).await;
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
        for i in 1..=5 {
            scorebook_core::domain::criteria::dec(&r[i]).map_err(Error::bad)?;
        }
        bars.push(Bar {
            start: at,
            end: to,
            open: r[1].into(),
            high: r[2].into(),
            low: r[3].into(),
            close: r[4].into(),
            volume: Some(r[5].into()),
        });
        if bars.len() > 50000 {
            return Err(Error::bad("archive_bar_budget_exceeded"));
        }
    }
    Ok(bars)
}

mod trades;

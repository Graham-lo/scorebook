use super::*;
use chrono::{Datelike, NaiveDate, TimeZone};
pub fn archive_prefix(market: &str, period: &str) -> Result<String> {
    let product = match market {
        "usd_m" => "um",
        "coin_m" => "cm",
        _ => return Err(Error::bad("invalid_market")),
    };
    if !matches!(period, "daily" | "monthly") {
        return Err(Error::bad("invalid_archive_period"));
    }
    Ok(format!("data/futures/{product}/{period}/klines/"))
}
pub async fn discover(s: &Services, input: ArchiveCatalogInput) -> Result<Value> {
    super::validate_symbol(&input.symbol)?;
    let iv = super::super::history::interval_of(&input.interval)?;
    // 归档目录里的周期段与对外写法只有月线不同（`1M` -> `1mo`）。
    let prefix = format!(
        "{}{}/{}/",
        archive_prefix(&input.market, "monthly")?,
        input.symbol,
        iv.archive_segment()
    );
    let listing = s.archives.list(&prefix, input.cursor.as_deref()).await?;
    let rows: Vec<_> = listing
        .contents
        .iter()
        .filter(|v| v.key.ends_with(".zip"))
        .map(|v| json!({"source_key":v.key,"size_bytes":v.size}))
        .collect();
    sqlx::query("INSERT INTO public_market.history_availability(market,symbol,timeframe,source_key,size_bytes,status) SELECT $1,$2,$3,r.source_key,r.size_bytes,'discovered' FROM jsonb_to_recordset($4) r(source_key text,size_bytes bigint) ON CONFLICT(market,symbol,timeframe,source_key) DO UPDATE SET status=CASE WHEN history_availability.size_bytes IS DISTINCT FROM EXCLUDED.size_bytes THEN 'discovered' ELSE history_availability.status END,size_bytes=EXCLUDED.size_bytes").bind(&input.market).bind(&input.symbol).bind(&input.interval).bind(json!(rows)).execute(&s.db.pool).await?;
    Ok(
        json!({"items":rows,"next_cursor":listing.next_marker,"complete_listing":!listing.is_truncated,"status":"discovered_not_yet_checksum_verified"}),
    )
}
pub async fn build(
    s: &Services,
    j: &Job,
    input: &super::super::history::HistoryIndexRequest,
) -> Result<Value> {
    let (bars, sources) = fetch_range(
        s,
        &input.market,
        &input.symbol,
        &input.interval,
        input.start_at,
        input.end_at,
    )
    .await?;
    let complete = bars.first().is_some_and(|v| v.start == input.start_at)
        && bars.last().is_some_and(|v| v.end == input.end_at)
        && bars.windows(2).all(|w| w[0].end == w[1].start);
    sqlx::query("INSERT INTO public_market.source_revisions(source_key,sha256,size_bytes) SELECT r.* FROM jsonb_to_recordset($1) r(source_key text,sha256 text,size_bytes bigint) ON CONFLICT DO NOTHING").bind(json!(sources)).execute(&s.db.pool).await?;
    super::super::history::index_bars(s, j, input, &bars, complete).await
}

/// 一次 `fetch_range` 里同时在飞的月档数。真正的总量上限在
/// `adapters::binance_archive` 的 `KLINE_SLOTS`；这个数只决定单次区间自己铺多宽。
/// 一个 256 根 1d 的窗口横跨 9 个自然月，串行实测 3.5 秒，而 6 个这样的窗口并发取
/// 墙钟只有 4.29 秒——时间全是一次 HTTPS 往返，并发几乎不掉速。
const MONTH_CONCURRENCY: usize = 8;

/// 把 `[start, end)` 覆盖到的自然月按时间顺序列成月档 key。纯函数，不碰网络也不碰
/// 数据库，所以「顺序不许变」这条能脱离网络单测。
pub fn month_plan(
    market: &str,
    symbol: &str,
    interval: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<Vec<String>> {
    let iv = super::super::history::interval_of(interval)?;
    let mut date = NaiveDate::from_ymd_opt(start.year(), start.month(), 1)
        .ok_or_else(|| Error::bad("invalid_date"))?;
    let mut keys = Vec::new();
    while Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap()) < end {
        if keys.len() >= 120 {
            return Err(Error::bad("archive_plan_exceeds_120_months"));
        }
        let segment = iv.archive_segment();
        keys.push(format!(
            "{}{}/{}/{}-{}-{}.zip",
            archive_prefix(market, "monthly")?,
            symbol,
            segment,
            symbol,
            segment,
            date.format("%Y-%m")
        ));
        date = date
            .checked_add_months(chrono::Months::new(1))
            .ok_or_else(|| Error::bad("invalid_date"))?;
    }
    Ok(keys)
}

/// Return bounded transient bars and provenance metadata; no raw file writes.
pub async fn fetch_range(
    s: &Services,
    market: &str,
    symbol: &str,
    interval: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<(Vec<scorebook_core::domain::criteria::Bar>, Vec<Value>)> {
    use futures_util::StreamExt;
    super::validate_symbol(symbol)?;
    let iv = super::super::history::interval_of(interval)?;
    if start >= end || iv.bars_between(start, end) > 50000 || end > Utc::now() {
        return Err(Error::bad("invalid_archive_range"));
    }
    // 先把整份月份计划算出来，再发第一个请求：`archive_plan_exceeds_120_months` 因此
    // 在任何下载动身之前就拒掉，而不是下到第 121 个月才发现。
    let keys = month_plan(market, symbol, interval, start, end)?;
    // `buffered` 是有序的那一支：请求并发发出，结果仍按月份顺序交回来，所以 `bars`
    // 和 `sources` 的最终顺序跟串行时逐条一致。
    let mut downloads = std::pin::pin!(
        futures_util::stream::iter(
            keys.into_iter()
                .map(|key| async move { s.archives.klines(&key, start, end).await }),
        )
        .buffered(MONTH_CONCURRENCY)
    );
    let mut bars = Vec::new();
    let mut sources = Vec::new();
    while let Some(source) = downloads.next().await {
        let source = source?;
        sources.push(json!({"source_key":source.source_key,"sha256":source.sha256,"size_bytes":source.size_bytes}));
        bars.extend(source.bars);
        if bars.len() > 50000 {
            return Err(Error::bad("archive_bar_budget_exceeded"));
        }
    }
    Ok((bars, sources))
}

#[cfg(test)]
mod month_plan_tests {
    use chrono::{DateTime, Utc};
    /// 月档并发下载之后，顺序只剩计划这一处能保证了：计划必须严格递增且无缺口，
    /// 否则 `bars` 拼出来会乱序或者中间开天窗，而 `build` 的 `complete` 判定
    /// （`w[0].end == w[1].start`）要到很晚才会发现。
    #[test]
    fn month_plan_is_strictly_increasing_with_no_gaps() {
        let at = |v: &str| v.parse::<DateTime<Utc>>().unwrap();
        let keys = super::month_plan(
            "usd_m",
            "BTCUSDT",
            "1d",
            at("2024-11-14T00:00:00Z"),
            at("2025-07-03T00:00:00Z"),
        )
        .unwrap();
        let months: Vec<i32> = keys
            .iter()
            .map(|key| {
                let stamp = key.strip_suffix(".zip").unwrap();
                let (year, month) = stamp[stamp.len() - 7..].split_once('-').unwrap();
                year.parse::<i32>().unwrap() * 12 + month.parse::<i32>().unwrap() - 1
            })
            .collect();
        // 起止两端都要覆盖到：2024-11 一直到 2025-07，共 9 个月。
        assert_eq!(months.len(), 9);
        assert_eq!(months.first().copied(), Some(2024 * 12 + 10));
        assert_eq!(months.last().copied(), Some(2025 * 12 + 6));
        assert!(months.windows(2).all(|w| w[1] == w[0] + 1));
        assert_eq!(
            keys[0],
            "data/futures/um/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2024-11.zip"
        );
    }

    /// `end` 是开区间端点，所以它正好落在月初那一刻时，那个月一根 K 线都不在范围里，
    /// 月档也就不该进计划——多下一个月档不会让结果变多，只会白花一次往返，遇到还没
    /// 发布的当月还会换来一个 `archive_not_available`。
    ///
    /// 上面那条测试的 `end` 落在月中，`<` 和 `<=` 在它身上结果一样，守不住这一端。
    /// 这里把边界两侧都夹住：正好落在 8 月 1 日零点时最后一档必须还是 7 月，早一秒
    /// 则必须一模一样。
    #[test]
    fn a_month_beginning_exactly_at_end_is_left_out_of_the_plan() {
        let at = |v: &str| v.parse::<DateTime<Utc>>().unwrap();
        let plan = |end: &str| {
            super::month_plan(
                "usd_m",
                "BTCUSDT",
                "1d",
                at("2025-06-01T00:00:00Z"),
                at(end),
            )
            .unwrap()
        };
        let flush = plan("2025-08-01T00:00:00Z");
        assert_eq!(flush.len(), 2, "{flush:?}");
        assert_eq!(
            flush.last().map(String::as_str),
            Some("data/futures/um/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2025-07.zip")
        );
        // 相邻的另一侧：早一秒时 7 月里还有 K 线，计划必须与上面逐字节相同。
        assert_eq!(plan("2025-07-31T23:59:59Z"), flush);
    }
}

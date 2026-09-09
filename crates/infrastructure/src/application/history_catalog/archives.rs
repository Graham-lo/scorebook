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
    super::super::history::interval_seconds(&input.interval)?;
    let prefix = format!(
        "{}{}/{}/",
        archive_prefix(&input.market, "monthly")?,
        input.symbol,
        input.interval
    );
    let listing = s.archives.list(&prefix, input.cursor.as_deref()).await?;
    let rows: Vec<_> = listing
        .contents
        .iter()
        .filter(|v| v.key.ends_with(".zip"))
        .map(|v| json!({"source_key":v.key,"size_bytes":v.size}))
        .collect();
    sqlx::query("INSERT INTO public_market.history_availability(market,symbol,timeframe,source_key,size_bytes,status) SELECT $1,$2,$3,r.source_key,r.size_bytes,'discovered' FROM jsonb_to_recordset($4) r(source_key text,size_bytes bigint) ON CONFLICT(market,symbol,timeframe,source_key) DO UPDATE SET size_bytes=EXCLUDED.size_bytes,checked_at=now()").bind(&input.market).bind(&input.symbol).bind(&input.interval).bind(json!(rows)).execute(&s.db.pool).await?;
    Ok(
        json!({"items":rows,"next_cursor":listing.next_marker,"complete_listing":!listing.is_truncated,"status":"discovered_not_yet_checksum_verified"}),
    )
}
pub async fn build(
    s: &Services,
    j: &Job,
    input: &super::super::history::HistoryIndexRequest,
) -> Result<Value> {
    let mut date = NaiveDate::from_ymd_opt(input.start_at.year(), input.start_at.month(), 1)
        .ok_or_else(|| Error::bad("invalid_date"))?;
    let mut bars = Vec::new();
    let mut sources = Vec::new();
    while Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).unwrap()) < input.end_at {
        if sources.len() >= 120 {
            return Err(Error::bad("archive_plan_exceeds_120_months"));
        }
        let key = format!(
            "{}{}/{}/{}-{}-{}.zip",
            archive_prefix(&input.market, "monthly")?,
            input.symbol,
            input.interval,
            input.symbol,
            input.interval,
            date.format("%Y-%m")
        );
        let source = s
            .archives
            .klines(&key, input.start_at, input.end_at)
            .await?;
        sources.push(json!({"source_key":source.source_key,"sha256":source.sha256,"size_bytes":source.size_bytes}));
        bars.extend(source.bars);
        if bars.len() > 50000 {
            return Err(Error::bad("archive_bar_budget_exceeded"));
        }
        date = date
            .checked_add_months(chrono::Months::new(1))
            .ok_or_else(|| Error::bad("invalid_date"))?;
    }
    let complete = bars.first().is_some_and(|v| v.start == input.start_at)
        && bars.last().is_some_and(|v| v.end == input.end_at)
        && bars.windows(2).all(|w| w[0].end == w[1].start);
    sqlx::query("INSERT INTO public_market.source_revisions(source_key,sha256,size_bytes) SELECT r.* FROM jsonb_to_recordset($1) r(source_key text,sha256 text,size_bytes bigint) ON CONFLICT DO NOTHING").bind(json!(sources)).execute(&s.db.pool).await?;
    super::super::history::index_bars(s, j, input, &bars, complete).await
}

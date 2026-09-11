//! Explicit archive recovery. Daily aggTrades are reduced in RAM and discarded.
use super::*;
fn key(market: &str, symbol: &str, day: DateTime<Utc>) -> Result<String> {
    super::super::history_catalog::validate_symbol(symbol)?;
    let m = match market {
        "usd_m" => "um",
        "coin_m" => "cm",
        _ => return Err(Error::bad("invalid_contract_market")),
    };
    Ok(format!(
        "data/futures/{m}/daily/aggTrades/{symbol}/{symbol}-aggTrades-{}.zip",
        day.format("%Y-%m-%d")
    ))
}
/// The declared reference range is the timestamp's UTC day and preceding day.
/// A verified empty range is not allowed to invent a reference price.
pub async fn reference(
    s: &Services,
    market: &str,
    symbol: &str,
    at: DateTime<Utc>,
) -> Result<(String, Value)> {
    let day = second(at, 86400);
    let result = s
        .archives
        .trade_day(
            &key(market, symbol, day)?,
            day,
            None::<String>,
            move |price, _, tr| {
                if tr.at <= at {
                    *price = Some(tr.price);
                }
                Ok(())
            },
        )
        .await?;
    let current = json!({"key":result.key,"sha256":result.sha256,"rows":result.rows});
    if let Some(price) = result.state {
        return Ok((price, current));
    }
    let previous = day - Duration::days(1);
    let result = s
        .archives
        .trade_day(
            &key(market, symbol, previous)?,
            previous,
            None::<String>,
            |price, _, tr| {
                *price = Some(tr.price);
                Ok(())
            },
        )
        .await?;
    let proof = json!([{"key":result.key,"sha256":result.sha256,"rows":result.rows},current]);
    Ok((
        result.state.ok_or_else(|| {
            Error::deferred(
                "archive_reference_price_unproven",
                RetryDirective::AwaitInput,
            )
        })?,
        proof,
    ))
}
pub async fn advance(
    s: &Services,
    market: &str,
    symbol: &str,
    w: Watch,
    target: DateTime<Utc>,
) -> Result<(Watch, Option<String>)> {
    // Endpoints are inclusive milliseconds. A following midnight belongs to the
    // following archive; never declare that boundary covered by yesterday's file.
    let day = second(w.through + Duration::milliseconds(1), 86400);
    let end = target.min(day + Duration::days(1) - Duration::milliseconds(1));
    if day + Duration::days(1) > Utc::now() {
        return Err(Error::deferred(
            "archive_day_pending_publication",
            RetryDirective::At(day + Duration::days(1) + Duration::hours(2)),
        ));
    }
    let result = s
        .archives
        .trade_day(
            &key(market, symbol, day)?,
            day,
            (w, None::<String>),
            move |state, id, tr| {
                let (w, last) = state;
                if tr.at <= end.min(w.deadline()) {
                    *last = Some(tr.price.clone());
                    w.reduce_trade(id, &tr).map_err(Error::bad)?;
                }
                Ok(())
            },
        )
        .await?;
    let (mut w, last) = result.state;
    w.through = end.min(w.deadline());
    let through = w.through;
    checkpoint_hash(
        &mut w,
        json!({"source_plan":"daily_archive_v1","key":result.key,"sha256":result.sha256,"rows":result.rows,"through":through}),
    );
    let endpoint = if w.through >= w.deadline() {
        last
    } else {
        None
    };
    Ok((w, endpoint))
}

//! Ephemeral provider data: no database/file/cache writes of OHLC or system charts.
use crate::{
    domain::{chart::ChartRequest, criteria::Bar},
    error::{Error, Result},
};
use serde_json::{Value, json};
pub async fn data(s: &super::Services, input: &ChartRequest) -> Result<Value> {
    if !matches!(input.market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::bad("contract_market_required"));
    }
    let iv = super::history::interval_of(&input.interval)?;
    if input
        .match_end_at
        .is_some_and(|at| at <= input.start_at || at > input.end_at)
    {
        return Err(Error::bad("invalid_match_boundary"));
    }
    if input.start_at >= input.end_at || iv.bars_between(input.start_at, input.end_at) > 2000 {
        return Err(Error::bad("interactive_market_limit_2000_bars"));
    }
    let mut result = if input.source == scorebook_core::market::HistorySource::MonthlyArchive {
        let (bars, sources) = super::history_catalog::archives::fetch_range(
            s,
            &input.market,
            &input.symbol,
            &input.interval,
            input.start_at,
            input.end_at,
        )
        .await?;
        let complete = bars.first().is_some_and(|b| b.start == input.start_at)
            && bars.last().is_some_and(|b| b.end == input.end_at)
            && bars.windows(2).all(|w| w[0].end == w[1].start);
        json!({"provider":"binance","source":"monthly_archive","market":input.market,"instrument":input.symbol,"interval":input.interval,"bars":bars,"coverage_complete":complete,"sources":sources})
    } else {
        s.market
            .klines(
                &input.market,
                &input.symbol,
                &input.interval,
                input.start_at,
                input.end_at,
            )
            .await?
    };
    result["storage_policy"] = json!("ephemeral;not_persisted");
    Ok(result)
}
pub async fn svg(s: &super::Services, input: &ChartRequest) -> Result<String> {
    let data = data(s, input).await?;
    let bars: Vec<Bar> =
        serde_json::from_value(data["bars"].clone()).map_err(|_| Error::bad("invalid_bars"))?;
    crate::domain::chart::svg_with_match(&bars, &input.symbol, &input.interval, input.match_end_at)
        .map_err(Error::bad)
}

//! Ephemeral provider data: no database/file/cache writes of OHLC or system charts.
use crate::{
    adapters::binance::Binance,
    domain::{chart::ChartRequest, criteria::Bar},
    error::{Error, Result},
};
use serde_json::{Value, json};
pub async fn data(input: &ChartRequest) -> Result<Value> {
    if !matches!(input.market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::bad("contract_market_required"));
    }
    let seconds = super::history::interval_seconds(&input.interval)?;
    if (input.end_at - input.start_at).num_seconds() / seconds > 2000 {
        return Err(Error::bad("interactive_market_limit_2000_bars"));
    }
    let mut result = Binance::new()?
        .klines(
            &input.market,
            &input.symbol,
            &input.interval,
            input.start_at,
            input.end_at,
        )
        .await?;
    result["storage_policy"] = json!("ephemeral;not_persisted");
    Ok(result)
}
pub async fn svg(input: &ChartRequest) -> Result<String> {
    let data = data(input).await?;
    let bars: Vec<Bar> =
        serde_json::from_value(data["bars"].clone()).map_err(|_| Error::bad("invalid_bars"))?;
    crate::domain::chart::svg(&bars, &input.symbol, &input.interval).map_err(Error::bad)
}

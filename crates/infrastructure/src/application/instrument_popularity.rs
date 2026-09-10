//! Public 24-hour turnover stays in RAM. Only the ordered identifiers reach SQL.
use super::Services;
use crate::error::{Error, Result};
use bigdecimal::BigDecimal;
use serde_json::Value;
use std::{collections::HashMap, str::FromStr};

pub async fn symbols(s: &Services, market: &str) -> Result<Vec<String>> {
    let sizes: HashMap<String, BigDecimal> = if market == "coin_m" {
        sqlx::query_as::<_, (String, String)>(
            "SELECT symbol, body->>'contractSize' FROM instrument_catalog WHERE venue='binance' AND market='coin_m' AND body->>'contractSize' IS NOT NULL",
        )
        .fetch_all(&s.db.pool)
        .await?
        .into_iter()
        .map(|(symbol, value)| Ok((symbol, decimal(&value)?)))
        .collect::<Result<_>>()?
    } else {
        HashMap::new()
    };
    rank(&s.market.tickers_24h(market).await?, market, &sizes)
}

fn decimal(value: &str) -> Result<BigDecimal> {
    // Provider values use fixed point. Bound input before arbitrary-precision parsing.
    if value.len() > 80
        || value.is_empty()
        || value.chars().any(|c| !c.is_ascii_digit() && c != '.')
    {
        return Err(Error::transient("invalid_ticker_turnover"));
    }
    BigDecimal::from_str(value).map_err(|_| Error::transient("invalid_ticker_turnover"))
}

fn rank(tickers: &Value, market: &str, sizes: &HashMap<String, BigDecimal>) -> Result<Vec<String>> {
    let rows = tickers
        .as_array()
        .ok_or_else(|| Error::transient("invalid_ticker_response"))?;
    if rows.is_empty() || rows.len() > 4000 {
        return Err(Error::transient("invalid_ticker_response"));
    }
    let mut amounts = Vec::new();
    for row in rows {
        let symbol = row["symbol"]
            .as_str()
            .ok_or_else(|| Error::transient("invalid_ticker_response"))?;
        let amount = match market {
            "usd_m" => decimal(
                row["quoteVolume"]
                    .as_str()
                    .ok_or_else(|| Error::transient("invalid_ticker_turnover"))?,
            )?,
            "coin_m" => {
                // Delivery contracts can remain in the ticker endpoint after leaving the catalogue.
                let Some(size) = sizes.get(symbol) else {
                    continue;
                };
                decimal(
                    row["volume"]
                        .as_str()
                        .ok_or_else(|| Error::transient("invalid_ticker_turnover"))?,
                )? * size
            }
            _ => return Err(Error::bad("market_not_supported")),
        };
        amounts.push((symbol.to_string(), amount));
    }
    amounts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(amounts.into_iter().map(|(symbol, _)| symbol).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn turnover_compares_value_not_coin_quantity_and_rejects_bad_numbers() {
        let tickers = json!([
            {"symbol":"TINYUSDT","volume":"999999999","quoteVolume":"5"},
            {"symbol":"BTCUSDT","volume":"2","quoteVolume":"200000"}
        ]);
        assert_eq!(
            rank(&tickers, "usd_m", &HashMap::new()).unwrap(),
            vec!["BTCUSDT", "TINYUSDT"]
        );
        let sizes = HashMap::from([
            ("BTCUSD_PERP".into(), BigDecimal::from(100)),
            ("ETHUSD_PERP".into(), BigDecimal::from(10)),
        ]);
        assert_eq!(rank(&json!([{"symbol":"ETHUSD_PERP","volume":"5"},{"symbol":"BTCUSD_PERP","volume":"1"}]),"coin_m",&sizes).unwrap(), vec!["BTCUSD_PERP", "ETHUSD_PERP"]);
        assert!(
            rank(
                &json!([{"symbol":"BTCUSDT","quoteVolume":"NaN"}]),
                "usd_m",
                &HashMap::new()
            )
            .is_err()
        );
    }
}

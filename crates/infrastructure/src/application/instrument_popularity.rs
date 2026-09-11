//! Public 24-hour turnover stays in RAM. Only the ordered identifiers reach SQL.
use super::Services;
use crate::error::{Error, Result};
use bigdecimal::BigDecimal;
use serde_json::Value;
use std::{collections::HashMap, str::FromStr};

/// 一个合约在 24 小时快照里的两项公开事实，外加各自的名次与合成名次。
#[derive(Clone)]
pub struct Ranked {
    pub symbol: String,
    /// 成交额。usd_m 直接取 `quoteVolume`；coin_m 是张数 × 合约面值。
    pub turnover: BigDecimal,
    /// 热度：24h 成交笔数，ticker 响应里的 `count`。
    pub trades: i64,
    pub turnover_rank: i32,
    pub trades_rank: i32,
}

impl Ranked {
    /// 合成名次的分数：两项名次之和，越小越靠前。
    fn borda(&self) -> i32 {
        self.turnover_rank + self.trades_rank
    }
}

pub async fn symbols(s: &Services, market: &str) -> Result<Vec<String>> {
    Ok(ranked(s, market)
        .await?
        .into_iter()
        .map(|v| v.symbol)
        .collect())
}

/// 名单入口：按合成名次取前 `top` 个，连同成交额与笔数一起交出去，好让调用方把
/// 这张快照原样存档。`top` 为 0 视为「全要」。
pub async fn leaders(s: &Services, market: &str, top: usize) -> Result<Vec<Ranked>> {
    let mut rows = ranked(s, market).await?;
    if top > 0 && rows.len() > top {
        rows.truncate(top);
    }
    Ok(rows)
}

async fn ranked(s: &Services, market: &str) -> Result<Vec<Ranked>> {
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

/// 按名次把一维排序结果写回每一行：`order` 是「第 i 名是哪一行」，返回的是
/// 「第 j 行排第几名」，名次从 1 开始。
fn places(order: &[usize], len: usize) -> Vec<i32> {
    let mut places = vec![0i32; len];
    for (place, row) in order.iter().enumerate() {
        places[*row] = place as i32 + 1;
    }
    places
}

fn rank(tickers: &Value, market: &str, sizes: &HashMap<String, BigDecimal>) -> Result<Vec<Ranked>> {
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
        // 热度在同一个响应里就有：`count` 是 24h 成交笔数，而且是数字不是字符串，
        // 不能照抄上面那几行的 `as_str`。
        let trades = row["count"]
            .as_i64()
            .filter(|v| *v >= 0)
            .ok_or_else(|| Error::transient("invalid_ticker_response"))?;
        amounts.push((symbol.to_string(), amount, trades));
    }
    if amounts.is_empty() {
        return Err(Error::transient("invalid_ticker_response"));
    }
    // 成交额和笔数各排一次名次，两个名次求和（Borda）后升序。单看任一项都会挑出
    // 一批偏科的币：成交额能被几笔巨鲸单顶上去，笔数高的又可能是一堆碎单的小票。
    // 和相同时按 symbol 字典序，保证同一份快照排出来的名单是确定的。
    let mut by_turnover: Vec<usize> = (0..amounts.len()).collect();
    by_turnover.sort_by(|a, b| {
        amounts[*b]
            .1
            .cmp(&amounts[*a].1)
            .then_with(|| amounts[*a].0.cmp(&amounts[*b].0))
    });
    let mut by_trades: Vec<usize> = (0..amounts.len()).collect();
    by_trades.sort_by(|a, b| {
        amounts[*b]
            .2
            .cmp(&amounts[*a].2)
            .then_with(|| amounts[*a].0.cmp(&amounts[*b].0))
    });
    let turnover_places = places(&by_turnover, amounts.len());
    let trades_places = places(&by_trades, amounts.len());
    let mut ranked: Vec<Ranked> = amounts
        .into_iter()
        .enumerate()
        .map(|(i, (symbol, turnover, trades))| Ranked {
            symbol,
            turnover,
            trades,
            turnover_rank: turnover_places[i],
            trades_rank: trades_places[i],
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.borda()
            .cmp(&b.borda())
            .then_with(|| a.symbol.cmp(&b.symbol))
    });
    Ok(ranked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn names(rows: Vec<Ranked>) -> Vec<String> {
        rows.into_iter().map(|v| v.symbol).collect()
    }
    #[test]
    fn turnover_compares_value_not_coin_quantity_and_rejects_bad_numbers() {
        // 成交额比的是金额不是币的个数：TINY 的币数多九位数，金额只有 5。笔数也同向，
        // 两项名次都排第二，合成名次自然还是第二。
        let tickers = json!([
            {"symbol":"TINYUSDT","volume":"999999999","quoteVolume":"5","count":10},
            {"symbol":"BTCUSDT","volume":"2","quoteVolume":"200000","count":90}
        ]);
        assert_eq!(
            names(rank(&tickers, "usd_m", &HashMap::new()).unwrap()),
            vec!["BTCUSDT", "TINYUSDT"]
        );
        let sizes = HashMap::from([
            ("BTCUSD_PERP".into(), BigDecimal::from(100)),
            ("ETHUSD_PERP".into(), BigDecimal::from(10)),
        ]);
        assert_eq!(
            names(
                rank(
                    &json!([
                        {"symbol":"ETHUSD_PERP","volume":"5","count":1},
                        {"symbol":"BTCUSD_PERP","volume":"1","count":2}
                    ]),
                    "coin_m",
                    &sizes
                )
                .unwrap()
            ),
            vec!["BTCUSD_PERP", "ETHUSD_PERP"]
        );
        assert!(
            rank(
                &json!([{"symbol":"BTCUSDT","quoteVolume":"NaN","count":1}]),
                "usd_m",
                &HashMap::new()
            )
            .is_err()
        );
    }
    #[test]
    fn heat_counts_too_so_a_single_whale_trade_cannot_carry_a_contract() {
        // WHALE 成交额第一但只有 1 笔（1+3=4），BUSY 成交额第二、笔数第一（2+1=3），
        // QUIET 两项都居中（3+2=5）。只按成交额排会把 WHALE 放在最前；两项名次相加
        // 之后，真正有人在交易的 BUSY 才是第一。
        let tickers = json!([
            {"symbol":"WHALEUSDT","quoteVolume":"300","count":1},
            {"symbol":"BUSYUSDT","quoteVolume":"200","count":100},
            {"symbol":"QUIETUSDT","quoteVolume":"100","count":50}
        ]);
        let rows = rank(&tickers, "usd_m", &HashMap::new()).unwrap();
        assert_eq!(
            rows.iter().map(|v| v.symbol.as_str()).collect::<Vec<_>>(),
            vec!["BUSYUSDT", "WHALEUSDT", "QUIETUSDT"]
        );
        assert_eq!((rows[1].turnover_rank, rows[1].trades_rank), (1, 3));
        // 名次和相同时按字典序，同一份快照排出来的名单必须是确定的。
        let tie = rank(
            &json!([
                {"symbol":"BBBUSDT","quoteVolume":"200","count":1},
                {"symbol":"AAAUSDT","quoteVolume":"100","count":2}
            ]),
            "usd_m",
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(names(tie), vec!["AAAUSDT", "BBBUSDT"]);
        // 缺 count 的响应是坏响应，不能当成热度为 0 混进名单。
        assert!(
            rank(
                &json!([{"symbol":"BTCUSDT","quoteVolume":"1"}]),
                "usd_m",
                &HashMap::new()
            )
            .is_err()
        );
    }
}

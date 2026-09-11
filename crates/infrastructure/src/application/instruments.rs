//! 品种目录：合约清单只从 `instrument_catalog` 读，REST 只负责把它刷新。
//!
//! 热度排序要的 24 小时成交额是实时的，拉不到就退回目录自己的顺序 —— 币安不通
//! 的时候还能选品种，比"排得最准"重要。
use super::Services;
use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
pub use scorebook_core::api::instruments::*;
use serde_json::{Value, json};

pub async fn refresh(s: &Services) -> Result<Value> {
    let provider = &s.market;
    let mut count = 0;
    for market in ["usd_m", "coin_m"] {
        let payload = provider.exchange_info(market).await?;
        let symbols = payload["symbols"]
            .as_array()
            .ok_or_else(|| Error::bad("invalid_exchange_info"))?;
        let mut tx = s.db.pool.begin().await?;
        for row in symbols {
            let symbol = row["symbol"]
                .as_str()
                .ok_or_else(|| Error::bad("invalid_symbol"))?;
            super::history_catalog::validate_symbol(symbol)?;
        }
        sqlx::query("INSERT INTO instrument_catalog(venue,market,symbol,body,refreshed_at) SELECT 'binance',$1,x->>'symbol',x,now() FROM jsonb_array_elements($2) x ON CONFLICT(venue,market,symbol) DO UPDATE SET body=EXCLUDED.body,refreshed_at=EXCLUDED.refreshed_at").bind(market).bind(json!(symbols)).execute(&mut *tx).await?;
        count += symbols.len();
        tx.commit().await?;
    }
    Ok(json!({"venue":"binance","contracts_refreshed":count,"default_market":"usd_m"}))
}
pub async fn list(s: &Services, f: InstrumentFilter) -> Result<Value> {
    let limit = f.limit.unwrap_or(50).clamp(1, 200);
    let input = f.q.as_deref().unwrap_or("");
    if input.len() > 512 {
        return Err(Error::bad("invalid_instrument_query"));
    }
    let query = scorebook_core::domain::instrument::search_query(input);
    let market = f.market.unwrap_or_else(|| "usd_m".into());
    if !matches!(market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::bad("market_not_supported"));
    }
    let popular = query.is_empty();
    // 热度排序失败不该让整张清单打不开：退化成目录顺序，并在响应里说清楚。
    let mut degraded = false;
    let ranked = if popular {
        match super::instrument_popularity::symbols(s, &market).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(code=%e.code,market=%market,"instrument ranking unavailable; serving catalogue order");
                degraded = true;
                vec![]
            }
        }
    } else {
        vec![]
    };
    let refreshed_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT max(refreshed_at) FROM instrument_catalog WHERE venue='binance' AND market=$1",
    )
    .bind(&market)
    .fetch_one(&s.db.pool)
    .await?;
    if degraded && refreshed_at.is_none() {
        // 实时的拿不到，库里也从来没刷进来过：这时候没有任何能交代的东西。
        return Err(Error::transient("instruments_unavailable"));
    }
    let snapshot = crate::adapters::db::digest(&json!([market, f.asset_class, ranked]));
    let cursor = if popular {
        match f.cursor {
            Some(cursor) => Some(
                cursor
                    .strip_prefix(&format!("popular:{snapshot}:"))
                    .ok_or_else(|| Error::conflict("instrument_ranking_changed"))?
                    .to_string(),
            ),
            None => None,
        }
    } else {
        f.cursor
    };
    let rows: Vec<Value> = sqlx::query_scalar(include_str!("instruments_search.sql"))
        .bind(query)
        .bind(market)
        .bind(f.asset_class)
        .bind(cursor)
        .bind(limit + 1)
        .bind(ranked)
        .fetch_all(&s.db.pool)
        .await?;
    let more = rows.len() > limit as usize;
    let items: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let next = if more {
        items.last().map(|v| {
            if popular {
                json!(format!(
                    "popular:{snapshot}:{}",
                    v["symbol"].as_str().unwrap()
                ))
            } else {
                v["symbol"].clone()
            }
        })
    } else {
        None
    };
    let ordering = match (popular, degraded) {
        (true, false) => "trading_then_24h_turnover_and_trade_count",
        (true, true) => "trading_then_symbol",
        (false, _) => "exact_symbol_then_base_asset_then_prefix_then_contains",
    };
    Ok(
        json!({"items":items,"next_cursor":next,"default_market":"usd_m","source":if degraded{"cached"}else{"binance_contract_exchange_info"},"refreshed_at":refreshed_at,"identity_policy":"contract_symbol_and_underlying_type;never_infer_from_ticker_name","price_type":"trade","ordering":ordering,"ranking_storage":"memory_only","ranking_cache_seconds":60}),
    )
}

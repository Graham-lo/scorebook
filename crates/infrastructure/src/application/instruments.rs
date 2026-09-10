use super::Services;
use crate::error::{Error, Result};
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
    let ranked = if popular {
        super::instrument_popularity::symbols(s, &market).await?
    } else {
        vec![]
    };
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
    Ok(
        json!({"items":items,"next_cursor":next,"default_market":"usd_m","source":"binance_contract_exchange_info","identity_policy":"contract_symbol_and_underlying_type;never_infer_from_ticker_name","price_type":"trade","ordering":if popular{"trading_then_24h_quote_turnover"}else{"exact_symbol_then_base_asset_then_prefix_then_contains"},"ranking_storage":"memory_only","ranking_cache_seconds":60}),
    )
}

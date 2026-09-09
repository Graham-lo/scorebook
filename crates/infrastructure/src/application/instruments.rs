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
    let pattern =
        f.q.map(|q| format!("%{}%", q.replace('%', "\\%").replace('_', "\\_")));
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(i) FROM instrument_catalog i WHERE ($1::text IS NULL OR symbol ILIKE $1) AND market=$2 AND ($3::text IS NULL OR body->>'underlyingType'=$3) AND ($4::text IS NULL OR symbol>$4) ORDER BY symbol LIMIT $5").bind(pattern).bind(f.market.unwrap_or_else(||"usd_m".into())).bind(f.asset_class).bind(f.cursor).bind(limit+1).fetch_all(&s.db.pool).await?;
    let more = rows.len() > limit as usize;
    let items: Vec<_> = rows.into_iter().take(limit as usize).collect();
    let next = if more {
        items.last().map(|v| v["symbol"].clone())
    } else {
        None
    };
    Ok(
        json!({"items":items,"next_cursor":next,"default_market":"usd_m","source":"binance_contract_exchange_info","identity_policy":"contract_symbol_and_underlying_type;never_infer_from_ticker_name","price_type":"trade"}),
    )
}

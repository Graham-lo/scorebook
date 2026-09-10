mod common;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, instruments, ports},
};
use serde_json::{Value, json};
struct Catalog {
    invalid: bool,
}
impl ports::MarketDataProvider for Catalog {
    fn tickers_24h<'a>(&'a self, _: &'a str) -> ports::ProviderFuture<'a> {
        Box::pin(async {
            Ok(json!([
                {"symbol":"DELISTEDUSDT","quoteVolume":"9999999999"},
                {"symbol":"BTCUSDT","quoteVolume":"100000000"},
                {"symbol":"MUUSDT","quoteVolume":"20000000"},
                {"symbol":"ARKMUSDT","quoteVolume":"1000"}
            ]))
        })
    }
    fn klines<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a str,
        _: chrono::DateTime<chrono::Utc>,
        _: chrono::DateTime<chrono::Utc>,
    ) -> ports::ProviderFuture<'a> {
        Box::pin(async { panic!("catalog refresh must not fetch prices") })
    }
    fn trades<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: chrono::DateTime<chrono::Utc>,
        _: chrono::DateTime<chrono::Utc>,
    ) -> ports::ProviderFuture<'a> {
        Box::pin(async { panic!("catalog refresh must not fetch trades") })
    }
    fn exchange_info<'a>(&'a self, market: &'a str) -> ports::ProviderFuture<'a> {
        Box::pin(async move {
            let symbols = if self.invalid {
                vec!["故障回滚品种USDT", "../bad"]
            } else if market == "usd_m" {
                vec!["BTCUSDT", "币安人生USDT", "我踏马来了USDT"]
            } else {
                vec!["BTCUSD_PERP"]
            };
            Ok(
                json!({"symbols":symbols.into_iter().map(|symbol|json!({"symbol":symbol,"status":"TRADING","contractType":"PERPETUAL"})).collect::<Vec<Value>>()}),
            )
        })
    }
}

#[tokio::test]
async fn shorthand_ranks_exact_assets_first_and_popularity_pages_are_consistent() {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let storage = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(storage.path()), Vision::new(None))
        .unwrap()
        .with_market(std::sync::Arc::new(Catalog { invalid: false }));
    let rows = json!([
        {"symbol":"MUUSDT","baseAsset":"MU","status":"TRADING"},
        {"symbol":"MUBARUSDT","baseAsset":"MUBAR","status":"TRADING"},
        {"symbol":"ARKMUSDT","baseAsset":"ARKM","status":"TRADING"},
        {"symbol":"ARMUSDT","baseAsset":"ARM","status":"TRADING"},
        {"symbol":"BTCUSDT","baseAsset":"BTC","status":"TRADING"},
        {"symbol":"DELISTEDUSDT","baseAsset":"DELISTED","status":"DELIVERED"}
    ]);
    sqlx::query("INSERT INTO instrument_catalog(venue,market,symbol,body,refreshed_at) SELECT 'binance','usd_m',x->>'symbol',x,now() FROM jsonb_array_elements($1) x ON CONFLICT(venue,market,symbol) DO UPDATE SET body=EXCLUDED.body")
        .bind(rows).execute(&s.db.pool).await.unwrap();
    for q in ["mu", " MU ", "mu/usdt", "ｍｕｕｓｄｔ", "BINANCE:MUUSDT.P"] {
        let page = instruments::list(
            &s,
            serde_json::from_value(json!({"q":q,"limit":1})).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(page["items"][0]["symbol"], "MUUSDT", "{q}");
    }
    let whole = instruments::list(
        &s,
        serde_json::from_value(json!({"q":"mu","limit":200})).unwrap(),
    )
    .await
    .unwrap();
    let mut seen = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = instruments::list(
            &s,
            serde_json::from_value(json!({"q":"mu","limit":1,"cursor":cursor})).unwrap(),
        )
        .await
        .unwrap();
        seen.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["symbol"].clone()),
        );
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(
        seen,
        whole["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["symbol"].clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(seen[..2], [json!("MUUSDT"), json!("MUBARUSDT")]);
    for q in ["%", "M' OR true--", "no-such-contract"] {
        assert!(
            instruments::list(&s, serde_json::from_value(json!({"q":q})).unwrap())
                .await
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    let hot = instruments::list(&s, serde_json::from_value(json!({"limit":2})).unwrap())
        .await
        .unwrap();
    assert_eq!(hot["items"][0]["symbol"], "BTCUSDT");
    assert_eq!(hot["items"][1]["symbol"], "MUUSDT");
    let next = instruments::list(
        &s,
        serde_json::from_value(json!({"limit":1,"cursor":hot["next_cursor"]})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(next["items"][0]["symbol"], "ARKMUSDT");
    let invalid = instruments::list(
        &s,
        serde_json::from_value(json!({"cursor":"popular:expired:BTCUSDT"})).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid.code, "instrument_ranking_changed");
}
#[tokio::test]
async fn mixed_language_catalog_is_complete_and_invalid_batch_is_atomic() {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let storage = tempfile::tempdir().unwrap();
    let services = Services::new(db, Storage::new(storage.path()), Vision::new(None))
        .unwrap()
        .with_market(std::sync::Arc::new(Catalog { invalid: false }));
    assert_eq!(
        instruments::refresh(&services).await.unwrap()["contracts_refreshed"],
        4
    );
    let names: Vec<String> = sqlx::query_scalar("SELECT symbol FROM instrument_catalog WHERE market='usd_m' AND symbol=ANY($1) ORDER BY symbol").bind(vec!["BTCUSDT", "币安人生USDT", "我踏马来了USDT"]).fetch_all(&services.db.pool).await.unwrap();
    assert_eq!(names.len(), 3);
    assert!(names.iter().any(|s| s == "币安人生USDT"));
    let invalid = services.with_market(std::sync::Arc::new(Catalog { invalid: true }));
    assert_eq!(
        instruments::refresh(&invalid).await.unwrap_err().code,
        "invalid_contract"
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM instrument_catalog WHERE symbol='故障回滚品种USDT'",
    )
    .fetch_one(&invalid.db.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

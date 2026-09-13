//! Catalog aliases are search suggestions, never silently saved source locations.
mod common;
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, calls, chart_search},
};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn gold_usd_uses_the_exact_catalog_base_without_confusing_tokenized_gold() {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let (owner, _) = db.create_user("screenshot-search").await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let s = Services::new(db, Storage::new(dir.path()), Vision::new(None)).unwrap();
    for (symbol, base) in [("XAUTUSDT", "XAUT")] {
        sqlx::query("INSERT INTO instrument_catalog(venue,market,symbol,body,refreshed_at) VALUES('binance','usd_m',$1,$2,now()) ON CONFLICT(venue,market,symbol) DO UPDATE SET body=EXCLUDED.body")
            .bind(symbol).bind(json!({"baseAsset":base,"quoteAsset":"USDT","contractType":if base == "XAU" {"TRADIFI_PERPETUAL"} else {"PERPETUAL"}})).execute(&s.db.pool).await.unwrap();
    }
    let mut im = image::RgbImage::from_pixel(800, 500, image::Rgb([255, 255, 255]));
    for i in 0..64 {
        let x = 30 + i * 11;
        let y = 350 - i * 3;
        for py in y - 7..y + 18 {
            im.put_pixel(x + 3, py, image::Rgb([0, 160, 90]));
        }
        for px in x..x + 7 {
            for py in y..y + 11 {
                im.put_pixel(px, py, image::Rgb([0, 160, 90]));
            }
        }
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(im)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    let uploaded = calls::upload(&s, owner, "gold", bytes.into_inner(), "scene".into(), None)
        .await
        .unwrap();
    let id: Uuid = serde_json::from_value(uploaded["id"].clone()).unwrap();
    let ocr = json!({"model_id":"apple-vision-text-r3","revision":3,"system_version":"fixture","observations":[
        {"text":"XAUUSD","confidence":1.,"box":[0.1,0.02,0.2,0.02]},
        {"text":"1天","confidence":1.,"box":[0.1,0.06,0.1,0.02]}
    ]});
    sqlx::query("INSERT INTO screenshot_ocr_cache(owner_id,sha256,attachment_id,protocol,result) SELECT owner_id,sha256,id,'native-ocr-toolbar-v3',$3 FROM attachments WHERE owner_id=$1 AND id=$2")
        .bind(owner).bind(id).bind(ocr).execute(&s.db.pool).await.unwrap();
    let input = scorebook_core::api::chart_search::ChartAnalysisInput {
        attachment_id: id,
        region: None,
        red_up: false,
    };
    let missing = chart_search::analyze(&s, owner, "before-catalog-refresh", input.clone())
        .await
        .unwrap();
    assert!(missing["recognized"]["symbol"].is_null());
    sqlx::query("INSERT INTO instrument_catalog(venue,market,symbol,body,refreshed_at) VALUES('binance','usd_m','XAUUSDT',$1,now()) ON CONFLICT(venue,market,symbol) DO UPDATE SET body=EXCLUDED.body")
        .bind(json!({"baseAsset":"XAU","quoteAsset":"USDT","contractType":"TRADIFI_PERPETUAL"})).execute(&s.db.pool).await.unwrap();
    let result = chart_search::analyze(&s, owner, "analyze-gold", input)
        .await
        .unwrap();
    assert_ne!(missing["id"], result["id"]);
    assert_eq!(result["recognized"]["symbol"], "XAUUSDT");
    assert_eq!(result["recognized"]["source_symbol"], "XAUUSD");
    assert_eq!(result["recognized"]["symbol_from"], "catalog_base_asset");
    assert_eq!(result["recognized"]["interval"], "1d");
    assert!(result["recognized"]["anchors"]["symbol"].is_null());
    let saved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM attachment_locations WHERE owner_id=$1 AND attachment_id=$2)",
    )
    .bind(owner)
    .bind(id)
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert!(!saved);
}

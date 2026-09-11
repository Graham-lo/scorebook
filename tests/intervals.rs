//! 周期扩容：币安合约 klines 的全部 15 个周期，从解析、校验一路到 features 分区。
//!
//! 用户的真实场景是 30 分钟截图：以前后端只有 6 个周期，30m 的记录只能拿 1h 的索引
//! 去匹配，永远得不到候选。这些用例盯的就是那条链路上每一段。
mod common;
use chrono::{Duration, Utc};
use scorebook::{
    adapters::{db::Database, storage::Storage, vision::Vision},
    application::{Services, history, replay},
};
use scorebook_core::domain::interval::{ALL, Interval};
use uuid::Uuid;

async fn setup() -> (Services, tempfile::TempDir) {
    let db = Database::connect(&common::test_db_url()).await.unwrap();
    db.migrate().await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    (
        Services::new(db.clone(), Storage::new(dir.path()), Vision::new(None)).unwrap(),
        dir,
    )
}

/// 0044 之后每个 market 下 15 个周期都有子分区，写 '30m' 和 '1M' 不再报缺分区。
#[tokio::test]
async fn every_interval_has_a_feature_partition() {
    let (s, _tmp) = setup().await;
    // feature_locator 与 features 互为外键（都 DEFERRABLE INITIALLY DEFERRED），
    // 必须在同一个事务里成对写入。
    let mut tx = s.db.pool.begin().await.unwrap();
    for market in ["usd_m", "coin_m"] {
        for iv in ALL {
            let id = Uuid::new_v4();
            let tf = iv.as_str();
            let start = iv.floor(Utc::now() - Duration::days(400));
            let end = iv.add_bars(start, 64);
            sqlx::query(
                "INSERT INTO public_market.feature_locator(id,market,timeframe) VALUES($1,$2,$3)",
            )
            .bind(id)
            .bind(market)
            .bind(tf)
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("feature_locator {market}/{tf}: {e}"));
            sqlx::query("INSERT INTO public_market.features(id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version) VALUES($1,$2,'BTCUSDT',$3,$4,$5,64,'candle-geometry-v2',$6::text::vector,$7,'v1')")
                .bind(id).bind(market).bind(tf).bind(start).bind(end)
                .bind(format!("[{}]", vec!["0"; 192].join(",")))
                .bind(format!("hash-{market}-{tf}"))
                .execute(&mut *tx).await
                .unwrap_or_else(|e| panic!("features {market}/{tf}: {e}"));
        }
    }
    tx.commit().await.unwrap();
    // 分区键存的是币安原文 '1M'，即便月线的物理表名叫 features_<market>_1mo。
    let month: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM public_market.features WHERE timeframe='1M' AND market='usd_m'",
    )
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(month, 1);
    let minute: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM public_market.features WHERE timeframe='1m' AND market='usd_m'",
    )
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(minute, 1, "'1M' 的行没有跑到 '1m' 分区里去");
    // 只数 features_<market> 下挂的表分区（relkind='r'，排除分区索引）。
    let partitions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_inherits h JOIN pg_class c ON c.oid=h.inhrelid JOIN pg_class p ON p.oid=h.inhparent JOIN pg_namespace n ON n.oid=p.relnamespace WHERE n.nspname='public_market' AND p.relname IN ('features_usd_m','features_coin_m') AND c.relkind='r'",
    )
    .fetch_one(&s.db.pool)
    .await
    .unwrap();
    assert_eq!(partitions, 30, "两个 market × 15 个周期");
    let month_partition: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public_market' AND c.relname IN ('features_usd_m_1mo','features_coin_m_1mo') AND c.relkind='r'")
        .fetch_one(&s.db.pool).await.unwrap();
    assert_eq!(month_partition, 2);
}

/// 记录的 timeframe 到币安 interval 的映射，全部 15 个周期加别名。
#[test]
fn replay_maps_every_interval_and_its_aliases() {
    for iv in ALL {
        assert_eq!(
            replay::interval_for(Some(iv.as_str())).unwrap(),
            iv.as_str()
        );
    }
    assert_eq!(replay::interval_for(Some("30m")).unwrap(), "30m");
    assert_eq!(replay::interval_for(Some("1M")).unwrap(), "1M");
    assert_eq!(replay::interval_for(Some("1m")).unwrap(), "1m");
    for (alias, want) in [
        ("m30", "30m"),
        (" 30M ", "30m"),
        ("h2", "2h"),
        ("w1", "1w"),
        ("1mo", "1M"),
        ("240m", "4h"),
        ("d1", "1d"),
    ] {
        assert_eq!(replay::interval_for(Some(alias)).unwrap(), want, "{alias}");
    }
    for bad in ["3h", "7m", "", "   ", "1y"] {
        assert_eq!(
            replay::interval_for(Some(bad)).unwrap_err().code,
            "replay_interval_unsupported",
            "{bad}"
        );
    }
    assert_eq!(
        replay::interval_for(None).unwrap_err().code,
        "replay_interval_unsupported"
    );
}

/// history::validate 接受全部 15 个周期，只认币安官方写法（别名不许落库）。
#[test]
fn history_validate_accepts_every_interval() {
    let request = |interval: &str, bars: i64| {
        let iv = Interval::parse(interval).unwrap_or(Interval::M1);
        let end = iv.floor(Utc::now());
        history::HistoryIndexRequest {
            source: history::HistorySource::Rest,
            symbol: "BTCUSDT".into(),
            market: "usd_m".into(),
            interval: interval.into(),
            start_at: iv.add_bars(end, -bars),
            end_at: end,
            window_bars: 64,
            stride_bars: 1,
            models: vec!["candle-geometry-v2".into()],
        }
    };
    for iv in ALL {
        history::validate(&request(iv.as_str(), 200))
            .unwrap_or_else(|e| panic!("{}: {}", iv.as_str(), e.code));
    }
    // 用户的 30 分钟截图场景：最近 200 根、window 64、stride 1。
    history::validate(&request("30m", 200)).unwrap();
    for bad in ["m30", "3h", "1mo", "30M"] {
        assert_eq!(
            history::validate(&request(bad, 200)).unwrap_err().code,
            "unsupported_interval",
            "{bad}"
        );
    }
    // 上限仍然按根数算，月线按日历月而不是固定秒数。
    assert_eq!(
        history::validate(&request("1m", 60_000)).unwrap_err().code,
        "history_request_exceeds_bounded_range;max_50000_bars_1000_windows"
    );
}

/// 截图搜索的周期白名单与唯一真相源同源。
#[test]
fn screenshot_search_requires_one_of_the_supported_intervals() {
    use scorebook_core::domain::chart_match::require_interval;
    for iv in ALL {
        assert_eq!(require_interval(Some(iv.as_str())).unwrap(), iv.as_str());
    }
    assert_eq!(
        require_interval(Some("3h")).unwrap_err().code,
        "unsupported_interval"
    );
    assert_eq!(
        require_interval(None).unwrap_err().code,
        "chart_interval_required"
    );
}

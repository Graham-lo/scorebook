//! Catalog facts, sizing and durable subscriptions are separate from feature extraction.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result, RetryDirective},
};
use chrono::{DateTime, Datelike, Duration, Utc};
use scorebook_core::api::{history::HistorySource, history_catalog::*};
use serde_json::{Value, json};
use uuid::Uuid;
pub mod archives;
pub mod boundaries;
pub mod subscriptions;
pub mod universe;
pub fn validate_symbol(symbol: &str) -> Result<()> {
    if !scorebook_core::domain::instrument::valid_symbol(symbol) {
        return Err(Error::bad("invalid_contract"));
    }
    Ok(())
}
pub async fn refresh(s: &Services) -> Result<Value> {
    super::instruments::refresh(s).await?;
    let version = Uuid::new_v4();
    let mut symbols = Vec::new();
    for market in ["usd_m", "coin_m"] {
        for period in ["monthly", "daily"] {
            let prefix = archives::archive_prefix(market, period)?;
            let mut marker = None;
            for page in 0..32 {
                let list = s.archives.list(&prefix, marker.as_deref()).await?;
                for p in list.common_prefixes {
                    if let Some(symbol) = p
                        .prefix
                        .strip_prefix(&prefix)
                        .and_then(|v| v.strip_suffix('/'))
                    {
                        validate_symbol(symbol)?;
                        symbols.push(json!({"market":market,"symbol":symbol}));
                    }
                }
                if !list.is_truncated {
                    break;
                }
                if page == 31 {
                    return Err(Error::bad("archive_catalog_page_budget_exceeded"));
                }
                marker = list.next_marker;
            }
        }
    }
    let hash = digest(&symbols);
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("INSERT INTO public_market.catalog_versions(id,source,source_hash) VALUES($1,'binance_exchange_info_and_official_archive',$2)").bind(version).bind(hash).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO public_market.instrument_lifecycles(market,symbol,onboard_at,delivery_at,status,catalog_version) SELECT market,symbol,to_timestamp((body->>'onboardDate')::double precision/1000),to_timestamp((body->>'deliveryDate')::double precision/1000),COALESCE(body->>'status',body->>'contractStatus','unknown'),$1 FROM instrument_catalog WHERE venue='binance' AND refreshed_at>now()-interval '10 minutes' ON CONFLICT(market,symbol) DO UPDATE SET onboard_at=EXCLUDED.onboard_at,delivery_at=EXCLUDED.delivery_at,status=EXCLUDED.status,last_seen_at=now(),catalog_version=$1").bind(version).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO public_market.instrument_lifecycles(market,symbol,status,archive_discovered,catalog_version) SELECT DISTINCT r.market,r.symbol,'archive_only',true,$1 FROM jsonb_to_recordset($2) r(market text,symbol text) ON CONFLICT(market,symbol) DO UPDATE SET archive_discovered=true,catalog_version=$1").bind(version).bind(json!(symbols)).execute(&mut *tx).await?;
    sqlx::query("UPDATE public_market.instrument_lifecycles l SET status='absent_from_current_catalog' WHERE last_seen_at<now()-interval '10 minutes' AND status NOT IN ('archive_only','absent_from_current_catalog') AND NOT EXISTS(SELECT 1 FROM instrument_catalog c WHERE c.market=l.market AND c.symbol=l.symbol AND c.refreshed_at>now()-interval '10 minutes')").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(
        json!({"catalog_version":version,"archive_prefix_observations":symbols.len(),"source":"official_binance","raw_market_storage":"none"}),
    )
}
pub async fn catalog(s: &Services, input: HistoryCatalogFilter) -> Result<Value> {
    let market = input.market.unwrap_or_else(|| "usd_m".into());
    archives::archive_prefix(&market, "monthly")?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(l) FROM public_market.instrument_lifecycles l WHERE market=$1 AND ($2::text IS NULL OR symbol>$2) AND ($3::text IS NULL OR symbol=$3) ORDER BY symbol LIMIT 101").bind(market).bind(input.cursor).bind(input.symbol).fetch_all(&s.db.pool).await?;
    let more = rows.len() > 100;
    let items: Vec<_> = rows.into_iter().take(100).collect();
    Ok(
        json!({"next_cursor":if more{items.last().map(|v|v["symbol"].clone())}else{None},"items":items,"coverage_policy":"catalog_presence_does_not_prove_history_availability","availability_endpoint":"/v1/history/archive-catalog"}),
    )
}
pub async fn resolve_symbols(
    s: &Services,
    market: &str,
    symbols: &[String],
) -> Result<Vec<String>> {
    archives::archive_prefix(market, "monthly")?;
    if symbols.len() > 4000 {
        return Err(Error::bad("too_many_symbols"));
    }
    for symbol in symbols {
        validate_symbol(symbol)?;
    }
    let rows:Vec<String>=sqlx::query_scalar("SELECT symbol FROM public_market.instrument_lifecycles WHERE market=$1 AND (cardinality($2::text[])=0 OR symbol=ANY($2)) ORDER BY symbol LIMIT 4001").bind(market).bind(symbols).fetch_all(&s.db.pool).await?;
    if rows.is_empty() || rows.len() > 4000 {
        return Err(Error::deferred(
            "catalog_refresh_required",
            RetryDirective::AwaitCapability,
        ));
    }
    let expected: std::collections::HashSet<_> = symbols.iter().collect();
    if !symbols.is_empty() && rows.len() != expected.len() {
        return Err(Error::bad("contract_missing_from_verified_catalog"));
    }
    Ok(rows)
}
pub async fn estimate(s: &Services, input: HistoryEstimateInput) -> Result<Value> {
    if input.start_at >= input.end_at
        || input.start_at.timestamp() < 0
        || input.end_at > Utc::now()
        || input.intervals.is_empty()
        || input.intervals.len() > 6
    {
        return Err(Error::bad("invalid_estimate_range"));
    }
    let symbols = resolve_symbols(s, &input.market, &input.symbols).await?;
    let mut rows = Vec::new();
    let mut total = 0u64;
    for tf in &input.intervals {
        let count = super::history::interval_of(tf)?.bars_between(input.start_at, input.end_at);
        for window in [64i64, 128, 256] {
            let stride = window / 4;
            let windows = if count >= window {
                ((count - window) / stride + 1) as u64
            } else {
                0
            };
            let vectors = windows * symbols.len() as u64;
            total = total
                .checked_add(vectors)
                .ok_or_else(|| Error::bad("estimate_overflow"))?;
            rows.push(json!({"interval":tf,"window_bars":window,"stride_bars":stride,"upper_bound_vectors":vectors}));
        }
    }
    let size:(i64,i64)=sqlx::query_as("SELECT COALESCE(sum(pg_total_relation_size(relid)),0)::bigint,COALESCE(sum(n_live_tup),0)::bigint FROM pg_stat_user_tables WHERE schemaname='public_market' AND relname LIKE 'features_%'").fetch_one(&s.db.pool).await?;
    Ok(
        json!({"symbols":symbols.len(),"items":rows,"upper_bound_vectors":total,"vector_payload_bytes":total*192*4,"estimate_kind":"declared_range_upper_bound_before_source_availability_probe","observed_feature_table_bytes":size.0,"approximate_observed_rows":size.1,"includes_index_overhead_in_vector_payload":false,"duration_estimate":null,"quality_gate":"real_filtered_ann_acceptance_required_before_mass_build"}),
    )
}

pub async fn request_refresh(s: &Services, owner: Uuid, key: &str) -> Result<Value> {
    let body = json!({});
    let (mut tx, cached) =
        s.db.write(owner, "history.catalog.refresh", key, &body)
            .await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let job = jobs::enqueue_tx(&mut tx, owner, "history.catalog", key, body.clone()).await?;
    let v = json!({"job_id":job,"status":"queued"});
    Database::finish(&mut tx, owner, "history.catalog.refresh", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn schedule(s: &Services) -> Result<()> {
    let owner:Option<Uuid>=sqlx::query_scalar("SELECT id FROM users WHERE NOT EXISTS(SELECT 1 FROM public_market.catalog_versions WHERE created_at>now()-interval '24 hours') ORDER BY created_at,id LIMIT 1").fetch_optional(&s.db.pool).await?;
    if let Some(owner) = owner {
        request_refresh(s, owner, &format!("catalog:{}", Utc::now().date_naive())).await?;
    }
    subscriptions::schedule(s).await
}

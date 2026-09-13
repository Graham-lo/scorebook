//! Ephemeral provider data: no database/file/cache writes of OHLC or system charts.
use crate::{
    domain::{chart::ChartRequest, criteria::Bar},
    error::{Error, Result},
};
use chrono::Utc;
use scorebook_core::api::market::MarketBoundsQuery;
use serde_json::{Value, json};

pub async fn bounds(s: &super::Services, input: &MarketBoundsQuery) -> Result<Value> {
    if !matches!(input.market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::bad("contract_market_required"));
    }
    super::history::interval_of(&input.interval)?;
    if input.symbol.trim().is_empty() {
        return Err(Error::bad("symbol_required"));
    }
    sqlx::query_scalar::<_, Value>(
        r#"SELECT jsonb_build_object(
          'market',l.market,'symbol',l.symbol,'interval',$3::text,
          'status',l.status,'onboard_at',l.onboard_at,'delivery_at',l.delivery_at,
          'first_bar_at',b.first_bar_at,'last_bar_at',b.last_bar_at,
          'gaps',COALESCE(b.gaps,'[]'::jsonb),'verified_at',b.verified_at,'server_now',now())
        FROM public_market.instrument_lifecycles l
        LEFT JOIN public_market.instrument_bounds b ON b.market=l.market AND b.symbol=l.symbol AND b.interval=$3
        WHERE l.market=$1 AND l.symbol=$2"#,
    )
    .bind(&input.market).bind(&input.symbol).bind(&input.interval)
    .fetch_optional(&s.db.pool).await?
    .ok_or_else(|| Error::new(crate::error::ErrorKind::NotFound, "instrument_unknown", crate::error::RetryDirective::Never))
}

/// Best-effort metadata only, using bars already fetched by the server.
pub(crate) async fn observe_bounds(
    s: &super::Services,
    input: &ChartRequest,
    bars: &[Bar],
    coverage_complete: bool,
) {
    let now = Utc::now();
    let first = bars
        .first()
        .filter(|b| !coverage_complete && b.start > input.start_at)
        .map(|b| b.start);
    let last = bars.iter().filter(|b| b.end <= now).map(|b| b.start).max();
    let gaps: Vec<Value> = bars
        .windows(2)
        .filter(|w| !coverage_complete && w[0].end < w[1].start)
        .map(|w| json!({"start":w[0].end,"end":w[1].start,"seen_at":now}))
        .collect();
    let result = sqlx::query(
        r#"INSERT INTO public_market.instrument_bounds AS b(market,symbol,interval,first_bar_at,last_bar_at,gaps)
        VALUES($1,$2,$3,
          CASE WHEN $4::timestamptz < (SELECT onboard_at FROM public_market.instrument_lifecycles WHERE market=$1 AND symbol=$2)
            OR (SELECT onboard_at FROM public_market.instrument_lifecycles WHERE market=$1 AND symbol=$2) IS NULL
          THEN $5::timestamptz ELSE NULL END,
          $6,public_market.merge_instrument_gaps($7))
        ON CONFLICT(market,symbol,interval) DO UPDATE SET
          first_bar_at=LEAST(b.first_bar_at,EXCLUDED.first_bar_at),
          last_bar_at=GREATEST(b.last_bar_at,EXCLUDED.last_bar_at),
          gaps=public_market.merge_instrument_gaps(b.gaps || EXCLUDED.gaps),verified_at=now()"#,
    )
    .bind(&input.market).bind(&input.symbol).bind(&input.interval).bind(input.start_at)
    .bind(first).bind(last).bind(json!(gaps)).execute(&s.db.pool).await;
    if let Err(error) = result {
        tracing::warn!(%error, market=%input.market, symbol=%input.symbol, interval=%input.interval, "instrument bounds update failed");
    }
}

pub async fn data(s: &super::Services, input: &ChartRequest) -> Result<Value> {
    if !matches!(input.market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::bad("contract_market_required"));
    }
    let iv = super::history::interval_of(&input.interval)?;
    if input
        .match_end_at
        .is_some_and(|at| at <= input.start_at || at > input.end_at)
    {
        return Err(Error::bad("invalid_match_boundary"));
    }
    if input.start_at >= input.end_at || iv.bars_between(input.start_at, input.end_at) > 2000 {
        return Err(Error::bad("interactive_market_limit_2000_bars"));
    }
    let mut result = if input.source == scorebook_core::market::HistorySource::MonthlyArchive {
        let (bars, sources) = super::history_catalog::archives::fetch_range(
            s,
            &input.market,
            &input.symbol,
            &input.interval,
            input.start_at,
            input.end_at,
        )
        .await?;
        let complete = bars.first().is_some_and(|b| b.start == input.start_at)
            && bars.last().is_some_and(|b| b.end == input.end_at)
            && bars.windows(2).all(|w| w[0].end == w[1].start);
        json!({"provider":"binance","source":"monthly_archive","market":input.market,"instrument":input.symbol,"interval":input.interval,"bars":bars,"coverage_complete":complete,"sources":sources})
    } else {
        s.market
            .klines(
                &input.market,
                &input.symbol,
                &input.interval,
                input.start_at,
                input.end_at,
            )
            .await?
    };
    match serde_json::from_value::<Vec<Bar>>(result["bars"].clone()) {
        Ok(bars) => observe_bounds(s, input, &bars, result["coverage_complete"] != false).await,
        Err(error) => tracing::warn!(%error, "instrument bounds skipped: invalid provider bars"),
    }
    result["storage_policy"] = json!("ephemeral;not_persisted");
    Ok(result)
}
pub async fn svg(s: &super::Services, input: &ChartRequest) -> Result<String> {
    let data = data(s, input).await?;
    let bars: Vec<Bar> =
        serde_json::from_value(data["bars"].clone()).map_err(|_| Error::bad("invalid_bars"))?;
    crate::domain::chart::svg_with_match(&bars, &input.symbol, &input.interval, input.match_end_at)
        .map_err(Error::bad)
}

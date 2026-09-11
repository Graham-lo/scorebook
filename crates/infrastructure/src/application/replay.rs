//! Relive/replay orchestration.
//!
//! Storage exception (README/docs/status.md): `replay_bars` is the one place a
//! public OHLC window is written down, and only as an expiring cache for one
//! record's stage. Statistics, settlement and search never read it. This module
//! writes no outcome, manifest or event, and the only rows it ever deletes are
//! `replay_bars` rows.
use crate::{
    adapters::db::Database,
    application::Services,
    domain::{
        chart::ChartRequest,
        criteria::{Bar, Criteria, Template},
        instrument::valid_symbol,
        replay::{Levels, levels},
    },
    error::{Error, Result},
};
use chrono::{DateTime, Duration, Utc};
use scorebook_core::domain::interval::Interval;
use scorebook_core::{
    api::replay::{AttachmentLocation, ChartSetup},
    market::HistorySource,
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

const CACHE_HOURS: i64 = 24;
const DEFAULT_BARS_BEFORE: i64 = 120;
const DEFAULT_BARS_AFTER: i64 = 120;
const MAX_BARS: i64 = 2000;

/// Writes follow the idempotency convention when a key is supplied; without one
/// the upsert simply runs, because an auto-derived key would replay a cached
/// response after the row had been deleted again.
async fn begin<'a>(
    s: &'a Services,
    owner: Uuid,
    op: &str,
    key: Option<&str>,
    body: &Value,
) -> Result<(Transaction<'a, Postgres>, Option<Value>)> {
    match key {
        Some(k) => s.db.write(owner, op, k, body).await,
        None => {
            let mut tx = s.db.pool.begin().await?;
            sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))")
                .bind(owner.to_string())
                .execute(&mut *tx)
                .await?;
            Ok((tx, None))
        }
    }
}
async fn end(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    op: &str,
    key: Option<&str>,
    body: &Value,
    response: &Value,
) -> Result<()> {
    if let Some(k) = key {
        Database::finish(tx, owner, op, k, body, response).await?;
    }
    Ok(())
}

fn source_name(source: &HistorySource) -> &'static str {
    match source {
        HistorySource::MonthlyArchive => "monthly_archive",
        HistorySource::Rest => "rest",
    }
}

/// Binance interval for a record's timeframe. Nothing is invented: an unknown
/// timeframe is refused instead of silently redrawn at another scale.
///
/// 别名解析在 `Interval::parse` 里（唯一真相源），这里只把它归一化成币安官方写法，
/// 并保留本接口原有的错误码。
pub fn interval_for(timeframe: Option<&str>) -> Result<String> {
    Ok(interval_of(timeframe)?.as_str().into())
}

/// 同上，但直接给出周期本身，供窗口算术使用。
pub fn interval_of(timeframe: Option<&str>) -> Result<Interval> {
    timeframe
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(|v| Interval::parse(v).ok())
        .ok_or_else(|| Error::bad("replay_interval_unsupported"))
}

pub async fn put_location(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
    key: Option<&str>,
    input: AttachmentLocation,
) -> Result<Value> {
    if !matches!(input.market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::bad("invalid_market"));
    }
    if !valid_symbol(&input.symbol) {
        return Err(Error::bad("invalid_symbol"));
    }
    super::history::interval_of(&input.interval)?;
    if input.start_at >= input.end_at {
        return Err(Error::bad("invalid_location_window"));
    }
    if input.bars_count.is_some_and(|v| v <= 0) {
        return Err(Error::bad("invalid_bars_count"));
    }
    if let Some(score) = &input.score {
        crate::domain::criteria::dec(score).map_err(Error::bad)?;
    }
    let body = json!(input);
    let (mut tx, cached) = begin(s, owner, "replay.location.put", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let owned: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(attachment)
            .fetch_one(&mut *tx)
            .await?;
    if !owned {
        return Err(Error::not_found());
    }
    let row: Value = sqlx::query_scalar(
        r#"INSERT INTO attachment_locations(owner_id,attachment_id,symbol,market,interval,start_at,end_at,bars_count,source,score,search_run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::numeric,$11)
        ON CONFLICT(owner_id,attachment_id) DO UPDATE SET symbol=EXCLUDED.symbol,market=EXCLUDED.market,interval=EXCLUDED.interval,
        start_at=EXCLUDED.start_at,end_at=EXCLUDED.end_at,bars_count=EXCLUDED.bars_count,source=EXCLUDED.source,score=EXCLUDED.score,
        search_run_id=EXCLUDED.search_run_id,confirmed_at=now()
        RETURNING (to_jsonb(attachment_locations)-'owner_id'-'score')||jsonb_build_object('score',score::text)"#,
    )
    .bind(owner)
    .bind(attachment)
    .bind(&input.symbol)
    .bind(&input.market)
    .bind(&input.interval)
    .bind(input.start_at)
    .bind(input.end_at)
    .bind(input.bars_count)
    .bind(source_name(&input.source))
    .bind(input.score.as_deref())
    .bind(input.search_run_id)
    .fetch_one(&mut *tx)
    .await?;
    end(&mut tx, owner, "replay.location.put", key, &body, &row).await?;
    tx.commit().await?;
    Ok(row)
}

pub async fn delete_location(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
    key: Option<&str>,
) -> Result<Value> {
    let body = json!({"attachment_id":attachment});
    let (mut tx, cached) = begin(s, owner, "replay.location.delete", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let removed =
        sqlx::query("DELETE FROM attachment_locations WHERE owner_id=$1 AND attachment_id=$2")
            .bind(owner)
            .bind(attachment)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    let response = json!({"attachment_id":attachment,"deleted":removed});
    end(
        &mut tx,
        owner,
        "replay.location.delete",
        key,
        &body,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

/// Shape only: the backend stores which overlays to draw and never computes one.
fn validate_setup(setup: &ChartSetup) -> Result<()> {
    if setup.ma.len() + setup.ema.len() > 6 {
        return Err(Error::bad("chart_setup_too_many_lines"));
    }
    for n in setup.ma.iter().chain(setup.ema.iter()) {
        if !(1..=500).contains(n) {
            return Err(Error::bad("invalid_chart_setup_period"));
        }
    }
    if let Some(b) = &setup.boll {
        if !(1..=500).contains(&b.n) {
            return Err(Error::bad("invalid_chart_setup_period"));
        }
        crate::domain::criteria::dec(&b.k).map_err(Error::bad)?;
    }
    if let Some(a) = &setup.atr
        && !(1..=500).contains(&a.n)
    {
        return Err(Error::bad("invalid_chart_setup_period"));
    }
    Ok(())
}

pub async fn put_chart_setup(
    s: &Services,
    owner: Uuid,
    call: Uuid,
    key: Option<&str>,
    input: ChartSetup,
) -> Result<Value> {
    validate_setup(&input)?;
    let body = json!(input);
    let (mut tx, cached) = begin(s, owner, "replay.chart_setup.put", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    super::calls::require_call(&mut tx, owner, call).await?;
    let updated:DateTime<Utc>=sqlx::query_scalar("INSERT INTO chart_setups(owner_id,call_id,body) VALUES($1,$2,$3) ON CONFLICT(owner_id,call_id) DO UPDATE SET body=EXCLUDED.body,updated_at=now() RETURNING updated_at")
        .bind(owner).bind(call).bind(&body).fetch_one(&mut *tx).await?;
    let response = json!({"call_id":call,"body":body,"updated_at":updated});
    end(
        &mut tx,
        owner,
        "replay.chart_setup.put",
        key,
        &body,
        &response,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

/// The stage window: what to draw, over which instrument, between which instants.
struct Plan {
    call: Uuid,
    symbol: String,
    market: String,
    iv: Interval,
    source: HistorySource,
    judgment: DateTime<Utc>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    truncated: bool,
    criteria: Criteria,
    levels: Levels,
    marks: Option<Value>,
    outcome_id: Option<Uuid>,
    base: Option<String>,
    atr0: Option<String>,
}

async fn plan(s: &Services, owner: Uuid, call: Uuid) -> Result<Plan> {
    let row = sqlx::query(
        "SELECT submitted_at,instrument,market,timeframe,body FROM calls WHERE owner_id=$1 AND id=$2",
    )
    .bind(owner)
    .bind(call)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)?;
    let submitted: DateTime<Utc> = row.get("submitted_at");
    let body: Value = row.get("body");
    let symbol: Option<String> = row.get("instrument");
    let symbol = symbol
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| Error::conflict("replay_needs_instrument"))?;
    if !valid_symbol(&symbol) {
        return Err(Error::conflict("replay_needs_instrument"));
    }
    let market: Option<String> = row.get("market");
    let market = market.unwrap_or_else(|| "usd_m".into());
    if !matches!(market.as_str(), "usd_m" | "coin_m") {
        return Err(Error::conflict("replay_needs_instrument"));
    }
    let timeframe: Option<String> = row.get("timeframe");
    let iv = interval_of(timeframe.as_deref())?;
    let interval = iv.as_str();
    let judgment: DateTime<Utc> = body["original_claimed_at"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or(submitted);

    // Claim 0 is the record's own judgment; its frozen criteria live in the
    // published manifest, and the current verdict in the head outcome.
    let head = sqlx::query("SELECT o.id,o.result,m.body AS manifest FROM outcome_heads h JOIN outcomes o ON o.owner_id=h.owner_id AND o.id=h.outcome_id JOIN manifests m ON m.owner_id=o.owner_id AND m.id=o.manifest_id WHERE h.owner_id=$1 AND h.call_id=$2 AND h.claim_no=0")
        .bind(owner).bind(call).fetch_optional(&s.db.pool).await?;
    let (outcome_id, marks, manifest) = match head {
        Some(r) => (
            Some(r.get::<Uuid, _>("id")),
            Some(r.get::<Value, _>("result")),
            Some(r.get::<Value, _>("manifest")),
        ),
        None => (None, None, None),
    };
    let criteria: Criteria = manifest
        .as_ref()
        .and_then(|m| serde_json::from_value(m["criteria"].clone()).ok())
        .or_else(|| serde_json::from_value(body["criteria"][0].clone()).ok())
        .unwrap_or_default();

    // Same frozen numbers the settlement path judges against.
    let watch: Option<(Option<String>, Option<String>)> = sqlx::query_as("SELECT checkpoint->>'submission_base',checkpoint->>'atr_at_submission' FROM trigger_watches WHERE owner_id=$1 AND call_id=$2 AND claim_no=0 ORDER BY updated_at DESC LIMIT 1")
        .bind(owner).bind(call).fetch_optional(&s.db.pool).await?;
    let (base, atr0) = watch.unwrap_or((None, None));

    let trigger_at = marks
        .as_ref()
        .and_then(|m| m["trigger_at"].as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc));
    let trigger_price = marks
        .as_ref()
        .and_then(|m| m["trigger_price"].as_str())
        .map(str::to_string);
    // Levels are drawn on the same anchor the published manifest settled on, so
    // the stage lines and the recorded verdict cannot drift apart; without a
    // manifest the judgment moment is the anchor.
    let anchor = manifest
        .as_ref()
        .and_then(|m| m["start"].as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or(judgment);
    let l = levels(
        &criteria,
        anchor,
        base.as_deref(),
        &atr0,
        trigger_at,
        trigger_price.as_deref(),
    );

    // A screenshot already pinned to real bars decides where the stage opens.
    let located: Option<(String, String, String, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT l.symbol,l.market,l.interval,l.start_at,l.source FROM attachment_locations l JOIN attachments a ON a.owner_id=l.owner_id AND a.id=l.attachment_id JOIN call_attachments ca ON ca.owner_id=a.owner_id AND ca.attachment_id=a.id WHERE l.owner_id=$1 AND ca.call_id=$2 AND a.kind='scene' ORDER BY a.uploaded_at,a.id LIMIT 1",
    )
    .bind(owner)
    .bind(call)
    .fetch_optional(&s.db.pool)
    .await?;
    let located =
        located.filter(|(sy, mk, tf, _, _)| *sy == symbol && *mk == market && *tf == interval);
    let source = match located.as_ref().map(|(_, _, _, _, src)| src.as_str()) {
        Some("monthly_archive") => HistorySource::MonthlyArchive,
        _ => HistorySource::Rest,
    };
    let start = match located.as_ref() {
        Some((_, _, _, at, _)) => iv.floor(*at),
        None => iv.add_bars(iv.floor(judgment), -DEFAULT_BARS_BEFORE),
    };
    let marks_end = marks
        .as_ref()
        .and_then(|m| m["end_at"].as_str())
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc));
    let horizon = l
        .horizon_end_at
        .or_else(|| l.trigger.as_ref().map(|t| t.window_end_at));
    let wanted = marks_end
        .or(horizon)
        .unwrap_or(iv.add_bars(judgment, DEFAULT_BARS_AFTER));
    let mut end = iv.floor(wanted.min(Utc::now()));
    if end <= start {
        end = iv.add_bars(start, 1);
    }
    let mut truncated = false;
    if iv.bars_between(start, end) > MAX_BARS {
        end = iv.add_bars(start, MAX_BARS);
        truncated = true;
    }
    Ok(Plan {
        call,
        symbol,
        market,
        iv,
        source,
        judgment,
        start,
        end,
        truncated,
        criteria,
        levels: l,
        marks,
        outcome_id,
        base,
        atr0,
    })
}

struct Cached {
    bar: Bar,
    source: String,
}

async fn cached(s: &Services, p: &Plan) -> Result<Vec<Cached>> {
    let rows = sqlx::query("SELECT bar_start,bar_end,open,high,low,close,source FROM replay_bars WHERE market=$1 AND symbol=$2 AND interval=$3 AND bar_start>=$4 AND bar_end<=$5 AND expires_at>now() ORDER BY bar_start")
        .bind(&p.market).bind(&p.symbol).bind(p.iv.as_str()).bind(p.start).bind(p.end).fetch_all(&s.db.pool).await?;
    Ok(rows
        .iter()
        .map(|r| Cached {
            bar: Bar {
                start: r.get("bar_start"),
                end: r.get("bar_end"),
                open: r.get("open"),
                high: r.get("high"),
                low: r.get("low"),
                close: r.get("close"),
            },
            source: r.get("source"),
        })
        .collect())
}

async fn fetch(
    s: &Services,
    p: &Plan,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<(Vec<Bar>, HistorySource)> {
    let request = |source: HistorySource| ChartRequest {
        source,
        symbol: p.symbol.clone(),
        market: p.market.clone(),
        interval: p.iv.as_str().into(),
        start_at: from,
        end_at: to,
        match_end_at: None,
    };
    let bars = |v: Value| -> Result<Vec<Bar>> {
        serde_json::from_value(v["bars"].clone()).map_err(|_| Error::bad("invalid_bars"))
    };
    if p.source == HistorySource::Rest {
        // A judgment from years ago is still replayable: when REST cannot serve
        // the range, the official monthly archive can.
        match super::market::data(s, &request(HistorySource::Rest)).await {
            Ok(v) => return Ok((bars(v)?, HistorySource::Rest)),
            Err(e) if e.kind == crate::error::ErrorKind::NotFound => return Err(e),
            Err(_) => {}
        }
    }
    let v = super::market::data(s, &request(HistorySource::MonthlyArchive)).await?;
    Ok((bars(v)?, HistorySource::MonthlyArchive))
}

async fn store(s: &Services, p: &Plan, bars: &[Bar], source: &str) -> Result<()> {
    if bars.is_empty() {
        return Ok(());
    }
    let starts: Vec<DateTime<Utc>> = bars.iter().map(|b| b.start).collect();
    let ends: Vec<DateTime<Utc>> = bars.iter().map(|b| b.end).collect();
    let open: Vec<String> = bars.iter().map(|b| b.open.clone()).collect();
    let high: Vec<String> = bars.iter().map(|b| b.high.clone()).collect();
    let low: Vec<String> = bars.iter().map(|b| b.low.clone()).collect();
    let close: Vec<String> = bars.iter().map(|b| b.close.clone()).collect();
    sqlx::query(r#"INSERT INTO replay_bars(market,symbol,interval,bar_start,bar_end,open,high,low,close,source,expires_at)
        SELECT $1,$2,$3,t.s,t.e,t.o,t.h,t.l,t.c,$4,now()+make_interval(hours=>$11::int)
        FROM UNNEST($5::timestamptz[],$6::timestamptz[],$7::text[],$8::text[],$9::text[],$10::text[]) AS t(s,e,o,h,l,c)
        ON CONFLICT(market,symbol,interval,bar_start) DO UPDATE SET bar_end=EXCLUDED.bar_end,open=EXCLUDED.open,high=EXCLUDED.high,
        low=EXCLUDED.low,close=EXCLUDED.close,source=EXCLUDED.source,fetched_at=now(),expires_at=EXCLUDED.expires_at"#)
        .bind(&p.market).bind(&p.symbol).bind(p.iv.as_str()).bind(source)
        .bind(&starts).bind(&ends).bind(&open).bind(&high).bind(&low).bind(&close)
        .bind(CACHE_HOURS as i32)
        .execute(&s.db.pool).await?;
    Ok(())
}

/// Where the path extreme actually happened, for the stage to mark it.
fn extreme_at(bars: &[Bar], from: DateTime<Utc>, to: DateTime<Utc>, high: bool) -> Option<Value> {
    let mut best: Option<(&Bar, bigdecimal::BigDecimal)> = None;
    for b in bars.iter().filter(|b| b.start >= from && b.end <= to) {
        let v = crate::domain::criteria::dec(if high { &b.high } else { &b.low }).ok()?;
        let better = match &best {
            None => true,
            Some((_, cur)) => {
                if high {
                    v > *cur
                } else {
                    v < *cur
                }
            }
        };
        if better {
            best = Some((b, v));
        }
    }
    best.map(|(b, _)| json!(b.start))
}

pub async fn get(s: &Services, owner: Uuid, call: Uuid) -> Result<Value> {
    let p = plan(s, owner, call).await?;
    let expected = p.iv.bars_between(p.start, p.end).max(0);
    let mut have = cached(s, &p).await?;
    let mut source = have
        .first()
        .map(|c| c.source.clone())
        .unwrap_or_else(|| source_name(&p.source).into());
    if (have.len() as i64) < expected {
        // One merged range covers every hole; the window is at most 2000 bars.
        let present: std::collections::HashSet<i64> =
            have.iter().map(|c| c.bar.start.timestamp()).collect();
        // 每根的开盘时刻按周期自己走，月线是日历月，不能用等差秒数铺。
        let missing: Vec<DateTime<Utc>> = (0..expected)
            .map(|k| p.iv.add_bars(p.start, k))
            .filter(|t| !present.contains(&t.timestamp()))
            .collect();
        if let (Some(first), Some(last)) = (missing.first(), missing.last()) {
            let from = *first;
            let to = p.iv.add_bars(*last, 1);
            let (bars, used) = fetch(s, &p, from, to).await?;
            source = source_name(&used).into();
            store(s, &p, &bars, &source).await?;
            let known: std::collections::HashSet<i64> = present;
            for bar in bars {
                if bar.start >= p.start
                    && bar.end <= p.end
                    && !known.contains(&bar.start.timestamp())
                {
                    have.push(Cached {
                        bar,
                        source: source.clone(),
                    });
                }
            }
            have.sort_by_key(|c| c.bar.start);
        }
    }
    // A cache hit still keeps the window alive for the rest of the session.
    sqlx::query("UPDATE replay_bars SET expires_at=now()+make_interval(hours=>$6::int) WHERE market=$1 AND symbol=$2 AND interval=$3 AND bar_start>=$4 AND bar_end<=$5")
        .bind(&p.market).bind(&p.symbol).bind(p.iv.as_str()).bind(p.start).bind(p.end).bind(CACHE_HOURS as i32)
        .execute(&s.db.pool).await?;
    let bars: Vec<Bar> = have.into_iter().map(|c| c.bar).collect();
    let coverage_complete = (bars.len() as i64) == expected
        && bars.first().is_some_and(|b| b.start == p.start)
        && bars.last().is_some_and(|b| b.end == p.end)
        && bars.windows(2).all(|w| w[0].end == w[1].start);
    let bars_before = p.iv.bars_between(p.start, p.iv.floor(p.judgment)).max(0);

    let short = p.criteria.direction.as_deref() == Some("S")
        && matches!(
            p.criteria.template,
            Template::T1 | Template::T2 | Template::T3
        );
    let marks = match &p.marks {
        Some(m) => {
            let from = m["trigger_at"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.with_timezone(&Utc))
                .unwrap_or(p.judgment);
            let to = m["end_at"]
                .as_str()
                .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
                .map(|v| v.with_timezone(&Utc))
                .unwrap_or(p.end)
                .min(p.end);
            let extreme = |high: bool| extreme_at(&bars, from, to, high);
            json!({
                "outcome_id":p.outcome_id,
                "state":m["state"],
                "reason":m["reason"],
                "trigger_at":m["trigger_at"],
                "trigger_price":m["trigger_price"],
                "first_threshold_interval":m["first_threshold_interval"],
                "invalidation_hit":m["invalidation_hit"],
                "end_at":m["end_at"],
                "signed_return":m["signed_return"],
                "mfe":m["mfe"],
                "mae":m["mae"],
                "mfe_at":if m["mfe"].is_null(){Value::Null}else{extreme(!short).unwrap_or(Value::Null)},
                "mae_at":if m["mae"].is_null(){Value::Null}else{extreme(short).unwrap_or(Value::Null)},
            })
        }
        None => Value::Null,
    };
    let expires = Utc::now() + Duration::hours(CACHE_HOURS);
    Ok(json!({
        "call_id":p.call,
        "symbol":p.symbol,
        "market":p.market,
        "interval":p.iv.as_str(),
        "source":source,
        "window":{"start_at":p.start,"end_at":p.end,"bars_before":bars_before,"truncated":p.truncated,"coverage_complete":coverage_complete},
        "judgment":{"at":p.judgment,"base_price":p.base,"atr0":p.atr0},
        "levels":p.levels,
        "marks":marks,
        "locating":super::locate::locating_for_call(s,owner,p.call).await?,
        "bars":bars,
        "storage_policy":format!("temporary;expires_at={}",expires.to_rfc3339()),
    }))
}

/// Drop this record's cached window. `replay_bars` rows are the only rows the
/// replay feature ever deletes.
pub async fn clear(s: &Services, owner: Uuid, call: Uuid) -> Result<Value> {
    let p = plan(s, owner, call).await?;
    let removed = sqlx::query("DELETE FROM replay_bars WHERE market=$1 AND symbol=$2 AND interval=$3 AND bar_start>=$4 AND bar_end<=$5")
        .bind(&p.market).bind(&p.symbol).bind(p.iv.as_str()).bind(p.start).bind(p.end)
        .execute(&s.db.pool).await?.rows_affected();
    Ok(json!({"call_id":call,"deleted":removed}))
}

/// Hourly maintenance: expired display cache leaves no trace.
pub async fn sweep(s: &Services) -> Result<u64> {
    Ok(
        sqlx::query("DELETE FROM replay_bars WHERE expires_at<now()")
            .execute(&s.db.pool)
            .await?
            .rows_affected(),
    )
}

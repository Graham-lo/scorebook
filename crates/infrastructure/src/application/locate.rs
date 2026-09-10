//! Pinning a screenshot to real Binance bars, once, in the background.
//!
//! Publishing a review is the moment a record is finished, so that is when each
//! scene screenshot that has never been pinned gets one automatic match. The
//! only thing keeping two matches off the same screenshot is the jobs table's
//! own `UNIQUE(owner_id,kind,dedupe_key)`: the automatic key is the attachment
//! id, so the automatic attempt happens at most once ever, and a manual request
//! joins a queued or running job instead of starting a second one. No lock
//! table, no shared writable state, and a location the trader confirmed is
//! never overwritten — the automatic job only ever inserts, and reports
//! `already_located` when a row is already there.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::error::{Error, Result};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub const KIND: &str = "attachment.locate";
const ACTIVE: [&str; 3] = ["queued", "retry_wait", "running"];

/// How sure an automatic match has to be before it is written down.
///
/// `chart_match::rerank` scores `exp(-6 * alignment_cost)`, so 0.85 is roughly
/// a hundredth of a normalized candle of drift per bar: the level the existing
/// chart-search acceptance treats as "the same chart", not merely a similar
/// one. The margin keeps the runner-up clearly behind, because a screenshot
/// that fits two windows equally well has not actually been identified.
fn thresholds() -> (f64, f64) {
    let read = |name: &str, fallback: f64| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(fallback)
    };
    (
        read("SCOREBOOK_AUTO_LOCATE_MIN_SCORE", 0.85),
        read("SCOREBOOK_AUTO_LOCATE_MIN_MARGIN", 0.05),
    )
}

fn score_of(item: &Value) -> f64 {
    item["match"]["score"].as_f64().unwrap_or(0.)
}

/// Write the match down only when it is unambiguous: the best window has to
/// look like the screenshot, and the runner-up has to be clearly behind it.
/// Anything else is handed back as candidates for the trader to choose from.
fn confident(items: &[Value], min_score: f64, min_margin: f64) -> bool {
    let Some(top) = items.first() else {
        return false;
    };
    score_of(top) >= min_score
        && items
            .get(1)
            .is_none_or(|second| score_of(top) - score_of(second) >= min_margin)
}

async fn owned(tx: &mut Transaction<'_, Postgres>, owner: Uuid, attachment: Uuid) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(attachment)
            .fetch_one(&mut **tx)
            .await?;
    if exists {
        Ok(())
    } else {
        Err(Error::not_found())
    }
}

const LOCATION: &str = "SELECT (to_jsonb(al)-'owner_id'-'score')||jsonb_build_object('score',al.score::text) FROM attachment_locations al WHERE al.owner_id=$1 AND al.attachment_id=$2";
const LATEST_JOB: &str = "SELECT jsonb_build_object('id',j.id,'status',j.status,'result',j.result,'created_at',j.created_at) FROM jobs j WHERE j.owner_id=$1 AND j.kind='attachment.locate' AND j.body->>'attachment_id'=$2::text ORDER BY j.created_at DESC,j.id DESC LIMIT 1";

/// The screenshot's pin and the most recent attempt at making one.
pub async fn get(s: &Services, owner: Uuid, attachment: Uuid) -> Result<Value> {
    let mut tx = s.db.pool.begin().await?;
    owned(&mut tx, owner, attachment).await?;
    let location: Option<Value> = sqlx::query_scalar(LOCATION)
        .bind(owner)
        .bind(attachment)
        .fetch_optional(&mut *tx)
        .await?;
    let job: Option<Value> = sqlx::query_scalar(LATEST_JOB)
        .bind(owner)
        .bind(attachment.to_string())
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"location":location,"job":job}))
}

/// The record this screenshot can be matched against: it has to name an
/// instrument and a timeframe, because a match without them has nothing to
/// search in.
async fn matchable_call(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    attachment: Uuid,
) -> Result<Uuid> {
    sqlx::query_scalar("SELECT c.id FROM calls c JOIN call_attachments l ON l.owner_id=c.owner_id AND l.call_id=c.id WHERE l.owner_id=$1 AND l.attachment_id=$2 AND c.instrument IS NOT NULL AND c.timeframe IS NOT NULL ORDER BY c.submitted_at,c.id LIMIT 1")
        .bind(owner)
        .bind(attachment)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| Error::conflict("replay_needs_instrument"))
}

/// Manual trigger. A queued or running job is returned as it is; only when
/// nothing is in flight does a new attempt start, under its own key so the
/// once-ever automatic key stays untouched.
pub async fn request(s: &Services, owner: Uuid, attachment: Uuid, key: &str) -> Result<Value> {
    let body = json!({"attachment_id":attachment});
    let (mut tx, cached) = s.db.write(owner, "attachment.locate", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    owned(&mut tx, owner, attachment).await?;
    let active: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',j.id,'status',j.status,'result',j.result,'created_at',j.created_at) FROM jobs j WHERE j.owner_id=$1 AND j.kind='attachment.locate' AND j.body->>'attachment_id'=$2::text AND j.status=ANY($3) ORDER BY j.created_at DESC,j.id DESC LIMIT 1")
        .bind(owner)
        .bind(attachment.to_string())
        .bind(ACTIVE.as_slice())
        .fetch_optional(&mut *tx)
        .await?;
    let deduplicated = active.is_some();
    let job = match active {
        Some(v) => v,
        None => {
            let call = matchable_call(&mut tx, owner, attachment).await?;
            // Every earlier job for this screenshot is finished, so their count
            // is what makes this attempt's key unique.
            let done:i64=sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='attachment.locate' AND body->>'attachment_id'=$2::text")
                .bind(owner).bind(attachment.to_string()).fetch_one(&mut *tx).await?;
            let id = jobs::enqueue_tx(
                &mut tx,
                owner,
                KIND,
                &format!("{attachment}:manual:{done}"),
                json!({"call_id":call,"attachment_id":attachment,"trigger":"manual"}),
            )
            .await?;
            sqlx::query_scalar("SELECT jsonb_build_object('id',j.id,'status',j.status,'result',j.result,'created_at',j.created_at) FROM jobs j WHERE j.id=$1")
                .bind(id).fetch_one(&mut *tx).await?
        }
    };
    let location: Option<Value> = sqlx::query_scalar(LOCATION)
        .bind(owner)
        .bind(attachment)
        .fetch_optional(&mut *tx)
        .await?;
    let v = json!({"location":location,"job":job,"deduplicated":deduplicated});
    crate::adapters::db::Database::finish(&mut tx, owner, "attachment.locate", key, &body, &v)
        .await?;
    tx.commit().await?;
    Ok(v)
}

/// One automatic attempt per never-pinned scene screenshot of a finished
/// record, enqueued inside the transaction that published the review.
pub async fn enqueue_after_review(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    call: Uuid,
) -> Result<()> {
    // Without an instrument and a timeframe there is nothing to match against.
    let matchable:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM calls WHERE owner_id=$1 AND id=$2 AND instrument IS NOT NULL AND timeframe IS NOT NULL)")
        .bind(owner).bind(call).fetch_one(&mut **tx).await?;
    if !matchable {
        return Ok(());
    }
    let pending: Vec<Uuid> = sqlx::query_scalar("SELECT a.id FROM attachments a JOIN call_attachments l ON l.owner_id=a.owner_id AND l.attachment_id=a.id WHERE l.owner_id=$1 AND l.call_id=$2 AND a.kind='scene' AND NOT EXISTS(SELECT 1 FROM attachment_locations al WHERE al.owner_id=a.owner_id AND al.attachment_id=a.id) ORDER BY a.uploaded_at,a.id")
        .bind(owner).bind(call).fetch_all(&mut **tx).await?;
    for attachment in pending {
        match jobs::enqueue_tx(
            tx,
            owner,
            KIND,
            &attachment.to_string(),
            json!({"call_id":call,"attachment_id":attachment,"trigger":"review_published"}),
        )
        .await
        {
            Ok(_) => {}
            // A full queue must never cost the trader their review; the
            // screenshot can still be pinned by hand later.
            Err(e) if e.code == "queue_capacity_reached" => break,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// What the replay stage shows while a match is still running: the record has
/// no pinned screenshot yet, but an attempt is in flight.
pub async fn locating_for_call(s: &Services, owner: Uuid, call: Uuid) -> Result<Value> {
    let pinned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachment_locations al JOIN call_attachments l ON l.owner_id=al.owner_id AND l.attachment_id=al.attachment_id WHERE al.owner_id=$1 AND l.call_id=$2)")
        .bind(owner).bind(call).fetch_one(&s.db.pool).await?;
    if pinned {
        return Ok(Value::Null);
    }
    let job:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('job_id',j.id,'status',j.status) FROM jobs j WHERE j.owner_id=$1 AND j.kind='attachment.locate' AND j.body->>'call_id'=$2::text AND j.status=ANY($3) ORDER BY j.created_at DESC,j.id DESC LIMIT 1")
        .bind(owner).bind(call.to_string()).bind(ACTIVE.as_slice()).fetch_optional(&s.db.pool).await?;
    Ok(job.unwrap_or(Value::Null))
}

fn named<'a>(candidate: &'a Value, field: &str) -> Result<&'a str> {
    candidate[field]
        .as_str()
        .ok_or_else(|| Error::bad("invalid_candidate"))
}

fn source_name(candidate: &Value) -> &'static str {
    let named = candidate["chart_request"]["source"]
        .as_str()
        .or_else(|| candidate["market_source"].as_str());
    match named {
        Some("monthly_archive") => "monthly_archive",
        _ => "rest",
    }
}

/// The worker's side: run the same bounded screenshot search a manual pin runs,
/// against the record's own contract and timeframe, as of the judgment moment.
pub async fn run(s: &Services, j: &Job) -> Result<Value> {
    let attachment: Uuid = serde_json::from_value(j.body["attachment_id"].clone())
        .map_err(|_| Error::bad("invalid_locate_job"))?;
    let call: Uuid = serde_json::from_value(j.body["call_id"].clone())
        .map_err(|_| Error::bad("invalid_locate_job"))?;
    let existing: Option<Value> = sqlx::query_scalar(LOCATION)
        .bind(j.owner)
        .bind(attachment)
        .fetch_optional(&s.db.pool)
        .await?;
    if let Some(location) = existing {
        return Ok(
            json!({"outcome":"already_located","attachment_id":attachment,"location":location}),
        );
    }
    let row = sqlx::query(
        "SELECT submitted_at,instrument,market,timeframe,body FROM calls WHERE owner_id=$1 AND id=$2",
    )
    .bind(j.owner)
    .bind(call)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)?;
    let symbol: Option<String> = row.get("instrument");
    let symbol = symbol
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| Error::conflict("replay_needs_instrument"))?;
    let market: Option<String> = row.get("market");
    let market = market.unwrap_or_else(|| "usd_m".into());
    let timeframe: Option<String> = row.get("timeframe");
    let interval = super::replay::interval_for(timeframe.as_deref())?;
    let submitted: DateTime<Utc> = row.get("submitted_at");
    let body: Value = row.get("body");
    // The judgment moment, exactly as the replay window uses it: nothing the
    // market revealed afterwards may take part in identifying the screenshot.
    let judgment: DateTime<Utc> = body["original_claimed_at"]
        .as_str()
        .and_then(|v| DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.with_timezone(&Utc))
        .unwrap_or(submitted);
    // Nothing can be recognised against an index that does not exist. This
    // machine deliberately runs no history sync, so the windows this search
    // needs are built here, now, around this one judgment moment.
    let index = ensure_index(s, j, &market, &symbol, &interval, judgment).await?;
    let input = json!({"attachment_id":attachment,"region":null,"scope":"binance_history","symbol":symbol,"market":market,"interval":interval,"cutoff_at":judgment,"reverse":false,"red_up":false,"limit":3});
    // This job is the search run, so its candidates stay readable afterwards at
    // GET /v1/chart-search/runs/{id} and the written location can cite it.
    sqlx::query("INSERT INTO chart_search_runs(id,owner_id,attachment_id,body) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body,result=NULL,completed_at=NULL")
        .bind(j.id).bind(j.owner).bind(attachment).bind(&input).execute(&s.db.pool).await?;
    let result = super::chart_search::run(
        s,
        &Job {
            body: input,
            ..j.clone()
        },
    )
    .await?;
    let top: Vec<Value> = result["items"]
        .as_array()
        .map(|v| v.iter().take(3).cloned().collect())
        .unwrap_or_default();
    let mut decided = decide(s, j, attachment, &top).await?;
    if let Some(o) = decided.as_object_mut() {
        o.insert("index".into(), index);
    }
    Ok(decided)
}

/// The bounded index this one match needs, and not one bar more.
///
/// The range is the replay window's own: `[T0 − 3×256 bars, T0 floored to the
/// interval]`, which is wide enough that the screenshot's window sits inside it
/// wherever within the last few hundred bars it was taken. All three window
/// sizes the search looks through are built, at stride 1, because a coarser
/// stride would move the reported boundaries by up to stride−1 bars and the
/// window written into `attachment_locations` has to be the real one.
///
/// This is not history sync: it subscribes to nothing, rolls forward nowhere,
/// and stores vectors plus time coordinates only. It happens once, with the
/// match, and the bars are dropped when it returns.
pub async fn ensure_index(
    s: &Services,
    j: &Job,
    market: &str,
    symbol: &str,
    interval: &str,
    judgment: DateTime<Utc>,
) -> Result<Value> {
    let step = super::history::interval_seconds(interval)?;
    let end = super::replay::floor_at(judgment, step);
    let bars = 3 * super::history::LOCATE_WINDOWS[2] as i64;
    let start = end - chrono::Duration::seconds(step * bars);
    let range = json!({"market":market,"symbol":symbol,"interval":interval,"start_at":start,"end_at":end,"bars":bars});
    if super::history::covered(s, market, symbol, interval, start, end).await? {
        return Ok(json!({"built":false,"reason":"already_indexed","range":range}));
    }
    let mut feature_rows = 0i64;
    let mut actual_start: Option<Value> = None;
    for window_bars in super::history::LOCATE_WINDOWS {
        let coverage = super::history::index_range(
            s,
            j,
            &super::history::HistoryIndexRequest {
                source: super::history::HistorySource::Rest,
                symbol: symbol.into(),
                market: market.into(),
                interval: interval.into(),
                start_at: start,
                end_at: end,
                window_bars,
                stride_bars: 1,
                models: vec![scorebook_core::domain::chart_match::MODEL.into()],
            },
        )
        .await?;
        feature_rows += coverage["feature_rows"].as_i64().unwrap_or(0);
        if actual_start.is_none() && !coverage["actual_start"].is_null() {
            actual_start = Some(coverage["actual_start"].clone());
        }
    }
    Ok(
        json!({"built":true,"feature_rows":feature_rows,"range":range,"windows":super::history::LOCATE_WINDOWS,"stride_bars":1,"actual_start":actual_start,"raw_market_storage":"none"}),
    )
}

/// The decision, kept apart from where the windows came from: either the best
/// one is unmistakable and gets written down, or the shortlist goes back to the
/// trader. Separate so it can be exercised against known candidates.
pub async fn decide(s: &Services, j: &Job, attachment: Uuid, items: &[Value]) -> Result<Value> {
    let top: Vec<Value> = items.iter().take(3).cloned().collect();
    let (min_score, min_margin) = thresholds();
    if !confident(&top, min_score, min_margin) {
        return Ok(
            json!({"outcome":"ambiguous","attachment_id":attachment,"search_run_id":j.id,"candidates":top,"min_score":min_score,"min_margin":min_margin}),
        );
    }
    let best = &top[0];
    let start: DateTime<Utc> = serde_json::from_value(best["start_at"].clone())
        .map_err(|_| Error::bad("invalid_candidate"))?;
    let end: DateTime<Utc> = serde_json::from_value(best["end_at"].clone())
        .map_err(|_| Error::bad("invalid_candidate"))?;
    let score = score_of(best).to_string();
    // Insert only: a row the trader confirmed in the meantime stays theirs.
    let written: Option<Value> = sqlx::query_scalar(
        r#"INSERT INTO attachment_locations(owner_id,attachment_id,symbol,market,interval,start_at,end_at,bars_count,source,score,search_run_id,matched_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text::numeric,$11,'auto') ON CONFLICT(owner_id,attachment_id) DO NOTHING
        RETURNING (to_jsonb(attachment_locations)-'owner_id'-'score')||jsonb_build_object('score',score::text)"#,
    )
    .bind(j.owner)
    .bind(attachment)
    .bind(named(best, "symbol")?)
    .bind(named(best, "market")?)
    .bind(named(best, "interval")?)
    .bind(start)
    .bind(end)
    .bind(best["bars_count"].as_i64().map(|v| v as i32))
    .bind(source_name(best))
    .bind(&score)
    .bind(j.id)
    .fetch_optional(&s.db.pool)
    .await?;
    match written {
        Some(location) => Ok(
            json!({"outcome":"located","attachment_id":attachment,"search_run_id":j.id,"score":score,"location":location}),
        ),
        None => Ok(json!({"outcome":"already_located","attachment_id":attachment})),
    }
}

#[cfg(test)]
mod decision_tests {
    use super::*;
    fn item(score: f64) -> Value {
        json!({"match":{"score":score}})
    }
    #[test]
    fn only_an_unambiguous_best_window_is_written_down() {
        assert!(confident(&[item(0.93)], 0.85, 0.05));
        assert!(confident(&[item(0.93), item(0.6)], 0.85, 0.05));
        // Close enough to be a coin toss: the trader chooses instead.
        assert!(!confident(&[item(0.93), item(0.91)], 0.85, 0.05));
        // Nothing that looks like the screenshot at all.
        assert!(!confident(&[item(0.4)], 0.85, 0.05));
        assert!(!confident(&[], 0.85, 0.05));
    }
}

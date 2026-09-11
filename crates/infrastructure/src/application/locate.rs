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
use scorebook_core::api::replay::LocateOverride;
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

/// 这张图上指定的品种。三项都可省；给了就必须是真能去找的东西。
///
/// 同板块对比图是常态：一条记录的三张场景图可以各是各的标的，所以"按图指定"
/// 才是对的，记录自己的 instrument 只是默认值。
fn checked_override(input: &LocateOverride) -> Result<LocateOverride> {
    let trimmed = |v: &Option<String>| -> Option<String> {
        v.as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let symbol = trimmed(&input.symbol);
    let market = trimmed(&input.market);
    let interval = trimmed(&input.interval);
    if let Some(symbol) = &symbol {
        super::history_catalog::validate_symbol(symbol)?;
    }
    if market
        .as_deref()
        .is_some_and(|v| !matches!(v, "usd_m" | "coin_m"))
    {
        return Err(Error::bad("invalid_market"));
    }
    let interval = match interval {
        Some(v) => Some(super::replay::interval_for(Some(&v))?),
        None => None,
    };
    Ok(LocateOverride {
        symbol,
        market,
        interval,
    })
}

/// 记录本身的三元组，作为没被覆盖时的默认值。
async fn call_target(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    call: Uuid,
) -> Result<(String, String, String)> {
    let row =
        sqlx::query("SELECT instrument,market,timeframe FROM calls WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(call)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(Error::not_found)?;
    let symbol: Option<String> = row.get("instrument");
    let symbol = symbol
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| Error::conflict("replay_needs_instrument"))?;
    let market: Option<String> = row.get("market");
    let timeframe: Option<String> = row.get("timeframe");
    Ok((
        symbol,
        market.unwrap_or_else(|| "usd_m".into()),
        super::replay::interval_for(timeframe.as_deref())?,
    ))
}

/// 这张截图自己写着的三元组，一张图至多读一次。
///
/// 「截图是闪迪或者 mu，默认应该把品种识别出来才对，没有识别出来让用户自己
/// 选择」：同板块对比图上的标的跟记录本身的不是一回事，图上那行代码 OCR 一直读
/// 得出来，只是从没人问过它。
///
/// 三道闸把这条路的代价和风险都关住：已经钉住的图不必再猜，读过的图直接取
/// `attachment_reads` 里那一行（面板两秒轮询一次 GET locate，不能每轮都开一个
/// OCR 子进程），读出来的东西不管是不是空的都记一行——「看过了」本身就是结论。
///
/// 出错一律当作没认出来：OCR 可执行文件没配、视觉服务停着，读这一条路也得照常
/// 200 回原来的兜底值。只有这张图自己永远读不出来（字节对不上、OCR 返回的东西
/// 不合法）才记行，能力性的不可用不记——不然视觉服务停一阵，每张图都会被永久
/// 标成「看过了」。
async fn screenshot_reading(s: &Services, owner: Uuid, attachment: Uuid) -> LocateOverride {
    let nothing = LocateOverride::default();
    let pinned: std::result::Result<bool, _> = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM attachment_locations WHERE owner_id=$1 AND attachment_id=$2)",
    )
    .bind(owner)
    .bind(attachment)
    .fetch_one(&s.db.pool)
    .await;
    if !matches!(pinned, Ok(false)) {
        return nothing;
    }
    let cached: Option<(Option<String>, Option<String>)> = match sqlx::query_as(
        "SELECT symbol,interval FROM attachment_reads WHERE owner_id=$1 AND attachment_id=$2",
    )
    .bind(owner)
    .bind(attachment)
    .fetch_optional(&s.db.pool)
    .await
    {
        Ok(v) => v,
        Err(_) => return nothing,
    };
    let (symbol, interval) = match cached {
        Some(v) => v,
        None => match super::chart_search::read_labels(s, owner, attachment).await {
            Ok((symbol, _, interval)) => {
                let _ = sqlx::query("INSERT INTO attachment_reads(owner_id,attachment_id,symbol,interval) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,attachment_id) DO NOTHING")
                    .bind(owner).bind(attachment).bind(&symbol).bind(&interval)
                    .execute(&s.db.pool).await;
                (symbol, interval)
            }
            Err(e) => {
                if e.kind == crate::error::ErrorKind::Invalid {
                    let _ = sqlx::query("INSERT INTO attachment_reads(owner_id,attachment_id,symbol,interval) VALUES($1,$2,NULL,NULL) ON CONFLICT(owner_id,attachment_id) DO NOTHING")
                        .bind(owner).bind(attachment).execute(&s.db.pool).await;
                }
                tracing::debug!(code = %e.code, "screenshot label read did not produce a default");
                return nothing;
            }
        },
    };
    // 市场跟着认出来的品种走，不继承记录的：对比图上的标的未必同市场。现查
    // catalog 而不是存进 attachment_reads，这张表只记 OCR 看见的东西。
    let market = match &symbol {
        Some(symbol) => sqlx::query_scalar::<_, String>(
            "SELECT market FROM instrument_catalog WHERE symbol=$1 GROUP BY market HAVING count(*)>0",
        )
        .bind(symbol)
        .fetch_all(&s.db.pool)
        .await
        .ok()
        .filter(|v| v.len() == 1)
        .and_then(|v| v.into_iter().next()),
        None => None,
    };
    LocateOverride {
        symbol,
        market,
        interval,
    }
}

/// 调用方这次明确挑过的那几格。job 体里的三元组一向是满的——没挑的由
/// `call_target` 补成记录自己的——所以只有另记一份凭据，事后才分得出
/// 「有人选了它」和「那天的默认值」。
fn chosen_fields(over: &LocateOverride) -> Vec<&'static str> {
    [
        ("symbol", &over.symbol),
        ("market", &over.market),
        ("interval", &over.interval),
    ]
    .into_iter()
    .filter(|(_, v)| v.is_some())
    .map(|(name, _)| name)
    .collect()
}

/// job 这一层只对挑过的那几格说话。
///
/// 「值在 job 体里」从来不等于「有人选过它」：`request` 给没覆盖的格子填的是记录
/// 当天的标的，`enqueue_after_review` 更是整组都来自记录。这些默认值一旦被当成
/// 决定，一张跑过定位的图就永远被第一次的默认值盖住——SK 海力士那条记录里，图上
/// 明明写着 SNDK/MU，九张却全解析成 SKHYUSDT。没有这份凭据的 job（改这条规则之前
/// 入队的全部，以及复盘发布排的每一条）一律按「一格都没挑」算，让位给图上写着的。
fn picked(job: Option<&Value>, key: &str) -> Option<String> {
    let job = job?;
    let chosen = job["chosen"].as_array()?;
    if !chosen.iter().any(|v| v.as_str() == Some(key)) {
        return None;
    }
    job[key].as_str().map(str::to_string)
}

/// 实际用来找图的三元组：这次给的覆盖值最优先，其次是最近一次 job 里**挑过**的
/// 那几格，再次是图上自己写着的，最后才是记录本身的。逐格论资排辈：一次只挑了
/// 周期的请求，不该把它随手带上的品种也一起抬进来。任何一格查不出来就留 null，
/// 不编。
async fn resolved(
    tx: &mut Transaction<'_, Postgres>,
    owner: Uuid,
    attachment: Uuid,
    over: &LocateOverride,
    read: &LocateOverride,
) -> Result<Value> {
    let job: Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('symbol',j.body->>'symbol','market',j.body->>'market','interval',j.body->>'interval','chosen',j.body->'chosen') FROM jobs j WHERE j.owner_id=$1 AND j.kind='attachment.locate' AND j.body->>'attachment_id'=$2::text ORDER BY j.created_at DESC,j.id DESC LIMIT 1")
        .bind(owner)
        .bind(attachment.to_string())
        .fetch_optional(&mut **tx)
        .await?;
    let call = sqlx::query_scalar::<_, Uuid>("SELECT c.id FROM calls c JOIN call_attachments l ON l.owner_id=c.owner_id AND l.call_id=c.id WHERE l.owner_id=$1 AND l.attachment_id=$2 ORDER BY c.submitted_at,c.id LIMIT 1")
        .bind(owner)
        .bind(attachment)
        .fetch_optional(&mut **tx)
        .await?;
    let from_call = match call {
        Some(call) => call_target(tx, owner, call).await.ok(),
        None => None,
    };
    let pick =
        |given: Option<&str>, key: &str, seen: Option<&str>, fallback: Option<&str>| -> Value {
            given
                .map(str::to_string)
                .or_else(|| picked(job.as_ref(), key))
                .or_else(|| seen.map(str::to_string))
                .or_else(|| fallback.map(str::to_string))
                .map(Value::String)
                .unwrap_or(Value::Null)
        };
    Ok(json!({
        "symbol":pick(over.symbol.as_deref(),"symbol",read.symbol.as_deref(),from_call.as_ref().map(|t|t.0.as_str())),
        "market":pick(over.market.as_deref(),"market",read.market.as_deref(),from_call.as_ref().map(|t|t.1.as_str())),
        "interval":pick(over.interval.as_deref(),"interval",read.interval.as_deref(),from_call.as_ref().map(|t|t.2.as_str())),
    }))
}

const LOCATION: &str = "SELECT (to_jsonb(al)-'owner_id'-'score')||jsonb_build_object('score',al.score::text) FROM attachment_locations al WHERE al.owner_id=$1 AND al.attachment_id=$2";
const LATEST_JOB: &str = "SELECT jsonb_build_object('id',j.id,'status',j.status,'result',j.result,'created_at',j.created_at) FROM jobs j WHERE j.owner_id=$1 AND j.kind='attachment.locate' AND j.body->>'attachment_id'=$2::text ORDER BY j.created_at DESC,j.id DESC LIMIT 1";

/// The screenshot's pin and the most recent attempt at making one.
pub async fn get(s: &Services, owner: Uuid, attachment: Uuid) -> Result<Value> {
    // 先读图，再开事务：OCR 要一枚视觉许可加一个子进程，不该攥着数据库连接跑。
    let read = screenshot_reading(s, owner, attachment).await;
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
    let used = resolved(
        &mut tx,
        owner,
        attachment,
        &LocateOverride::default(),
        &read,
    )
    .await?;
    tx.commit().await?;
    Ok(
        json!({"location":location,"job":job,"symbol":used["symbol"],"market":used["market"],"interval":used["interval"]}),
    )
}

/// The record this screenshot can be matched against: it has to name an
/// instrument and a timeframe, because a match without them has nothing to
/// search in.
pub async fn matchable_call(
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
pub async fn request(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
    key: &str,
    input: LocateOverride,
) -> Result<Value> {
    let over = checked_override(&input)?;
    // GET 与 POST 回显的默认值得是同一份，所以这里也问一次图；读过之后是一次
    // 主键查表，没有第二个 OCR 子进程。
    let read = screenshot_reading(s, owner, attachment).await;
    // 覆盖值进指纹：同一把 Idempotency-Key 换了品种就是另一次请求，不该回放旧结果。
    // 不给覆盖时指纹与从前逐字节相同。
    let mut body = json!({"attachment_id":attachment});
    for (name, value) in [
        ("symbol", &over.symbol),
        ("market", &over.market),
        ("interval", &over.interval),
    ] {
        if let Some(v) = value {
            body[name] = json!(v);
        }
    }
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
            // worker 读的是 job 体，所以实际用的三元组在这里就定下来，
            // 它跑的时候记录被改成别的品种也不影响这一次。
            let (symbol, market, interval) = call_target(&mut tx, owner, call).await?;
            let symbol = over.symbol.clone().unwrap_or(symbol);
            let market = over.market.clone().unwrap_or(market);
            let interval = over.interval.clone().unwrap_or(interval);
            // Every earlier job for this screenshot is finished, so their count
            // is what makes this attempt's key unique.
            let done:i64=sqlx::query_scalar("SELECT count(*) FROM jobs WHERE owner_id=$1 AND kind='attachment.locate' AND body->>'attachment_id'=$2::text")
                .bind(owner).bind(attachment.to_string()).fetch_one(&mut *tx).await?;
            // 三元组照旧写满（worker 读的就是这三格，一个字节都不能变），另记
            // 一份「这几格是人选的」：其余几格只是当天记录的标的，事后不该拿它
            // 去盖图上写着的东西。
            let chosen = chosen_fields(&over);
            let id = jobs::enqueue_tx(
                &mut tx,
                owner,
                KIND,
                &format!("{attachment}:manual:{done}"),
                json!({"call_id":call,"attachment_id":attachment,"trigger":"manual","symbol":symbol,"market":market,"interval":interval,"chosen":chosen}),
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
    let used = resolved(
        &mut tx,
        owner,
        attachment,
        &LocateOverride::default(),
        &read,
    )
    .await?;
    let v = json!({"location":location,"job":job,"deduplicated":deduplicated,"symbol":used["symbol"],"market":used["market"],"interval":used["interval"]});
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
    // 这张图上指定的品种；手动请求已经把实际要用的三元组写进 job 体了。
    let over = LocateOverride {
        symbol: j.body["symbol"].as_str().map(str::to_string),
        market: j.body["market"].as_str().map(str::to_string),
        interval: j.body["interval"].as_str().map(str::to_string),
    };
    if let Some(location) = existing {
        // 已经钉住的图就按钉住的那份回显，不去猜记录写的是什么。
        let echo = |key: &str, given: Option<&str>| -> Value {
            given
                .map(str::to_string)
                .or_else(|| location[key].as_str().map(str::to_string))
                .map(Value::String)
                .unwrap_or(Value::Null)
        };
        let (symbol, market, interval) = (
            echo("symbol", over.symbol.as_deref()),
            echo("market", over.market.as_deref()),
            echo("interval", over.interval.as_deref()),
        );
        return Ok(
            json!({"outcome":"already_located","attachment_id":attachment,"location":location,"symbol":symbol,"market":market,"interval":interval}),
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
    let symbol = over
        .symbol
        .clone()
        .or_else(|| symbol.filter(|v| !v.trim().is_empty()))
        .ok_or_else(|| Error::conflict("replay_needs_instrument"))?;
    let market: Option<String> = row.get("market");
    let market = over
        .market
        .clone()
        .or(market)
        .unwrap_or_else(|| "usd_m".into());
    let timeframe: Option<String> = row.get("timeframe");
    let interval = match &over.interval {
        Some(v) => super::replay::interval_for(Some(v))?,
        None => super::replay::interval_for(timeframe.as_deref())?,
    };
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
    let input = json!({"attachment_id":attachment,"region":null,"scope":"binance_history","symbol":&symbol,"market":&market,"interval":&interval,"cutoff_at":judgment,"reverse":false,"red_up":false,"limit":3});
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
        o.insert("symbol".into(), json!(symbol));
        o.insert("market".into(), json!(market));
        o.insert("interval".into(), json!(interval));
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
    let iv = super::history::interval_of(interval)?;
    let end = iv.floor(judgment);
    let bars = 3 * super::history::LOCATE_WINDOWS[2] as i64;
    // 按根数后退，1w/1M 这种对齐特殊或长度可变的周期也才是真的 768 根。
    let start = iv.add_bars(end, -bars);
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

#[cfg(test)]
mod provenance_tests {
    use super::*;
    fn some(v: &str) -> Option<String> {
        Some(v.to_string())
    }

    #[test]
    fn only_the_fields_the_caller_chose_are_marked() {
        assert!(chosen_fields(&LocateOverride::default()).is_empty());
        assert_eq!(
            chosen_fields(&LocateOverride {
                symbol: None,
                market: None,
                interval: some("15m"),
            }),
            ["interval"]
        );
        assert_eq!(
            chosen_fields(&LocateOverride {
                symbol: some("SNDKUSDT"),
                market: some("usd_m"),
                interval: some("1h"),
            }),
            ["symbol", "market", "interval"]
        );
    }

    #[test]
    fn a_job_speaks_only_for_what_someone_picked() {
        // 只挑了周期的那一次：品种是当天记录的默认值，跟着来的不算数。
        let one =
            json!({"symbol":"SKHYUSDT","market":"usd_m","interval":"15m","chosen":["interval"]});
        assert_eq!(picked(Some(&one), "interval"), some("15m"));
        assert_eq!(picked(Some(&one), "symbol"), None);
        assert_eq!(picked(Some(&one), "market"), None);

        // 改这条规则之前入队的 job，以及复盘发布排的那一条：没有凭据，一格都
        // 不算挑过——它们的三元组只是记录自己的标的，压不过图上写着的。
        let legacy = json!({"symbol":"SKHYUSDT","market":"usd_m","interval":"1h"});
        for key in ["symbol", "market", "interval"] {
            assert_eq!(picked(Some(&legacy), key), None);
        }
        let auto = json!({"trigger":"review_published"});
        assert_eq!(picked(Some(&auto), "symbol"), None);
        assert_eq!(picked(None, "symbol"), None);

        // 凭据说挑过、值却不在（谁手改过 job 体）：当没挑过，往下让。
        let torn = json!({"chosen":["symbol"]});
        assert_eq!(picked(Some(&torn), "symbol"), None);
    }
}

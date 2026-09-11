//! 刻舟求剑的索引广度：把月档归档批量灌进 `public_market.features`。
//!
//! 重温要的是「准」——一张记录的截图钉回它自己的品种和周期上，判断时刻可能就在昨天，
//! 所以走 REST。刻舟求剑要的是「广」——任意品种、任意周期的历史里找相似结构，看的全是
//! 已经归档的过去。所以这条路只走 `data.binance.vision` 的月档：
//! `adapters::binance_archive` 全文没有一处 `budget.reserve`，它是 S3 静态对象存储，
//! 不吃 fapi 的限频配额。整个方案成立就靠这一点，别把它换成 REST。
//!
//! 一根 K 线都不落盘。这里唯一写行情内容的语句是 `index_generation` 里的
//! `INSERT INTO public_market.features`（向量 + 时间坐标），bars 出了作用域就没了，
//! coverage 里照实写 `"raw_market_storage":"none"`。
//!
//! **一个月的 zip 只下载一次。** `history::index_range` 那条路是「一个请求一次行情」，
//! 三档窗口 × 多个时间片会把同一个月档下三到六遍。这里改成：一段范围的月档下载一次，
//! 拿到 bars 之后直接喂给 `history::index_generation`，三档窗口各建一个世代。
//!
//! 续跑是白拿的：`generations.status='ready'` + `coverage_segments.status='complete'`
//! + `features.published=true` 这三件一套本来就是永久标记，做完一个单元就有，
//! 下次扫到直接跳过。中途停最多丢正在做的那一个单元。
use super::*;
use chrono::NaiveDate;
use scorebook_core::domain::criteria::Bar;

/// 一步最多干多久。作业按 (品种, 周期, 一段月份) 推进，到点就把进度写下来、让出
/// 队列，下一步接着走——几小时的作业不该把 batch 队列一直占死，也不该做成
/// 「点一下等一会儿」。
const STEP_BUDGET: std::time::Duration = std::time::Duration::from_secs(45);
/// 同时下几个月档。S3 静态对象不限频，但也没必要往死里打。
const DOWNLOAD_FANOUT: usize = 6;
/// 一段范围最多几根 K 线。`history::validate` 卡的是「≤1000 个窗口」，
/// stride=4、window=64 时对应 64+999*4=4060 根，取 4000 留余量。
const CHUNK_BAR_BUDGET: i64 = 4000;
/// 一段范围的月数只在这几档里挑，都能整除 12 或者是 12 的倍数，所以网格从
/// 1970-01 起算之后正好落在自然年 / 季 / 月的边界上，跨次运行是稳定的。
const MONTH_LADDER: [i64; 9] = [1, 2, 3, 4, 6, 12, 24, 60, 120];
/// 一段里希望至少有这么多根，最大的 256 根窗口才放得下、还能多切出几个。
const CHUNK_BAR_TARGET: i64 = 512;
/// 三档窗口共用的步长。
const STRIDE: usize = 4;
/// 失败清单只留最近这么多条，不然一个作业跑几千个单元能把 jsonb 撑爆。
const FAILURE_LOG: usize = 50;

/// 作业入参：一次只做一个周期。用户明确要求能分开跑，粗周期跑完刻舟求剑就能在那一档
/// 上工作，细周期是大头，什么时候跑由人决定。
struct Scope {
    market: String,
    interval: String,
    top: usize,
}

fn scope_of(body: &Value) -> Result<Scope> {
    let market = body["market"]
        .as_str()
        .unwrap_or("usd_m")
        .to_string();
    let interval = body["interval"]
        .as_str()
        .ok_or_else(|| Error::bad("invalid_universe_job"))?
        .to_string();
    let top = body["top"].as_u64().unwrap_or(200) as usize;
    archives::archive_prefix(&market, "monthly")?;
    super::super::history::interval_of(&interval)?;
    if !(1..=1000).contains(&top) {
        return Err(Error::bad("invalid_universe_size"));
    }
    Ok(Scope {
        market,
        interval,
        top,
    })
}

/// 这一轮扇出的累计数字，每走完一个品种就落一次库。
#[derive(Default, Clone)]
struct Tally {
    built: i64,
    skipped: i64,
    failed: i64,
    months: i64,
    rows: i64,
    failures: Vec<Value>,
}

impl Tally {
    fn fail(&mut self, symbol: &str, at: &str, code: &str) {
        self.failures
            .push(json!({"symbol":symbol,"at":at,"code":code}));
        if self.failures.len() > FAILURE_LOG {
            let extra = self.failures.len() - FAILURE_LOG;
            self.failures.drain(0..extra);
        }
    }
}

/// 归档里缺一个月是常态不是错误：新币还没上市、合约已经下架、币安偶尔漏传。
/// `binance_archive` 把 404 写成 `Error::deferred(_, AwaitInput)`，那在 `jobs::complete`
/// 里会把整个作业挂成 `awaiting_input` 等人来管——对一个要扫两百个品种的扇出来说，
/// 一个缺失的月份不该有这种杀伤力。所以这里只把「租约丢了」往外抛（那是真的该停），
/// 其余一律记下来继续走。
fn fatal(e: &Error) -> bool {
    e.code.contains("lease")
}

fn at(year: i32, month: u32) -> Result<DateTime<Utc>> {
    NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|v| v.and_hms_opt(0, 0, 0))
        .map(|v| v.and_utc())
        .ok_or_else(|| Error::bad("invalid_date"))
}

/// 从 1970-01 起算的月序号。网格用绝对月序号而不是「这个品种的第一个月」，这样
/// 新月份发布之后老的分段边界不会整体平移，续跑和重跑都对得上。
fn month_start(index: i64) -> Result<DateTime<Utc>> {
    let year = 1970 + index.div_euclid(12);
    let month = index.rem_euclid(12) + 1;
    if !(1970..=3000).contains(&year) {
        return Err(Error::bad("invalid_date"));
    }
    at(year as i32, month as u32)
}

/// 一个月最短 28 天、最长 31 天，分段容量要按最长的那个月算才不会越界。
fn month_bars(iv: super::super::history::Interval) -> Result<(i64, i64)> {
    let short = iv.bars_between(at(2021, 2)?, at(2021, 3)?);
    let long = iv.bars_between(at(2021, 1)?, at(2021, 2)?);
    Ok((short.min(long), short.max(long)))
}

/// 一段放几个月：先找最小的一档，使最短的月份组合起来也有 512 根以上、最长的组合
/// 又没超过 4000 根；找不到就退而取还塞得下 4000 根上限的最大一档。
fn months_per_chunk(iv: super::super::history::Interval) -> Result<i64> {
    let (short, long) = month_bars(iv)?;
    if long <= 0 {
        return Ok(1);
    }
    Ok(MONTH_LADDER
        .iter()
        .copied()
        .find(|n| n * short >= CHUNK_BAR_TARGET && n * long <= CHUNK_BAR_BUDGET)
        .or_else(|| {
            MONTH_LADDER
                .iter()
                .rev()
                .copied()
                .find(|n| n * long <= CHUNK_BAR_BUDGET)
        })
        .unwrap_or(1))
}

/// `SYMBOL-1d-2024-07.zip` -> 2024-07 的绝对月序号。日档的 `-2024-07-15.zip` 解析不出
/// 月份（第二段带不上 `-`），会被丢掉，这正是想要的：这条路只吃月档。
fn month_of_key(key: &str, symbol: &str, segment: &str) -> Option<i64> {
    let name = key.rsplit('/').next()?;
    let rest = name
        .strip_prefix(&format!("{symbol}-{segment}-"))?
        .strip_suffix(".zip")?;
    let (year, month) = rest.split_once('-')?;
    let year: i64 = year.parse().ok()?;
    let month: i64 = month.parse().ok()?;
    if !(1970..=3000).contains(&year) || !(1..=12).contains(&month) {
        return None;
    }
    Some((year - 1970) * 12 + month - 1)
}

/// 这个品种这个周期在 S3 上到底有哪些月。顺手把结果写进
/// `public_market.history_availability`（`archives::discover` 自己干的），所以事后
/// 能对着账查「归档里有 N 个月、我建了几个月」。
async fn months(s: &Services, scope: &Scope, symbol: &str) -> Result<Vec<(i64, String)>> {
    let iv = super::super::history::interval_of(&scope.interval)?;
    let segment = iv.archive_segment();
    let mut cursor: Option<String> = None;
    let mut found = Vec::new();
    for _ in 0..32 {
        let page = archives::discover(
            s,
            ArchiveCatalogInput {
                market: scope.market.clone(),
                symbol: symbol.to_string(),
                interval: scope.interval.clone(),
                cursor: cursor.clone(),
            },
        )
        .await?;
        for item in page["items"].as_array().into_iter().flatten() {
            let Some(key) = item["source_key"].as_str() else {
                continue;
            };
            if let Some(index) = month_of_key(key, symbol, segment) {
                found.push((index, key.to_string()));
            }
        }
        if page["complete_listing"] == true {
            break;
        }
        let Some(next) = page["next_cursor"].as_str().map(str::to_string) else {
            break;
        };
        cursor = Some(next);
    }
    found.sort();
    found.dedup();
    Ok(found)
}

/// 一个工作单元：一段连续月份的时间范围，加上这段里归档真正有的那些月档 key。
struct Unit {
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    keys: Vec<String>,
}

fn units(iv: super::super::history::Interval, listing: &[(i64, String)]) -> Result<Vec<Unit>> {
    let (Some(first), Some(last)) = (listing.first(), listing.last()) else {
        return Ok(vec![]);
    };
    let n = months_per_chunk(iv)?;
    let now = Utc::now();
    let mut units = Vec::new();
    for block in first.0.div_euclid(n)..=last.0.div_euclid(n) {
        // 分段掐在品种自己的第一个月和最后一个月上：往前留空只会白拉一段没有数据的
        // 范围，往后越界会撞上 validate 的 `end_at > now`。
        let from = (block * n).max(first.0);
        let to = ((block + 1) * n).min(last.0 + 1);
        if from >= to {
            continue;
        }
        let (start, end) = (month_start(from)?, month_start(to)?);
        if end > now {
            continue;
        }
        let keys: Vec<String> = listing
            .iter()
            .filter(|(index, _)| (from..to).contains(index))
            .map(|(_, key)| key.clone())
            .collect();
        if keys.is_empty() {
            continue;
        }
        units.push(Unit { start, end, keys });
    }
    Ok(units)
}

/// 把一段里的月档并发下载、校验、解压、解析成内存里的 bars。返回 (bars, 来源明细,
/// 失败的 key)。下载完就只剩 bars 在内存里，压缩包和 CSV 都不落盘。
async fn fetch(
    s: &Services,
    unit: &Unit,
) -> (Vec<Bar>, Vec<Value>, Vec<(String, String)>) {
    let mut ok = Vec::new();
    let mut failed = Vec::new();
    // 按批并发：一次发 DOWNLOAD_FANOUT 个请求，等这一批回来再发下一批。
    for chunk in unit.keys.chunks(DOWNLOAD_FANOUT) {
        let batch = chunk.iter().map(|key| async move {
            (
                key.clone(),
                s.archives.klines(key, unit.start, unit.end).await,
            )
        });
        for (key, result) in futures_util::future::join_all(batch).await {
            match result {
                Ok(v) => ok.push((key, v)),
                Err(e) => failed.push((key, e.code)),
            }
        }
    }
    // key 里的 `YYYY-MM` 字典序就是时间序，排完直接拼。
    ok.sort_by(|a, b| a.0.cmp(&b.0));
    let mut bars = Vec::new();
    let mut sources = Vec::new();
    for (_, archive) in ok {
        sources.push(
            json!({"source_key":archive.source_key,"sha256":archive.sha256,"size_bytes":archive.size_bytes}),
        );
        bars.extend(archive.bars);
    }
    (bars, sources, failed)
}

async fn build_unit(
    s: &Services,
    j: &Job,
    scope: &Scope,
    symbol: &str,
    unit: &Unit,
    tally: &mut Tally,
) -> Result<()> {
    let iv = super::super::history::interval_of(&scope.interval)?;
    let span = iv.bars_between(unit.start, unit.end);
    // 一段太短就放不下大窗口。这不是失败，是这段范围本来就切不出 256 根的窗口。
    let needed: Vec<usize> = super::super::history::LOCATE_WINDOWS
        .into_iter()
        .filter(|w| span >= *w as i64)
        .collect();
    if needed.is_empty() {
        tally.skipped += 1;
        return Ok(());
    }
    let have = super::super::history::covered_windows(
        s,
        &scope.market,
        symbol,
        &scope.interval,
        unit.start,
        unit.end,
    )
    .await?;
    let missing: Vec<usize> = needed
        .into_iter()
        .filter(|w| !have.contains(&(*w as i32)))
        .collect();
    if missing.is_empty() {
        // 永久标记已经在：这一段不下载、不重算。续跑靠的就是这一句。
        tally.skipped += 1;
        return Ok(());
    }
    let expected = unit.keys.len();
    let (bars, sources, failed) = fetch(s, unit).await;
    tally.months += (expected - failed.len()) as i64;
    for (key, code) in &failed {
        tally.fail(symbol, key, code);
    }
    if bars.is_empty() {
        tally.failed += 1;
        return Ok(());
    }
    sqlx::query("INSERT INTO public_market.source_revisions(source_key,sha256,size_bytes) SELECT r.* FROM jsonb_to_recordset($1) r(source_key text,sha256 text,size_bytes bigint) ON CONFLICT DO NOTHING").bind(json!(sources)).execute(&s.db.pool).await?;
    // 与 `archives::build` 同一条判据：首尾都顶到请求范围、中间没有断口，才算完整。
    // 合约在这一段中途才上市的，首根对不上范围起点，这一段就只是 partial——它照样
    // 会写进 features 供检索，只是不会拿到永久标记，重跑时会再来一次。
    let complete = failed.is_empty()
        && bars.first().is_some_and(|v| v.start == unit.start)
        && bars.last().is_some_and(|v| v.end == unit.end)
        && bars.windows(2).all(|w| w[0].end == w[1].start);
    for window in missing {
        let input = super::super::history::HistoryIndexRequest {
            source: HistorySource::MonthlyArchive,
            symbol: symbol.to_string(),
            market: scope.market.clone(),
            interval: scope.interval.clone(),
            start_at: unit.start,
            end_at: unit.end,
            window_bars: window,
            stride_bars: STRIDE,
            models: vec![scorebook_core::domain::chart_match::MODEL.to_string()],
        };
        let generation = super::super::history::generation_of(s, &input).await?;
        let coverage =
            super::super::history::index_generation(s, j, generation, &input, &bars, complete)
                .await?;
        tally.rows += coverage["feature_rows"].as_i64().unwrap_or(0);
        tally.built += 1;
    }
    // bars 在这里出作用域。行情内容只以向量 + 时间坐标的形式留在 features 里。
    Ok(())
}

async fn build_symbol(
    s: &Services,
    j: &Job,
    scope: &Scope,
    symbol: &str,
    tally: &mut Tally,
    started: &std::time::Instant,
) -> Result<()> {
    let iv = super::super::history::interval_of(&scope.interval)?;
    let listing = match months(s, scope, symbol).await {
        Ok(v) => v,
        Err(e) if !fatal(&e) => {
            tally.failed += 1;
            tally.fail(symbol, "listing", &e.code);
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    if listing.is_empty() {
        // 归档里根本没有这个品种这个周期：新上市还没归档，或者币安没传。记一笔继续走。
        tally.fail(symbol, "listing", "archive_not_available");
        return Ok(());
    }
    for unit in units(iv, &listing)? {
        let range = format!(
            "{}..{}",
            unit.start.format("%Y-%m"),
            unit.end.format("%Y-%m")
        );
        sqlx::query("UPDATE public_market.universe_index_runs SET current_range=$2,updated_at=now() WHERE job_id=$1").bind(j.id).bind(&range).execute(&s.db.pool).await?;
        match build_unit(s, j, scope, symbol, &unit, tally).await {
            Ok(()) => {}
            Err(e) if !fatal(&e) => {
                tally.failed += 1;
                tally.fail(symbol, &range, &e.code);
            }
            Err(e) => return Err(e),
        }
        if started.elapsed() > STEP_BUDGET {
            // 单元级别的中断点。已经打过标记的单元下一步会直接跳过，所以从这里停
            // 最多丢掉「正在做的那一个」。
            break;
        }
    }
    Ok(())
}

/// 建档：把这一轮的名单原样存下来。24h ticker 是快照，前 200 名每天都在变，不存
/// 事后就没人答得出「这次到底搜了哪 200 个、截止到哪一天」。
async fn snapshot(s: &Services, j: &Job, scope: &Scope) -> Result<Uuid> {
    let all = super::super::instrument_popularity::leaders(s, &scope.market, 0).await?;
    let candidates = all.len();
    let leaders: Vec<_> = all.into_iter().take(scope.top).collect();
    if leaders.is_empty() {
        return Err(Error::transient("instrument_ranking_unavailable"));
    }
    let rows: Vec<Value> = leaders
        .iter()
        .enumerate()
        .map(|(i, v)| {
            json!({"rank":i as i32+1,"symbol":v.symbol,"quote_volume":v.turnover.to_string(),
                   "trade_count":v.trades,"turnover_rank":v.turnover_rank,"trades_rank":v.trades_rank})
        })
        .collect();
    let id = Uuid::new_v4();
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("INSERT INTO public_market.universe_snapshots(id,market,size,candidates,ranking,source) VALUES($1,$2,$3,$4,'turnover_rank_plus_trade_count_rank_borda_asc','binance_ticker_24hr')")
        .bind(id).bind(&scope.market).bind(leaders.len() as i32).bind(candidates as i32).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO public_market.universe_members(snapshot_id,rank,symbol,quote_volume,trade_count,turnover_rank,trades_rank) SELECT $1,r.rank,r.symbol,r.quote_volume::numeric,r.trade_count,r.turnover_rank,r.trades_rank FROM jsonb_to_recordset($2) r(rank int,symbol text,quote_volume text,trade_count bigint,turnover_rank int,trades_rank int)")
        .bind(id).bind(json!(rows)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO public_market.universe_index_runs(job_id,owner_id,snapshot_id,market,timeframe,status,symbols_total) VALUES($1,$2,$3,$4,$5,'running',$6)")
        .bind(j.id).bind(j.owner).bind(id).bind(&scope.market).bind(&scope.interval).bind(leaders.len() as i32).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn progress(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    sqlx::query_scalar(
        "SELECT to_jsonb(r)-'owner_id' FROM public_market.universe_index_runs r WHERE job_id=$1 AND owner_id=$2",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(&s.db.pool)
    .await?
    .ok_or_else(Error::not_found)
}

pub async fn step(s: &Services, j: &Job) -> Result<Value> {
    let scope = scope_of(&j.body)?;
    let state = match progress(s, j.owner, j.id).await {
        Ok(v) => v,
        Err(e) if e.kind == crate::error::ErrorKind::NotFound => {
            snapshot(s, j, &scope).await?;
            progress(s, j.owner, j.id).await?
        }
        Err(e) => return Err(e),
    };
    if state["status"] == "completed" {
        return Ok(state);
    }
    let snapshot_id: Uuid = serde_json::from_value(state["snapshot_id"].clone())
        .map_err(|_| Error::bad("invalid_universe_run"))?;
    let symbols: Vec<String> = sqlx::query_scalar(
        "SELECT symbol FROM public_market.universe_members WHERE snapshot_id=$1 ORDER BY rank",
    )
    .bind(snapshot_id)
    .fetch_all(&s.db.pool)
    .await?;
    let mut tally = Tally {
        built: state["units_built"].as_i64().unwrap_or(0),
        skipped: state["units_skipped"].as_i64().unwrap_or(0),
        failed: state["units_failed"].as_i64().unwrap_or(0),
        months: state["months_downloaded"].as_i64().unwrap_or(0),
        rows: state["feature_rows"].as_i64().unwrap_or(0),
        failures: state["failures"].as_array().cloned().unwrap_or_default(),
    };
    let mut no = state["symbol_no"].as_u64().unwrap_or(0) as usize;
    let started = std::time::Instant::now();
    while no < symbols.len() {
        let symbol = symbols[no].clone();
        sqlx::query("UPDATE public_market.universe_index_runs SET current_symbol=$2,symbol_no=$3,updated_at=now() WHERE job_id=$1").bind(j.id).bind(&symbol).bind(no as i32).execute(&s.db.pool).await?;
        build_symbol(s, j, &scope, &symbol, &mut tally, &started).await?;
        if started.elapsed() > STEP_BUDGET {
            // 品种没做完就到点了：进度停在这个品种上，下一步重扫它的分段，
            // 已经有永久标记的直接跳过，只有「正在做的那一个」会重来。
            save(s, j, &tally, no).await?;
            return Err(Error::deferred(
                "universe_index_step_yielded",
                RetryDirective::At(Utc::now() + Duration::seconds(1)),
            ));
        }
        no += 1;
        save(s, j, &tally, no).await?;
    }
    let mut tx = jobs::fence(s, j).await?;
    sqlx::query("UPDATE public_market.universe_index_runs SET status='completed',current_symbol=NULL,current_range=NULL,symbol_no=$2,updated_at=now() WHERE job_id=$1").bind(j.id).bind(no as i32).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(
        json!({"job_id":j.id,"snapshot_id":snapshot_id,"market":scope.market,"interval":scope.interval,
               "symbols":symbols.len(),"units_built":tally.built,"units_skipped":tally.skipped,
               "units_failed":tally.failed,"months_downloaded":tally.months,"feature_rows":tally.rows,
               "failures":tally.failures,"source":"binance_monthly_archive","raw_market_storage":"none",
               "windows":super::super::history::LOCATE_WINDOWS,"stride_bars":STRIDE}),
    )
}

async fn save(s: &Services, j: &Job, tally: &Tally, no: usize) -> Result<()> {
    sqlx::query("UPDATE public_market.universe_index_runs SET symbol_no=$2,units_built=$3,units_skipped=$4,units_failed=$5,months_downloaded=$6,feature_rows=$7,failures=$8,updated_at=now() WHERE job_id=$1")
        .bind(j.id).bind(no as i32).bind(tally.built).bind(tally.skipped).bind(tally.failed)
        .bind(tally.months).bind(tally.rows).bind(json!(tally.failures))
        .execute(&s.db.pool).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::super::history::Interval;

    #[test]
    fn a_chunk_holds_enough_bars_for_the_largest_window_and_stays_inside_validate() {
        for iv in [Interval::D1, Interval::H4, Interval::H1, Interval::M15] {
            let n = months_per_chunk(iv).unwrap();
            let (short, long) = month_bars(iv).unwrap();
            assert!(n * short >= 256, "{} 放不下 256 根窗口", iv.as_str());
            assert!(n * long <= CHUNK_BAR_BUDGET, "{} 越过分段上限", iv.as_str());
            // validate 卡的是窗口数：最小的窗口切出来的份数最多。
            let windows = (n * long - 64) / STRIDE as i64 + 1;
            assert!(windows <= 1000, "{} 切出 {windows} 个窗口", iv.as_str());
        }
        // 15 分钟一个月就快顶满，粗周期才攒得起多个月。
        assert_eq!(months_per_chunk(Interval::M15).unwrap(), 1);
        assert!(months_per_chunk(Interval::D1).unwrap() >= 12);
    }

    #[test]
    fn month_keys_parse_monthly_archives_and_reject_daily_ones() {
        assert_eq!(
            month_of_key(
                "data/futures/um/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2024-07.zip",
                "BTCUSDT",
                "1d"
            ),
            Some((2024 - 1970) * 12 + 6)
        );
        // 日档、别的品种、别的周期都不该混进来。
        for key in [
            "data/futures/um/daily/klines/BTCUSDT/1d/BTCUSDT-1d-2024-07-15.zip",
            "data/futures/um/monthly/klines/ETHUSDT/1d/ETHUSDT-1d-2024-07.zip",
            "data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2024-07.zip",
        ] {
            assert_eq!(month_of_key(key, "BTCUSDT", "1d"), None);
        }
    }

    #[test]
    fn units_tile_the_listing_without_reaching_past_the_first_or_last_archived_month() {
        let first = (2020 - 1970) * 12; // 2020-01
        let listing: Vec<(i64, String)> = (0..30)
            .map(|i| (first + i, format!("k-{i}")))
            .collect();
        let units = units(Interval::D1, &listing).unwrap();
        assert!(!units.is_empty());
        assert_eq!(units[0].start, at(2020, 1).unwrap());
        assert_eq!(units.last().unwrap().end, at(2022, 7).unwrap());
        // 每个月档只属于一个单元：同一个月的 zip 不会被下载两次。
        let keys: Vec<&String> = units.iter().flat_map(|u| u.keys.iter()).collect();
        let unique: std::collections::HashSet<_> = keys.iter().collect();
        assert_eq!(keys.len(), unique.len());
        assert_eq!(keys.len(), listing.len());
    }
}

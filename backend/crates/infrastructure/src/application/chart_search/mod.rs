//! Analysis and bounded, cancellable search; the worker dispatches this use case only.
use super::{
    Services,
    jobs::{self, Job},
};
use crate::{
    adapters::db::{Database, digest},
    error::{Error, Result},
};
use chrono::{DateTime, Utc};
use scorebook_core::{api::chart_search::*, domain::chart_match};
use serde_json::{Value, json};
use uuid::Uuid;
mod analysis;
pub mod anchors;
pub mod calibration;
mod toolbar;
/// 只读图上那行字的识别：定位面板拿它当「这张图默认是哪个品种」。
pub use analysis::read as read_labels;
/// §5.2 第 1 步的全部证据：定位流水线要的是锚点本身，不是 chart.analyze 的那份 JSON。
pub use analysis::{Anchored, anchored};
mod quote_variants;
mod recall;
pub mod reindex;
mod repository;
pub(crate) mod rerank;
mod visual_query;
/// Read-only display contour. It is neither a market price series nor persisted data.
pub async fn outline(s: &Services, owner: Uuid, input: ChartAnalysisInput) -> Result<Value> {
    let read = analysis::anchored(s, owner, &input).await?;
    Ok(json!({
        "attachment_id": input.attachment_id,
        "source": "screenshot_contour",
        "symbol": read.anchors.symbol,
        "interval": read.anchors.interval,
        "values": chart_match::display_outline(&read.geometry.candles)?,
        "storage_policy": "ephemeral",
    }))
}
pub async fn geometry(
    s: &Services,
    owner: Uuid,
    input: &ChartAnalysisInput,
) -> Result<chart_match::Geometry> {
    use tokio::io::AsyncReadExt;
    let hash: String =
        sqlx::query_scalar("SELECT sha256 FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
    let _permit = s.vision.acquire().await?;
    let mut bytes = Vec::new();
    s.images
        .open(owner, input.attachment_id)
        .await?
        .take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 20 * 1024 * 1024 || crate::adapters::db::hash_bytes(&bytes) != hash {
        return Err(Error::bad("attachment_integrity_failure"));
    }
    let input = input.clone();
    tokio::task::spawn_blocking(move || {
        let (im, _) = crate::adapters::storage::Storage::decode(&bytes)?;
        chart_match::detect(&im, input.region, input.red_up).map_err(Into::into)
    })
    .await
    .map_err(|_| Error::bad("chart_analysis_interrupted"))?
}
pub async fn analyze(
    s: &Services,
    owner: Uuid,
    key: &str,
    input: ChartAnalysisInput,
) -> Result<Value> {
    let body = json!(input);
    let (tx, cached) = s.db.write(owner, "chart.analyze", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    tx.commit().await?;
    let (geometry, ocr, recognized) = analysis::evidence(s, owner, &input).await?;
    let (mut tx, cached) = s.db.write(owner, "chart.analyze", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let rh = digest(
        &json!({"input":body,"recognition_protocol":"toolbar-chart-boundary-v6","recognized":recognized,"geometry":geometry.quality}),
    );
    let id = Uuid::new_v4();
    let value = json!({"id":id,"attachment_id":input.attachment_id,"geometry":geometry.quality,"recognized":recognized,"ocr":ocr,"ocr_status":"complete","chart_type":"ordinary_candlestick_candidate","quality_validated":false});
    let value:Value=sqlx::query_scalar("INSERT INTO chart_analyses(id,owner_id,attachment_id,region_hash,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,attachment_id,region_hash) DO UPDATE SET region_hash=EXCLUDED.region_hash RETURNING body").bind(id).bind(owner).bind(input.attachment_id).bind(rh).bind(value).fetch_one(&mut *tx).await?;
    Database::finish(&mut tx, owner, "chart.analyze", key, &body, &value).await?;
    tx.commit().await?;
    Ok(value)
}
/// 周期由策略决定：默认必须挑一个周期；显式选了「不限」就不许再带周期，
/// 免得「用户选了不限」和「前端漏传周期」这两件事混成同一个请求。
fn check_interval(input: &ChartSearchInput) -> Result<()> {
    match input.interval_policy {
        IntervalPolicy::SameInterval => {
            chart_match::require_interval(input.interval.as_deref())?;
        }
        IntervalPolicy::AnyInterval => {
            if input
                .interval
                .as_deref()
                .is_some_and(|v| !v.trim().is_empty())
            {
                return Err(Error::bad("chart_interval_conflict"));
            }
        }
    }
    Ok(())
}

/// 人一轮否掉三条，累加到一百条就是三十几轮：再多不是「继续找」，是这张图根本
/// 不该在这里找。给它一个上限，免得一条 SQL 里绑进无限长的数组。
pub const MAX_EXCLUDE: usize = 100;

fn check_exclude(exclude: &[Uuid]) -> Result<()> {
    if exclude.len() > MAX_EXCLUDE {
        return Err(Error::bad("chart_exclude_too_many"));
    }
    Ok(())
}

/// Match the existing knowledge-search byte limit; never silently discard text.
fn normalize_text(input: &mut ChartSearchInput) -> Result<()> {
    input.query_text = input
        .query_text
        .take()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty());
    if let Some(text) = &input.query_text {
        if text.len() > 4096 {
            return Err(Error::bad("chart_query_text_too_long"));
        }
        if input.scope != ChartScope::Private {
            return Err(Error::bad("chart_query_text_requires_private_scope"));
        }
    }
    Ok(())
}

/// 公开语料一轮精排多少条。用线上生产的 ANN 参数实测过两个真实 4h 查询：外层
/// 1000 行按「每个合约最多 3 条」封顶之后还剩 323 行 / 142 个合约、376 行 /
/// 141 个合约，而预算 30 只让其中 25 和 27 个合约真的进了精排——不到两成。
/// 所以「按图找」的宽度卡在哪里是清楚的：不是 ANN 的召回，是这个数字。抬的是它。
pub const RERANK_BUDGET: usize = 300;

/// 私有语料的预算跟公开那一条故意不是同一个数，因为两边的成本结构完全不同：
/// 公开那一支每组是去 Binance Vision 下一个月档（网络等待，可以靠并发摊掉），
/// 私有这一支是对每一张截图跑一次视觉模型，而 `adapters::vision` 的信号量只有 2，
/// 把预算抬上去只会让队排在信号量上，一秒都省不下来。何况私有语料统共十几张图，
/// 30 早就把它整个装下了。
pub const PRIVATE_RERANK_BUDGET: usize = 30;

/// 把预算和闸门锁死在一起。`history::attach_market_sources` 对候选条数有一个防御性
/// 上界，而「按图找」传进去的正是上面这个预算——预算超过闸门，每一次跨品种检索都会
/// 在那里 400。这条断言挡的就是这件事：以后谁再抬预算、忘了抬闸门，编译就过不去，
/// 而不是等到线上第一次检索才发现。
const _: () = assert!(RERANK_BUDGET <= super::history::SOURCE_LOOKUP_BUDGET);

/// 截断候选池用的那个数，和结果里报出来的那个数，必须是同一个。前端把
/// `rerank_budget` 原样画给人看（「先筛多少条再精排」），它一旦跟这一轮实际做的事
/// 对不上就是在骗人。所以取数那一头和报数那一头都只从这里拿，不各写各的常量。
pub fn budget(scope: &ChartScope) -> usize {
    match scope {
        ChartScope::BinanceHistory => RERANK_BUDGET,
        ChartScope::Private => PRIVATE_RERANK_BUDGET,
    }
}

/// §5.5-4：默认返回几条、最多几条。需求文档里那三个数（3 / 5 / 10）说的是同一件事
/// 的三个位置：一眼能看完的是三条，一屏能看完的是五条，再多是人自己要求「多给点」。
/// 默认给五条，上限十条——上限不是性能预算（精排早就做完了），是「翻到第十一条还
/// 没有一条像的，那就是没有」。
pub const DEFAULT_RESULTS: usize = 5;
pub const MAX_RESULTS: usize = 10;

pub async fn create(
    s: &Services,
    owner: Uuid,
    key: &str,
    mut input: ChartSearchInput,
) -> Result<Value> {
    if input.limit.is_some_and(|v| v == 0 || v > MAX_RESULTS)
        || input
            .market
            .as_ref()
            .is_some_and(|v| !matches!(v.as_str(), "usd_m" | "coin_m"))
    {
        return Err(Error::bad("invalid_chart_search"));
    }
    check_exclude(&input.exclude)?;
    check_interval(&input)?;
    normalize_text(&mut input)?;
    let original = json!(input);
    let (mut tx, cached) = s.db.write(owner, "chart.search", key, &original).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM attachments WHERE owner_id=$1 AND id=$2)")
            .bind(owner)
            .bind(input.attachment_id)
            .fetch_one(&mut *tx)
            .await?;
    if !exists {
        return Err(Error::not_found());
    }
    input.cutoff_at = Some(input.cutoff_at.unwrap_or_else(Utc::now));
    let body = json!(input);
    let id = jobs::enqueue_tx(&mut tx, owner, "chart.search", key, body.clone()).await?;
    sqlx::query(
        "INSERT INTO chart_search_runs(id,owner_id,attachment_id,body) VALUES($1,$2,$3,$4)",
    )
    .bind(id)
    .bind(owner)
    .bind(input.attachment_id)
    .bind(body)
    .execute(&mut *tx)
    .await?;
    let v =
        json!({"search_run_id":id,"job_id":id,"status":"queued","protocol":chart_match::PROTOCOL});
    Database::finish(&mut tx, owner, "chart.search", key, &original, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn get(s: &Services, owner: Uuid, id: Uuid) -> Result<Value> {
    let mut run: Value = sqlx::query_scalar("SELECT (to_jsonb(r)-'owner_id') || jsonb_build_object('status',j.status,'generation',j.generation,'error_code',j.error_code) FROM chart_search_runs r JOIN jobs j ON j.id=r.id WHERE r.owner_id=$1 AND r.id=$2").bind(owner).bind(id).fetch_optional(&s.db.pool).await?.ok_or_else(Error::not_found)?;
    // Apply the same display rule to saved runs without rewriting their evidence.
    if run["body"]["scope"] == "binance_history"
        && run["body"]["symbol"].is_null()
        && run["result"]["status"] == "final"
    {
        for field in ["items", "ranked_items"] {
            if let Some(items) = run["result"][field].as_array_mut() {
                quote_variants::annotate(s, items).await?;
                quote_variants::usdt_only(items);
                *items = quote_variants::deduplicate(std::mem::take(items));
            }
        }
        run["result"]["quote_variant_grouping"] = json!(quote_variants::POLICY);
        run["result"]["quote_policy"] = json!(quote_variants::QUOTE_POLICY);
    }
    Ok(run)
}
pub async fn cancel(
    s: &Services,
    owner: Uuid,
    id: Uuid,
    key: &str,
    input: SearchRunControl,
) -> Result<Value> {
    let body = json!({"search_run_id":id,"expected_generation":input.expected_generation});
    let (mut tx, cached) = s.db.write(owner, "chart.cancel", key, &body).await?;
    if let Some(v) = cached {
        return Ok(v);
    }
    let result=sqlx::query("UPDATE jobs SET status='cancelled',generation=generation+1,lease_until=NULL,lease_owner=NULL WHERE owner_id=$1 AND id=$2 AND kind='chart.search' AND generation=$3 AND status NOT IN ('cancelled','succeeded')").bind(owner).bind(id).bind(input.expected_generation).execute(&mut *tx).await?;
    if result.rows_affected() != 1 {
        return Err(Error::conflict("search_generation_conflict"));
    }
    let v =
        json!({"search_run_id":id,"status":"cancelled","generation":input.expected_generation+1});
    Database::finish(&mut tx, owner, "chart.cancel", key, &body, &v).await?;
    tx.commit().await?;
    Ok(v)
}
pub async fn run(s: &Services, j: &Job) -> Result<Value> {
    let mut input: ChartSearchInput =
        serde_json::from_value(j.body.clone()).map_err(|_| Error::bad("invalid_search_job"))?;
    check_interval(&input)?;
    check_exclude(&input.exclude)?;
    normalize_text(&mut input)?;
    let text = repository::private_text_context(s, j.owner, &input).await?;
    let (query, _, _) = analysis::evidence(
        s,
        j.owner,
        &ChartAnalysisInput {
            attachment_id: input.attachment_id,
            region: input.region.clone(),
            red_up: input.red_up,
        },
    )
    .await?;
    let query_candles = if input.reverse {
        chart_match::normalized(&query.candles, true)?
            .into_iter()
            .map(chart_match::Candle::new)
            .collect()
    } else {
        query.candles.clone()
    };
    let vector = chart_match::descriptor(&query_candles)?;
    // 公开语料里有来路证不出来的窗口时，那几条候选会被丢掉。丢了多少要跟着结果走
    // 到底；私有语料没有这个概念，恒为 0。
    let (candidates, unproven) = if input.scope == ChartScope::BinanceHistory {
        repository::public_candidates(s, &input, vector, query.quality.detected_candles).await?
    } else {
        let visual = visual_query::encode(s, j.owner, &input, &query.quality.region).await?;
        (
            repository::private_candidates(s, j.owner, &input, vector, visual, text.as_ref())
                .await?,
            0,
        )
    };
    repository::publish(s,j,&json!({"status":"provisional","items":candidates,"protocol":chart_match::PROTOCOL,"quality_validated":false,"windows_dropped_for_unproven_source":unproven}),false).await?;
    let (mut ranked, excluded) = rerank::run(s, j, &input, &query.candles, candidates).await?;
    // One window per contract only makes sense while the contract is still in
    // question; a search already restricted to one returns its best windows.
    let grouped = input.scope == ChartScope::BinanceHistory && input.symbol.is_none();
    if grouped {
        quote_variants::annotate(s, &mut ranked).await?;
        quote_variants::usdt_only(&mut ranked);
    }
    let interval_policy = match input.interval_policy {
        IntervalPolicy::SameInterval => "same_interval_only",
        IntervalPolicy::AnyInterval => "any_interval",
    };
    // Public visibility is always structural similarity >= 60%, independent of calibration.
    let calibration = calibration::Calibration::empty();
    let ranked = best_matches(
        ranked,
        grouped,
        budget(&input.scope),
        &calibration,
        input.scope == ChartScope::BinanceHistory,
    );
    let ranked = if text.is_some() {
        fuse_text_matches(ranked, PRIVATE_RERANK_BUDGET)
    } else {
        ranked
    };
    let verdict = verdict(&ranked);
    let first_page: Vec<Value> = ranked
        .iter()
        .take(input.limit.unwrap_or(DEFAULT_RESULTS))
        .cloned()
        .collect();
    let mut result = json!({"search_run_id":j.id,"verdict":verdict,"protocol":chart_match::PROTOCOL,"status":"final","items":first_page,"ranked_items":ranked,"pagination":"frozen_verified_ranking_v1","excluded_candidates":excluded,"scope":input.scope,"interval":input.interval,"interval_policy":interval_policy,"rejected_by_hand":input.exclude.len(),"windows_dropped_for_unproven_source":unproven,"cutoff_at":input.cutoff_at,"quality_validated":false,"query_quality":query.quality,"coverage":"published_geometry_v2_only","minimum_similarity":if input.scope == ChartScope::BinanceHistory {Some(0.60)} else {None},"candidate_budget":if input.scope == ChartScope::BinanceHistory {recall::CANDIDATE_POOL} else {3000},"rerank_budget":budget(&input.scope),"grouping":if grouped {"best_verified_window_per_contract"} else if input.scope == ChartScope::BinanceHistory {"best_verified_windows_of_the_named_contract"} else {"exact_image_then_confirmed_episode"},"raw_market_storage":"none"});
    if grouped {
        result["quote_variant_grouping"] = json!(quote_variants::POLICY);
        result["quote_policy"] = json!(quote_variants::QUOTE_POLICY);
    }
    if let Some(text) = text {
        result["query_text"] = json!(input.query_text);
        result["text_retrieval"] = text.metadata;
        result["ranking"] = json!("geometry-text-rrf-k60-v1");
        result["rank_fusion_score_meaning"] = json!("retrieval_order_not_image_similarity");
    }
    repository::publish(s, j, &result, true).await?;
    Ok(result)
}

/// Fuse the full verified image pool, then apply the display limit. Image
/// score, rarity and level remain exactly what geometric reranking produced.
fn fuse_text_matches(mut ranked: Vec<Value>, limit: usize) -> Vec<Value> {
    for (image_rank, item) in ranked.iter_mut().enumerate() {
        let text_rank = item["text_match"]["retrieval_rank"].as_u64().unwrap_or(120);
        item["rank_fusion_score"] =
            json!(1. / (61. + image_rank as f64) + 1. / (60. + text_rank as f64));
    }
    ranked.sort_by(|a, b| {
        b["rank_fusion_score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["rank_fusion_score"].as_f64().unwrap_or(0.))
            .then_with(|| a["call_id"].as_str().cmp(&b["call_id"].as_str()))
    });
    ranked.truncate(limit);
    ranked
}

/// §5.5-4：同品种同周期、窗口重叠超过一半的两条，说的是同一段行情，只留分高的那条。
/// 自由长度精排之后这件事才真的会发生：候选取数那一层按索引窗口的半个身位去过重，
/// 精排却会把窗口挪到最像的位置上去，两条候选于是可能收敛到同一段。
fn overlapping(a: &Value, b: &Value) -> bool {
    if a["market"] != b["market"] || a["symbol"] != b["symbol"] || a["interval"] != b["interval"] {
        return false;
    }
    time_overlapping(a, b)
}

fn time_overlapping(a: &Value, b: &Value) -> bool {
    let at = |v: &Value, k: &str| {
        v[k].as_str()
            .and_then(|v| v.parse::<DateTime<Utc>>().ok())
            .map(|v| v.timestamp())
    };
    let (Some(a0), Some(a1), Some(b0), Some(b1)) = (
        at(a, "start_at"),
        at(a, "end_at"),
        at(b, "start_at"),
        at(b, "end_at"),
    ) else {
        return false;
    };
    let overlap = (a1.min(b1) - a0.max(b0)).max(0) as f64;
    let shortest = (a1 - a0).min(b1 - b0).max(1) as f64;
    overlap / shortest > 0.5
}

/// 一次检索的结论只有三种，而且它只取决于最像的那一条：有（`found`）、只有点像
/// （`weak`）、没有（`none`）。词本身在前端，这里只给枚举值。
fn verdict(ranked: &[Value]) -> &'static str {
    match ranked.first().and_then(|v| v["match"]["level"].as_str()) {
        Some("sure") | Some("likely") => "found",
        Some("weak") => "weak",
        _ => "none",
    }
}

fn best_matches(
    mut ranked: Vec<Value>,
    grouped: bool,
    limit: usize,
    calibration: &calibration::Calibration,
    drop_unremarkable: bool,
) -> Vec<Value> {
    ranked.sort_by(|a, b| {
        b["match"]["score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["match"]["score"].as_f64().unwrap_or(0.))
    });
    // 稀有度和词都写在 `match` 里，跟分放在一起：前端拿到的是一条结果自己的判词，
    // 不用再去别处对照阈值。没有校准样本时 `rarity` 是 null，不是 0——「没量过」和
    // 「量过、很常见」得分得开。
    let mut kept = Vec::with_capacity(ranked.len());
    for mut item in ranked {
        let score = item["match"]["score"].as_f64().unwrap_or(0.);
        let bars = item["bars_count"].as_u64().unwrap_or(0) as usize;
        let rarity = calibration.rarity(bars, score);
        let level = calibration::level(rarity, score);
        item["match"]["rarity"] = json!(rarity);
        item["match"]["level"] = json!(level);
        if drop_unremarkable && (!score.is_finite() || score < 0.60) {
            continue;
        }
        kept.push(item);
    }
    let mut ranked: Vec<Value> = Vec::with_capacity(kept.len());
    for item in kept {
        if ranked.iter().any(|kept| {
            overlapping(kept, &item) || (grouped && quote_variants::overlapping(kept, &item))
        }) {
            continue;
        }
        ranked.push(item);
    }
    if grouped {
        let mut seen = std::collections::HashSet::new();
        ranked.retain(|v| {
            seen.insert((
                v["market"].clone().to_string(),
                v["symbol"].clone().to_string(),
            ))
        });
    }
    ranked.truncate(limit);
    ranked
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    /// 挡的是「前端画出来的数字跟后端实际做的事情对不上」。结果 JSON 里的
    /// `rerank_budget` 和真正把候选池截断的那一步，走的是同一个 `budget()`，所以剩下
    /// 唯一还能错的是这张映射表本身——两种 scope 接反、或者抬公开那一条时顺手把私有
    /// 那一条也带上去。两边各钉一条，外加一条「它们本来就不该相等」。
    ///
    /// 预算和 `history::SOURCE_LOOKUP_BUDGET` 那个闸门之间的关系不在这里测：那是一条
    /// 编译期断言，抬了预算忘了抬闸门连编译都过不去，用不着再抄一份运行时的。
    #[test]
    fn the_reported_budget_is_the_one_that_actually_truncated() {
        assert_eq!(budget(&ChartScope::BinanceHistory), RERANK_BUDGET);
        assert_eq!(budget(&ChartScope::Private), PRIVATE_RERANK_BUDGET);
        assert_ne!(
            budget(&ChartScope::BinanceHistory),
            budget(&ChartScope::Private)
        );
    }
}

#[cfg(test)]
mod result_tests {
    use super::*;
    #[test]
    fn public_visibility_has_an_inclusive_sixty_percent_similarity_floor() {
        let rows = [0.599999, 0.60, 0.61, 0.9]
            .into_iter()
            .map(|score| json!({"match":{"score":score}}))
            .collect();
        let result = best_matches(rows, false, 300, &calibration::Calibration::empty(), true);
        assert_eq!(result.len(), 3);
        assert_eq!(result[2]["match"]["score"], 0.60);
        for rarity in [None, Some(0.), Some(0.59), Some(1.)] {
            assert_eq!(calibration::level(rarity, 0.61), Some("likely"));
            assert_eq!(calibration::level(rarity, 0.9), Some("sure"));
        }
    }

    #[test]
    fn hybrid_ranking_promotes_text_evidence_before_limit_without_relabeling_geometry() {
        let mut items = vec![
            json!({"call_id":"a", "match":{"score":0.99}, "text_match":{"retrieval_rank":100}}),
            json!({"call_id":"b", "match":{"score":0.70}, "text_match":{"retrieval_rank":1}}),
        ];
        items = best_matches(
            items,
            false,
            PRIVATE_RERANK_BUDGET,
            &calibration::Calibration::empty(),
            false,
        );
        let image_match = items[1]["match"].clone();
        let result = fuse_text_matches(items, 1);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["call_id"], "b");
        assert_eq!(result[0]["match"], image_match);
        assert_ne!(result[0]["rank_fusion_score"], result[0]["match"]["score"]);
    }

    #[test]
    fn historical_results_keep_the_best_verified_window_for_each_contract() {
        let make = |s: &str, score| json!({"market":"usd_m","symbol":s,"match":{"score":score}});
        let flat = calibration::Calibration::empty();
        let best =
            |items: Vec<Value>, grouped, limit| best_matches(items, grouped, limit, &flat, true);
        let input = vec![
            make("BTCUSDT", 0.7),
            make("ETHUSDT", 0.8),
            make("BTCUSDT", 0.9),
            make("SOLUSDT", 0.6),
        ];
        let result = best(input.clone(), true, 3);
        assert_eq!(
            result
                .iter()
                .map(|v| v["symbol"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        );
        assert_eq!(result[0]["match"]["score"], 0.9);
        assert_eq!(best(input, false, 3)[2]["symbol"], "BTCUSDT");
    }
}

pub(crate) async fn browser_labels_cached(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
) -> Result<Option<scorebook_core::api::replay::LocateOverride>> {
    analysis::browser_labels_cached(s, owner, attachment).await
}

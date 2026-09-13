//! §5.2 的锚定定位流水线：先读图上自己写着的东西，再去行情里核对。
//!
//! 从前这条路是「建索引 → ANN → 精排 → 阈值」，一张真实截图永远够不到阈值，
//! 因为 ANN 只认 64/128/256 三个固定长度，而人截的图是 110 根、116 根。现在顺序
//! 反过来：图上的时间标签把这一段钉死在时间轴上，极值标签把它钉死在某两根上，
//! 形状只在没有锚点的时候才当兜底。ANN 在这条路上不再出现。
use super::{Services, chart_search::anchors, jobs::Job};
use crate::{
    domain::{chart::ChartRequest, criteria::Bar},
    error::{Error, ErrorKind, Result},
};
use chrono::{DateTime, Duration, Utc};
use scorebook_core::{
    api::chart_search::ChartAnalysisInput,
    domain::{
        chart_match::{self, Candle, MatchScore},
        interval::Interval,
    },
    market::HistorySource,
};
use serde_json::{Value, json};
use uuid::Uuid;

/// 这一次定位的上下文：记录给的默认值、人明确挑过的几格、判断时刻。
pub struct Context {
    pub attachment: Uuid,
    pub judgment: DateTime<Utc>,
    /// 记录自己的 symbol / market / interval，作为图上读不出来时的默认值。
    pub record: (String, Option<String>, Option<String>),
    pub chosen_symbol: Option<String>,
    pub chosen_market: Option<String>,
    pub chosen_interval: Option<String>,
    /// 上一次确认时记住的截图时区（分钟）。
    pub preferred_offset: Option<i32>,
}

/// 一段行情。REST 拉不到就退官方月档，和重温那条路是同一个规矩。
pub async fn bars_of(
    s: &Services,
    market: &str,
    symbol: &str,
    iv: Interval,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<Bar>> {
    let request = |source: HistorySource| ChartRequest {
        source,
        symbol: symbol.into(),
        market: market.into(),
        interval: iv.as_str().into(),
        start_at: from,
        end_at: to,
        match_end_at: None,
    };
    let bars = |v: Value| -> Result<Vec<Bar>> {
        serde_json::from_value(v["bars"].clone()).map_err(|_| Error::bad("invalid_bars"))
    };
    match super::market::data(s, &request(HistorySource::Rest)).await {
        Ok(v) => bars(v),
        Err(e) if e.kind == ErrorKind::NotFound => Err(e),
        Err(_) => bars(super::market::data(s, &request(HistorySource::MonthlyArchive)).await?),
    }
}

/// 一次滑动核对的全部产出：最佳窗口、次佳不重叠窗口，以及这一次所有窗口的分布。
struct Hit {
    start: usize,
    len: usize,
    score: MatchScore,
    second: f64,
    z: f64,
    /// 与最佳互不重叠的后两段，够不到门槛时它们就是交回去的候选。
    others: Vec<(usize, usize, MatchScore)>,
}

/// 重叠超过一半算同一段，不该拿它当「次佳」。
fn overlaps(a: (usize, usize), b: (usize, usize)) -> bool {
    let lo = a.0.max(b.0);
    let hi = (a.0 + a.1).min(b.0 + b.1);
    let shared = hi.saturating_sub(lo);
    shared * 2 > a.1.min(b.1)
}

/// 自由长度滑窗核对（§5.2 第 4 步 b/c、§5.4-7）。红绿两种假设都试，取高者。
///
/// `band` 是时间锚给的约束：`(最后一根的下标, 允许偏几根)`。给了它，最佳窗口只能
/// 在这一小段里挑（§5.2 第 4 步 b 的「±10 根」）；次佳与分布仍然取整段行情上的全部
/// 窗口，否则 ±10 根之内彼此全都重叠，「次佳」和 z 都失去意义。
fn assess(
    query: &[Candle],
    bars: &[Candle],
    n: usize,
    band: Option<(usize, usize)>,
) -> Option<Hit> {
    if bars.len() < 16 || query.len() < 16 {
        return None;
    }
    let lo = (n * 9 / 10).max(16);
    let hi = (n * 11 / 10).min(bars.len());
    if lo > hi {
        return None;
    }
    let flipped = chart_match::flipped(query);
    let mut all: Vec<(usize, usize, MatchScore)> = chart_match::sweep(query, bars, lo..=hi, 2);
    let other = chart_match::sweep(&flipped, bars, lo..=hi, 2);
    // 两种配色假设各自的窗口分布合在一起，否则「同一段在另一种假设下也不高」这件
    // 事会被当成证据；取最高的那一支即可，但分布要算全。
    if other.first().map(|v| v.2.score).unwrap_or(0.) > all.first().map(|v| v.2.score).unwrap_or(0.)
    {
        all = other;
    }
    let best = match band {
        Some((end, slack)) => all
            .iter()
            .find(|v| {
                let last = v.0 + v.1 - 1;
                last.abs_diff(end) <= slack
            })?
            .clone(),
        None => all.first()?.clone(),
    };
    let scores: Vec<f64> = all.iter().map(|v| v.2.score).collect();
    let mean = scores.iter().sum::<f64>() / scores.len() as f64;
    let sd =
        (scores.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / scores.len() as f64).sqrt();
    // 只留互不重叠的几段：同一段行情被 ±10% 的长度扫出十几次，逐条列出来对人
    // 没有意义，交回去的三条必须是三段不同的行情。
    let mut others: Vec<(usize, usize, MatchScore)> = Vec::new();
    for v in all.iter() {
        if overlaps((v.0, v.1), (best.0, best.1))
            || others
                .iter()
                .any(|w: &(usize, usize, MatchScore)| overlaps((v.0, v.1), (w.0, w.1)))
        {
            continue;
        }
        others.push(v.clone());
        if others.len() == 2 {
            break;
        }
    }
    let second = others.first().map(|v| v.2.score).unwrap_or(0.);
    let z = if sd > 1e-9 {
        (best.2.score - mean) / sd
    } else {
        0.
    };
    Some(Hit {
        start: best.0,
        len: best.1,
        score: best.2,
        second,
        z,
        others,
    })
}

/// 一个数字印在图上时的精度，用来定极值比对的容差：`1058.09` 是两位小数，
/// 真实最高价与它的差不会超过印出来的那一位。
fn tolerance(v: f64) -> f64 {
    let text = format!("{v}");
    let decimals = text.split_once('.').map(|(_, d)| d.len()).unwrap_or(0);
    10f64.powi(-(decimals as i32)) * 1.01
}

fn price(v: &str) -> Option<f64> {
    v.parse::<f64>().ok()
}

/// 归一化横坐标 → 图像归一化坐标里的一根蜡烛。
struct Frame {
    x_first: f64,
    x_last: f64,
    bars: usize,
}

fn frame(quality: &chart_match::GeometryQuality, image: (u32, u32)) -> Frame {
    let w = f64::from(image.0).max(1.);
    let left = f64::from(quality.region.x) / w;
    let width = f64::from(quality.region.width) / w;
    let n = quality.detected_candles.max(1) as f64;
    let pitch = width / n;
    Frame {
        x_first: left + pitch / 2.,
        x_last: left + width - pitch / 2.,
        bars: quality.detected_candles,
    }
}

/// 拟合出来的时间轴：秒/归一化横坐标、首尾时刻、用的是哪个时区。
struct Axis {
    offset: i32,
    seconds_per_x: f64,
    first: DateTime<Utc>,
    last: DateTime<Utc>,
    residual: f64,
    points: usize,
}

/// §5.2 第 2 步。时区候选只改绝对时刻不改残差，所以拟合本身分不出它们；这里把每个
/// 候选各拟一份交出去，由第 4 步按实际比对分数挑。排序用的是「最后一根落在判断时刻
/// 之前且离它最近」——截图是当时拍的，不会拍到判断之后的行情——只在没有分数可比
/// 的时候（比如只报锚点）当默认值。
fn time_axes(
    labels: &[anchors::TimeLabel],
    f: &Frame,
    judgment: DateTime<Utc>,
    preferred: Option<i32>,
) -> Vec<Axis> {
    let mut out: Vec<Axis> = Vec::new();
    for offset in anchors::utc_offsets(preferred) {
        let points = anchors::stamps(labels, judgment, offset);
        if points.len() < 2 {
            continue;
        }
        let Some((a, b, residual)) = anchors::time_fit(&points) else {
            continue;
        };
        if b <= 0. {
            continue;
        }
        let at = |x: f64| DateTime::from_timestamp((a + b * x) as i64, 0).unwrap_or(judgment);
        let axis = Axis {
            offset,
            seconds_per_x: b,
            first: at(f.x_first),
            last: at(f.x_last),
            residual,
            points: points.len(),
        };
        out.push(axis);
    }
    out.sort_by_key(|v: &Axis| {
        let late = (v.last - judgment).num_seconds();
        (late > 12 * 3600, late.abs())
    });
    out
}

/// 只要排第一的那一份。手填回推时区、以及没有行情可比时都用它。
fn time_axis(
    labels: &[anchors::TimeLabel],
    f: &Frame,
    judgment: DateTime<Utc>,
    preferred: Option<i32>,
) -> Option<Axis> {
    time_axes(labels, f, judgment, preferred).into_iter().next()
}

/// 时间轴给出的周期：一根蜡烛占多少秒，取最接近的合法周期。
fn interval_from_axis(axis: &Axis, f: &Frame) -> Option<Interval> {
    let pitch = (f.x_last - f.x_first) / (f.bars.max(2) - 1) as f64;
    let seconds = axis.seconds_per_x * pitch;
    if !seconds.is_finite() || seconds <= 0. {
        return None;
    }
    let mut best: Option<(f64, Interval)> = None;
    for iv in Interval::ALL {
        let s = iv.min_seconds() as f64;
        let ratio = (s / seconds).max(seconds / s);
        if best.as_ref().is_none_or(|cur| ratio < cur.0) {
            best = Some((ratio, iv));
        }
    }
    // 差出一倍以上就不是这一档，宁可说认不出来。
    best.filter(|(ratio, _)| *ratio < 1.6).map(|(_, iv)| iv)
}

/// §5.3 步：把几何蜡烛的像素 OHLC 换成价格 OHLC。
///
/// 几何给的 `shape` 是「工作图里的行号取负」，而价格轴是归一化图像坐标；两者之间
/// 的换算靠 `region`——它本来就是这一排蜡烛的外接框，所以最高的那根影线顶正是
/// `region.y`，最低的那根影线底正是 `region.y + region.height`。
fn priced(
    candles: &[Candle],
    quality: &chart_match::GeometryQuality,
    image: (u32, u32),
    axis: &anchors::PriceAxis,
) -> Vec<Candle> {
    let h = f64::from(image.1).max(1.);
    let top = f64::from(quality.region.y) / h;
    let height = f64::from(quality.region.height) / h;
    let hi = candles
        .iter()
        .map(|c| c.shape[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let lo = candles
        .iter()
        .map(|c| c.shape[2])
        .fold(f64::INFINITY, f64::min);
    if !(hi - lo).is_finite() || hi - lo <= f64::EPSILON || height <= 0. {
        return candles.to_vec();
    }
    let at = |v: f64| axis.at(top + (hi - v) / (hi - lo) * height);
    candles
        .iter()
        .map(|c| {
            Candle::priced(
                c.shape,
                [
                    at(c.shape[0]),
                    at(c.shape[1]),
                    at(c.shape[2]),
                    at(c.shape[3]),
                ],
            )
        })
        .collect()
}

fn candles_of(bars: &[Bar]) -> Result<Vec<Candle>> {
    chart_match::from_bars(bars).map_err(Into::into)
}

/// 一条候选，字段名与 §5.2 的结果结构一致。
fn candidate(
    symbol: &str,
    market: &str,
    interval: &str,
    window: &[Bar],
    score: &MatchScore,
    level: &str,
    z: Option<f64>,
) -> Value {
    let mut m = json!({"score":score.score,"level":level,"reverse":score.reverse,"alignment_cost":score.alignment_cost});
    if let Some(z) = z {
        m["z"] = json!(z);
    }
    json!({
        "symbol":symbol,"market":market,"interval":interval,
        "start_at":window.first().map(|b|b.start),
        "end_at":window.last().map(|b|b.end),
        "bars_count":window.len(),
        "match":m,
    })
}

fn level_of(score: f64) -> &'static str {
    if score >= 0.75 {
        "sure"
    } else if score >= 0.55 {
        "likely"
    } else {
        "weak"
    }
}

/// §5.2 第 5 步的两个环境变量，只作用于路径 b/c。
pub fn thresholds() -> (f64, f64) {
    let read = |name: &str, fallback: f64| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(fallback)
    };
    (
        read("SCOREBOOK_AUTO_LOCATE_MIN_SCORE", 0.75),
        read("SCOREBOOK_AUTO_LOCATE_MIN_MARGIN", 0.10),
    )
}

/// 读一张图：OCR 锚点 + 几何。读不动就是 `None`，手填照样能填，只是没有对照分。
pub async fn read_chart(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
) -> Option<super::chart_search::Anchored> {
    let input = ChartAnalysisInput {
        attachment_id: attachment,
        region: None,
        red_up: false,
    };
    super::chart_search::anchored(s, owner, &input).await.ok()
}

/// 要拿去比对的那一串蜡烛：价格轴拟合得出来就换成真价格，否则只剩形状。
pub fn query_candles(read: &super::chart_search::Anchored) -> Vec<Candle> {
    match &read.anchors.price_axis {
        Some(axis) => priced(
            &read.geometry.candles,
            &read.geometry.quality,
            read.image,
            axis,
        ),
        None => read.geometry.candles.clone(),
    }
}

/// §5.2 第 6 步的对照词门槛：0.75 / 0.55。前端只显示词，不显示分。
pub fn preview_level(score: f64) -> &'static str {
    level_of(score)
}

/// 手填之后回推这张图用的是哪个时区：把时间标签按每个候选时区各拟合一次，取最后
/// 一根离人填的那个时刻最近的一个。标签不足两个就认不出来。
pub fn offset_matching(read: &super::chart_search::Anchored, target: DateTime<Utc>) -> Option<i32> {
    let f = frame(&read.geometry.quality, read.image);
    time_axis(&read.anchors.time_labels, &f, target, None).map(|a| a.offset)
}

pub struct Outcome {
    pub value: Value,
    /// `Some` 时调用方把它写进 `attachment_locations`。
    pub write: Option<Value>,
    pub anchor: Value,
}

/// 整条流水线。
pub async fn run(s: &Services, j: &Job, ctx: &Context) -> Result<Outcome> {
    let input = ChartAnalysisInput {
        attachment_id: ctx.attachment,
        region: None,
        red_up: false,
    };
    // 第 1 步：读锚点与几何。这张图根本读不出蜡烛，就是 `unreadable`，不编候选。
    let read = match super::chart_search::anchored(s, j.owner, &input).await {
        Ok(v) => v,
        Err(e) if e.kind == ErrorKind::Invalid => {
            return Ok(Outcome {
                value: json!({"outcome":"unreadable","attachment_id":ctx.attachment,"reason":e.code,"candidates":[]}),
                write: None,
                anchor: Value::Null,
            });
        }
        Err(e) => return Err(e),
    };
    let mut anchor = read.anchors.clone();
    let quality = read.geometry.quality.clone();
    let f = frame(&quality, read.image);

    // 品种：人挑过的 > 图上写着的 > 记录自己的。
    let (symbol, symbol_from) = match (&ctx.chosen_symbol, &anchor.symbol) {
        (Some(v), _) => (Some(v.clone()), "user"),
        (None, Some(v)) => (Some(v.clone()), "ocr"),
        (None, None) => (Some(ctx.record.0.clone()), "record"),
    };
    anchor.symbol = symbol.clone();
    anchor.symbol_from = Some(symbol_from.into());
    let symbol = symbol.unwrap_or_default();
    let market = ctx
        .chosen_market
        .clone()
        .or_else(|| ctx.record.1.clone())
        .unwrap_or_else(|| "usd_m".into());

    // 第 2 步：时间轴。每个时区候选各拟一份，第 4 步 b 用分数在它们之间选。
    let axes = time_axes(&anchor.time_labels, &f, ctx.judgment, ctx.preferred_offset);
    let mut axis_at = 0usize;
    let from_axis = axes.first().and_then(|a| interval_from_axis(a, &f));
    if symbol.is_empty()
        || (ctx.chosen_interval.is_none()
            && from_axis.is_none()
            && anchor.interval.is_none()
            && ctx.record.2.is_none())
    {
        return Ok(Outcome {
            value: json!({"outcome":"needs_manual","attachment_id":ctx.attachment,"anchors":anchor,"candidates":[]}),
            write: None,
            anchor: Value::Null,
        });
    }
    let interval = match (&ctx.chosen_interval, from_axis, &anchor.interval) {
        (Some(v), _, _) => (Interval::exact(v)?, "user"),
        (None, Some(iv), _) => (iv, "axis"),
        (None, None, Some(v)) => (Interval::exact(v)?, "ocr"),
        (None, None, None) => (
            Interval::exact(ctx.record.2.as_deref().unwrap_or("1h"))?,
            "record",
        ),
    };
    let (iv, interval_from) = interval;
    anchor.interval = Some(iv.as_str().into());
    anchor.interval_from = Some(interval_from.into());
    anchor.bars_guess = Some(f.bars);

    // 第 3 步：价格轴。拟合得出来就把蜡烛换成真价格，比形状更硬。
    let query = query_candles(&read);
    let n = f.bars;
    let mut method = "shape_sweep";
    // 最终选中的那一段的最后一根：用来回头认这张图到底是哪个时区。
    let mut chosen_last: Option<DateTime<Utc>> = None;
    let mut located: Option<(Vec<Bar>, MatchScore, Option<f64>)> = None;
    let mut shortlist: Vec<Value> = Vec::new();
    let mut sure = false;
    let (min_score, min_margin) = thresholds();

    // 取行情的范围：有时间轴就按时间轴前后各放宽 10%，没有就用判断时刻往前 768 根。
    // 几个时区候选合成一段一次取回——它们之间最多差几个小时，分开取纯属多跑一趟。
    let span = iv.min_seconds().max(1);
    let (from, to) = if axes.is_empty() {
        (
            iv.add_bars(iv.floor(ctx.judgment), -768),
            iv.floor(ctx.judgment),
        )
    } else {
        let pad = |a: &Axis| ((a.last - a.first).num_seconds() / 10).max(span * 12);
        let from = axes
            .iter()
            .map(|a| a.first - Duration::seconds(pad(a)))
            .min()
            .unwrap_or(ctx.judgment);
        let to = axes
            .iter()
            .map(|a| a.last + Duration::seconds(pad(a)))
            .max()
            .unwrap_or(ctx.judgment)
            .min(Utc::now());
        (from, to)
    };
    let market_bars = if symbol.is_empty() {
        Vec::new()
    } else {
        bars_of(s, &market, &symbol, iv, iv.floor(from), iv.ceil(to))
            .await
            .unwrap_or_default()
    };

    // 第 4 步 a：极值指纹。图上印着最高价和最低价时，这是最短的一条路。
    if let (Some(ex), false) = (anchor.extremes, market_bars.is_empty())
        && let (Some(gi), Some(gl)) = (
            argmax(&query, |c| c.shape[1]),
            argmax(&query, |c| -c.shape[2]),
        )
    {
        let th = tolerance(ex.high);
        let tl = tolerance(ex.low);
        let highs: Vec<usize> = (0..market_bars.len())
            .filter(|i| price(&market_bars[*i].high).is_some_and(|v| (v - ex.high).abs() <= th))
            .collect();
        let lows: Vec<usize> = (0..market_bars.len())
            .filter(|i| price(&market_bars[*i].low).is_some_and(|v| (v - ex.low).abs() <= tl))
            .collect();
        if highs.len() == 1 && lows.len() == 1 {
            let (bh, bl) = (highs[0] as f64, lows[0] as f64);
            // 比的是两根极值在图区里的横向位置，不是检测序号：几何数出来的根数和
            // 真实根数常常差几根（粘连、切断各一种），序号直接相减会把这点误差
            // 放大成十几根。文档 §5.2 第 4 步 a 说的就是「以两根的 x 位置反推
            // 首尾」。
            let scale = (n.max(2) - 1) as f64 / (query.len().max(2) - 1) as f64;
            let (xi, xl) = (gi as f64 * scale, gl as f64 * scale);
            let spacing = (bh - bl) - (xi - xl);
            let start = (((bh - xi) + (bl - xl)) / 2.).round() as i64;
            if spacing.abs() <= 3. && start >= 0 && start + n as i64 <= market_bars.len() as i64 {
                let window = market_bars[start as usize..start as usize + n].to_vec();
                if let Ok(theirs) = candles_of(&window) {
                    let score = best_score(&query, &theirs);
                    method = "extremes";
                    sure = true;
                    chosen_last = window.last().map(|b| b.start);
                    located = Some((window, score, None));
                }
            }
        }
    }

    // 第 4 步 b/c：滑窗核对。有时间轴就每个时区候选各在自己预测的末根附近 ±10 根里
    // 挑一次，分高的那个时区就是这张图的时区；没有时间轴才在整段上自由滑。
    if located.is_none() && !market_bars.is_empty() {
        method = if axes.is_empty() {
            "shape_sweep"
        } else {
            "time_axis"
        };
        let index_of = |at: DateTime<Utc>| {
            market_bars
                .iter()
                .position(|b| b.start >= at)
                .unwrap_or(market_bars.len().saturating_sub(1))
        };
        let mut picked: Option<Hit> = None;
        if let Ok(theirs) = candles_of(&market_bars) {
            if axes.is_empty() {
                picked = assess(&query, &theirs, n, None);
            } else {
                for (i, a) in axes.iter().enumerate() {
                    let band = Some((index_of(iv.floor(a.last)), 10));
                    let Some(hit) = assess(&query, &theirs, n, band) else {
                        continue;
                    };
                    if picked
                        .as_ref()
                        .is_none_or(|cur| hit.score.score > cur.score.score)
                    {
                        axis_at = i;
                        picked = Some(hit);
                    }
                }
            }
        }
        if let Some(hit) = picked {
            let window = market_bars[hit.start..hit.start + hit.len].to_vec();
            chosen_last = window.last().map(|b| b.start);
            let s1 = hit.score.score;
            if s1 >= min_score && s1 - hit.second >= min_margin && hit.z >= 4. {
                sure = true;
                located = Some((window, hit.score, Some(hit.z)));
            } else {
                let level = if s1 >= 0.6 && s1 - hit.second >= 0.06 {
                    "likely"
                } else {
                    "weak"
                };
                shortlist.push(candidate(
                    &symbol,
                    &market,
                    iv.as_str(),
                    &window,
                    &hit.score,
                    level,
                    Some(hit.z),
                ));
                for (start, len, score) in &hit.others {
                    shortlist.push(candidate(
                        &symbol,
                        &market,
                        iv.as_str(),
                        &market_bars[*start..*start + *len],
                        score,
                        level_of(score.score),
                        None,
                    ));
                }
            }
        }
    }

    // 时区与末根：报的是第 4 步真正选中的那一份，不是排序时的默认值。几个时区候选的
    // 窗口常常叠在一起、比出来同一段行情；这时哪个时区对，看的是谁预测的末根离选中的
    // 那一根最近——极值指纹那条路压根没用时间轴，也靠这一步把时区认回来。
    if let Some(at) = chosen_last
        && let Some((i, _)) = axes
            .iter()
            .enumerate()
            .min_by_key(|(_, a)| (iv.floor(a.last) - at).num_seconds().abs())
    {
        axis_at = i;
    }
    let axis = axes.get(axis_at);
    anchor.utc_offset_minutes = axis.map(|a| a.offset);
    anchor.end_at_guess = axis.map(|a| iv.floor(a.last));

    // 存进 attachment_locations.anchor 的那份：锚点本身，外加这次时间轴拟合的成色。
    let anchor_json = json!({
        "anchors":anchor,"method":method,
        "time_axis":axis.map(|a| json!({
            "utc_offset_minutes":a.offset,
            "seconds_per_x":a.seconds_per_x,
            "first_at":a.first,"last_at":a.last,
            "residual_seconds":a.residual,"labels_used":a.points,
        })),
    });
    if let Some((window, score, z)) = located
        && sure
    {
        let best = candidate(&symbol, &market, iv.as_str(), &window, &score, "sure", z);
        return Ok(Outcome {
            value: json!({
                "outcome":"located","attachment_id":ctx.attachment,"search_run_id":j.id,
                "anchors":anchor,"method":method,"candidates":[best.clone()],
            }),
            write: Some(best),
            anchor: anchor_json,
        });
    }
    shortlist.truncate(3);
    let outcome = if shortlist.is_empty() {
        "needs_manual"
    } else {
        "candidates"
    };
    Ok(Outcome {
        value: json!({
            "outcome":outcome,"attachment_id":ctx.attachment,"search_run_id":j.id,
            "anchors":anchor,"method":method,"candidates":shortlist,
            "min_score":min_score,"min_margin":min_margin,
        }),
        write: None,
        anchor: anchor_json,
    })
}

fn argmax(candles: &[Candle], key: impl Fn(&Candle) -> f64) -> Option<usize> {
    (0..candles.len()).max_by(|a, b| key(&candles[*a]).total_cmp(&key(&candles[*b])))
}

/// 红绿两种假设各比一次，取高者（§5.4-6）。
pub fn best_score(query: &[Candle], candidate: &[Candle]) -> MatchScore {
    let flipped = chart_match::flipped(query);
    let mut best = chart_match::rerank(query, candidate, false).unwrap_or_else(|_| MatchScore {
        score: 0.,
        alignment_cost: 1.,
        direction_consistent: false,
        reverse: false,
        meaning: "similarity_not_probability".into(),
        rarity: None,
        level: None,
        z: None,
    });
    if let Ok(other) = chart_match::rerank(&flipped, candidate, false)
        && other.score > best.score
    {
        best = other;
    }
    if let Ok(priced) = chart_match::rerank_priced(query, candidate)
        && priced.score > best.score
    {
        best = priced;
    }
    best.level = Some(level_of(best.score).into());
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_printed_precision_decides_how_close_an_extreme_has_to_be() {
        assert!((tolerance(1058.09) - 0.0101).abs() < 1e-9);
        assert!((tolerance(199.64) - 0.0101).abs() < 1e-9);
        assert!(tolerance(50.) > 1.);
    }

    #[test]
    fn a_window_that_mostly_covers_another_is_not_a_runner_up() {
        assert!(overlaps((100, 110), (105, 110)));
        assert!(!overlaps((100, 110), (160, 110)));
        assert!(!overlaps((100, 110), (0, 110)));
    }
}

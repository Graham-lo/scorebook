//! §5.2 第 1 步：从 OCR 观测里读出「图上自己写着的锚点」。
//!
//! 这里只做解析，不碰数据库、不猜品种：时间标签、价格轴、极值、最新价、副图切线。
//! 定位流水线拿它们把一张截图钉到时间轴上，比对形状只是最后的兜底。
use crate::adapters::ocr::{Observation, OcrResult};
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use serde::Serialize;

/// 一个时间标签在横轴上的位置与它写着的字。`parsed` 只在进程内用。
#[derive(Clone, Debug, Serialize)]
pub struct TimeLabel {
    pub x: f64,
    pub text: String,
    #[serde(skip)]
    pub parsed: Partial,
}
/// 标签里读到的零件；缺的那几格保持 None，由 `stamps()` 拿邻居补。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Partial {
    pub year: Option<i32>,
    pub month: Option<u32>,
    pub day: Option<u32>,
    pub hour: Option<u32>,
    pub minute: Option<u32>,
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PriceAxis {
    /// `linear` 或 `log`
    pub kind: &'static str,
    pub fit_points: usize,
    /// price = c + d·y（log 轴时是 ln(price) = c + d·y）
    #[serde(skip)]
    pub c: f64,
    #[serde(skip)]
    pub d: f64,
    #[serde(skip)]
    pub lo: f64,
    #[serde(skip)]
    pub hi: f64,
}
impl PriceAxis {
    pub fn at(&self, y: f64) -> f64 {
        let v = self.c + self.d * y;
        if self.kind == "log" { v.exp() } else { v }
    }
    pub fn range(&self) -> f64 {
        (self.hi - self.lo).abs()
    }
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Extremes {
    pub high: f64,
    pub low: f64,
}
/// §5.2 结果结构里的 `anchors` 那一块，字段名与文档逐字一致。
#[derive(Clone, Debug, Default, Serialize)]
pub struct Anchors {
    pub symbol: Option<String>,
    pub symbol_from: Option<String>,
    pub interval: Option<String>,
    pub interval_from: Option<String>,
    pub utc_offset_minutes: Option<i32>,
    pub time_labels: Vec<TimeLabel>,
    pub price_axis: Option<PriceAxis>,
    pub extremes: Option<Extremes>,
    pub last_price: Option<f64>,
    pub end_at_guess: Option<DateTime<Utc>>,
    pub bars_guess: Option<usize>,
    /// 副图标题的纵坐标；有它就把几何检测限制在它上面。不进 §5.2 的 JSON，
    /// 但存进 `attachment_locations.anchor` 时有用，所以照样序列化出来。
    pub pane_cut_y: Option<f64>,
}

fn center_x(o: &Observation) -> f64 {
    o.r#box[0] + o.r#box[2] / 2.
}
fn center_y(o: &Observation) -> f64 {
    o.r#box[1] + o.r#box[3] / 2.
}
const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
/// 副图标题词。看到其中一个就说明底下不再是主图。
const PANES: [&str; 9] = [
    "vol",
    "macd",
    "rsi",
    "kdj",
    "boll",
    "obv",
    "oi",
    "持仓量",
    "成交量",
];

/// 把 `1,058.09`、`50.00K`、`-962.59`、`981.76л` 这类读成数字。
/// 返回 (值, 是否带前后短横)。OCR 会把极值旁边那条短横线当成减号粘上来。
pub fn number(text: &str) -> Option<(f64, bool)> {
    let trimmed = text.trim();
    let dashes = ['-', '−', '–', '—', '~', '一'];
    let mut body = trimmed;
    let mut dashed = false;
    while let Some(first) = body.chars().next() {
        if dashes.contains(&first) {
            dashed = true;
            body = &body[first.len_utf8()..];
        } else {
            break;
        }
    }
    while let Some(last) = body.chars().last() {
        if dashes.contains(&last) {
            dashed = true;
            body = &body[..body.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    // 末尾的量级后缀，以及 OCR 常在数字后面粘上的一两个杂字。
    let mut scale = 1.;
    let mut digits = String::new();
    let mut seen_digit = false;
    for ch in body.chars() {
        match ch {
            '0'..='9' => {
                seen_digit = true;
                digits.push(ch);
            }
            '.' if seen_digit && !digits.contains('.') => digits.push('.'),
            ',' | ' ' if seen_digit => {}
            'K' | 'k' if seen_digit => {
                scale = 1e3;
                break;
            }
            'M' if seen_digit => {
                scale = 1e6;
                break;
            }
            'B' | 'b' if seen_digit => {
                scale = 1e9;
                break;
            }
            _ if seen_digit => break,
            _ => return None,
        }
    }
    let value: f64 = digits.parse().ok()?;
    Some((value * scale, dashed))
}

/// 时间标签解析。认得 `MM-DD HH:mm`、`MM/DD HH:mm`、`YYYY/MM/DD HH:mm`、
/// `MM-DD`、`HH:mm`、`DD MMM`、`MMM DD`，以及左边被裁掉月份的 `-04 22:00`
/// 和右边被裁掉分钟的 `09-10 05:`。
pub fn time_label(text: &str) -> Option<Partial> {
    let raw = text.trim();
    if raw.is_empty() || raw.chars().count() > 24 {
        return None;
    }
    let mut out = Partial::default();
    let mut month_name = None;
    for token in raw.split([' ', '\u{a0}', ',']).filter(|t| !t.is_empty()) {
        let low = token.to_lowercase();
        if let Some(i) = MONTHS.iter().position(|m| low.starts_with(m)) {
            // 月份名后面除了点号不该再有别的字母。
            if low[MONTHS[i].len()..]
                .chars()
                .any(|c| c.is_ascii_alphabetic())
            {
                return None;
            }
            month_name = Some(i as u32 + 1);
            continue;
        }
        if token.contains(':') {
            let mut it = token.split(':');
            let h: u32 = it.next()?.parse().ok()?;
            let m = it.next().unwrap_or("");
            let minute: u32 = if m.is_empty() { 0 } else { m.parse().ok()? };
            if h > 23 || minute > 59 || it.next().is_some_and(|s| s.parse::<u32>().is_err()) {
                return None;
            }
            out.hour = Some(h);
            out.minute = Some(minute);
            continue;
        }
        if token.contains('-') || token.contains('/') {
            let parts: Vec<&str> = token.split(['-', '/']).collect();
            let nums: Vec<Option<u32>> = parts
                .iter()
                .map(|p| if p.is_empty() { None } else { p.parse().ok() })
                .collect();
            if nums.iter().skip(1).any(|v| v.is_none()) || nums.len() > 3 {
                return None;
            }
            match nums.as_slice() {
                [Some(a), Some(b), Some(c)] if parts[0].len() == 4 => {
                    out.year = Some(*a as i32);
                    out.month = Some(*b);
                    out.day = Some(*c);
                }
                [Some(a), Some(b)] => {
                    out.month = Some(*a);
                    out.day = Some(*b);
                }
                // 左边被裁掉月份：`-04 22:00`
                [None, Some(b)] => out.day = Some(*b),
                _ => return None,
            }
            continue;
        }
        if let Ok(n) = token.parse::<u32>() {
            if out.day.is_none() && (1..=31).contains(&n) {
                out.day = Some(n);
                continue;
            }
            return None;
        }
        return None;
    }
    if let Some(m) = month_name {
        out.month = Some(m);
    }
    if out.month.is_some_and(|m| !(1..=12).contains(&m)) || out.day.is_some_and(|d| d > 31) {
        return None;
    }
    ((out.day.is_some() && (out.month.is_some() || out.hour.is_some())) || out.hour.is_some())
        .then_some(out)
}

/// 挑出时间标签：图的下半部、又矮又短的那一排字。
///
/// 屏幕左右两头的标签会被裁掉一截（`-04 22:00` 少了月份，`09-10 05:` 少了分钟），
/// 裁过的框中心比真正的刻度偏；用其余标签的中位宽度把中心还原回去，否则最小二乘
/// 会被这一个点带偏好几个小时。
fn time_labels(ocr: &OcrResult) -> Vec<TimeLabel> {
    let mut found: Vec<([f64; 4], String, Partial)> = ocr
        .observations
        .iter()
        .filter(|o| o.r#box[1] > 0.45 && o.r#box[3] < 0.03 && o.confidence >= 0.5)
        .filter_map(|o| time_label(&o.text).map(|p| (o.r#box, o.text.clone(), p)))
        .collect();
    found.sort_by(|a, b| a.0[0].total_cmp(&b.0[0]));
    let clipped = |b: &[f64; 4]| b[0] <= 0.005 || b[0] + b[2] >= 0.995;
    let mut widths: Vec<f64> = found
        .iter()
        .filter(|(b, _, _)| !clipped(b))
        .map(|(b, _, _)| b[2])
        .collect();
    widths.sort_by(f64::total_cmp);
    let median = widths.get(widths.len() / 2).copied();
    let mut out: Vec<TimeLabel> = found
        .into_iter()
        .map(|(b, text, parsed)| {
            let x = match median {
                Some(w) if b[0] <= 0.005 && b[2] < w => b[0] + b[2] - w / 2.,
                Some(w) if b[0] + b[2] >= 0.995 && b[2] < w => b[0] + w / 2.,
                _ => b[0] + b[2] / 2.,
            };
            TimeLabel { x, text, parsed }
        })
        .collect();
    out.dedup_by(|a, b| (a.x - b.x).abs() < 0.01);
    out
}

/// 把标签补全成绝对时刻。`near` 是记录的判断时刻，用来定年份（跨年取最近的一个）；
/// `offset` 是图上时间相对 UTC 的分钟数。
pub fn stamps(labels: &[TimeLabel], near: DateTime<Utc>, offset: i32) -> Vec<(f64, DateTime<Utc>)> {
    let dated: Vec<usize> = (0..labels.len())
        .filter(|i| labels[*i].parsed.month.is_some() && labels[*i].parsed.day.is_some())
        .collect();
    let mut out = Vec::new();
    let local = near + Duration::minutes(i64::from(offset));
    for (i, label) in labels.iter().enumerate() {
        let p = label.parsed;
        // 缺月份/日期的，找横轴上最近的一个完整标签借。
        let borrow = dated
            .iter()
            .min_by_key(|j| (labels[**j].x - label.x).abs().to_bits())
            .map(|j| labels[*j].parsed);
        let month = p.month.or(borrow.and_then(|b| b.month));
        let day = p.day.or(borrow.and_then(|b| b.day));
        let (Some(month), Some(day)) = (month, day) else {
            continue;
        };
        let year = p
            .year
            .or(borrow.and_then(|b| b.year))
            .unwrap_or(local.year());
        let Some(date) = NaiveDate::from_ymd_opt(year, month, day) else {
            continue;
        };
        let naive = date
            .and_hms_opt(p.hour.unwrap_or(0), p.minute.unwrap_or(0), 0)
            .unwrap();
        let mut t = Utc.from_utc_datetime(&naive) - Duration::minutes(i64::from(offset));
        // 跨年：取离判断时刻最近的那一个年份。
        for shift in [-1i64, 1] {
            let moved = t + Duration::days(365 * shift);
            if (moved - near).num_seconds().abs() < (t - near).num_seconds().abs() {
                t = moved;
            }
        }
        out.push((labels[i].x, t));
    }
    out
}

/// 最小二乘 `t = a + b·x`（t 为秒）。返回 (a, b, 残差秒)。
pub fn time_fit(points: &[(f64, DateTime<Utc>)]) -> Option<(f64, f64, f64)> {
    if points.len() < 2 {
        return None;
    }
    let n = points.len() as f64;
    let xs: Vec<f64> = points.iter().map(|p| p.0).collect();
    let ts: Vec<f64> = points.iter().map(|p| p.1.timestamp() as f64).collect();
    let mx = xs.iter().sum::<f64>() / n;
    let mt = ts.iter().sum::<f64>() / n;
    let sxx: f64 = xs.iter().map(|x| (x - mx) * (x - mx)).sum();
    if sxx <= f64::EPSILON {
        return None;
    }
    let sxt: f64 = xs
        .iter()
        .zip(&ts)
        .map(|(x, t)| (x - mx) * (t - mt))
        .sum::<f64>();
    let b = sxt / sxx;
    let a = mt - b * mx;
    let residual = (xs
        .iter()
        .zip(&ts)
        .map(|(x, t)| (a + b * x - t).powi(2))
        .sum::<f64>()
        / n)
        .sqrt();
    Some((a, b, residual))
}

/// 右轴刻度。只认最右那一列的纯数字，纵向必须单调递减，否则整组丢弃。
/// 最长递减子列：入参已按 y 升序排好，留下来的这几个价格严格递减。
fn falling(points: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let n = points.len();
    let mut best = vec![1usize; n];
    let mut from = vec![usize::MAX; n];
    for i in 0..n {
        for k in 0..i {
            if points[k].1 > points[i].1 && best[k] + 1 > best[i] {
                best[i] = best[k] + 1;
                from[i] = k;
            }
        }
    }
    let Some(mut at) = (0..n).max_by_key(|i| best[*i]) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    loop {
        out.push(points[at]);
        if from[at] == usize::MAX {
            break;
        }
        at = from[at];
    }
    out.reverse();
    out
}

/// 返回 (轴, 不在等距刻度上的那个数 = 最新价)。
fn price_axis(ocr: &OcrResult, cut: Option<f64>, right: f64) -> (Option<PriceAxis>, Option<f64>) {
    let mut points: Vec<(f64, f64)> = ocr
        .observations
        .iter()
        .filter(|o| o.r#box[0] > 0.8 * right && o.confidence >= 0.5)
        .filter(|o| cut.is_none_or(|c| center_y(o) < c))
        .filter_map(|o| number(&o.text).map(|(v, _)| (center_y(o), v)))
        .filter(|(_, v)| *v > 0.)
        .collect();
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    points.dedup_by(|a, b| (a.0 - b.0).abs() < 0.004);
    if points.len() < 3 {
        return (None, None);
    }
    // y 往下走价格必须往下掉。跟右轴同一列的还有页首那几个部件（成交额、资金费率、
    // 涨跌幅），它们混进来会把整条轴判废；取最长的那一条递减子列，把不合的摘掉。
    let points = falling(&points);
    if points.len() < 3 {
        return (None, None);
    }
    // 等距刻度的公差：相邻差值的中位数。不落在这张格子上的那个数就是最新价。
    let mut diffs: Vec<f64> = points.windows(2).map(|w| w[0].1 - w[1].1).collect();
    diffs.sort_by(f64::total_cmp);
    let step = diffs[diffs.len() / 2];
    if step <= 0. {
        return (None, None);
    }
    let on_grid = |base: f64, v: f64| {
        let k = (base - v) / step;
        (k - k.round()).abs() < 0.08
    };
    let base = points
        .iter()
        .max_by_key(|p| points.iter().filter(|q| on_grid(p.1, q.1)).count())
        .map(|p| p.1)
        .unwrap();
    /// 一串刻度：每个是（像素纵坐标，读出来的价）。
    type Ticks = Vec<(f64, f64)>;
    let (grid, off): (Ticks, Ticks) = points.iter().partition(|p| on_grid(base, p.1));
    if grid.len() < 3 {
        return (None, None);
    }
    let last = (off.len() == 1).then(|| off[0].1);
    // 对数轴：相邻刻度比值恒定而差值不恒定。
    let ratios: Vec<f64> = grid.windows(2).map(|w| w[0].1 / w[1].1).collect();
    let spread = |v: &[f64]| {
        let m = v.iter().sum::<f64>() / v.len() as f64;
        if m.abs() < 1e-12 {
            return f64::INFINITY;
        }
        (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt() / m.abs()
    };
    let steps: Vec<f64> = grid.windows(2).map(|w| w[0].1 - w[1].1).collect();
    let log = ratios.len() >= 2 && spread(&ratios) < 0.01 && spread(&steps) > 0.05;
    let n = grid.len() as f64;
    let ys: Vec<f64> = grid.iter().map(|p| p.0).collect();
    let vs: Vec<f64> = grid
        .iter()
        .map(|p| if log { p.1.ln() } else { p.1 })
        .collect();
    let my = ys.iter().sum::<f64>() / n;
    let mv = vs.iter().sum::<f64>() / n;
    let syy: f64 = ys.iter().map(|y| (y - my) * (y - my)).sum();
    if syy <= f64::EPSILON {
        return (None, None);
    }
    let d = ys
        .iter()
        .zip(&vs)
        .map(|(y, v)| (y - my) * (v - mv))
        .sum::<f64>()
        / syy;
    let axis = PriceAxis {
        kind: if log { "log" } else { "linear" },
        fit_points: grid.len(),
        c: mv - d * my,
        d,
        lo: grid.last().unwrap().1,
        hi: grid[0].1,
    };
    (Some(axis), last)
}

/// 副图标题里最靠上的那一个的 `box[1]`；主图到此为止。
fn pane_cut(ocr: &OcrResult) -> Option<f64> {
    ocr.observations
        .iter()
        .filter(|o| o.r#box[1] > 0.35 && o.confidence >= 0.5)
        .filter(|o| {
            let low = o.text.to_lowercase();
            PANES.iter().any(|p| {
                low.split(|c: char| !c.is_alphanumeric() && !"持仓量成交".contains(c))
                    .any(|w| w == *p || w.starts_with(&format!("{p}(")))
                    || low.starts_with(&format!("{p}:"))
                    || low.starts_with(&format!("{p}("))
            })
        })
        .map(|o| o.r#box[1])
        .min_by(f64::total_cmp)
}

/// 图区里贴着短横线的最高价 / 最低价。有右轴时用「按 y 反推的价格对得上」来确认，
/// 没有右轴就只认带短横的那种写法。
fn extremes(ocr: &OcrResult, axis: Option<&PriceAxis>, cut: Option<f64>) -> Option<Extremes> {
    let top = cut.unwrap_or(1.);
    let mut hits: Vec<(f64, f64)> = Vec::new();
    for o in ocr
        .observations
        .iter()
        .filter(|o| o.confidence >= 0.5 && center_x(o) < 0.8 && o.r#box[3] < 0.03)
        .filter(|o| o.r#box[1] > 0.2 && center_y(o) < top)
    {
        let Some((value, dashed)) = number(&o.text) else {
            continue;
        };
        let ok = match axis {
            Some(a) => {
                let want = a.at(center_y(o));
                (want - value).abs() < a.range().max(1e-9) * 0.03
            }
            None => dashed && value > 0.,
        };
        if ok {
            hits.push((center_y(o), value));
        }
    }
    let high = hits
        .iter()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .copied()
        .map(|v| v.1)?;
    let low = hits
        .iter()
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .copied()
        .map(|v| v.1)?;
    (high > low).then_some(Extremes { high, low })
}

/// 读出这张图上所有认得的锚点。品种、周期、`end_at_guess` 由调用方补齐。
pub fn read(ocr: &OcrResult) -> Anchors {
    read_in_pane(ocr, 1.)
}

pub fn read_in_pane(ocr: &OcrResult, right: f64) -> Anchors {
    let cut = pane_cut(ocr);
    let (axis, last_price) = price_axis(ocr, cut, right);
    Anchors {
        time_labels: time_labels(ocr),
        extremes: extremes(ocr, axis.as_ref(), cut),
        price_axis: axis,
        last_price,
        pane_cut_y: cut,
        ..Default::default()
    }
}

/// `[设置里的截图时区, 本机时区, 0, +8]` 去重。
pub fn utc_offsets(preferred: Option<i32>) -> Vec<i32> {
    let local = chrono::Local::now().offset().local_minus_utc() / 60;
    let mut out = Vec::new();
    for v in [preferred.unwrap_or(local), local, 0, 480] {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn obs(text: &str, x: f64, y: f64) -> Observation {
        wide(text, x, y, 0.09)
    }
    fn wide(text: &str, x: f64, y: f64, w: f64) -> Observation {
        Observation {
            text: text.into(),
            confidence: 1.,
            r#box: [x, y, w, 0.009],
        }
    }
    fn result(items: Vec<Observation>) -> OcrResult {
        OcrResult {
            model_id: "apple-vision-text-r3".into(),
            revision: 3,
            system_version: "test".into(),
            observations: items,
        }
    }
    #[test]
    fn the_four_shapes_the_binance_app_writes_on_its_axes() {
        // 左边被裁掉月份的第一个标签
        assert_eq!(
            time_label("-04 22:00"),
            Some(Partial {
                day: Some(4),
                hour: Some(22),
                minute: Some(0),
                ..Default::default()
            })
        );
        assert_eq!(
            time_label("09-06 06:00"),
            Some(Partial {
                month: Some(9),
                day: Some(6),
                hour: Some(6),
                minute: Some(0),
                ..Default::default()
            })
        );
        // 跨日那一根带年份，右边被裁掉分钟的照样要认
        assert_eq!(
            time_label("2026/09/07 18:00"),
            Some(Partial {
                year: Some(2026),
                month: Some(9),
                day: Some(7),
                hour: Some(18),
                minute: Some(0),
            })
        );
        assert_eq!(
            time_label("09-10 05:"),
            Some(Partial {
                month: Some(9),
                day: Some(10),
                hour: Some(5),
                minute: Some(0),
                ..Default::default()
            })
        );
        assert_eq!(number("1,058.09").unwrap().0, 1058.09);
        assert_eq!(number("50.00K").unwrap().0, 50_000.);
        assert_eq!(number("981.76л").unwrap().0, 981.76);
        let (value, dashed) = number("-962.59").unwrap();
        assert_eq!((value, dashed), (962.59, true));
        // 副图标题、均线那一行都不是时间标签
        assert_eq!(time_label("VOL:9.98K"), None);
        assert_eq!(time_label("MACD(10,30,9) DIF:-13.58"), None);
        assert_eq!(time_label("1058.09"), None);
        assert_eq!(number("MA30"), None);
    }
    #[test]
    fn the_axes_of_the_mu_screenshot_come_back_whole() {
        let ocr = result(vec![
            obs("MU/USDT", 0.334, 0.07),
            obs("1058.09", 0.618, 0.324),
            obs("-962.59", 0.041, 0.531),
            obs("1050.00", 0.895, 0.340),
            obs("1025.00", 0.899, 0.395),
            obs("1000.00", 0.898, 0.450),
            obs("981.76", 0.908, 0.489),
            obs("975.00", 0.905, 0.504),
            obs("950.00", 0.905, 0.559),
            wide("-04 22:00", -0.0001, 0.6002, 0.0979),
            wide("09-06 06:00", 0.2303, 0.6003, 0.1293),
            wide("09-07 14:00", 0.4921, 0.6003, 0.1262),
            wide("09-08 22:00", 0.7539, 0.6003, 0.1293),
            obs("VOL:9.98K MU MAVOL5:56.33K", 0.012, 0.6206),
            obs("200.00K", 0.895, 0.648),
        ]);
        let a = read(&ocr);
        assert_eq!(a.time_labels.len(), 4);
        assert_eq!(a.pane_cut_y, Some(0.6206));
        let axis = a.price_axis.expect("右轴");
        assert_eq!((axis.kind, axis.fit_points), ("linear", 5));
        assert!((a.last_price.unwrap() - 981.76).abs() < 1e-6);
        let ex = a.extremes.expect("极值");
        assert!((ex.high - 1058.09).abs() < 1e-6 && (ex.low - 962.59).abs() < 1e-6);
        // 横轴拟合：UTC+8 下每个蜡烛间距正好一小时，最右一根落在 2026-09-09 00:00Z
        let near = Utc.with_ymd_and_hms(2026, 9, 9, 0, 0, 0).unwrap();
        let pts = stamps(&a.time_labels, near, 480);
        assert_eq!(pts.len(), 4);
        let (c, b, residual) = time_fit(&pts).expect("拟合");
        assert!(residual < 600., "残差 {residual}");
        // 主图宽 0.90、110 根，一根的横向间距换算成时间应当是一小时
        let step = b * 0.90 / 110.;
        assert!((step - 3600.).abs() < 90., "每根 {step} 秒");
        let last = Utc.timestamp_opt((c + b * 0.90) as i64, 0).unwrap();
        assert!(
            (last - Utc.with_ymd_and_hms(2026, 9, 9, 0, 0, 0).unwrap())
                .num_minutes()
                .abs()
                <= 60,
            "最右一根 {last}"
        );
    }
    #[test]
    fn a_price_column_keeps_only_the_numbers_that_keep_falling() {
        // 混进一个不合规矩的（1025 夹在 1000 和 950 之间），留下仍然递减的那三个。
        let ocr = result(vec![
            obs("1050.00", 0.9, 0.34),
            obs("1000.00", 0.9, 0.40),
            obs("1025.00", 0.9, 0.46),
            obs("950.00", 0.9, 0.52),
        ]);
        let axis = read(&ocr).price_axis.expect("价格轴");
        assert_eq!(axis.fit_points, 3);
    }
    #[test]
    fn a_price_column_that_does_not_fall_at_all_is_thrown_away() {
        let ocr = result(vec![
            obs("950.00", 0.9, 0.34),
            obs("1000.00", 0.9, 0.40),
            obs("1025.00", 0.9, 0.46),
            obs("1050.00", 0.9, 0.52),
        ]);
        assert!(read(&ocr).price_axis.is_none());
    }
}

//! chart-match-v2 geometry. Price samples live only in memory; public persistence uses
//! the fixed 192-dimensional descriptor, never this per-candle representation.
use crate::{
    api::dto::Region,
    error::{Error, Result},
};
use image::{DynamicImage, GenericImageView};
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;
use utoipa::ToSchema;

/// Screenshot searches always compare one declared candle interval. Missing input
/// is rejected before encoding or persistence, including calls from model tools.
pub fn require_interval(interval: Option<&str>) -> Result<&str> {
    let interval = interval
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| Error::bad("chart_interval_required"))?;
    // 周期白名单只有 domain::interval 一份；这里只做校验，返回原字符串。
    crate::domain::interval::Interval::exact(interval)?;
    Ok(interval)
}

pub const MODEL: &str = "candle-geometry-v2";
pub const PROTOCOL: &str = "chart-match-v2";
/// open/high/low/close。`shape` 永远是几何坐标（y 向上为正，像素取负），
/// `priced` 只有在价格轴拟合成功时才有，装的是真价格。
#[derive(Clone, Debug)]
pub struct Candle {
    pub shape: [f64; 4],
    pub priced: Option<[f64; 4]>,
}
impl Candle {
    pub fn new(shape: [f64; 4]) -> Self {
        Self {
            shape,
            priced: None,
        }
    }
    pub fn priced(shape: [f64; 4], priced: [f64; 4]) -> Self {
        Self {
            shape,
            priced: Some(priced),
        }
    }
}
/// 红绿假设反过来就是每根的开收互换：`up = (color == 1) == red_up`，翻转 red_up
/// 只会把 open/close 对调，不必重新做一遍连通域。
pub fn flipped(candles: &[Candle]) -> Vec<Candle> {
    candles
        .iter()
        .map(|c| Candle {
            shape: [c.shape[3], c.shape[1], c.shape[2], c.shape[0]],
            priced: c.priced.map(|p| [p[3], p[1], p[2], p[0]]),
        })
        .collect()
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct GeometryQuality {
    pub protocol: String,
    pub model_id: String,
    pub region: Region,
    pub detected_candles: usize,
    pub spacing_consistency: f64,
    pub supported: bool,
    pub limitations: Vec<String>,
}
pub struct Geometry {
    pub candles: Vec<Candle>,
    pub quality: GeometryQuality,
}
/// 分位数；`v` 允许乱序。
fn quantile(v: &mut [f64], q: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    let pos = (v.len() - 1) as f64 * q;
    let i = pos.floor() as usize;
    let j = (i + 1).min(v.len() - 1);
    v[i] + (v[j] - v[i]) * (pos - i as f64)
}
/// 背景色：四角各取一小片，再加上全图隔点取样，逐通道取中位。
/// 暗色主题的图四角常有工具栏，中位色能把它拉回真正的底色。
fn background(rgb: &image::RgbImage) -> [f64; 3] {
    let (w, h) = (rgb.width(), rgb.height());
    let patch = 16.min(w / 8).min(h / 8).max(1);
    let mut ch = [Vec::new(), Vec::new(), Vec::new()];
    let mut take = |p: &image::Rgb<u8>| {
        for (k, c) in ch.iter_mut().enumerate() {
            c.push(f64::from(p.0[k]));
        }
    };
    for (cx, cy) in [
        (0, 0),
        (w - patch, 0),
        (0, h - patch),
        (w - patch, h - patch),
    ] {
        for x in cx..cx + patch {
            for y in cy..cy + patch {
                take(rgb.get_pixel(x, y));
            }
        }
    }
    for y in (0..h).step_by(7) {
        for x in (0..w).step_by(7) {
            take(rgb.get_pixel(x, y));
        }
    }
    let mut out = [0.; 3];
    for (k, v) in out.iter_mut().enumerate() {
        *v = quantile(&mut ch[k], 0.5);
    }
    out
}
/// 红 1 / 绿 2 / 其它 0。暗色主题（背景亮度 < 90）下绝对亮度门槛没有意义，
/// 换成「比背景对应通道高 30」；饱和度那一条两种主题都保留。
fn color(p: image::Rgb<u8>, bg: [f64; 3], dark: bool) -> u8 {
    let [r, g, b] = p.0.map(f64::from);
    if r.max(g).max(b) - r.min(g).min(b) < 40. {
        return 0;
    }
    let (red_floor, green_floor) = if dark {
        (bg[0] + 30., bg[1] + 30.)
    } else {
        (65., 65.)
    };
    if r > g * 1.25 && r > b * 1.1 && r > red_floor {
        1
    } else if g > r * 1.15 && g > b * 1.02 && g > green_floor {
        2
    } else {
        0
    }
}
/// 蜡烛间距估计：列投影的自相关，先越过第一个谷再取最高峰，避开「半个蜡烛宽」那种假峰。
fn pitch_estimate(mask: &[u8], w: usize) -> Option<f64> {
    if w < 64 {
        return None;
    }
    let mut counts = vec![0f64; w];
    for (i, v) in mask.iter().enumerate() {
        if *v != 0 {
            counts[i % w] += 1.;
        }
    }
    let mean = counts.iter().sum::<f64>() / w as f64;
    let dev: Vec<f64> = counts.iter().map(|v| v - mean).collect();
    let denom: f64 = dev.iter().map(|v| v * v).sum();
    if denom <= f64::EPSILON {
        return None;
    }
    let top = (w / 16).max(6);
    let r = |lag: usize| {
        dev[..w - lag]
            .iter()
            .zip(&dev[lag..])
            .map(|(a, b)| a * b)
            .sum::<f64>()
            / denom
    };
    let mut lag = 2;
    while lag < top && r(lag) > 0.05 {
        lag += 1;
    }
    let mut best = (0., 0usize);
    for l in lag..=top {
        let v = r(l);
        if v > best.0 {
            best = (v, l);
        }
    }
    (best.0 > 0.1 && best.1 >= 4).then_some(best.1 as f64)
}
/// §5.4-1 去线：均线（MA30/120/256 那几条）会把蜡烛串成一大片连通域，检测直接失效。
///
/// 做法是沿着「细」结构一路往右追：同色、竖向厚度 ≤ 3px 的段算细段；某一列没有细段，
/// 但那里有一条同色的粗段正好盖住当前高度，就认为线被蜡烛挡住了，跨过去接着追。
/// 跨栏只允许发生在「确实有蜡烛挡着」的列上——这一条把「一排十字星」排除在外：
/// 十字星之间是空背景，追不过去，于是一根也不会被抹掉。
/// 追完的链条横跨 > 2×蜡烛间距，就把链条上的细段全部置 0。
fn erase_thin_lines(mask: &mut [u8], w: usize, h: usize, pitch: f64) {
    let span = (2. * pitch).max(8.);
    // 每列的竖向连通段：(y0, y1, class)
    let mut runs: Vec<Vec<(usize, usize, u8)>> = vec![Vec::new(); w];
    for (x, column) in runs.iter_mut().enumerate() {
        let mut y = 0;
        while y < h {
            let c = mask[y * w + x];
            if c == 0 {
                y += 1;
                continue;
            }
            let mut z = y;
            while z < h && mask[z * w + x] == c {
                z += 1;
            }
            column.push((y, z - 1, c));
            y = z;
        }
    }
    // 文档写「≤3px」，工作图是缩放到 1600 的版本，抗锯齿会给细线镶一圈，放到 4px。
    let thin = |r: &(usize, usize, u8)| r.1 - r.0 <= 3;
    let mut used: Vec<Vec<bool>> = runs.iter().map(|c| vec![false; c.len()]).collect();
    let mut chain: Vec<(usize, usize)> = Vec::new();
    for x0 in 0..w {
        for i0 in 0..runs[x0].len() {
            if used[x0][i0] || !thin(&runs[x0][i0]) {
                continue;
            }
            let class = runs[x0][i0].2;
            let mut yc = (runs[x0][i0].0 + runs[x0][i0].1) as f64 / 2.;
            chain.clear();
            chain.push((x0, i0));
            used[x0][i0] = true;
            let (mut x, mut last) = (x0, x0);
            let mut bridged = 0usize;
            while x + 1 < w {
                x += 1;
                let hit = runs[x].iter().enumerate().find(|(k, r)| {
                    r.2 == class
                        && thin(r)
                        && !used[x][*k]
                        && ((r.0 + r.1) as f64 / 2. - yc).abs() <= 3.5
                });
                if let Some((k, r)) = hit {
                    yc = (r.0 + r.1) as f64 / 2.;
                    used[x][k] = true;
                    chain.push((x, k));
                    last = x;
                    bridged = 0;
                    continue;
                }
                // 被同色蜡烛挡住的那一小段：允许跨过去，但只在真有东西挡着时。
                let covered = runs[x].iter().any(|r| {
                    r.2 == class && !thin(r) && r.0 as f64 <= yc + 3. && r.1 as f64 >= yc - 3.
                });
                bridged += 1;
                if !covered || bridged as f64 > pitch * 1.5 {
                    break;
                }
            }
            if (last - x0) as f64 > span {
                for (cx, ci) in &chain {
                    let (y0, y1, _) = runs[*cx][*ci];
                    for y in y0..=y1 {
                        mask[y * w + cx] = 0;
                    }
                }
            }
        }
    }
}
#[derive(Clone)]
struct Glyph {
    x0: usize,
    x1: usize,
    y0: usize,
    y1: usize,
    body_top: usize,
    body_bottom: usize,
    color: u8,
}
/// 剔掉柱状副图（成交量、MACD 之类）：它们的特征是一大群 glyph 共用同一条底边。
///
/// 这道判断必须放在按列去重之前、在没混过的 glyph 上做。主图蜡烛和它脚下的成交量柱
/// 落在同一个 x 上，先按 x 去重就会把两者并成一根，共用底边的比例再也到不了阈值——
/// 旧版那道同名的闸门就是这么失效的：它看到的已经是混合后的一排。
///
/// 只看「共用底边」会误伤「一串蜡烛恰好收在同一个最低价」，所以另加三条：
/// 一、这一组得大半是实心的柱，上下都没有影线——蜡烛几乎总有影线，柱子没有。
/// 门槛定在一半：手机竖屏那类窄图里，量柱细到只有两三像素宽，缩放后最底下一两行
/// 凑不够 body 的像素数，于是柱子也会被当成「带下影线」，实测这类图的实心率掉到
/// 0.56~0.70，而正常认出来的副图是 0.78~1.00；真正的蜡烛群实心率接近零，一半这条
/// 线离两边都远，够用了；
/// 二、底边到该组最高一根之间的这一段里，几乎不能有别的 glyph 收在半空——
/// 副图里每根柱子都坐在底边上，主图同一段里总还夹着收在中途的蜡烛；
/// 三、这一段之上还得有一片体量相当的图形——副图永远在主图底下，最上面那片不是副图。
fn without_bar_panes(glyphs: Vec<Glyph>) -> Vec<Glyph> {
    const TOL: usize = 2; // 缩放和抗锯齿会让同一条底边差出一两个像素
    let total = glyphs.len();
    let mut order: Vec<usize> = (0..total).collect();
    order.sort_by_key(|i| glyphs[*i].y1);
    let mut doomed = vec![false; total];
    let (mut lo, mut hi, mut last) = (0usize, 0usize, usize::MAX);
    for i in &order {
        let base = glyphs[*i].y1;
        while glyphs[order[lo]].y1 + TOL < base {
            lo += 1;
        }
        while hi < total && glyphs[order[hi]].y1 <= base + TOL {
            hi += 1;
        }
        let size = hi - lo;
        // 副图是一列一根，体量与主图相当；零星几根同底不值得怀疑。同一条底边只判一次。
        if size < 8 || size * 4 < total || last.abs_diff(base) <= TOL {
            continue;
        }
        last = base;
        let solid = (lo..hi)
            .map(|j| &glyphs[order[j]])
            .filter(|g| g.body_top <= g.y0 + TOL && g.body_bottom + TOL >= g.y1)
            .count();
        let top = (lo..hi).map(|j| glyphs[order[j]].y0).min().unwrap();
        let stray = glyphs
            .iter()
            .filter(|g| g.y1 > top && g.y1 + TOL < base)
            .count();
        let above = glyphs.iter().filter(|g| g.y1 < top).count();
        if solid * 2 >= size && stray * 8 <= size && above >= 8 && above * 2 >= size {
            for j in lo..hi {
                doomed[order[j]] = true;
            }
        }
    }
    glyphs
        .into_iter()
        .zip(doomed)
        .filter(|(_, drop)| !drop)
        .map(|(g, _)| g)
        .collect()
}
/// 检测参数。`blanked` 是要先抹掉的矩形（图像归一化坐标 `[x, y, w, h]`，与 OCR
/// 观测框同一套），用来去掉右轴最新价那种带底色的标签；它只抹标签本身，不切掉
/// 标签左边的整条竖带——真实截图里蜡烛常常一直画到价格标签底下。
#[derive(Default)]
pub struct DetectOptions<'a> {
    pub region: Option<Region>,
    pub red_up: bool,
    pub blanked: &'a [[f64; 4]],
}
pub fn detect(im: &DynamicImage, region: Option<Region>, red_up: bool) -> Result<Geometry> {
    detect_with(
        im,
        DetectOptions {
            region,
            red_up,
            blanked: &[],
        },
    )
}
pub fn detect_with(im: &DynamicImage, o: DetectOptions<'_>) -> Result<Geometry> {
    let (iw, ih) = im.dimensions();
    let roi = o.region.unwrap_or(Region {
        x: 0,
        y: 0,
        width: iw,
        height: ih,
    });
    if roi.width < 64
        || roi.height < 32
        || roi.x.checked_add(roi.width).is_none_or(|v| v > iw)
        || roi.y.checked_add(roi.height).is_none_or(|v| v > ih)
    {
        return Err(Error::bad("invalid_region"));
    }
    let crop = im.crop_imm(roi.x, roi.y, roi.width, roi.height);
    let rgb = crop
        .resize(1600, 1600, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let bg = background(&rgb);
    let dark = bg.iter().sum::<f64>() / 3. < 90.;
    let mut mask: Vec<u8> = rgb.pixels().map(|p| color(*p, bg, dark)).collect();
    for r in o.blanked {
        let px = |v: f64, whole: u32, off: u32, size: u32, out: usize| {
            (((v * f64::from(whole)) - f64::from(off)) / f64::from(size) * out as f64).round()
        };
        let x0 = px(r[0], iw, roi.x, roi.width, w).max(0.) as usize;
        let y0 = px(r[1], ih, roi.y, roi.height, h).max(0.) as usize;
        let x1 = (px(r[0] + r[2], iw, roi.x, roi.width, w).max(0.) as usize).min(w);
        let y1 = (px(r[1] + r[3], ih, roi.y, roi.height, h).max(0.) as usize).min(h);
        for y in y0..y1 {
            for x in x0..x1 {
                mask[y * w + x] = 0;
            }
        }
    }
    if let Some(pitch) = pitch_estimate(&mask, w) {
        erase_thin_lines(&mut mask, w, h, pitch);
    }
    let mut glyphs = Vec::new();
    for root in 0..mask.len() {
        let class = mask[root];
        if class == 0 {
            continue;
        }
        mask[root] = 0;
        let mut stack = vec![root];
        let mut points = Vec::new();
        let (mut x0, mut x1, mut y0, mut y1) = (w, 0, h, 0);
        while let Some(p) = stack.pop() {
            let (x, y) = (p % w, p / w);
            x0 = x0.min(x);
            x1 = x1.max(x);
            y0 = y0.min(y);
            y1 = y1.max(y);
            points.push((x, y));
            for next in [
                if x > 0 { Some(p - 1) } else { None },
                if x + 1 < w { Some(p + 1) } else { None },
                if y > 0 { Some(p - w) } else { None },
                if y + 1 < h { Some(p + w) } else { None },
            ]
            .into_iter()
            .flatten()
            {
                if mask[next] == class {
                    mask[next] = 0;
                    stack.push(next);
                }
            }
        }
        let width = x1 - x0 + 1;
        let height = y1 - y0 + 1;
        if width < 2 || width > w / 24 || height < 3 || points.len() < 6 || height > h * 4 / 5 {
            continue;
        }
        let mut rows = vec![0usize; height];
        for (_, y) in &points {
            rows[*y - y0] += 1;
        }
        let threshold = (width * 2 / 3).max(2);
        let body: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter(|(_, n)| **n >= threshold)
            .map(|(y, _)| y + y0)
            .collect();
        if body.is_empty() {
            continue;
        }
        glyphs.push(Glyph {
            x0,
            x1,
            y0,
            y1,
            body_top: body[0],
            body_bottom: *body.last().unwrap(),
            color: class,
        });
    }
    if glyphs.len() > 4096 {
        return Err(Error::bad("chart_too_complex_select_region"));
    }
    // 先整片切掉共用底边的柱状副图，再在剩下的主图候选里挑那一排。
    // 孤立的符号和文字凑不出足够长、间距规整的一排，交给下面的一致性判据。
    let mut glyphs = without_bar_panes(glyphs);
    glyphs.sort_by_key(|g| g.x0 + g.x1);
    let mut best = Vec::new();
    for seed in glyphs.iter().take(2048) {
        let center = (seed.y0 + seed.y1) as f64 / 2.;
        let mut row: Vec<_> = glyphs
            .iter()
            .filter(|g| {
                let gc = (g.y0 + g.y1) as f64 / 2.;
                (gc - center).abs() < h as f64 * 0.55
                    && g.x1 - g.x0 < (seed.x1 - seed.x0 + 1) * 3
                    && seed.x1 - seed.x0 < (g.x1 - g.x0 + 1) * 3
            })
            .cloned()
            .collect();
        row.dedup_by(|a, b| (a.x0 + a.x1).abs_diff(b.x0 + b.x1) < (a.x1 - a.x0 + b.x1 - b.x0 + 2));
        if row.len() > best.len() {
            best = row;
        }
    }
    if best.len() < 16 || best.len() > 512 {
        return Err(Error::bad("ordinary_candles_not_resolved"));
    }
    let mut gaps: Vec<f64> = best
        .windows(2)
        .map(|g| ((g[1].x0 + g[1].x1) - (g[0].x0 + g[0].x1)) as f64 / 2.)
        .collect();
    gaps.sort_by(f64::total_cmp);
    let median = gaps[gaps.len() / 2];
    let consistency = gaps
        .iter()
        .filter(|g| **g >= median * 0.6 && **g <= median * 1.5)
        .count() as f64
        / gaps.len() as f64;
    if consistency < 0.75 {
        return Err(Error::bad("chart_obstructed_or_unsupported"));
    }
    let left = best.iter().map(|g| g.x0).min().unwrap();
    let right = best.iter().map(|g| g.x1).max().unwrap();
    let top = best.iter().map(|g| g.y0).min().unwrap();
    let bottom = best.iter().map(|g| g.y1).max().unwrap();
    let scale_x = roi.width as f64 / w as f64;
    let scale_y = roi.height as f64 / h as f64;
    let region = Region {
        x: roi.x + (left as f64 * scale_x).floor() as u32,
        y: roi.y + (top as f64 * scale_y).floor() as u32,
        width: (((right - left + 1) as f64 * scale_x).ceil() as u32).min(roi.width),
        height: (((bottom - top + 1) as f64 * scale_y).ceil() as u32).min(roi.height),
    };
    let candles = best
        .iter()
        .map(|g| {
            let up = (g.color == 1) == o.red_up;
            let high = -(g.y0 as f64);
            let low = -(g.y1 as f64);
            let bt = -(g.body_top as f64);
            let bb = -(g.body_bottom as f64);
            Candle::new([
                if up { bb } else { bt },
                high,
                low,
                if up { bt } else { bb },
            ])
        })
        .collect();
    Ok(Geometry {
        candles,
        quality: GeometryQuality {
            protocol: PROTOCOL.into(),
            model_id: MODEL.into(),
            region,
            detected_candles: best.len(),
            spacing_consistency: consistency,
            supported: true,
            limitations: vec![
                "ordinary_red_green_candles_only".into(),
                "heikin_ashi_cannot_be_excluded_from_pixels_alone".into(),
                "symbol_and_interval_require_visible_text".into(),
                "semantic_quality_not_yet_validated".into(),
            ],
        },
    })
}
/// Preserve every detected candle and its direction; apply only one vertical
/// affine transform. Display-only: no DTW, fitted price axis, or invented future.
pub fn display_outline(candles: &[Candle]) -> Result<Vec<f64>> {
    normalized(candles, false)?; // Validate supported size, finite OHLC and non-flat geometry.
    let low = candles
        .iter()
        .map(|c| c.shape[2])
        .fold(f64::INFINITY, f64::min);
    let high = candles
        .iter()
        .map(|c| c.shape[1])
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(candles
        .iter()
        .map(|c| (c.shape[3] - low) / (high - low))
        .collect())
}
pub fn from_bars(bars: &[super::criteria::Bar]) -> Result<Vec<Candle>> {
    super::chart::numbers(bars)
        .map(|v| v.into_iter().map(|c| Candle::priced(c, c)).collect())
        .map_err(Error::bad)
}
/// 归一化到 64 个采样点。上下界取高的 98 分位 / 低的 2 分位（§5.4-4）：
/// 单根插针以前会把整张图压扁，现在它自己越界到 0..1 之外，其余部分的起伏保住。
pub fn normalized(candles: &[Candle], reverse: bool) -> Result<Vec<[f64; 4]>> {
    if candles.len() < 16
        || candles.len() > 2000
        || candles.iter().any(|c| {
            c.shape.iter().any(|v| !v.is_finite())
                || c.shape[1] < c.shape[0].max(c.shape[3])
                || c.shape[2] > c.shape[0].min(c.shape[3])
        })
    {
        return Err(Error::bad("invalid_candle_geometry"));
    }
    let mut highs: Vec<f64> = candles.iter().map(|c| c.shape[1]).collect();
    let mut lows: Vec<f64> = candles.iter().map(|c| c.shape[2]).collect();
    let mut hi = quantile(&mut highs, 0.98);
    let mut lo = quantile(&mut lows, 0.02);
    if hi - lo <= f64::EPSILON {
        // 分位数被一段长横盘吃掉了，退回绝对上下界。
        hi = *highs.last().unwrap();
        lo = lows[0];
    }
    let range = hi - lo;
    if range <= f64::EPSILON {
        return Err(Error::bad("flat_chart_geometry"));
    }
    Ok((0..64)
        .map(|i| {
            let pos = i as f64 * (candles.len() - 1) as f64 / 63.;
            let a = pos.floor() as usize;
            let b = (a + 1).min(candles.len() - 1);
            let t = pos - a as f64;
            let mut p = [0.; 4];
            for (j, v) in p.iter_mut().enumerate() {
                *v = (candles[a].shape[j] * (1. - t) + candles[b].shape[j] * t - lo) / range;
            }
            if reverse {
                [1. - p[0], 1. - p[2], 1. - p[1], 1. - p[3]]
            } else {
                p
            }
        })
        .collect())
}
/// 价格域重采样：只有每一根都带 `priced` 时才成立。
fn resampled_prices(candles: &[Candle]) -> Result<Vec<[f64; 4]>> {
    if candles.len() < 16 || candles.iter().any(|c| c.priced.is_none()) {
        return Err(Error::bad("candles_without_price_axis"));
    }
    Ok((0..64)
        .map(|i| {
            let pos = i as f64 * (candles.len() - 1) as f64 / 63.;
            let a = pos.floor() as usize;
            let b = (a + 1).min(candles.len() - 1);
            let t = pos - a as f64;
            let (pa, pb) = (candles[a].priced.unwrap(), candles[b].priced.unwrap());
            let mut p = [0.; 4];
            for (j, v) in p.iter_mut().enumerate() {
                *v = pa[j] * (1. - t) + pb[j] * t;
            }
            p
        })
        .collect())
}
pub fn descriptor(candles: &[Candle]) -> Result<Vec<f32>> {
    let series = normalized(candles, false)?;
    let mut vector = Vec::with_capacity(192);
    for (i, p) in series.iter().enumerate() {
        let center = (p[0] + p[3]) / 2.;
        let prev = if i == 0 {
            center
        } else {
            (series[i - 1][0] + series[i - 1][3]) / 2.
        };
        vector.extend([
            (center - 0.5) as f32,
            ((p[1] - p[2]) * 0.5) as f32,
            ((center - prev) * 2.) as f32,
        ]);
    }
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm <= 1e-6 {
        return Err(Error::bad("flat_chart_geometry"));
    }
    for v in &mut vector {
        *v /= norm;
    }
    Ok(vector)
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct MatchScore {
    pub score: f64,
    pub alignment_cost: f64,
    pub direction_consistent: bool,
    pub reverse: bool,
    pub meaning: String,
    /// 校准后的稀有度：同档位样本里低于此分的比例（§5.5-3）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rarity: Option<f64>,
    /// 给前端的档位词来源，只回枚举值：`sure|likely|weak` 或 `很像|像|有点像` 对应的键。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// 本次比对分布里的 z 分数（§5.2 第 5 步）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z: Option<f64>,
}
impl MatchScore {
    fn new(score: f64, cost: f64, consistent: bool, reverse: bool, meaning: &str) -> Self {
        Self {
            score,
            alignment_cost: cost,
            direction_consistent: consistent,
            reverse,
            meaning: meaning.into(),
            rarity: None,
            level: None,
            z: None,
        }
    }
}
/// 归一化之后的带状 DTW；方向不再是断崖，而是按净涨跌差连续扣分（§5.4-5）。
fn compare(a: &[[f64; 4]], b: &[[f64; 4]], reverse: bool) -> MatchScore {
    let net = |v: &[[f64; 4]]| v[63][3] - v[0][0];
    let consistent =
        net(a).signum() == net(b).signum() || net(a).abs() < 0.08 || net(b).abs() < 0.08;
    let mut prev = [f64::INFINITY; 65];
    prev[0] = 0.;
    for i in 1usize..=64 {
        let mut row = [f64::INFINITY; 65];
        for j in i.saturating_sub(6).max(1)..=(i + 6).min(64) {
            let p = a[i - 1];
            let q = b[j - 1];
            let cost = (p[0] - q[0]).abs() * 0.25
                + (p[3] - q[3]).abs() * 0.35
                + (p[1] - q[1]).abs() * 0.2
                + (p[2] - q[2]).abs() * 0.2;
            row[j] = cost + (prev[j - 1]).min(prev[j] + 0.025).min(row[j - 1] + 0.025);
        }
        prev = row;
    }
    let cost = prev[64] / 64. + 0.15 * (net(a) - net(b)).abs();
    MatchScore::new(
        (-6. * cost).exp(),
        cost,
        consistent,
        reverse,
        "structural_similarity_not_probability",
    )
}
pub fn rerank(query: &[Candle], candidate: &[Candle], reverse: bool) -> Result<MatchScore> {
    let a = normalized(query, reverse)?;
    let b = normalized(candidate, false)?;
    Ok(compare(&a, &b, reverse))
}
/// 价格域比对（§5.4-8）：两边都拿得到真价格时，用相对误差的中位数打分。
pub fn rerank_priced(query: &[Candle], candidate: &[Candle]) -> Result<MatchScore> {
    let a = resampled_prices(query)?;
    let b = resampled_prices(candidate)?;
    let mut errs = Vec::with_capacity(256);
    for (p, q) in a.iter().zip(&b) {
        for (x, y) in p.iter().zip(q) {
            errs.push((x - y).abs() / y.abs().max(1e-9));
        }
    }
    let median = quantile(&mut errs, 0.5);
    let net = |v: &[[f64; 4]]| v[63][3] - v[0][0];
    Ok(MatchScore::new(
        (-200. * median).exp(),
        median,
        net(&a).signum() == net(&b).signum(),
        false,
        "price_domain_median_relative_error",
    ))
}
/// §5.4-7 自由长度扫描：在 `bars` 里试遍所有起点与 `lengths` 里的长度，返回
/// 按分数从高到低排好的 `(start, len, score)`。位置步长固定 1，`step` 是长度步长。
pub fn sweep(
    query: &[Candle],
    bars: &[Candle],
    lengths: RangeInclusive<usize>,
    step: usize,
) -> Vec<(usize, usize, MatchScore)> {
    sweep_reversed(query, bars, lengths, step, false)
}
pub fn sweep_reversed(
    query: &[Candle],
    bars: &[Candle],
    lengths: RangeInclusive<usize>,
    step: usize,
    reverse: bool,
) -> Vec<(usize, usize, MatchScore)> {
    let Ok(a) = normalized(query, reverse) else {
        return vec![];
    };
    let lo = (*lengths.start()).max(16);
    let hi = (*lengths.end()).min(bars.len()).min(2000);
    let mut out = Vec::new();
    let mut len = lo;
    while len <= hi {
        for start in 0..=bars.len() - len {
            if let Ok(b) = normalized(&bars[start..start + len], false) {
                out.push((start, len, compare(&a, &b, reverse)));
            }
        }
        len += step.max(1);
    }
    out.sort_by(|x, y| y.2.score.total_cmp(&x.2.score));
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};
    // 合成图：一张 1280x800 的浅底图，红绿两档正好落在 color() 认得的范围里。
    const W: u32 = 1280;
    const H: u32 = 800;
    const N: usize = 48;
    const PITCH: u32 = W / N as u32;
    const BODY: u32 = 12;
    const WICK: u32 = 4;
    const UP: Rgb<u8> = Rgb([32, 178, 108]);
    const DOWN: Rgb<u8> = Rgb([222, 64, 72]);
    // 双段版：主图占上方七成，成交量柱占下方一成七，中间留出窗格间隙。
    const MAIN_TOP: u32 = 40;
    const MAIN_HEIGHT: u32 = 560;
    const VOLUME_BASE: u32 = 780;
    const VOLUME_HEIGHT: u32 = 136;
    fn canvas() -> RgbImage {
        RgbImage::from_pixel(W, H, Rgb([250, 250, 250]))
    }
    fn rect(im: &mut RgbImage, i: usize, width: u32, top: u32, bottom: u32, up: bool) {
        fill(im, i, width, top, bottom, if up { UP } else { DOWN });
    }
    fn fill(im: &mut RgbImage, i: usize, width: u32, top: u32, bottom: u32, c: Rgb<u8>) {
        let x0 = PITCH / 2 + i as u32 * PITCH - width / 2;
        for x in x0..x0 + width {
            for y in top..bottom {
                im.put_pixel(x, y, c);
            }
        }
    }
    /// 一条确定的起伏走势，取值 0..1，1 是这一片的顶。
    fn wave(i: usize) -> f64 {
        0.5 + 0.3 * (i as f64 * 0.37).sin() + 0.12 * (i as f64 * 1.13).cos()
    }
    /// 在 [top, top + height) 这一片里画蜡烛。skip 为真的那几列不画：真实截图里
    /// 总有几根十字星矮到检不出、或者被光标标签盖住，而它们脚下的成交量柱照样在——
    /// 盲测里检出根数超过真值，来的就是顶上来替班的那几根量柱。
    fn candles(im: &mut RgbImage, top: u32, height: u32, skip: bool) -> usize {
        let mut drawn = 0;
        for i in (0..N).filter(|i| !(skip && missing(*i))) {
            let y = |v: f64| top + ((1. - v) * height as f64) as u32;
            let (o, c) = (wave(i), wave(i + 1));
            let (hi, lo) = (o.max(c), o.min(c));
            rect(im, i, WICK, y(hi + 0.05), y(lo - 0.05), c > o);
            rect(im, i, BODY, y(hi), y(lo).max(y(hi) + 5), c > o);
            drawn += 1;
        }
        drawn
    }
    fn missing(i: usize) -> bool {
        i % 12 == 5
    }
    /// 一段柱状副图：N 根柱子共用底边 base，x 与蜡烛对齐，颜色同为红绿。返回最高一根的顶边。
    fn bars(im: &mut RgbImage, base: u32, height: u32, phase: f64) -> u32 {
        let mut top = base;
        for i in 0..N {
            let v = 0.15 + 0.8 * (0.5 + 0.5 * (i as f64 * phase).sin());
            let bar = (v * height as f64) as u32;
            rect(im, i, BODY, base - bar, base, wave(i + 1) > wave(i));
            top = top.min(base - bar);
        }
        top
    }
    fn geometry(im: RgbImage) -> Geometry {
        detect(&DynamicImage::ImageRgb8(im), None, false).unwrap()
    }
    #[test]
    fn volume_pane_never_enters_the_candle_row() {
        let mut im = canvas();
        let drawn = candles(&mut im, MAIN_TOP, MAIN_HEIGHT, true);
        let top = bars(&mut im, VOLUME_BASE, VOLUME_HEIGHT, 0.8);
        let g = geometry(im);
        // 每一列上蜡烛和成交量柱各一根：认出来的只能是主图那几根，不是 2N，也不能多出来。
        assert_eq!(g.quality.detected_candles, drawn);
        assert_eq!(g.candles.len(), drawn);
        let bottom = g.quality.region.y + g.quality.region.height;
        assert!(
            bottom <= top,
            "认出的区域压到了成交量柱上：{bottom} > {top}"
        );
    }
    #[test]
    fn main_pane_alone_still_resolves() {
        let mut im = canvas();
        assert_eq!(candles(&mut im, MAIN_TOP, MAIN_HEIGHT, false), N);
        let g = geometry(im);
        assert_eq!(g.quality.detected_candles, N);
        let bottom = g.quality.region.y + g.quality.region.height;
        assert!(g.quality.region.y + 2 >= MAIN_TOP && bottom <= MAIN_TOP + MAIN_HEIGHT + 2);
    }
    #[test]
    fn volume_and_indicator_panes_are_both_dropped() {
        let (main_height, volume_base, indicator_base) = (430, 610, 770);
        let mut im = canvas();
        let drawn = candles(&mut im, 30, main_height, true);
        let top = bars(&mut im, volume_base, 110, 0.8).min(bars(&mut im, indicator_base, 110, 1.7));
        let g = geometry(im);
        assert_eq!(g.quality.detected_candles, drawn);
        let bottom = g.quality.region.y + g.quality.region.height;
        assert!(bottom <= top, "认出的区域压到了副图上：{bottom} > {top}");
    }
    #[test]
    fn candles_resting_on_one_support_are_not_a_volume_pane() {
        let mut im = canvas();
        let y = |v: f64| MAIN_TOP + ((1. - v) * MAIN_HEIGHT as f64) as u32;
        // 48 根里 41 根恰好收在同一个最低价上：底边天然相同，但它们是蜡烛，不是量柱。
        for i in 0..N {
            let (o, c) = (0.3 + 0.5 * wave(i), 0.3 + 0.5 * wave(i + 1));
            let (hi, lo) = (o.max(c), if i % 7 == 0 { o.min(c) - 0.05 } else { 0.12 });
            rect(&mut im, i, WICK, y(hi + 0.05), y(lo), c > o);
            rect(&mut im, i, BODY, y(hi), y(o.min(c)).max(y(hi) + 5), c > o);
        }
        assert_eq!(geometry(im).quality.detected_candles, N);
    }

    /// §5.4-1：均线穿过蜡烛。三条彩色折线分别落进红类和绿类，不去线的话整排蜡烛
    /// 会被串成几个超宽的连通域，一根都认不出来。
    #[test]
    fn moving_average_lines_do_not_glue_the_candles_together() {
        let mut im = canvas();
        let drawn = candles(&mut im, MAIN_TOP, MAIN_HEIGHT, false);
        assert_eq!(drawn, N);
        let lines = [
            (Rgb([236, 100, 186]), 300., 130., 0.0035, 0.0),
            (Rgb([240, 162, 44]), 330., 90., 0.0021, 1.7),
            (Rgb([96, 204, 128]), 270., 110., 0.0028, 3.1),
        ];
        for (c, mid, amp, freq, phase) in lines {
            for x in 0..W {
                let y = mid + amp * (x as f64 * freq + phase).sin();
                for t in 0..2 {
                    im.put_pixel(x, y as u32 + t, c);
                }
            }
        }
        let g = geometry(im);
        assert_eq!(g.quality.detected_candles, N, "均线把蜡烛粘住了");
    }
    /// §5.4-2：暗色主题。这两组颜色的绝对亮度都够不到旧版的 65 门槛，
    /// 但相对底色的饱和度很清楚。
    #[test]
    fn dark_theme_candles_are_still_red_and_green() {
        const NIGHT: Rgb<u8> = Rgb([10, 12, 16]);
        const DIM_UP: Rgb<u8> = Rgb([18, 62, 42]);
        const DIM_DOWN: Rgb<u8> = Rgb([64, 20, 26]);
        let mut im = RgbImage::from_pixel(W, H, NIGHT);
        for i in 0..N {
            let y = |v: f64| MAIN_TOP + ((1. - v) * MAIN_HEIGHT as f64) as u32;
            let (o, c) = (wave(i), wave(i + 1));
            let (hi, lo) = (o.max(c), o.min(c));
            let tone = if c > o { DIM_UP } else { DIM_DOWN };
            fill(&mut im, i, WICK, y(hi + 0.05), y(lo - 0.05), tone);
            fill(&mut im, i, BODY, y(hi), y(lo).max(y(hi) + 5), tone);
        }
        let g = detect(&DynamicImage::ImageRgb8(im), None, false).unwrap();
        assert_eq!(g.quality.detected_candles, N);
    }
    /// §5.4-7：从 768 根里截出 110 根当查询，sweep 必须把它放回原处。
    #[test]
    fn sweep_puts_the_excerpt_back_where_it_was_cut_from() {
        let bars: Vec<Candle> = (0..768)
            .map(|i| {
                let f = i as f64;
                let v =
                    100. + 9. * (f * 0.031).sin() + 4. * (f * 0.11).cos() + 1.5 * (f * 0.7).sin();
                let n = 100. + 9. * ((f + 1.) * 0.031).sin() + 4. * ((f + 1.) * 0.11).cos();
                Candle::new([v, v.max(n) + 0.6, v.min(n) - 0.6, n])
            })
            .collect();
        let query: Vec<Candle> = bars[300..410].to_vec();
        let found = sweep(&query, &bars, 99..=121, 2);
        let (start, len, score) = found.first().expect("sweep 应该给出结果");
        assert!(score.score > 0.9, "分数太低：{}", score.score);
        assert!(start.abs_diff(300) <= 2, "起点找错了：{start}");
        assert!(len.abs_diff(110) <= 4, "长度找错了：{len}");
    }
}

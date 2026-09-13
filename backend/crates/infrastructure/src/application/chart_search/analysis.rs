use super::*;
use crate::{adapters::ocr::OcrResult, application::chart_search::anchors};
use std::collections::BTreeSet;

/// A desktop browser capture can include unrelated tab symbols and a watchlist.
/// Locate a regular, descending price-axis column and keep only its main chart.
/// Nothing is cropped merely because a symbol happens to look plausible.
fn chart_scope(ocr: OcrResult) -> (OcrResult, Option<[f64; 4]>, f64) {
    let top = ocr
        .observations
        .iter()
        .filter(|o| {
            let t = o.text.to_lowercase();
            o.r#box[1] < 0.15
                && (t.contains("tradingview.com/")
                    || t.starts_with("https://")
                    || t.starts_with("http://"))
        })
        .map(|o| o.r#box[1] + o.r#box[3] + 0.03)
        .max_by(f64::total_cmp)
        .unwrap_or(0.);
    if top == 0. {
        return (ocr, None, 1.);
    }
    let numeric: Vec<_> = ocr
        .observations
        .iter()
        .filter(|o| {
            o.confidence >= 0.8
                && o.r#box[0] > 0.55
                && o.r#box[1] > top.max(0.18)
                && o.r#box[1] < 0.9
        })
        .filter_map(|o| {
            o.text
                .replace(',', "")
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && *v > 0.)
                .map(|v| (o, v))
        })
        .collect();
    let mut best: Vec<usize> = Vec::new();
    for (a, (oa, va)) in numeric.iter().enumerate() {
        for (ob, vb) in numeric.iter().skip(a + 1) {
            let dy = ob.r#box[1] - oa.r#box[1];
            if dy.abs() < 0.15 || (oa.r#box[0] - ob.r#box[0]).abs() > 0.02 {
                continue;
            }
            let slope = (vb - va) / dy;
            if slope >= 0. {
                continue;
            }
            let hits: Vec<usize> = numeric
                .iter()
                .enumerate()
                .filter(|(_, (o, v))| {
                    (o.r#box[0] - oa.r#box[0]).abs() < 0.025
                        && (v - (va + slope * (o.r#box[1] - oa.r#box[1]))).abs()
                            < slope.abs() * 0.002
                })
                .map(|(i, _)| i)
                .collect();
            if hits.len() > best.len() {
                best = hits;
            }
        }
    }
    let right = if best.len() >= 5 {
        (best
            .iter()
            .map(|i| numeric[*i].0.r#box[0] + numeric[*i].0.r#box[2])
            .fold(0., f64::max)
            + 0.008)
            .min(1.)
    } else {
        1.
    };
    let plot_right = if best.len() >= 5 {
        best.iter()
            .map(|i| numeric[*i].0.r#box[0])
            .fold(1., f64::min)
            - 0.008
    } else {
        1.
    };
    // Native mobile captures already have a clean title strip; leave their established crop unchanged.
    let crop = if best.len() >= 5 {
        let mut rows: Vec<f64> = best
            .iter()
            .map(|i| numeric[*i].0.r#box[1] + numeric[*i].0.r#box[3] / 2.)
            .collect();
        rows.sort_by(f64::total_cmp);
        let mut steps: Vec<f64> = rows
            .windows(2)
            .map(|r| r[1] - r[0])
            .filter(|d| *d > 0.005)
            .collect();
        steps.sort_by(f64::total_cmp);
        let padding = steps.get(steps.len() / 2).copied().unwrap_or(0.04) / 2.;
        let chart_top = (rows[0] - padding).max(top);
        let chart_bottom = (rows[rows.len() - 1] + padding).min(1.);
        Some([0., chart_top, plot_right, chart_bottom - chart_top])
    } else {
        None
    };
    let observations = ocr
        .observations
        .into_iter()
        .filter(|o| o.r#box[1] >= top && o.r#box[0] < right)
        .collect();
    (
        OcrResult {
            observations,
            ..ocr
        },
        crop,
        right,
    )
}

/// 图上自己写着的品种候选与周期，只从 OCR 的文字里读。
///
/// 抽出来是因为有两个人要用同一份规则：`evidence()` 给 chart.analyze 填证据，
/// 定位面板给「这张图默认是哪个品种」填默认值。规则只有这一份，白名单也只有
/// `domain::interval` 那一份，两边不会各认各的。
///
/// 只看顶上那条窄带（`box[1] < 0.35`）里置信度 0.9 以上的字：币安 App 的标题
/// 栏就在那儿，图心的价格、指标数字不该参与认品种。窄带和门槛都按 §5.2 第 1 步
/// 放宽过——横屏截图的标题栏会掉到 0.3 以下，0.98 也把一部分清楚的标题挡在外面。
fn labels(ocr: &OcrResult) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut symbols = BTreeSet::new();
    let mut intervals = BTreeSet::new();
    for obs in ocr
        .observations
        .iter()
        .filter(|o| o.confidence >= 0.9 && o.r#box[1] < 0.35)
    {
        for word in obs.text.split_whitespace() {
            if let Some(iv) = toolbar::canonical(word) {
                intervals.insert(iv);
            }
        }
        // 标题栏写的是 `SNDK/USDT` 这种带斜杠的对，而交易所的合约名是
        // `SNDKUSDT`：按斜杠切开只剩 `SNDK`、`USDT` 两个四字母碎片，谁都过不了
        // 五字门槛，图上明明白白的品种反而读不出来。所以除了原样切一遍，再把
        // 斜杠抹掉切一遍，让这一对能合回它在 catalog 里的样子。合出来的东西照
        // 样要过 catalog 这一关，`2026/09/07` 拼成的 `20260907` 不在表里，自然
        // 落不进候选。
        for text in [obs.text.as_str(), &obs.text.replace('/', "")] {
            for word in text.split(|c: char| {
                !c.is_ascii_alphanumeric()
                    && !scorebook_core::domain::instrument::symbol_character(c)
            }) {
                // 周期白名单只有 domain::interval 一份。先按原样精确匹配，`1M`（月线）
                // 才不会被当成 `1m`（分钟线）；匹配不上再退一步做大小写不敏感匹配，
                // 这样截图上的 `1D`/`30M` 也能认出来。别名不在这里放行：OCR 噪声里
                // 单个 `d`、`w` 太容易误判成周期。
                if let Some(iv) = toolbar::canonical(word) {
                    intervals.insert(iv);
                }
                if word.chars().count() >= 5
                    && scorebook_core::domain::instrument::valid_symbol(word)
                {
                    symbols.insert(word.to_string());
                }
            }
        }
    }
    (symbols, intervals)
}

/// exchange_info 抄下来的 `instrument_catalog` 是自动填入品种的唯一权威：候选里
/// 活下来正好一个才算认出来，多一个就是没认出来。
///
/// 市场跟着品种一起回来，因为同板块对比图上的标的未必跟记录同一个市场。同名合
/// 约跨两个市场时市场留空——认出了品种不等于认出了市场，这一格宁可空着。
async fn catalogued(
    s: &Services,
    candidates: BTreeSet<String>,
) -> Result<(Option<String>, Option<String>)> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT symbol,market FROM instrument_catalog WHERE symbol=ANY($1)",
    )
    .bind(candidates.into_iter().collect::<Vec<_>>())
    .fetch_all(&s.db.pool)
    .await?;
    let known: BTreeSet<&str> = rows.iter().map(|(symbol, _)| symbol.as_str()).collect();
    let Some(symbol) = known.iter().next().filter(|_| known.len() == 1) else {
        return Ok((None, None));
    };
    let markets: BTreeSet<&str> = rows.iter().map(|(_, market)| market.as_str()).collect();
    let market = markets
        .iter()
        .next()
        .filter(|_| markets.len() == 1)
        .map(|v| v.to_string());
    Ok((Some(symbol.to_string()), market))
}

/// Search may compare another quote of the same catalogued base asset. This is
/// a search suggestion only; exact-location anchors retain the source identity.
async fn search_symbol(s: &Services, ocr: &OcrResult) -> Result<(Option<String>, Option<String>)> {
    let (symbols, _) = labels(ocr);
    let (exact, _) = catalogued(s, symbols.clone()).await?;
    if exact.is_some() {
        return Ok((exact.clone(), exact));
    }
    let sources: Vec<_> = symbols
        .iter()
        .filter_map(|symbol| {
            symbol
                .strip_suffix("USD")
                .filter(|base| !base.is_empty())
                .map(|base| (symbol, base))
        })
        .collect();
    let bases: Vec<_> = sources.iter().map(|(_, base)| *base).collect();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT symbol,body->>'baseAsset' FROM instrument_catalog WHERE venue='binance' AND market='usd_m' AND body->>'baseAsset'=ANY($1) AND body->>'quoteAsset'='USDT' AND body->>'contractType' IN ('PERPETUAL','TRADIFI_PERPETUAL')"
    ).bind(bases).fetch_all(&s.db.pool).await?;
    if let [(symbol, base)] = rows.as_slice() {
        let source = sources
            .iter()
            .find(|(_, b)| *b == base)
            .map(|(source, _)| (*source).clone());
        Ok((Some(symbol.clone()), source))
    } else {
        Ok((None, None))
    }
}

fn only(set: &BTreeSet<String>) -> Option<&String> {
    set.iter().next().filter(|_| set.len() == 1)
}

/// Pixel work stays off the async executor. Ambiguous toolbar rows remain unknown.
async fn period(bytes: &[u8], ocr: &OcrResult) -> Result<(Option<String>, Option<String>)> {
    let raw = bytes.to_vec();
    let owned = ocr.clone();
    let selected = tokio::task::spawn_blocking(move || {
        let (image, _) = crate::adapters::storage::Storage::decode(&raw)?;
        Ok::<_, Error>(toolbar::selected(&image.to_rgb8(), &owned))
    })
    .await
    .map_err(|_| Error::bad("chart_analysis_interrupted"))??;
    if let Some(selected) = selected {
        return Ok((Some(selected), Some("toolbar_relative_contrast".into())));
    }
    let (_, confident) = labels(ocr);
    let possible: BTreeSet<String> = ocr
        .observations
        .iter()
        .filter(|o| o.confidence >= 0.3 && o.r#box[1] < 0.4)
        .flat_map(|o| o.text.split_whitespace())
        .filter_map(toolbar::canonical)
        .collect();
    let interval = only(&confident)
        .filter(|iv| possible.iter().all(|v| v == *iv))
        .cloned();
    let source = interval.as_ref().map(|_| "ocr".to_string());
    Ok((interval, source))
}

/// 把附件读进内存并校验完整性；证据不可变，字节对不上就不是这张图。
async fn bytes_of(s: &Services, owner: Uuid, attachment: Uuid) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let hash: String =
        sqlx::query_scalar("SELECT sha256 FROM attachments WHERE owner_id=$1 AND id=$2")
            .bind(owner)
            .bind(attachment)
            .fetch_optional(&s.db.pool)
            .await?
            .ok_or_else(Error::not_found)?;
    let mut bytes = Vec::new();
    s.images
        .open(owner, attachment)
        .await?
        .take(20 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 20 * 1024 * 1024 || crate::adapters::db::hash_bytes(&bytes) != hash {
        return Err(Error::bad("attachment_integrity_failure"));
    }
    Ok(bytes)
}

async fn cached_ocr(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
    bytes: Vec<u8>,
) -> Result<OcrResult> {
    let hash = crate::adapters::db::hash_bytes(&bytes);
    let mut tx = s.db.pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,15))")
        .bind(format!("{owner}:{hash}"))
        .execute(&mut *tx)
        .await?;
    let cached: Option<Value> = sqlx::query_scalar("SELECT result FROM screenshot_ocr_cache WHERE owner_id=$1 AND sha256=$2 AND protocol='native-ocr-toolbar-v3'")
        .bind(owner).bind(&hash).fetch_optional(&mut *tx).await?;
    if let Some(cached) = cached {
        return serde_json::from_value(cached).map_err(|_| Error::bad("invalid_ocr_cache"));
    }
    let result = crate::adapters::ocr::recognize(bytes).await?;
    sqlx::query("INSERT INTO screenshot_ocr_cache(owner_id,sha256,attachment_id,protocol,result) VALUES($1,$2,$3,'native-ocr-toolbar-v3',$4)")
        .bind(owner).bind(hash).bind(attachment).bind(json!(result)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(result)
}

pub async fn browser_labels_cached(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
) -> Result<Option<scorebook_core::api::replay::LocateOverride>> {
    let value: Option<Value> = sqlx::query_scalar("SELECT c.result FROM screenshot_ocr_cache c JOIN attachments a ON a.owner_id=c.owner_id AND a.sha256=c.sha256 WHERE a.owner_id=$1 AND a.id=$2 AND c.protocol='native-ocr-toolbar-v3'")
        .bind(owner).bind(attachment).fetch_optional(&s.db.pool).await?;
    let Some(value) = value else {
        return Ok(None);
    };
    let ocr: OcrResult =
        serde_json::from_value(value).map_err(|_| Error::bad("invalid_ocr_cache"))?;
    if !ocr
        .observations
        .iter()
        .any(|o| o.r#box[1] < 0.15 && o.text.to_lowercase().contains("tradingview.com/"))
    {
        return Ok(None);
    }
    let _permit = s.vision.acquire().await?;
    let (ocr, _, _) = chart_scope(ocr);
    let (symbols, _) = labels(&ocr);
    let (symbol, market) = catalogued(s, symbols).await?;
    Ok(Some(scorebook_core::api::replay::LocateOverride {
        symbol,
        market,
        interval: period(&bytes_of(s, owner, attachment).await?, &ocr)
            .await?
            .0,
        exclude: Vec::new(),
    }))
}

/// 这张截图自己的品种、市场与周期：OCR 文字结合周期栏的选中样式。
///
/// 刻意不碰 `chart_match::detect`：紧裁过的图上蜡烛解不出几何（
/// `ordinary_candles_not_resolved`），可角落里的代码照样看得清清楚楚。认品种要
/// 的是那行字，不是那些蜡烛，所以这条路不该被几何拖下水。
///
/// 三格各自独立：认不出来就留 None，绝不拿另外两格去推。
pub async fn read(
    s: &Services,
    owner: Uuid,
    attachment: Uuid,
) -> Result<(Option<String>, Option<String>, Option<String>)> {
    let _permit = s.vision.acquire().await?;
    let bytes = bytes_of(s, owner, attachment).await?;
    let (ocr, _, _) = chart_scope(cached_ocr(s, owner, attachment, bytes.clone()).await?);
    let (symbols, _) = labels(&ocr);
    let (symbol, market) = catalogued(s, symbols).await?;
    Ok((symbol, market, period(&bytes, &ocr).await?.0))
}

/// Visible text and toolbar selection styling only. Uncertain fields remain null.
///
/// 顺序是 OCR 在先、几何在后（§5.2 第 1 步）：副图标题的纵坐标决定主图到哪儿为止，
/// 右轴那一列数字的框要先抹掉——带底色的最新价标签会被当成一根蜡烛。
pub async fn evidence(
    s: &Services,
    owner: Uuid,
    input: &ChartAnalysisInput,
) -> Result<(chart_match::Geometry, OcrResult, Value)> {
    let read = anchored(s, owner, input).await?;
    let (symbol, source_symbol) = search_symbol(s, &read.ocr).await?;
    let result = json!({
        "symbol": symbol,
        "source_symbol": source_symbol,
        "symbol_from": if symbol == source_symbol {"ocr"} else {"catalog_base_asset"},
        "interval": read.anchors.interval,
        "indicators": toolbar::indicators(&read.ocr),
        "anchors": read.anchors,
        "auto_accept_confidence_threshold": 0.9,
        "precision_validated": false,
        "unknown_fields_are_not_inferred": true,
    });
    Ok((read.geometry, read.ocr, result))
}

/// 一张截图读出来的全部证据：几何、OCR 原文、锚点，外加原图尺寸。
///
/// 尺寸要跟着走，因为几何给的 `region` 是原图像素，而锚点（时间标签、价格轴）
/// 一律是归一化坐标；把蜡烛钉到时间轴上必须让这两套坐标对上。
pub struct Anchored {
    pub geometry: chart_match::Geometry,
    pub ocr: OcrResult,
    pub anchors: anchors::Anchors,
    pub image: (u32, u32),
}

pub async fn anchored(s: &Services, owner: Uuid, input: &ChartAnalysisInput) -> Result<Anchored> {
    let _permit = s.vision.acquire().await?;
    let bytes = bytes_of(s, owner, input.attachment_id).await?;
    let (ocr, crop, right) =
        chart_scope(cached_ocr(s, owner, input.attachment_id, bytes.clone()).await?);
    let text = ocr
        .observations
        .iter()
        .map(|o| o.text.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    if ["heikin", "renko", "平均蜡烛", "砖形"]
        .iter()
        .any(|v| text.contains(v))
    {
        return Err(Error::bad("nonstandard_candles_not_supported"));
    }
    let mut anchor = anchors::read_in_pane(&ocr, right);
    let (symbols, _) = labels(&ocr);
    // exchange_info's current metadata catalog is authoritative for auto-filled symbols.
    let (symbol, _) = catalogued(s, symbols).await?;
    anchor.symbol_from = symbol.as_ref().map(|_| "ocr".to_string());
    anchor.symbol = symbol;
    (anchor.interval, anchor.interval_from) = period(&bytes, &ocr).await?;
    let mut scoped = input.clone();
    if scoped.region.is_none()
        && let Some([x, y, w, h]) = crop
    {
        let size = crate::adapters::storage::Storage::inspect(&bytes)?;
        scoped.region = Some(scorebook_core::api::dto::Region {
            x: (x * f64::from(size.width)) as u32,
            y: (y * f64::from(size.height)) as u32,
            width: (w * f64::from(size.width)) as u32,
            height: (h * f64::from(size.height)) as u32,
        });
    }
    let (geometry, image) = detect(&bytes, &scoped, &anchor, &ocr).await?;
    Ok(Anchored {
        geometry,
        ocr,
        anchors: anchor,
        image,
    })
}

/// 按锚点把检测框起来再跑几何。右轴标签只抹框本身，不切掉标签左边的整条竖带：
/// 币安 App 的蜡烛一直画到标签底下，切竖带会把最右边十几根一起扔掉。
pub async fn detect(
    bytes: &[u8],
    input: &ChartAnalysisInput,
    anchor: &anchors::Anchors,
    ocr: &OcrResult,
) -> Result<(chart_match::Geometry, (u32, u32))> {
    let raw = bytes.to_vec();
    let region = input.region.clone();
    let red_up = input.red_up;
    let cut = anchor.pane_cut_y.filter(|_| region.is_none());
    // 图上的字一律不算蜡烛：右轴刻度、当前价那块带底色的牌子、极值标签、均线图例，还有
    // 顶栏那行涨跌额——它们本身就是红绿的，落在检测区里就是一根凭空多出来的蜡烛，会把
    // 整排的序号推歪，最右边那几块还会把图区的右界一路撑到贴边。
    //
    // 只抹字框本身，不按右轴的 x 切一整条竖带：极值标签（`1058.09 —`）就压在蜡烛中间，
    // 切竖带会把它右边的真蜡烛一起丢掉。
    let mut blanked: Vec<[f64; 4]> = ocr
        .observations
        .iter()
        .filter(|o| o.r#box[3] < 0.05)
        .map(|o| o.r#box)
        .collect();
    if let Some(top) = toolbar::chart_top(ocr) {
        blanked.push([0., 0., 1., top]);
    }
    tokio::task::spawn_blocking(move || {
        let (im, _) = crate::adapters::storage::Storage::decode(&raw)?;
        let dims = image::GenericImageView::dimensions(&im);
        let region = region.or_else(|| {
            let (w, h) = dims;
            let bottom = (cut? * f64::from(h)) as u32;
            (bottom > h / 4).then_some(scorebook_core::api::dto::Region {
                x: 0,
                y: 0,
                width: w,
                height: bottom,
            })
        });
        let geometry = chart_match::detect_with(
            &im,
            chart_match::DetectOptions {
                region,
                red_up,
                blanked: &blanked,
            },
        )
        .map_err(Error::from)?;
        Ok((geometry, dims))
    })
    .await
    .map_err(|_| Error::bad("chart_analysis_interrupted"))?
}

#[cfg(test)]
mod label_tests {
    use super::*;
    use crate::adapters::ocr::Observation;
    fn ocr(items: &[(&str, f32, f64)]) -> OcrResult {
        OcrResult {
            model_id: "apple-vision-text-r3".into(),
            revision: 3,
            system_version: "test".into(),
            observations: items
                .iter()
                .map(|(text, confidence, top)| Observation {
                    text: (*text).into(),
                    confidence: *confidence,
                    r#box: [0.3, *top, 0.2, 0.02],
                })
                .collect(),
        }
    }
    #[test]
    fn the_pair_written_in_the_title_bar_reads_as_the_contract_name() {
        // 币安 App 的标题栏；`SNDK`、`USDT` 各自都不够五个字符。
        let (symbols, _) = labels(&ocr(&[("SNDK/USDT", 1., 0.071)]));
        assert!(symbols.contains("SNDKUSDT"), "{symbols:?}");
        let (symbols, _) = labels(&ocr(&[("MU/USDT", 1., 0.071)]));
        assert!(symbols.contains("MUUSDT"), "{symbols:?}");
    }
    #[test]
    fn only_the_top_strip_and_only_confident_text_takes_part() {
        // 图心那行 OHLC 里也有 `2026/09/07`，但它不在顶上那条带里。
        let (symbols, _) = labels(&ocr(&[("BTCUSDT", 1., 0.6), ("ETHUSDT", 0.85, 0.1)]));
        assert!(symbols.is_empty(), "{symbols:?}");
    }
    #[test]
    fn the_monthly_interval_is_never_read_as_the_minute_one() {
        let (_, intervals) = labels(&ocr(&[("1M", 1., 0.1)]));
        assert_eq!(intervals.iter().collect::<Vec<_>>(), ["1M"]);
        let (_, intervals) = labels(&ocr(&[("1D", 1., 0.1)]));
        assert_eq!(intervals.iter().collect::<Vec<_>>(), ["1d"]);
        // 噪声里的单个字母不是周期。
        let (_, intervals) = labels(&ocr(&[("d w J", 1., 0.1)]));
        assert!(intervals.is_empty(), "{intervals:?}");
    }
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::adapters::ocr::Observation;
    #[test]
    fn browser_tab_and_watchlist_cannot_supply_the_main_chart_symbol() {
        let mut obs = vec![
            Observation {
                text: "HYPEUSDT.P".into(),
                confidence: 1.,
                r#box: [0.3, 0.01, 0.12, 0.02],
            },
            Observation {
                text: "cn.tradingview.com/chart/test".into(),
                confidence: 1.,
                r#box: [0.1, 0.05, 0.3, 0.02],
            },
            Observation {
                text: "XAUUSD".into(),
                confidence: 1.,
                r#box: [0.04, 0.12, 0.05, 0.02],
            },
            Observation {
                text: "BTCUSDT".into(),
                confidence: 1.,
                r#box: [0.84, 0.28, 0.07, 0.02],
            },
        ];
        for i in 0..7 {
            obs.push(Observation {
                text: (5600 - i * 200).to_string(),
                confidence: 1.,
                r#box: [0.75, 0.22 + f64::from(i) * 0.06, 0.035, 0.014],
            });
        }
        let (scoped, crop, _) = chart_scope(OcrResult {
            model_id: "fixture".into(),
            revision: 1,
            system_version: "test".into(),
            observations: obs,
        });
        let (symbols, _) = labels(&scoped);
        assert!(symbols.contains("XAUUSD"));
        assert!(!symbols.contains("HYPEUSDT"));
        assert!(!symbols.contains("BTCUSDT"));
        let crop = crop.unwrap();
        assert!(crop[1] > 0.09);
        assert!(crop[2] < 0.75);
    }
}

#[cfg(test)]
mod screenshot_regressions {
    use super::*;
    #[tokio::test]
    #[ignore = "requires local native OCR and user-provided screenshot fixtures"]
    async fn real_toolbar_and_header_geometry() {
        let root = std::env::var("SCOREBOOK_SCREENSHOT_FIXTURES").unwrap();
        for (name, expected, count) in [("skhy", "1h", Some(108)), ("gold", "1d", None)] {
            let bytes = std::fs::read(format!("{root}/{name}")).unwrap();
            let (ocr, crop, right) = chart_scope(
                crate::adapters::ocr::recognize(bytes.clone())
                    .await
                    .unwrap(),
            );
            let (actual, _) = period(&bytes, &ocr).await.unwrap();
            assert_eq!(actual.as_deref(), Some(expected), "{name}");
            let anchor = anchors::read_in_pane(&ocr, right);
            let size = crate::adapters::storage::Storage::inspect(&bytes).unwrap();
            let region = crop.map(|[x, y, w, h]| scorebook_core::api::dto::Region {
                x: (x * size.width as f64) as u32,
                y: (y * size.height as f64) as u32,
                width: (w * size.width as f64) as u32,
                height: (h * size.height as f64) as u32,
            });
            let (geometry, _) = detect(
                &bytes,
                &ChartAnalysisInput {
                    attachment_id: Uuid::nil(),
                    region,
                    red_up: false,
                },
                &anchor,
                &ocr,
            )
            .await
            .unwrap();
            eprintln!(
                "{name}: interval={expected}, candles={}",
                geometry.candles.len()
            );
            if count.is_some() {
                assert!((100..=120).contains(&geometry.candles.len()));
                assert!(
                    geometry.quality.region.y as f64
                        >= toolbar::chart_top(&ocr).unwrap() * size.height as f64
                );
            }
        }
    }
}

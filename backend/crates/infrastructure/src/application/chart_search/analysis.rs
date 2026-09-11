use super::*;
use crate::adapters::ocr::OcrResult;
use std::collections::BTreeSet;

/// 图上自己写着的品种候选与周期，只从 OCR 的文字里读。
///
/// 抽出来是因为有两个人要用同一份规则：`evidence()` 给 chart.analyze 填证据，
/// 定位面板给「这张图默认是哪个品种」填默认值。规则只有这一份，白名单也只有
/// `domain::interval` 那一份，两边不会各认各的。
///
/// 只看顶上那条窄带（`box[1] < 0.3`）里置信度 0.98 以上的字：币安 App 的标题
/// 栏就在那儿，图心的价格、指标数字不该参与认品种。
fn labels(ocr: &OcrResult) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut symbols = BTreeSet::new();
    let mut intervals = BTreeSet::new();
    for obs in ocr
        .observations
        .iter()
        .filter(|o| o.confidence >= 0.98 && o.r#box[1] < 0.3)
    {
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
                let canonical = scorebook_core::domain::interval::Interval::from_binance(word)
                    .or_else(|| {
                        scorebook_core::domain::interval::Interval::from_binance(
                            &word.to_lowercase(),
                        )
                    });
                if let Some(iv) = canonical {
                    intervals.insert(iv.as_str().to_string());
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

fn only(set: &BTreeSet<String>) -> Option<&String> {
    set.iter().next().filter(|_| set.len() == 1)
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

/// 这张截图自己写着的品种、市场与周期，只走 OCR。
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
    let ocr = crate::adapters::ocr::recognize(bytes).await?;
    let (symbols, intervals) = labels(&ocr);
    let (symbol, market) = catalogued(s, symbols).await?;
    Ok((symbol, market, only(&intervals).cloned()))
}

/// Only visible text is considered. Unknown or contradictory fields remain null.
pub async fn evidence(
    s: &Services,
    owner: Uuid,
    input: &ChartAnalysisInput,
) -> Result<(chart_match::Geometry, OcrResult, Value)> {
    let _permit = s.vision.acquire().await?;
    let bytes = bytes_of(s, owner, input.attachment_id).await?;
    let raw = bytes.clone();
    let input = input.clone();
    let geometry = tokio::task::spawn_blocking(move || {
        let (im, _) = crate::adapters::storage::Storage::decode(&raw)?;
        chart_match::detect(&im, input.region, input.red_up).map_err(Error::from)
    })
    .await
    .map_err(|_| Error::bad("chart_analysis_interrupted"))??;
    let ocr = crate::adapters::ocr::recognize(bytes).await?;
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
    let (symbols, intervals) = labels(&ocr);
    // exchange_info's current metadata catalog is authoritative for auto-filled symbols.
    let (symbol, _) = catalogued(s, symbols).await?;
    let result = json!({"symbol":symbol,"interval":only(&intervals),"auto_accept_confidence_threshold":0.98,"precision_validated":false,"unknown_fields_are_not_inferred":true});
    Ok((geometry, ocr, result))
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
        let (symbols, _) = labels(&ocr(&[("BTCUSDT", 1., 0.6), ("ETHUSDT", 0.9, 0.1)]));
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

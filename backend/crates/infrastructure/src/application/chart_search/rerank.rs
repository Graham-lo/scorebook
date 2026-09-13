//! 候选先按合约周期并成组，再只在内存里重取行情做精排。两支的并发各有各的理由：
//! 公开那一支受限于网络，私有那一支受限于视觉服务的信号量，见下面两处注释。
use super::*;
use futures_util::{StreamExt, TryStreamExt, stream};
use scorebook_core::{
    domain::{chart::ChartRequest, criteria::Bar},
    market::HistorySource,
};
/// 公开那一支同时取几组月档。一组就是一次 `fetch_range`：该区间覆盖的每个自然月都要
/// 两次 HTTP（`.CHECKSUM` 和 zip）加一次 sha256 校验和解压，几乎全是网络等待不是 CPU。
///
/// 这个数**不是**总量闸门，别把它当唯一的旋钮——取数并发是三层叠出来的：
/// - 这里的 `REFETCH_CONCURRENCY` 只决定精排这一支自己铺多宽，即同时有几个区间在取；
/// - 单个区间内部还有 `application/history_catalog/archives.rs` 的 `MONTH_CONCURRENCY`，
///   决定一个区间的月档铺多宽（一个 256 根 1d 的窗口横跨 9 个月）；
/// - 真正的总量上限是 `adapters::binance_archive` 的 `KLINE_SLOTS`：所有 `klines()`
///   调用（连同 `universe.rs` 的扇出建索引）都在同一个信号量前排队。这两层乘出来超过
///   它，多的部分只是在信号量上等着，并不会真的同时在飞。
///
/// 6 这个数不是拿内存换来的：从前那笔「6 路最坏 384MB、两个交互作业最坏 768MB」的账
/// 前提就是错的。月档实测 1d 2159 字节、4h 10812 字节，`ttfb` 约等于 `total`，成本几乎
/// 全是一次 HTTPS 往返，既不是传输量也不是内存（`bounded(response, 64 * 1024 * 1024)`
/// 仍留着当安全网，但那是个防炸的上界，不是预算）。所以这一层宽窄只影响延迟：打开
/// h2 之后实测一次检索 12 个窗口并发、108 个文件，整批 1.2–1.3 秒。连接池那边不必担心
/// ——每组开头那句 `fence(s, j).await?.commit().await?` 取了连接立刻就还，长长的下载
/// 过程里一条连接都不占，压不到 `max_connections(12)`。
///
/// 预算抬到 100 之后实测 89 组、793 个月档文件（预算 30 时是 29 组 / 262 个），精排覆盖
/// 的合约数从 25 涨到 60+。「大约 70 组」是抬预算之前按代理查询估的，实测比它多，这里
/// 记实测值。再往上要先动的多半是 `KLINE_SLOTS` 而不是这里。
const REFETCH_CONCURRENCY: usize = 6;

type Ranked = (Vec<Value>, Vec<Value>);

/// §5.5-2：在这一段行情里，长度 `n ± 15%`（步长 4）、位置逐根滑，取最像的一段。
/// 红绿两种假设各扫一遍取高者（§5.4-6）。返回 `((start, len), 分)`。
pub(super) fn best_window(
    query: &[chart_match::Candle],
    bars: &[Bar],
    n: usize,
) -> Option<((usize, usize), chart_match::MatchScore)> {
    let candidates = chart_match::from_bars(bars).ok()?;
    let lo = (n * 85 / 100).max(16);
    let hi = (n * 115 / 100).min(candidates.len());
    if lo > hi || candidates.len() < 16 {
        return None;
    }
    let flipped = chart_match::flipped(query);
    let best = chart_match::sweep(query, &candidates, lo..=hi, 4)
        .into_iter()
        .next();
    let other = chart_match::sweep(&flipped, &candidates, lo..=hi, 4)
        .into_iter()
        .next();
    let pick = match (best, other) {
        (Some(a), Some(b)) => {
            if b.2.score > a.2.score {
                b
            } else {
                a
            }
        }
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => return None,
    };
    Some(((pick.0, pick.1), pick.2))
}
struct Group {
    request: ChartRequest,
    items: Vec<Value>,
}
fn request(item: &Value) -> Result<ChartRequest> {
    let string = |k: &str| {
        item[k]
            .as_str()
            .ok_or_else(|| Error::bad("invalid_candidate"))
    };
    Ok(ChartRequest {
        match_end_at: None,
        source: serde_json::from_value(item["market_source"].clone())
            .map_err(|_| Error::bad("candidate_source_plan_missing"))?,
        symbol: string("symbol")?.into(),
        market: string("market")?.into(),
        interval: string("interval")?.into(),
        start_at: string("start_at")?
            .parse()
            .map_err(|_| Error::bad("invalid_candidate"))?,
        end_at: string("end_at")?
            .parse()
            .map_err(|_| Error::bad("invalid_candidate"))?,
    })
}
/// 精排要看的不只是索引里那一格窗口，还有它前后各 L/4 根：截图截到的那一段几乎
/// 不会正好落在索引的格子上（§5.5-2）。
fn widened(r: &ChartRequest, cutoff: DateTime<Utc>) -> Result<ChartRequest> {
    let iv = super::super::history::interval_of(&r.interval)?;
    let bars = iv.bars_between(r.start_at, r.end_at).max(1);
    let pad = (bars / 4).max(4);
    Ok(ChartRequest {
        start_at: iv.add_bars(r.start_at, -pad),
        end_at: iv.add_bars(r.end_at, pad).min(iv.floor(cutoff)),
        ..r.clone()
    })
}

fn groups(items: Vec<Value>, cutoff: DateTime<Utc>) -> Result<Vec<Group>> {
    let mut rows = items
        .into_iter()
        .map(|v| Ok((widened(&request(&v)?, cutoff)?, v)))
        .collect::<Result<Vec<_>>>()?;
    let key = |r: &ChartRequest| {
        (
            r.market.clone(),
            r.symbol.clone(),
            r.interval.clone(),
            if r.source == HistorySource::Rest {
                0
            } else {
                1
            },
            r.start_at,
        )
    };
    rows.sort_by_key(|(r, _)| key(r));
    let mut groups: Vec<Group> = Vec::new();
    for (r, item) in rows {
        let iv = super::super::history::interval_of(&r.interval)?;
        if let Some(last) = groups.last_mut().filter(|g| {
            g.request.source == r.source
                && g.request.market == r.market
                && g.request.symbol == r.symbol
                && g.request.interval == r.interval
                && r.start_at <= g.request.end_at
                && iv.bars_between(g.request.start_at, r.end_at.max(g.request.end_at)) <= 2000
        }) {
            last.request.end_at = last.request.end_at.max(r.end_at);
            last.items.push(item);
        } else {
            groups.push(Group {
                request: r,
                items: vec![item],
            });
        }
    }
    Ok(groups)
}
pub async fn run(
    s: &Services,
    j: &Job,
    input: &ChartSearchInput,
    query: &[chart_match::Candle],
    items: Vec<Value>,
) -> Result<Ranked> {
    // Padding is search input too: never request future archives or compare bars
    // beyond the user's frozen cutoff, even when the indexed window itself is valid.
    let cutoff = input.cutoff_at.unwrap_or_else(Utc::now).min(Utc::now());
    let results: Vec<Ranked> = if input.scope == ChartScope::Private {
        stream::iter(items.into_iter().map(|mut item| async move {
            repository::fence(s, j).await?.commit().await?;
            let attachment_id = serde_json::from_value(item["attachment_id"].clone())
                .map_err(|_| Error::bad("invalid_candidate"))?;
            let candidate = match geometry(
                s,
                j.owner,
                &ChartAnalysisInput {
                    attachment_id,
                    region: None,
                    red_up: false,
                },
            )
            .await
            {
                Ok(v) => v.candles,
                Err(e) if e.kind == scorebook_core::error::ErrorKind::Invalid => {
                    return Ok((
                        vec![],
                        vec![json!({"attachment_id":attachment_id,"reason":e.code})],
                    ));
                }
                Err(e) => return Err(e),
            };
            item["match"] = json!(chart_match::rerank(query, &candidate, input.reverse)?);
            item["stage"] = json!("reranked");
            Ok((vec![item], vec![]))
        }))
        // 私有这一支每条都要跑一次视觉模型，而 `adapters::vision` 的信号量只有 2：
        // 这里调大只是把队伍从这里挪到信号量上去排，一秒都省不下来，所以跟着它。
        .buffered(2)
        .try_collect()
        .await?
    } else {
        stream::iter(groups(items, cutoff)?.into_iter().map(|g| async move {
            repository::fence(s, j).await?.commit().await?;
            let requests = g.items.iter().map(request).collect::<Result<Vec<_>>>()?;
            let mut original = g.request.clone();
            original.start_at = requests
                .iter()
                .map(|r| r.start_at)
                .min()
                .unwrap_or(original.start_at);
            original.end_at = requests
                .iter()
                .map(|r| r.end_at)
                .max()
                .unwrap_or(original.end_at);
            let Some(payload) = fetch_padded(g.request.clone(), original, |r| async move {
                super::super::market::data(s, &r).await
            })
            .await?
            else {
                return Ok((
                    vec![],
                    g.items
                        .iter()
                        .map(|item| json!({"id":item["id"],"reason":"archive_not_available"}))
                        .collect(),
                ));
            };
            let bars: Vec<Bar> = serde_json::from_value(payload["bars"].clone())
                .map_err(|_| Error::bad("invalid_provider_bars"))?;
            let mut ranked = Vec::new();
            let mut excluded = Vec::new();
            for mut item in g.items {
                let r = request(&item)?;
                let selected: Vec<Bar> = bars
                    .iter()
                    .filter(|b| b.start >= r.start_at && b.end <= r.end_at)
                    .cloned()
                    .collect();
                // 来路照旧一格不松：证明这一段行情和建索引时是同一段，用的仍然是
                // 索引里那一格窗口的哈希。放宽的只是「拿它周围哪几段去比」。
                if payload["coverage_complete"] != true
                    || digest(&selected) != item["source_hash_at_index"].as_str().unwrap_or("")
                {
                    excluded.push(json!({"id":item["id"],"reason":"source_changed_or_incomplete"}));
                    continue;
                }
                let wide = widened(&r, cutoff)?;
                let around: Vec<Bar> = bars
                    .iter()
                    .filter(|b| b.start >= wide.start_at && b.end <= wide.end_at)
                    .cloned()
                    .collect();
                let (window, score) = match best_window(query, &around, query.len()) {
                    Some(v) => v,
                    None => {
                        let candidate = chart_match::from_bars(&selected)?;
                        item["chart_request"] = json!(r);
                        item["match"] =
                            json!(chart_match::rerank(query, &candidate, input.reverse)?);
                        item["stage"] = json!("reranked");
                        ranked.push(item);
                        continue;
                    }
                };
                let mut r = r;
                r.start_at = around[window.0].start;
                r.end_at = around[window.0 + window.1 - 1].end;
                item["start_at"] = json!(r.start_at);
                item["end_at"] = json!(r.end_at);
                item["bars_count"] = json!(window.1);
                item["chart_request"] = json!(r);
                item["match"] = json!(score);
                item["stage"] = json!("reranked");
                ranked.push(item);
            }
            Ok::<Ranked, Error>((ranked, excluded))
        }))
        .buffered(REFETCH_CONCURRENCY)
        .try_collect()
        .await?
    };
    let mut ranked = Vec::new();
    let mut excluded = Vec::new();
    for (r, e) in results {
        ranked.extend(r);
        excluded.extend(e);
    }
    Ok((ranked, excluded))
}

/// Missing padding must not discard a valid indexed window or abort unrelated candidates.
async fn fetch_padded<F, Fut>(
    padded: ChartRequest,
    original: ChartRequest,
    mut fetch: F,
) -> Result<Option<Value>>
where
    F: FnMut(ChartRequest) -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    match fetch(padded).await {
        Ok(payload) => Ok(Some(payload)),
        Err(error) if error.code == "archive_not_available" => match fetch(original).await {
            Ok(payload) => Ok(Some(payload)),
            Err(error) if error.code == "archive_not_available" => Ok(None),
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window() -> ChartRequest {
        request(&json!({"symbol":"BTCUSDT","market":"usd_m","interval":"1h","start_at":"2026-01-01T00:00:00Z","end_at":"2026-01-05T00:00:00Z","market_source":"monthly_archive"})).unwrap()
    }
    #[test]
    fn daily_padding_stays_before_the_frozen_cutoff() {
        let mut r = window();
        r.interval = "1d".into();
        r.start_at = "2026-02-21T00:00:00Z".parse().unwrap();
        r.end_at = "2026-09-01T00:00:00Z".parse().unwrap();
        let cutoff = "2026-09-13T05:00:00Z".parse().unwrap();
        let wide = widened(&r, cutoff).unwrap();
        assert_eq!(
            wide.end_at,
            "2026-09-13T00:00:00Z".parse::<DateTime<Utc>>().unwrap()
        );
        assert!(wide.start_at < r.start_at);
        // A historical cutoff is equally binding; later available bars cannot leak in.
        assert_eq!(widened(&r, r.end_at).unwrap().end_at, r.end_at);
        let items = vec![
            json!({"symbol":r.symbol,"market":r.market,"interval":r.interval,
            "start_at":r.start_at,"end_at":r.end_at,"market_source":"monthly_archive"}),
        ];
        assert!(
            groups(items, cutoff)
                .unwrap()
                .iter()
                .all(|g| g.request.end_at <= cutoff)
        );
    }

    #[tokio::test]
    async fn missing_padding_retries_the_exact_indexed_window() {
        let original = window();
        let mut seen = vec![];
        let result = fetch_padded(
            widened(&original, "2026-02-01T00:00:00Z".parse().unwrap()).unwrap(),
            original.clone(),
            |r| {
                seen.push((r.start_at, r.end_at));
                std::future::ready(if seen.len() == 1 {
                    Err(Error::bad("archive_not_available"))
                } else {
                    Ok(json!({"bars":[],"coverage_complete":true}))
                })
            },
        )
        .await
        .unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].0 < original.start_at);
        assert_eq!(seen[1], (original.start_at, original.end_at));
        assert!(result.is_some());
    }
    #[tokio::test]
    async fn missing_group_is_excluded_but_other_errors_are_not_swallowed() {
        let original = window();
        assert!(
            fetch_padded(
                widened(&original, "2026-02-01T00:00:00Z".parse().unwrap()).unwrap(),
                original.clone(),
                |_| { std::future::ready(Err(Error::bad("archive_not_available"))) }
            )
            .await
            .unwrap()
            .is_none()
        );
        let error = fetch_padded(
            widened(&original, "2026-02-01T00:00:00Z".parse().unwrap()).unwrap(),
            original,
            |_| std::future::ready(Err(Error::bad("provider_timeout"))),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "provider_timeout");
    }
}

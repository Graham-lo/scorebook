//! Merge candidate intervals before RAM-only refetch; two groups run at a time.
use super::*;
use futures_util::{StreamExt, TryStreamExt, stream};
use scorebook_core::{
    domain::{chart::ChartRequest, criteria::Bar},
    market::HistorySource,
};
type Ranked = (Vec<Value>, Vec<Value>);
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
fn groups(items: Vec<Value>) -> Result<Vec<Group>> {
    let mut rows = items
        .into_iter()
        .map(|v| Ok((request(&v)?, v)))
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
        .buffered(2)
        .try_collect()
        .await?
    } else {
        stream::iter(groups(items)?.into_iter().map(|g| async move {
            repository::fence(s, j).await?.commit().await?;
            let payload = super::super::market::data(s, &g.request).await?;
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
                if payload["coverage_complete"] != true
                    || digest(&selected) != item["source_hash_at_index"].as_str().unwrap_or("")
                {
                    excluded.push(json!({"id":item["id"],"reason":"source_changed_or_incomplete"}));
                    continue;
                }
                let candidate = chart_match::from_bars(&selected)?;
                item["chart_request"] = json!(r);
                item["match"] = json!(chart_match::rerank(query, &candidate, input.reverse)?);
                item["stage"] = json!("reranked");
                ranked.push(item);
            }
            Ok::<Ranked, Error>((ranked, excluded))
        }))
        .buffered(2)
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

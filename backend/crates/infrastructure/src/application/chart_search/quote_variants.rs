//! Similar-case diversity only; never substitute a contract's prices or identity.
use super::*;

pub const POLICY: &str = "same_base_usdt_usdc_perpetual_same_interval_majority_overlap_v1";
pub const QUOTE_POLICY: &str = "usd_m_usdt_only_v1";

pub fn usdt_only(items: &mut Vec<Value>) {
    items.retain(|item| {
        item["market"] != "usd_m" || item["instrument_identity"]["quote_asset"] == "USDT"
    });
}

pub async fn annotate(s: &Services, items: &mut [Value]) -> Result<()> {
    let symbols: Vec<&str> = items.iter().filter_map(|v| v["symbol"].as_str()).collect();
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT symbol,jsonb_build_object('base_asset',body->>'baseAsset','quote_asset',body->>'quoteAsset','contract_type',body->>'contractType') FROM instrument_catalog WHERE venue='binance' AND market='usd_m' AND symbol=ANY($1)",
    ).bind(&symbols).fetch_all(&s.db.pool).await?;
    for item in items {
        if item["market"] == "usd_m"
            && let Some((_, identity)) = rows.iter().find(|(symbol, _)| item["symbol"] == *symbol)
        {
            item["instrument_identity"] = identity.clone();
        }
    }
    Ok(())
}

pub fn overlapping(a: &Value, b: &Value) -> bool {
    let identity = |v: &Value| -> Option<String> {
        let i = &v["instrument_identity"];
        if v["market"] != "usd_m"
            || !matches!(
                i["contract_type"].as_str(),
                Some("PERPETUAL" | "TRADIFI_PERPETUAL")
            )
            || !matches!(i["quote_asset"].as_str(), Some("USDT" | "USDC"))
        {
            return None;
        }
        i["base_asset"]
            .as_str()
            .filter(|base| !base.is_empty())
            .map(str::to_owned)
    };
    matches!((identity(a), identity(b)), (Some(a), Some(b)) if a == b)
        && a["instrument_identity"]["quote_asset"] != b["instrument_identity"]["quote_asset"]
        && a["interval"].as_str().is_some_and(|iv| !iv.is_empty())
        && a["interval"] == b["interval"]
        && super::time_overlapping(a, b)
}

pub fn deduplicate(mut items: Vec<Value>) -> Vec<Value> {
    items.sort_by(|a, b| {
        b["match"]["score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["match"]["score"].as_f64().unwrap_or(0.))
    });
    let mut kept = Vec::new();
    for item in items {
        if !kept.iter().any(|v| overlapping(v, &item)) {
            kept.push(item);
        }
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(symbol: &str, quote: &str, score: f64) -> Value {
        json!({"symbol":symbol,"market":"usd_m","interval":"1h",
            "start_at":"2024-11-05T00:00:00Z","end_at":"2024-11-09T17:00:00Z",
            "instrument_identity":{"base_asset":"BTC","quote_asset":quote,"contract_type":"PERPETUAL"},
            "match":{"score":score},"chart_request":{"symbol":symbol}})
    }
    #[test]
    fn user_quote_policy_keeps_usdt_even_when_usdc_scores_higher() {
        let usdt = candidate("BTCUSDT", "USDT", 0.7);
        let usdc = candidate("BTCUSDC", "USDC", 0.95);
        let mut unknown = candidate("UNKNOWNUSDT", "USDT", 0.9);
        unknown["instrument_identity"] = Value::Null;
        let mut items = vec![usdc, usdt.clone(), unknown];
        usdt_only(&mut items);
        assert_eq!(items, vec![usdt]);
    }
    #[test]
    fn quote_duplicates_leave_room_for_the_next_case_and_keep_real_contract() {
        let usdt = candidate("BTCUSDT", "USDT", 0.728075);
        let usdc = candidate("BTCUSDC", "USDC", 0.725955);
        let mut eth = candidate("ETHUSDT", "USDT", 0.7);
        eth["instrument_identity"]["base_asset"] = json!("ETH");
        let items = vec![usdc.clone(), eth.clone(), usdt.clone()];
        let result = best_matches(items, true, 2, &calibration::Calibration::empty(), true);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0]["symbol"], "BTCUSDT");
        assert_eq!(result[0]["chart_request"], usdt["chart_request"]);
        assert_eq!(result[1]["symbol"], "ETHUSDT");
        assert_eq!(
            deduplicate(vec![usdc.clone(), usdt.clone()]),
            vec![usdt.clone()]
        );
        // Score determines the representative, not a hardcoded quote preference.
        let mut better_usdc = usdc;
        better_usdc["match"]["score"] = json!(0.9);
        assert_eq!(
            deduplicate(vec![usdt, better_usdc.clone()]),
            vec![better_usdc]
        );
    }
    #[test]
    fn unrelated_windows_and_unproven_identities_are_not_merged() {
        let a = candidate("BTCUSDT", "USDT", 0.8);
        let b = candidate("BTCUSDC", "USDC", 0.7);
        for (key, value) in [
            ("interval", json!("4h")),
            ("market", json!("coin_m")),
            ("start_at", json!("2024-12-05T00:00:00Z")),
            ("instrument_identity", Value::Null),
        ] {
            let mut changed = b.clone();
            changed[key] = value;
            assert!(!overlapping(&a, &changed), "{key}");
        }
        for (key, value) in [
            ("base_asset", "ETH"),
            ("quote_asset", "BTC"),
            ("contract_type", "CURRENT_QUARTER"),
            ("base_asset", ""),
        ] {
            let mut changed = b.clone();
            changed["instrument_identity"][key] = json!(value);
            assert!(!overlapping(&a, &changed), "{key}");
        }
        let result = best_matches(
            vec![a, b],
            false,
            5,
            &calibration::Calibration::empty(),
            true,
        );
        assert_eq!(
            result.len(),
            2,
            "restricted/private searches keep their identity rules"
        );
    }
}

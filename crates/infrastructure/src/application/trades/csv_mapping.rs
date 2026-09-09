use super::*;
use std::io::Read;
pub fn decode(bytes: Vec<u8>, format: &str) -> Result<Vec<u8>> {
    match format {
        "csv" => Ok(bytes),
        "zip_csv" => {
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|_| Error::bad("invalid_trade_export_zip"))?;
            if zip.len() != 1 {
                return Err(Error::bad("trade_export_requires_exactly_one_csv"));
            }
            let file = zip
                .by_index(0)
                .map_err(|_| Error::bad("invalid_trade_export_zip"))?;
            if file.is_dir()
                || file.size() > 128 * 1024 * 1024
                || !file.name().to_lowercase().ends_with(".csv")
            {
                return Err(Error::bad("invalid_trade_export_member"));
            }
            let mut output = Vec::new();
            file.take(128 * 1024 * 1024 + 1).read_to_end(&mut output)?;
            if output.len() > 128 * 1024 * 1024 {
                return Err(Error::bad("trade_export_uncompressed_budget"));
            }
            Ok(output)
        }
        _ => Err(Error::bad("explicit_trade_export_format_required")),
    }
}
pub fn validate(mapping: &CsvMapping, dataset: &str) -> Result<()> {
    let allowed = if dataset == "trades" {
        vec![
            "trade_id",
            "order_id",
            "symbol",
            "side",
            "position_side",
            "price",
            "quantity",
            "realized_pnl",
            "settlement_asset",
            "commission",
            "commission_asset",
            "traded_at",
            "liquidation",
        ]
    } else {
        vec![
            "transaction_id",
            "kind",
            "symbol",
            "asset",
            "amount",
            "occurred_at",
            "trade_id",
        ]
    };
    if !matches!(
        mapping.timestamp_format.as_str(),
        "iso8601" | "unix_ms" | "utc_datetime"
    ) || mapping.columns.is_empty()
        || mapping.columns.iter().any(|(k, v)| {
            !allowed.contains(&k.as_str())
                || v.is_empty()
                || v.len() > 150
                || mapping.constants.contains_key(k)
        })
        || mapping
            .constants
            .iter()
            .any(|(k, v)| !allowed.contains(&k.as_str()) || v.len() > 150)
    {
        return Err(Error::bad("invalid_explicit_csv_mapping"));
    }
    Ok(())
}
pub fn row(
    headers: &csv::StringRecord,
    row: &csv::StringRecord,
    m: &CsvMapping,
    dataset: &str,
) -> Result<Value> {
    let mut result = serde_json::Map::new();
    for (field, header) in &m.columns {
        let n = headers.iter().position(|h| h == header).ok_or_else(|| {
            Error::deferred(
                "csv_column_mapping_required",
                crate::error::RetryDirective::AwaitInput,
            )
        })?;
        result.insert(
            field.clone(),
            json!(
                row.get(n)
                    .ok_or_else(|| Error::bad("csv_row_width_mismatch"))?
            ),
        );
    }
    for (k, v) in &m.constants {
        result.insert(k.clone(), json!(v));
    }
    let time = if dataset == "trades" {
        "traded_at"
    } else {
        "occurred_at"
    };
    let raw = result
        .get(time)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::bad("csv_timestamp_mapping_required"))?;
    let at = match m.timestamp_format.as_str() {
        "iso8601" => DateTime::parse_from_rfc3339(raw)
            .map(|v| v.with_timezone(&Utc))
            .map_err(|_| Error::bad("csv_invalid_timestamp"))?,
        "unix_ms" => raw
            .parse::<i64>()
            .ok()
            .and_then(DateTime::from_timestamp_millis)
            .ok_or_else(|| Error::bad("csv_invalid_timestamp"))?,
        "utc_datetime" => chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f")
            .map_err(|_| Error::bad("csv_invalid_timestamp"))?
            .and_utc(),
        _ => return Err(Error::bad("invalid_timestamp_format")),
    };
    result.insert(time.into(), json!(at));
    if let Some(v) = result.get("liquidation").and_then(Value::as_str) {
        let b = match v {
            "true" => true,
            "false" => false,
            _ => return Err(Error::bad("csv_invalid_liquidation_boolean")),
        };
        result.insert("liquidation".into(), json!(b));
    }
    Ok(Value::Object(result))
}

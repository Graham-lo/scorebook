use super::*;
use crate::adapters::ocr::OcrResult;
/// Only visible text is considered. Unknown or contradictory fields remain null.
pub async fn evidence(
    s: &Services,
    owner: Uuid,
    input: &ChartAnalysisInput,
) -> Result<(chart_match::Geometry, OcrResult, Value)> {
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
    let mut symbols = std::collections::BTreeSet::new();
    let mut intervals = std::collections::BTreeSet::new();
    for obs in ocr
        .observations
        .iter()
        .filter(|o| o.confidence >= 0.98 && o.r#box[1] < 0.3)
    {
        for word in obs
            .text
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        {
            let tf = word.to_lowercase();
            if ["1m", "5m", "15m", "1h", "4h", "1d"].contains(&tf.as_str()) {
                intervals.insert(tf);
            }
            if word.len() >= 5
                && word.len() <= 40
                && word
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                symbols.insert(word.to_string());
            }
        }
    }
    // exchange_info's current metadata catalog is authoritative for auto-filled symbols.
    let known: Vec<String> =
        sqlx::query_scalar("SELECT DISTINCT symbol FROM instrument_catalog WHERE symbol=ANY($1)")
            .bind(symbols.into_iter().collect::<Vec<_>>())
            .fetch_all(&s.db.pool)
            .await?;
    let result = json!({"symbol":if known.len()==1 {known.first()}else{None},"interval":if intervals.len()==1{intervals.first()}else{None},"auto_accept_confidence_threshold":0.98,"precision_validated":false,"unknown_fields_are_not_inferred":true});
    Ok((geometry, ocr, result))
}

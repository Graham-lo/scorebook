use super::*;
use scorebook_core::domain::criteria::{Trade, dec};
use std::io::{BufRead, BufReader};
/// No Serialize/Debug: this carrier may contain transient caller state.
pub struct Reduction<T> {
    pub state: T,
    pub key: String,
    pub sha256: String,
    pub rows: u64,
}
impl BinanceArchive {
    /// One checksum-verified day, reduced without materializing trades or unpacking
    /// a file. One heavy archive per process; 256 MiB compressed, 2 GiB expanded.
    pub async fn trade_day<T, F>(
        &self,
        key: &str,
        day: DateTime<Utc>,
        state: T,
        visit: F,
    ) -> Result<Reduction<T>>
    where
        T: Send + 'static,
        F: FnMut(&mut T, i64, Trade) -> Result<()> + Send + 'static,
    {
        validate_key(key)?;
        if !key.contains("/daily/aggTrades/")
            || !key.ends_with(&format!("-{}.zip", day.format("%Y-%m-%d")))
            || day.timestamp().rem_euclid(86400) != 0
        {
            return Err(Error::bad("invalid_daily_trade_archive"));
        }
        if day + chrono::Duration::days(1) > Utc::now() {
            return Err(Error::deferred(
                "daily_archive_not_published",
                RetryDirective::At(day + chrono::Duration::days(1) + chrono::Duration::hours(2)),
            ));
        }
        let permit = self
            .trade_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::transient("archive_pool_closed"))?;
        let checksum = self
            .client
            .get(format!("https://data.binance.vision/{key}.CHECKSUM"))
            .send()
            .await
            .map_err(|_| Error::transient("archive_checksum_unavailable"))?;
        let checksum = bounded(checksum, 1024).await?;
        let checksum =
            std::str::from_utf8(&checksum).map_err(|_| Error::bad("invalid_archive_checksum"))?;
        let mut fields = checksum.split_whitespace();
        let hash = fields
            .next()
            .ok_or_else(|| Error::bad("invalid_archive_checksum"))?;
        if hash.len() != 64
            || !hash.bytes().all(|c| c.is_ascii_hexdigit())
            || fields.next().map(|s| s.trim_start_matches('*')) != key.rsplit('/').next()
            || fields.next().is_some()
        {
            return Err(Error::bad("invalid_archive_checksum"));
        }
        let response = self
            .client
            .get(format!("https://data.binance.vision/{key}"))
            .send()
            .await
            .map_err(|_| Error::transient("archive_download_unavailable"))?;
        let bytes = bounded(response, 256 * 1024 * 1024).await?;
        if hash_bytes(&bytes) != hash {
            return Err(Error::transient("archive_checksum_mismatch"));
        }
        let sha256 = hash.to_string();
        let key = key.to_string();
        let (state, rows) = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            reduce(bytes, day, state, visit)
        })
        .await
        .map_err(|_| Error::transient("archive_decode_interrupted"))??;
        Ok(Reduction {
            state,
            key,
            sha256,
            rows,
        })
    }
}
fn reduce<T, F>(bytes: Vec<u8>, day: DateTime<Utc>, mut state: T, mut visit: F) -> Result<(T, u64)>
where
    F: FnMut(&mut T, i64, Trade) -> Result<()>,
{
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| Error::bad("invalid_archive_zip"))?;
    if archive.len() != 1 {
        return Err(Error::bad("unexpected_archive_entries"));
    }
    let entry = archive
        .by_index(0)
        .map_err(|_| Error::bad("invalid_archive_entry"))?;
    const MAX: u64 = 2 * 1024 * 1024 * 1024;
    if !entry.name().ends_with(".csv") || entry.size() > MAX {
        return Err(Error::bad("archive_uncompressed_budget_exceeded"));
    }
    let expected = entry.size();
    let mut reader = BufReader::with_capacity(64 * 1024, entry.take(MAX + 1));
    let mut line = Vec::with_capacity(512);
    let mut last: Option<(i64, i64)> = None;
    let (mut rows, mut expanded) = (0u64, 0u64);
    while bounded_line(&mut reader, &mut line)? {
        expanded += line.len() as u64;
        if expanded > MAX {
            return Err(Error::bad("archive_uncompressed_budget_exceeded"));
        }
        let text = std::str::from_utf8(&line).map_err(|_| Error::bad("invalid_archive_csv"))?;
        let fields: Vec<_> = text.trim_end_matches(['\r', '\n']).split(',').collect();
        if rows == 0 && fields.first() == Some(&"agg_trade_id") {
            continue;
        }
        if rows == 0 && fields.first() == Some(&"aggregate_trade_id") {
            continue;
        }
        if fields.len() != 7 {
            return Err(Error::bad("invalid_archive_trade_row"));
        }
        let int = |i: usize| {
            fields[i]
                .parse::<i64>()
                .map_err(|_| Error::bad("invalid_archive_trade_integer"))
        };
        let (id, first, last_id, ms) = (int(0)?, int(3)?, int(4)?, int(5)?);
        let at = DateTime::from_timestamp_millis(ms)
            .ok_or_else(|| Error::bad("invalid_archive_timestamp"))?;
        if id < 0
            || first < 0
            || last_id < first
            || at < day
            || at >= day + chrono::Duration::days(1)
            || last.is_some_and(|(p, t)| p.checked_add(1) != Some(id) || ms < t)
            || !matches!(fields[6], "true" | "false" | "True" | "False")
            || dec(fields[1]).map_or(true, |p| p <= 0)
            || dec(fields[2]).map_or(true, |q| q <= 0)
        {
            return Err(Error::bad("archive_trade_sequence_unproven"));
        }
        last = Some((id, ms));
        rows += 1;
        visit(
            &mut state,
            id,
            Trade {
                at,
                price: fields[1].to_string(),
            },
        )?;
    }
    // Reading to EOF verifies ZIP CRC as well as the independent SHA-256.
    if expanded != expected {
        return Err(Error::bad("archive_size_mismatch"));
    }
    Ok((state, rows))
}
fn bounded_line(reader: &mut impl BufRead, line: &mut Vec<u8>) -> Result<bool> {
    line.clear();
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            return Ok(!line.is_empty());
        }
        let end = buf.iter().position(|b| *b == b'\n').map(|n| n + 1);
        let n = end.unwrap_or(buf.len());
        if line.len() + n > 4096 {
            return Err(Error::bad("archive_trade_row_too_large"));
        }
        line.extend_from_slice(&buf[..n]);
        reader.consume(n);
        if end.is_some() {
            return Ok(true);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn zip(text: &str) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        w.start_file("test.csv", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.write_all(text.as_bytes()).unwrap();
        w.finish().unwrap().into_inner()
    }
    #[tokio::test]
    #[ignore = "explicit public daily archive acceptance; no raw files"]
    async fn live_daily_archive_checksum_reduction() {
        let archive = BinanceArchive::new().unwrap();
        let day = DateTime::from_timestamp(1704067200, 0).unwrap();
        let result = archive
            .trade_day(
                "data/futures/um/daily/aggTrades/ADAUSDT/ADAUSDT-aggTrades-2024-01-01.zip",
                day,
                0u64,
                |count, _, _| {
                    *count += 1;
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert!(result.rows > 1000);
        assert_eq!(result.rows, result.state);
        assert_eq!(result.sha256.len(), 64);
    }
    #[test]
    fn reduces_contiguous_archive_and_rejects_gaps_and_large_rows() {
        let day = DateTime::from_timestamp(1704067200, 0).unwrap();
        let text = "agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n1,100,1,1,1,1704067200000,true\n2,105,1,2,2,1704067200000,false\n";
        let (sum, n) = reduce(zip(text), day, 0, |s, _, _| {
            *s += 1;
            Ok(())
        })
        .unwrap();
        assert_eq!((sum, n), (2, 2));
        assert!(
            reduce(zip(&text.replace("2,105", "3,105")), day, (), |_, _, _| Ok(
                ()
            ))
            .is_err()
        );
        assert!(reduce(zip(&"1".repeat(4097)), day, (), |_, _, _| Ok(())).is_err());
    }
}

use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::America::New_York;
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize)]
pub struct TradingSession {
    pub date: NaiveDate,
    pub close: DateTime<Utc>,
}
/// Caller supplies a versioned authoritative calendar, including early closes.
pub fn resolve_days(
    submitted: DateTime<Utc>,
    days: u32,
    market: &str,
    sessions: &[TradingSession],
) -> Result<DateTime<Utc>, String> {
    if days == 0 || days > 3650 {
        return Err("invalid_days".into());
    }
    if market != "us_equity" {
        return Ok(submitted + Duration::days(days.into()));
    }
    let date = submitted.with_timezone(&New_York).date_naive();
    let mut dates: Vec<_> = sessions.iter().filter(|s| s.date > date).collect();
    dates.sort_by_key(|s| s.date);
    if dates.windows(2).any(|s| s[0].date == s[1].date) {
        return Err("duplicate_calendar_session".into());
    }
    dates
        .get(days as usize - 1)
        .map(|s| s.close)
        .ok_or("calendar_coverage_missing".into())
}

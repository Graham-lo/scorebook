//! K 线周期的唯一真相源。
//!
//! 币安 USDⓈ-M / COIN-M 合约 klines 支持 15 个周期，这里全部收录，并且**只有这一
//! 份白名单**：解析、对外字符串、归档目录段、秒数、对齐与窗口算术都从这里出，任何
//! 其它模块都不得再写第二份 `match interval { .. }`。
//!
//! 对外字符串一律沿用币安写法，区分大小写：`1m` 是一分钟，`1M` 是一个月。
//!
//! 对齐规则与币安一致：
//! * 分钟 / 小时 / `1d`：按 Unix 纪元整除对齐。
//! * `1w`：K 线开在**周一 00:00 UTC**。纪元起点 1970-01-01 是周四，纯整除会错 3 天，
//!   所以整除前先把时间轴平移 3 天。
//! * `3d`：**不是**纪元整除。币安的三日线落在一条平移过的三日网格上，见
//!   [`D3_ANCHOR_DAY`] / [`D3_LEGACY_ANCHOR_DAY`] 的实测依据。
//! * `1M`：按日历月，开在每月 1 日 00:00 UTC，长度不固定（28~31 天），用日历加减。
use crate::error::{Error, Result};
use chrono::{DateTime, Datelike, Duration, Months, TimeZone, Utc};

/// 一周的秒数。
const WEEK: i64 = 7 * 86400;
/// 1970-01-01 是周四；它之前最近的周一是 1969-12-29，即 -3 天。周线对齐先加上这个
/// 偏移再整除，整除完再减回去。
const WEEK_ANCHOR: i64 = 3 * 86400;

/// 三日线的一天秒数与网格步长。
const DAY: i64 = 86400;
const THREE_DAYS: i64 = 3 * DAY;

/// 三日线**不按纪元整除**。拉 fapi / dapi / spot 的真实 3d K 线可以看到，纪元整除
/// （`epoch_days % 3 == 0`）在任何时期都不是币安的开盘日。
///
/// 2023-08-16T00:00Z 起，全部 USDⓈ-M 合约共用同一条网格，开盘日满足
/// `epoch_days % 3 == 1`。实测开盘日（BTCUSDT / SOLUSDT / 1000PEPEUSDT 一致）：
/// 2023-08-16、2023-08-19、2025-12-30、2026-01-02、2026-09-05、2026-09-08、2026-09-11。
/// 2023-08-16 的纪元日序是 19585，19585 % 3 == 1，所以偏移取 `2 * DAY`
/// （`(ts + 2 天) / 3 天` 整除后再减回去，就落在 ≡ 1 的那条网格上）。
const D3_ANCHOR: i64 = 2 * DAY;

/// 切换点：2023-08-16T00:00Z。在它之前，BTCUSDT 的三日线开在 `epoch_days % 3 == 2`
/// 上（实测 2019-12-30、2020-01-02、2022-12-29、2023-01-01、2023-08-11、2023-08-14），
/// 2023-08-14 那根只活到 08-16 就被下一根接上，是一根 2 天的短棒，锚点从此前移一天。
const D3_SWITCH: i64 = 1_692_144_000; // 2023-08-16T00:00:00Z
/// 切换点之前用的偏移，对应 `epoch_days % 3 == 2` 的那条网格。
const D3_LEGACY_ANCHOR: i64 = DAY;

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Interval {
    M1,
    M3,
    M5,
    M15,
    M30,
    H1,
    H2,
    H4,
    H6,
    H8,
    H12,
    D1,
    D3,
    W1,
    /// 月线。币安写作 `1M`（大写 M），归档目录里写作 `1mo`。
    Mo1,
}

use Interval::*;

/// 币安合约 klines 支持的全部周期，按时长升序。
pub const ALL: [Interval; 15] = [
    M1, M3, M5, M15, M30, H1, H2, H4, H6, H8, H12, D1, D3, W1, Mo1,
];

impl Interval {
    pub const ALL: [Interval; 15] = ALL;

    /// 对外 / 对币安 REST 的周期字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            M1 => "1m",
            M3 => "3m",
            M5 => "5m",
            M15 => "15m",
            M30 => "30m",
            H1 => "1h",
            H2 => "2h",
            H4 => "4h",
            H6 => "6h",
            H8 => "8h",
            H12 => "12h",
            D1 => "1d",
            D3 => "3d",
            W1 => "1w",
            Mo1 => "1M",
        }
    }

    /// data.binance.vision 月度归档目录里的周期段。月线在归档里叫 `1mo`，不叫 `1M`
    /// （对象存储路径大小写敏感，而且 `1M`/`1m` 在很多文件系统上会撞车）。
    pub fn archive_segment(self) -> &'static str {
        match self {
            Mo1 => "1mo",
            other => other.as_str(),
        }
    }

    /// PostgreSQL `interval` 字面量。运行时 SQL 需要一步步长时用它，避免在 SQL 里再
    /// 抄一份 `CASE`。`1 month` 在 PostgreSQL 里就是日历月，减法与本模块一致。
    pub fn pg_interval(self) -> &'static str {
        match self {
            M1 => "1 minute",
            M3 => "3 minutes",
            M5 => "5 minutes",
            M15 => "15 minutes",
            M30 => "30 minutes",
            H1 => "1 hour",
            H2 => "2 hours",
            H4 => "4 hours",
            H6 => "6 hours",
            H8 => "8 hours",
            H12 => "12 hours",
            D1 => "1 day",
            D3 => "3 days",
            W1 => "1 week",
            Mo1 => "1 month",
        }
    }

    /// 固定长度周期的秒数。月线长度随月份变化，没有固定秒数，返回 `None`。
    ///
    /// 只有真正需要「一根有多少秒」的地方才用它（例如 `bar_close` 触发按秒数配置）。
    /// 想做区间算术请用 [`Interval::add_bars`] / [`Interval::bars_between`]。
    pub fn fixed_seconds(self) -> Option<i64> {
        Some(match self {
            M1 => 60,
            M3 => 180,
            M5 => 300,
            M15 => 900,
            M30 => 1800,
            H1 => 3600,
            H2 => 7200,
            H4 => 14400,
            H6 => 21600,
            H8 => 28800,
            H12 => 43200,
            D1 => 86400,
            D3 => 3 * 86400,
            W1 => WEEK,
            Mo1 => return None,
        })
    }

    /// 一根 K 线秒数的**下界**，只用于粗略估算（预算、上限校验的保守化）。月线取 28 天
    /// ——最短的二月，这样按它换算出的根数不会少估。精确计数请用 `bars_between`。
    pub fn min_seconds(self) -> i64 {
        self.fixed_seconds().unwrap_or(28 * 86400)
    }

    /// 只接受币安官方写法（区分大小写）。存进数据库、拼归档路径、当分区键的值必须
    /// 走这一条，别名不得落库。
    pub fn from_binance(s: &str) -> Option<Self> {
        ALL.into_iter().find(|v| v.as_str() == s)
    }

    /// 只接受币安官方写法，失败返回 `unsupported_interval`。
    pub fn exact(s: &str) -> Result<Self> {
        Self::from_binance(s).ok_or_else(|| Error::bad("unsupported_interval"))
    }

    /// 宽松解析：先按官方写法精确匹配（保证 `1M` 月线不会被当成 `1m` 分钟线），匹配不
    /// 上再按小写别名匹配。用户手填的记录 timeframe 走这一条。
    ///
    /// 注意：任何别名小写后都不可能等于 `1m` 以外的分钟写法，所以月线只能用 `1M`、
    /// `1mo`、`mo1`、`1month`、`mn` 这些无歧义写法表达，写成 `1m` 永远是分钟。
    pub fn parse(s: &str) -> Result<Self> {
        let s = s.trim();
        if s.is_empty() {
            return Err(Error::bad("unsupported_interval"));
        }
        if let Some(v) = Self::from_binance(s) {
            return Ok(v);
        }
        let lower = s.to_ascii_lowercase();
        if let Some(v) = Self::from_binance(&lower) {
            return Ok(v);
        }
        Ok(match lower.as_str() {
            "m1" | "60s" | "1min" => M1,
            "m3" | "180s" | "3min" => M3,
            "m5" | "5min" => M5,
            "m15" | "15min" => M15,
            "m30" | "30min" => M30,
            "h1" | "60m" | "1hour" => H1,
            "h2" | "120m" | "2hour" => H2,
            "h4" | "240m" | "4hour" => H4,
            "h6" | "360m" | "6hour" => H6,
            "h8" | "480m" | "8hour" => H8,
            "h12" | "720m" | "12hour" => H12,
            "d1" | "d" | "1day" | "24h" => D1,
            "d3" | "3day" | "72h" => D3,
            "w1" | "w" | "1week" | "7d" => W1,
            "mo1" | "1mo" | "1month" | "mn" | "mn1" => Mo1,
            _ => return Err(Error::bad("unsupported_interval")),
        })
    }

    /// 秒数反查周期。`bar_close` 触发只给秒数，没有周期名；月线没有固定秒数，永远查
    /// 不到，这是刻意的。
    pub fn from_fixed_seconds(seconds: i64) -> Option<Self> {
        ALL.into_iter().find(|v| v.fixed_seconds() == Some(seconds))
    }

    /// 把时刻向下对齐到这一周期 K 线的开盘时刻。
    pub fn floor(self, t: DateTime<Utc>) -> DateTime<Utc> {
        match self {
            Mo1 => Utc
                .with_ymd_and_hms(t.year(), t.month(), 1, 0, 0, 0)
                .single()
                .unwrap_or(t),
            W1 => {
                let ts = t.timestamp();
                let floored = (ts + WEEK_ANCHOR).div_euclid(WEEK) * WEEK - WEEK_ANCHOR;
                DateTime::from_timestamp(floored, 0).unwrap_or(t)
            }
            D3 => {
                // 三日线不是纪元整除，做法和 W1 一样：先平移到网格原点再整除。
                // 2023-08-16T00:00Z 起用 D3_ANCHOR（≡ 1 mod 3），之前用
                // D3_LEGACY_ANCHOR（≡ 2 mod 3）。
                let ts = t.timestamp();
                let anchor = if ts >= D3_SWITCH {
                    D3_ANCHOR
                } else {
                    D3_LEGACY_ANCHOR
                };
                let floored = (ts + anchor).div_euclid(THREE_DAYS) * THREE_DAYS - anchor;
                DateTime::from_timestamp(floored, 0).unwrap_or(t)
            }
            other => {
                // 纪元整除，币安对分钟 / 小时 / 1d 就是这么对齐的。
                let step = other.fixed_seconds().unwrap_or(60);
                DateTime::from_timestamp(t.timestamp().div_euclid(step) * step, 0).unwrap_or(t)
            }
        }
    }

    /// 把时刻向上对齐到这一周期 K 线的开盘时刻（已经对齐的原样返回）。
    pub fn ceil(self, t: DateTime<Utc>) -> DateTime<Utc> {
        let floored = self.floor(t);
        if floored == t {
            floored
        } else {
            self.add_bars(floored, 1)
        }
    }

    /// 时刻前进 / 后退 `n` 根 K 线。月线按日历月加减，其余按固定秒数。
    ///
    /// `3d` 的注意事项：这里按固定的 3 天步进，因此**跨越 2023-08-14 那根 2 天短棒
    /// 时会差 1 根**（`bars_between` 同理）。这是刻意接受的：短棒只有一根、只在
    /// 2023-08 出现一次，而两侧各自的网格都是等距的，`floor` 仍然精确。
    pub fn add_bars(self, t: DateTime<Utc>, n: i64) -> DateTime<Utc> {
        match self {
            Mo1 => {
                let months = u32::try_from(n.unsigned_abs()).unwrap_or(u32::MAX);
                let shifted = if n >= 0 {
                    t.checked_add_months(Months::new(months))
                } else {
                    t.checked_sub_months(Months::new(months))
                };
                shifted.unwrap_or(t)
            }
            other => {
                let step = other.fixed_seconds().unwrap_or(60);
                t.checked_add_signed(Duration::seconds(step.saturating_mul(n)))
                    .unwrap_or(t)
            }
        }
    }

    /// `[start, end)` 里装得下多少根完整 K 线。`end` 在 `start` 之前时返回负数。
    pub fn bars_between(self, start: DateTime<Utc>, end: DateTime<Utc>) -> i64 {
        match self {
            Mo1 => {
                // 先按年月之差取一个粗值，再用日历加法校正最多一根。
                let index = |t: DateTime<Utc>| i64::from(t.year()) * 12 + i64::from(t.month());
                let mut n = index(end) - index(start);
                while self.add_bars(start, n) > end {
                    n -= 1;
                }
                while self.add_bars(start, n + 1) <= end {
                    n += 1;
                }
                n
            }
            other => {
                let step = other.fixed_seconds().unwrap_or(60);
                (end - start).num_seconds().div_euclid(step)
            }
        }
    }

    /// 这根 K 线的时间范围是否正好是一根本周期的 K 线。月线长度不固定，所以不能拿秒
    /// 数比，只能按日历核对。
    pub fn is_one_bar(self, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
        self.add_bars(start, 1) == end
    }
}

impl std::fmt::Display for Interval {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn every_binance_contract_interval_is_covered_exactly_once() {
        let names: Vec<&str> = ALL.iter().map(|v| v.as_str()).collect();
        assert_eq!(
            names,
            [
                "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d",
                "1w", "1M"
            ]
        );
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 15);
        for v in ALL {
            assert_eq!(Interval::exact(v.as_str()).unwrap(), v);
            assert_eq!(Interval::parse(v.as_str()).unwrap(), v);
        }
    }

    #[test]
    fn month_and_minute_are_different_intervals() {
        assert_eq!(Interval::parse("1M").unwrap(), Mo1);
        assert_eq!(Interval::parse("1m").unwrap(), M1);
        assert_eq!(Interval::exact("1M").unwrap(), Mo1);
        assert_eq!(Interval::exact("1m").unwrap(), M1);
        // 别名小写后是 "1m"，所以只能是分钟；月线必须用无歧义写法。
        for alias in ["1mo", "mo1", "1month", "mn"] {
            assert_eq!(Interval::parse(alias).unwrap(), Mo1);
        }
        assert_eq!(
            Interval::exact("1mo").unwrap_err().code,
            "unsupported_interval"
        );
    }

    #[test]
    fn aliases_resolve_to_canonical_binance_strings() {
        for (alias, want) in [
            ("m1", "1m"),
            ("60s", "1m"),
            ("m3", "3m"),
            ("m5", "5m"),
            ("m15", "15m"),
            ("m30", "30m"),
            ("30M", "30m"),
            ("h1", "1h"),
            ("60m", "1h"),
            ("h2", "2h"),
            ("120m", "2h"),
            ("h4", "4h"),
            ("240m", "4h"),
            ("h6", "6h"),
            ("h8", "8h"),
            ("h12", "12h"),
            ("d1", "1d"),
            ("D", "1d"),
            ("1day", "1d"),
            ("d3", "3d"),
            ("3D", "3d"),
            ("w1", "1w"),
            ("1W", "1w"),
            ("1week", "1w"),
        ] {
            assert_eq!(Interval::parse(alias).unwrap().as_str(), want, "{alias}");
        }
        for bad in ["", "  ", "7m", "1y", "0m", "min", "1mm"] {
            assert_eq!(
                Interval::parse(bad).unwrap_err().code,
                "unsupported_interval"
            );
        }
    }

    #[test]
    fn archive_segment_renames_only_the_month() {
        for v in ALL {
            if v == Mo1 {
                assert_eq!(v.archive_segment(), "1mo");
            } else {
                assert_eq!(v.archive_segment(), v.as_str());
            }
        }
    }

    #[test]
    fn fixed_seconds_exists_for_everything_but_the_month() {
        assert_eq!(M3.fixed_seconds(), Some(180));
        assert_eq!(M30.fixed_seconds(), Some(1800));
        assert_eq!(H2.fixed_seconds(), Some(7200));
        assert_eq!(H6.fixed_seconds(), Some(21600));
        assert_eq!(H8.fixed_seconds(), Some(28800));
        assert_eq!(H12.fixed_seconds(), Some(43200));
        assert_eq!(D3.fixed_seconds(), Some(259200));
        assert_eq!(W1.fixed_seconds(), Some(604800));
        assert_eq!(Mo1.fixed_seconds(), None);
        assert_eq!(Mo1.min_seconds(), 28 * 86400);
        assert_eq!(Interval::from_fixed_seconds(1800), Some(M30));
        assert_eq!(Interval::from_fixed_seconds(604800), Some(W1));
        assert_eq!(Interval::from_fixed_seconds(28 * 86400), None);
        for v in ALL {
            match v.fixed_seconds() {
                Some(s) => assert_eq!(Interval::from_fixed_seconds(s), Some(v)),
                None => assert_eq!(v, Mo1),
            }
        }
    }

    #[test]
    fn minute_and_hour_intervals_floor_by_epoch_division() {
        let t = at("2026-09-11T11:14:37Z");
        assert_eq!(M1.floor(t), at("2026-09-11T11:14:00Z"));
        assert_eq!(M3.floor(t), at("2026-09-11T11:12:00Z"));
        assert_eq!(M5.floor(t), at("2026-09-11T11:10:00Z"));
        assert_eq!(M15.floor(t), at("2026-09-11T11:00:00Z"));
        assert_eq!(M30.floor(t), at("2026-09-11T11:00:00Z"));
        assert_eq!(
            M30.floor(at("2026-09-11T11:44:00Z")),
            at("2026-09-11T11:30:00Z")
        );
        assert_eq!(H1.floor(t), at("2026-09-11T11:00:00Z"));
        assert_eq!(H2.floor(t), at("2026-09-11T10:00:00Z"));
        assert_eq!(H4.floor(t), at("2026-09-11T08:00:00Z"));
        assert_eq!(H6.floor(t), at("2026-09-11T06:00:00Z"));
        assert_eq!(H8.floor(t), at("2026-09-11T08:00:00Z"));
        assert_eq!(H12.floor(t), at("2026-09-11T00:00:00Z"));
        assert_eq!(D1.floor(t), at("2026-09-11T00:00:00Z"));
    }

    #[test]
    fn three_day_bars_follow_binance_shifted_grid_not_epoch_division() {
        // 下面每个开盘时刻都来自真实的币安 3d K 线（fapi BTCUSDT / SOLUSDT /
        // 1000PEPEUSDT，spot 与 dapi 另行核对），不是推算出来的。
        // 纪元整除（epoch_days % 3 == 0）在任何时期都不是币安的开盘日。

        // 2023-08-16 之后：epoch_days % 3 == 1。
        assert_eq!(
            D3.floor(at("2026-09-11T10:00:00Z")),
            at("2026-09-11T00:00:00Z")
        );
        // 2026-10-01 不是开盘日，它落在 2026-09-29 开的那根里；下一根开在 10-02。
        assert_eq!(
            D3.floor(at("2026-10-01T05:00:00Z")),
            at("2026-09-29T00:00:00Z")
        );
        assert_eq!(
            D3.floor(at("2026-10-02T00:00:00Z")),
            at("2026-10-02T00:00:00Z")
        );

        // 2023-08-16 之前：epoch_days % 3 == 2。
        assert_eq!(
            D3.floor(at("2023-01-02T00:00:00Z")),
            at("2023-01-01T00:00:00Z")
        );
        // 切换点两侧：2023-08-14 那根只活到 08-16（2 天的短棒）。
        assert_eq!(
            D3.floor(at("2023-08-15T12:00:00Z")),
            at("2023-08-14T00:00:00Z")
        );
        assert_eq!(
            D3.floor(at("2023-08-16T00:00:00Z")),
            at("2023-08-16T00:00:00Z")
        );

        // 往前扫 40 根，开盘日一律 ≡ 1 (mod 3)，而且都是真正的开盘（幂等）。
        let mut open = at("2026-09-11T00:00:00Z");
        for _ in 0..40 {
            assert_eq!(
                open.timestamp().div_euclid(86400).rem_euclid(3),
                1,
                "{open}"
            );
            assert_eq!(D3.floor(open), open, "{open}");
            open = D3.add_bars(open, -1);
        }
    }

    #[test]
    fn weekly_bars_open_on_monday_utc() {
        // 纪元起点是周四，纯整除会错 3 天，这条是本模块最容易写错的地方。
        let t = at("2026-09-11T11:14:00Z");
        assert_eq!(W1.floor(t), at("2026-09-07T00:00:00Z"));
        assert_eq!(
            W1.floor(at("2026-09-07T00:00:00Z")),
            at("2026-09-07T00:00:00Z")
        );
        assert_eq!(
            W1.floor(at("2026-09-06T23:59:59Z")),
            at("2026-08-31T00:00:00Z")
        );
        assert_eq!(
            W1.floor(at("1970-01-01T00:00:00Z")),
            at("1969-12-29T00:00:00Z")
        );
        for days in 0..40 {
            let t = at("2026-01-01T07:13:00Z") + Duration::days(days);
            let floored = W1.floor(t);
            assert_eq!(floored.weekday(), chrono::Weekday::Mon, "{t}");
            assert!(floored <= t && t < W1.add_bars(floored, 1));
        }
    }

    #[test]
    fn monthly_bars_follow_the_calendar() {
        assert_eq!(
            Mo1.floor(at("2026-09-11T11:14:00Z")),
            at("2026-09-01T00:00:00Z")
        );
        assert_eq!(
            Mo1.floor(at("2026-01-01T00:00:00Z")),
            at("2026-01-01T00:00:00Z")
        );
        let jan = at("2026-01-01T00:00:00Z");
        assert_eq!(Mo1.add_bars(jan, 1), at("2026-02-01T00:00:00Z"));
        // 二月 28 天、三月 31 天：固定秒数在这里一定是错的。
        assert_eq!(Mo1.add_bars(jan, 2), at("2026-03-01T00:00:00Z"));
        assert_eq!(Mo1.add_bars(jan, 12), at("2027-01-01T00:00:00Z"));
        assert_eq!(Mo1.add_bars(jan, -1), at("2025-12-01T00:00:00Z"));
        assert_eq!(Mo1.bars_between(jan, at("2027-01-01T00:00:00Z")), 12);
        assert_eq!(Mo1.bars_between(jan, at("2026-02-28T00:00:00Z")), 1);
        assert_eq!(Mo1.bars_between(jan, at("2026-01-31T23:59:59Z")), 0);
        assert_eq!(
            Mo1.bars_between(at("2024-02-01T00:00:00Z"), at("2024-03-01T00:00:00Z")),
            1
        );
        assert_eq!(Mo1.bars_between(at("2026-03-01T00:00:00Z"), jan), -2);
    }

    #[test]
    fn add_bars_and_bars_between_agree_for_every_interval() {
        let t = at("2026-09-11T11:14:37Z");
        for v in ALL {
            let start = v.floor(t);
            assert_eq!(v.floor(start), start, "{v} floor is idempotent");
            assert_eq!(v.ceil(start), start, "{v} ceil of an aligned instant");
            assert_eq!(
                v.ceil(v.add_bars(start, 1) - Duration::seconds(1)),
                v.add_bars(start, 1)
            );
            for n in [1i64, 2, 7, 64, 256, 768] {
                let end = v.add_bars(start, n);
                assert_eq!(v.bars_between(start, end), n, "{v} +{n}");
                assert_eq!(v.floor(end), end, "{v} +{n} stays aligned");
                assert_eq!(v.add_bars(end, -n), start, "{v} -{n}");
            }
            assert!(v.is_one_bar(start, v.add_bars(start, 1)));
            assert!(!v.is_one_bar(start, v.add_bars(start, 2)));
        }
    }

    #[test]
    fn locate_window_is_768_bars_for_every_interval() {
        // locate.rs 的索引范围 [T0 − 3×256 根, T0 向下取整]，对可变长度周期也要对。
        let t = at("2026-09-11T11:14:37Z");
        for v in ALL {
            let end = v.floor(t);
            let start = v.add_bars(end, -768);
            assert_eq!(v.bars_between(start, end), 768, "{v}");
            assert!(start < end);
        }
    }
}

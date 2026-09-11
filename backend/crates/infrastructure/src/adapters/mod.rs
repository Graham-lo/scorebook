pub mod binance;
pub mod db;
pub mod storage;
pub mod vision;

pub mod ann;

pub mod provider_budget;

pub mod ocr;

pub mod binance_archive;

pub mod binance_account;

pub mod text_encoder;

pub mod chat_model;

pub mod keychain;

pub mod restic;

pub mod account_export_file;

pub mod market_stream;
pub mod shared_market;

/// 限速到 `per_second` 字节每秒时，这一刻还该等多久。已经落后于配额（含刚好
/// 用完配额）就返回 `None` —— 调用方一次 await 都不该走。
///
/// 这个函数存在的唯一理由是挡住一次下溢：`expected - elapsed` 在 `elapsed`
/// 更大时会 panic，而且 release 也一样 panic（`Duration` 的减法是自身的断言，
/// 不是 debug 的溢出检查）。所以这里只取一次 `elapsed`、只用 `checked_sub`：
/// 判断和相减之间时间还在走，分两次取就是那个 panic 的窗口。
pub(crate) fn throttle(
    bytes: usize,
    per_second: f64,
    elapsed: std::time::Duration,
) -> Option<std::time::Duration> {
    std::time::Duration::try_from_secs_f64(bytes as f64 / per_second)
        .ok()?
        .checked_sub(elapsed)
        .filter(|remaining| !remaining.is_zero())
}

#[cfg(test)]
mod throttle_tests {
    use super::throttle;
    use std::time::Duration;

    const PER_SECOND: f64 = 2. * 1024. * 1024.;

    #[test]
    fn still_ahead_of_quota_waits_the_difference() {
        // 4 MiB 的配额是 2 秒，才走了 0.5 秒，还欠 1.5 秒。
        assert_eq!(
            throttle(4 * 1024 * 1024, PER_SECOND, Duration::from_millis(500)),
            Some(Duration::from_millis(1500))
        );
    }

    #[test]
    fn exactly_on_quota_does_not_wait_at_all() {
        // 刚好用满配额：约定返回 None，而不是 Some(0)。让调用方连一次
        // `sleep(0)` 的 await 都不走。
        assert_eq!(
            throttle(4 * 1024 * 1024, PER_SECOND, Duration::from_secs(2)),
            None
        );
    }

    #[test]
    fn far_behind_quota_returns_none_instead_of_underflowing() {
        // 这条是整个修复的意义所在：下载比配额慢得多的时候，旧写法在
        // `expected - elapsed` 上直接 panic，把整条 worker 循环打死。
        let expected = Duration::from_secs(2);
        let elapsed = Duration::from_secs(60);
        assert!(
            elapsed > expected,
            "这个用例必须真的落后于配额，否则它什么都没测到"
        );
        // 换回 `expected - elapsed` 的那一刻，这一行就是 panic。
        assert_eq!(throttle(4 * 1024 * 1024, PER_SECOND, elapsed), None);
    }
}

//! Exact exchange identifiers, including Binance's Han-character contract names.
//! Validation never rewrites an identifier or treats it as a path/URL fragment.
pub fn symbol_character(c: char) -> bool {
    c.is_ascii_uppercase()
        || c.is_ascii_digit()
        || c == '_'
        || matches!(c, '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}' | '\u{20000}'..='\u{2fa1f}' | '\u{30000}'..='\u{323af}')
}

pub fn valid_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.len() <= 128
        && symbol.chars().count() <= 40
        && symbol.chars().all(symbol_character)
}

/// Normalize a search phrase only. Returned identities always come from the catalogue.
pub fn search_query(input: &str) -> String {
    let folded: String = input
        .chars()
        .map(|c| match c {
            '\u{ff01}'..='\u{ff5e}' => char::from_u32(c as u32 - 0xfee0).unwrap(),
            _ => c,
        })
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let query = folded.trim_start_matches('$');
    let query = query.strip_prefix("BINANCE:").unwrap_or(query);
    let query = query.strip_suffix(".P").unwrap_or(query);
    query
        .chars()
        .filter(|c| !matches!(c, '/' | '-' | '_'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pasted_search_notation_is_normalized_without_inventing_aliases() {
        for input in [
            "mu/usdt",
            " MU-USDT ",
            "ｍｕ／ｕｓｄｔ",
            "$muusdt",
            "BINANCE:MUUSDT.P",
        ] {
            assert_eq!(search_query(input), "MUUSDT");
        }
        assert_eq!(search_query("mu"), "MU");
        assert_eq!(search_query("币安人生"), "币安人生");
        assert_eq!(search_query("BTCUSD_PERP"), "BTCUSDPERP");
        assert_eq!(search_query("%"), "%");
    }
    #[test]
    fn real_exchange_names_preserve_their_exact_identity() {
        for symbol in [
            "BTCUSDT",
            "BTCUSD_PERP",
            "1000SHIBUSDT",
            "币安人生USDT",
            "我踏马来了USDT",
            "龙虾USDT",
        ] {
            assert!(valid_symbol(symbol), "{symbol}");
        }
    }
    #[test]
    fn paths_urls_controls_and_unbounded_names_are_rejected() {
        for symbol in [
            "",
            "btcusdt",
            "BTC/USDT",
            "../BTCUSDT",
            "BTC%2FUSDT",
            "BTC?x=1",
            "BTC\\USDT",
            "BTC\nUSDT",
            "币安 人生USDT",
            "币安\u{202e}USDT",
            "币安\u{200b}USDT",
        ] {
            assert!(!valid_symbol(symbol), "{symbol:?}");
        }
        assert!(!valid_symbol(&"A".repeat(41)));
    }
}

//! Relive/replay inputs: a confirmed screenshot location, the chart setup, the
//! per-screenshot locating override and the attachment kind correction.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

/// One screenshot pinned to a real Binance window. Confirmed once, kept for good.
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentLocation {
    pub symbol: String,
    #[serde(default = "usd_m")]
    pub market: String,
    pub interval: String,
    /// 手填时只给「最后一根的时间」，起点由 `bars_count`（缺省用几何数出来的
    /// 根数）反推，所以这一格可以不给（§5.2 第 6 步）。
    #[serde(default)]
    pub start_at: Option<DateTime<Utc>>,
    pub end_at: DateTime<Utc>,
    pub bars_count: Option<i32>,
    /// 手填时不给：服务端自己知道这段 K 线是从哪儿取来的。
    #[serde(default)]
    pub source: Option<crate::market::HistorySource>,
    /// 匹配分。线上一直是字符串，因为库里是 `numeric`，回显时走 `score::text`，
    /// 不让它路过 f64 掉精度。但前端把刚拿到的 `match.score` 原样回填时它是个
    /// JSON 数字，整个请求体会被 Json 提取器直接顶掉，报出来的只是一句
    /// `invalid_request`——哪个字段错了都看不见。所以收的时候两种都认，数字按
    /// 它的十进制写法收下；发出去的仍然只有字符串一种形状。
    #[serde(default, deserialize_with = "score_text")]
    #[schema(value_type = Option<String>)]
    pub score: Option<String>,
    pub search_run_id: Option<Uuid>,
}
fn usd_m() -> String {
    "usd_m".into()
}

/// 字符串或 JSON 数字都收，别的类型照旧拒收：布尔、数组、对象都不是分数。
fn score_text<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    struct Text;
    impl<'de> serde::de::Visitor<'de> for Text {
        type Value = Option<String>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a decimal score as a string or a number")
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }
        // 整数与浮点各走各的路：i64/u64 不经过 f64，`9007199254740993` 这种
        // 超出双精度整数区间的值才不会被改写成邻近的偶数。
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v.to_string()))
        }
        // f64 的 Display 是最短往返写法，所以 0.3445477185544664 收进来还是它
        // 自己，不会变成 0.34454771855446640000…。
        fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
            if v.is_finite() {
                Ok(Some(v.to_string()))
            } else {
                Err(E::custom("score must be finite"))
            }
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            d.deserialize_any(Text)
        }
    }
    d.deserialize_option(Text)
}

/// Which overlays the replay stage draws. The backend stores the shape only and
/// never computes an indicator.
///
/// 每个字段都有默认值，所以旧的 `{"ma":[],"ema":[]}` 依然能解出来；未知字段仍然拒收。
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ChartSetup {
    #[serde(default)]
    pub ma: Vec<u32>,
    #[serde(default)]
    pub ema: Vec<u32>,
    #[serde(default)]
    pub boll: Option<BollSetup>,
    #[serde(default)]
    pub atr: Option<AtrSetup>,
    /// 非 null 即表示要画 VOL 副图；`ma` 是 MAVOL 的周期。
    #[serde(default)]
    pub volume: Option<VolumeSetup>,
    #[serde(default)]
    pub macd: Option<MacdSetup>,
    #[serde(default)]
    pub rsi: Option<RsiSetup>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct BollSetup {
    pub n: u32,
    pub k: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AtrSetup {
    pub n: u32,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct VolumeSetup {
    #[serde(default)]
    pub ma: Vec<u32>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MacdSetup {
    pub fast: u32,
    pub slow: u32,
    pub signal: u32,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RsiSetup {
    pub n: u32,
}

/// `GET /v1/calls/{id}/replay` 的查询串。`bars=none` 只要元数据：前端自己直连
/// 币安拉 K 线，后端这一次既不取数也不写缓存。
#[derive(Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplayQuery {
    #[serde(default)]
    pub bars: Option<String>,
}

/// 手动定位时按这张图指定品种：三张同板块对比图各归各的标的。
/// 三项都可省，省掉的沿用记录本身的 instrument/market/timeframe。
#[derive(Clone, Default, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LocateOverride {
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub market: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
    /// 人已经看过并且说了「都不是」的那些候选窗口。累加的：第三轮要把前两轮
    /// 一共六条都写在这里。给了就意味着这一次不是原地重试——索引会沿时间轴再
    /// 往前推一段，拉没拉过的 K 线。不给就是从前那条自动定位的路，一格不变。
    #[serde(default)]
    pub exclude: Vec<Uuid>,
}

/// 改附件用途：把同板块对比图从 scene 降成 reference。
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AttachmentKindUpdate {
    pub kind: String,
}

#[cfg(test)]
mod score_tests {
    use super::*;
    fn body(score: &str) -> String {
        format!(
            r#"{{"symbol":"SNDKUSDT","market":"usd_m","interval":"1h",
               "start_at":"2026-09-08T00:00:00Z","end_at":"2026-09-09T00:00:00Z",
               "bars_count":24,"source":"rest","search_run_id":null{score}}}"#
        )
    }
    fn parse(score: &str) -> Result<AttachmentLocation, serde_json::Error> {
        serde_json::from_str(&body(score))
    }
    #[test]
    fn a_score_is_accepted_as_a_string_or_as_a_number_and_always_sent_back_as_a_string() {
        // 前端原样回填 match.score 时给的就是这个数字，从前整个请求体会被顶掉。
        assert_eq!(
            parse(r#","score":0.3445477185544664"#).unwrap().score,
            Some("0.3445477185544664".into())
        );
        assert_eq!(
            parse(r#","score":"0.91""#).unwrap().score,
            Some("0.91".into())
        );
        assert_eq!(parse(r#","score":1"#).unwrap().score, Some("1".into()));
        assert_eq!(parse(r#","score":null"#).unwrap().score, None);
        assert_eq!(parse("").unwrap().score, None);
        // 发出去的形状一格没动：仍旧是字符串。
        let v = serde_json::to_value(parse(r#","score":0.3445477185544664"#).unwrap()).unwrap();
        assert_eq!(v["score"], serde_json::json!("0.3445477185544664"));
        assert_eq!(
            serde_json::to_value(parse(r#","score":null"#).unwrap()).unwrap()["score"],
            serde_json::Value::Null
        );
    }
    #[test]
    fn anything_that_is_not_a_number_or_a_string_is_still_rejected() {
        for score in [
            r#","score":true"#,
            r#","score":[0.9]"#,
            r#","score":{"value":0.9}"#,
        ] {
            assert!(parse(score).is_err(), "{score}");
        }
        // 未知字段照旧拒收。
        assert!(parse(r#","score":"0.9","extra":1"#).is_err());
    }
}

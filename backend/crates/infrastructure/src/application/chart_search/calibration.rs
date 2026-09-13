//! Archived rarity analytics. Public search uses an absolute structural similarity floor.
use super::*;
pub const DEFAULT_SAMPLES: usize = 500;
const PIPELINE: &str = "public-search-300-v1";

/// Old percentile calibration is retired. Preserve its samples for audit, but
/// do not consume market/network capacity or mix the new recall with old samples.
pub async fn run(_s: &Services, _j: &Job) -> Result<Value> {
    Ok(json!({"status":"retired", "pipeline":PIPELINE,
        "reason":"public_visibility_uses_structural_similarity", "minimum_similarity":0.60}))
}

/// 一个档位的样本分布，升序。查询那一头一次把整个周期的分布读进来，逐条结果在内存
/// 里算稀有度——每条结果去查一次库，一次检索就是十几个来回。
pub struct Calibration(std::collections::BTreeMap<i32, Vec<f64>>);

impl Calibration {
    /// 没有分布：稀有度恒为 None，词退回按绝对分给。
    pub fn empty() -> Self {
        Self(Default::default())
    }

    pub async fn load(s: &Services, interval: Option<&str>) -> Result<Self> {
        let Some(interval) = interval.filter(|v| !v.trim().is_empty()) else {
            return Ok(Self::empty());
        };
        let rows: Vec<(i32, Vec<f64>)> = sqlx::query_as("SELECT bars_bucket,array_agg(sample_score::float8 ORDER BY sample_score) FROM chart_match_calibration WHERE interval=$1 AND pipeline=$2 GROUP BY bars_bucket HAVING count(*) >= $3")
            .bind(interval)
            .bind(PIPELINE)
            .bind(DEFAULT_SAMPLES as i64)
            .fetch_all(&s.db.pool)
            .await?;
        Ok(Self(rows.into_iter().collect()))
    }

    /// 这一档里低于这个分的样本比例。没有这一档的样本就没有稀有度——不拿隔壁档位
    /// 的分布凑，档位之间的分布本来就不在一个量级上。
    pub fn rarity(&self, bars: usize, score: f64) -> Option<f64> {
        let bucket = super::super::history::LOCATE_WINDOWS
            .iter()
            .min_by_key(|bucket| (**bucket as i64 - bars as i64).unsigned_abs())?;
        let samples = self.0.get(&(*bucket as i32)).filter(|v| !v.is_empty())?;
        let below = samples.partition_point(|v| *v < score);
        Some(below as f64 / samples.len() as f64)
    }
}

/// Labels describe structural similarity. Rarity never changes scores or visibility.
pub fn level(_rarity: Option<f64>, score: f64) -> Option<&'static str> {
    if score >= 0.75 {
        Some("sure")
    } else if score >= 0.60 {
        Some("likely")
    } else if score >= 0.45 {
        Some("weak")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_bucket_does_not_borrow_a_different_distribution() {
        let distribution = Calibration([(128, vec![0.2, 0.6, 0.8])].into());
        assert_eq!(distribution.rarity(96, 0.9), None);
        assert_eq!(distribution.rarity(192, 0.9), None);
        assert_eq!(distribution.rarity(124, 0.6), Some(1. / 3.));
        assert_eq!(distribution.rarity(128, 0.9), Some(1.));
    }
}

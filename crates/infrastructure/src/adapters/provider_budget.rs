//! PostgreSQL serializes the shared outbound IP/product budget across API and workers.
use crate::error::{Error, Result, RetryDirective};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};
#[derive(Clone)]
pub struct ProviderBudget {
    pool: PgPool,
    egress: String,
    limit: i32,
}
impl ProviderBudget {
    pub fn new(pool: PgPool) -> anyhow::Result<Self> {
        let limit = std::env::var("SCOREBOOK_BINANCE_WEIGHT_PER_MINUTE")
            .map(|v| v.parse())
            .unwrap_or(Ok(600))?;
        anyhow::ensure!(
            (20..=2400).contains(&limit),
            "invalid Binance weight budget"
        );
        Ok(Self {
            pool,
            egress: std::env::var("SCOREBOOK_EGRESS_ID")
                .unwrap_or_else(|_| "default-egress".into()),
            limit,
        })
    }
    pub async fn reserve(&self, market: &str, weight: i32) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO provider_budgets(egress_id,market) VALUES($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(&self.egress)
        .bind(market)
        .execute(&mut *tx)
        .await?;
        let row=sqlx::query("SELECT window_start,used,blocked_until,now() AS at FROM provider_budgets WHERE egress_id=$1 AND market=$2 FOR UPDATE").bind(&self.egress).bind(market).fetch_one(&mut *tx).await?;
        let now: DateTime<Utc> = row.get("at");
        let blocked: DateTime<Utc> = row.get("blocked_until");
        let start: DateTime<Utc> = row.get("window_start");
        if blocked > now {
            return Err(Error::deferred(
                "provider_cooling_down",
                RetryDirective::At(blocked),
            ));
        }
        let current = now.timestamp().div_euclid(60) == start.timestamp().div_euclid(60);
        if current && row.get::<i32, _>("used") + weight > self.limit {
            return Err(Error::deferred(
                "provider_budget_exhausted",
                RetryDirective::At(start + chrono::Duration::minutes(1)),
            ));
        }
        sqlx::query("UPDATE provider_budgets SET used=CASE WHEN window_start=date_trunc('minute',now()) THEN used+$3 ELSE $3 END,window_start=date_trunc('minute',now()) WHERE egress_id=$1 AND market=$2").bind(&self.egress).bind(market).bind(weight).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn observe(
        &self,
        market: &str,
        used: Option<i32>,
        cooldown: Option<u32>,
    ) -> Result<()> {
        sqlx::query("UPDATE provider_budgets SET used=CASE WHEN window_start=date_trunc('minute',now()) THEN greatest(used,COALESCE($3,0)) ELSE COALESCE($3,0) END,window_start=date_trunc('minute',now()),blocked_until=CASE WHEN $4::int IS NULL THEN blocked_until ELSE greatest(blocked_until,now()+make_interval(secs=>$4)) END WHERE egress_id=$1 AND market=$2").bind(&self.egress).bind(market).bind(used).bind(cooldown.map(|s|s as i32)).execute(&self.pool).await?;
        Ok(())
    }
}

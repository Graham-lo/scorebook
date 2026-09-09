use crate::error::{Error, Result, RetryDirective};
use hmac::{Hmac, Mac};
use scorebook_core::exchange::{ACCOUNT_CAPABILITIES, AccountHistoryProvider, AccountRead};
use scorebook_core::secrets::SecretStore;
use serde_json::Value;
use sha2::Sha256;
use zeroize::Zeroize;
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    api_key: String,
    secret: String,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.api_key.zeroize();
        self.secret.zeroize();
    }
}
#[derive(Clone)]
pub struct BinanceAccount {
    client: reqwest::Client,
    budget: super::provider_budget::ProviderBudget,
}
impl BinanceAccount {
    pub fn new(pool: sqlx::PgPool) -> anyhow::Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(25))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            budget: super::provider_budget::ProviderBudget::new(pool)?,
        })
    }
    async fn get(&self, service: &str, market: &str, request: AccountRead) -> Result<Value> {
        let income = matches!(
            &request,
            AccountRead::IncomeExport { .. } | AccountRead::IncomeDownload { .. }
        );
        let request = match request {
            AccountRead::IncomeExport { start, end } => AccountRead::HistoryExport { start, end },
            AccountRead::IncomeDownload { download_id } => {
                AccountRead::HistoryDownload { download_id }
            }
            r => r,
        };
        let (id, mut params) = match request {
            AccountRead::Trades {
                symbol,
                start,
                end,
                from_id,
            } => {
                crate::application::history_catalog::validate_symbol(&symbol)?;
                let mut p = vec![
                    ("symbol".to_string(), symbol),
                    ("limit".into(), "1000".into()),
                ];
                if let Some(from) = from_id {
                    if from.parse::<u64>().is_err() {
                        return Err(Error::bad("invalid_trade_cursor"));
                    }
                    p.push(("fromId".into(), from));
                } else {
                    if start >= end || (end - start).num_seconds() > 7 * 86400 {
                        return Err(Error::bad("invalid_account_time_window"));
                    }
                    p.extend([
                        ("startTime".into(), start.timestamp_millis().to_string()),
                        ("endTime".into(), (end.timestamp_millis() - 1).to_string()),
                    ]);
                }
                ("account_trades", p)
            }
            AccountRead::Income { start, end, page } => {
                if start >= end || page == 0 || page > 100000 {
                    return Err(Error::bad("invalid_income_page"));
                }
                (
                    "account_income",
                    vec![
                        ("startTime".into(), start.timestamp_millis().to_string()),
                        ("endTime".into(), (end.timestamp_millis() - 1).to_string()),
                        ("page".into(), page.to_string()),
                        ("limit".into(), "1000".into()),
                    ],
                )
            }
            AccountRead::HistoryExport { start, end } => {
                if start >= end || (end - start).num_seconds() > 365 * 86400 {
                    return Err(Error::bad("invalid_history_export_window"));
                }
                (
                    "history_export",
                    vec![
                        ("startTime".into(), start.timestamp_millis().to_string()),
                        ("endTime".into(), (end.timestamp_millis() - 1).to_string()),
                    ],
                )
            }
            AccountRead::IncomeExport { .. } | AccountRead::IncomeDownload { .. } => {
                unreachable!("normalized explicit dataset")
            }
            AccountRead::HistoryDownload { download_id } => {
                if download_id.is_empty()
                    || download_id.len() > 64
                    || !download_id.chars().all(|c| c.is_ascii_digit())
                {
                    return Err(Error::bad("invalid_download_id"));
                }
                ("history_download", vec![("downloadId".into(), download_id)])
            }
        };
        let id = if income {
            if id == "history_export" {
                "income_export"
            } else {
                "income_download"
            }
        } else {
            id
        };
        let capability = ACCOUNT_CAPABILITIES
            .iter()
            .find(|c| c.id == id && c.market == market)
            .ok_or_else(|| {
                Error::deferred(
                    "account_capability_not_supported",
                    RetryDirective::AwaitCapability,
                )
            })?;
        self.budget.reserve(market, capability.weight).await?;
        let credentials = credentials(service).await?;
        params.extend([
            (
                "timestamp".into(),
                chrono::Utc::now().timestamp_millis().to_string(),
            ),
            ("recvWindow".into(), "5000".into()),
        ]);
        let base = match market {
            "usd_m" => "https://fapi.binance.com",
            "coin_m" => "https://dapi.binance.com",
            _ => return Err(Error::bad("invalid_market")),
        };
        let mut url = reqwest::Url::parse(&format!("{base}{}", capability.path))
            .map_err(|_| Error::bad("invalid_account_endpoint"))?;
        url.query_pairs_mut().extend_pairs(&params);
        let mut mac = Hmac::<Sha256>::new_from_slice(credentials.secret.as_bytes())
            .map_err(|_| Error::bad("invalid_exchange_secret"))?;
        mac.update(url.query().unwrap_or("").as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        url.query_pairs_mut().append_pair("signature", &signature);
        let mut header = reqwest::header::HeaderValue::from_str(&credentials.api_key)
            .map_err(|_| Error::bad("invalid_exchange_key"))?;
        header.set_sensitive(true);
        let mut response = self
            .client
            .get(url)
            .header("X-MBX-APIKEY", header)
            .send()
            .await
            .map_err(|_| Error::transient("exchange_account_request_failed"))?;
        let used = response
            .headers()
            .get("x-mbx-used-weight-1m")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok());
        let status = response.status();
        let cooldown = if matches!(status.as_u16(), 418 | 429) {
            Some(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(60),
            )
        } else {
            None
        };
        self.budget.observe(market, used, cooldown).await?;
        if let Some(seconds) = cooldown {
            return Err(Error::deferred(
                "exchange_account_cooling_down",
                RetryDirective::After(seconds),
            ));
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(Error::deferred(
                "exchange_credentials_rejected",
                RetryDirective::AwaitInput,
            ));
        }
        if !status.is_success() {
            return Err(Error::deferred(
                "exchange_account_response_rejected",
                if status.is_server_error() {
                    RetryDirective::Backoff
                } else {
                    RetryDirective::AwaitInput
                },
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::transient("exchange_account_body_interrupted"))?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err(Error::bad("exchange_page_too_large"));
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| Error::bad("invalid_exchange_account_response"))
    }
}
impl AccountHistoryProvider for BinanceAccount {
    fn download<'a>(&'a self, url: String) -> scorebook_core::ports::AppFuture<'a, Vec<u8>> {
        Box::pin(async move {
            super::account_export_file::download(url)
                .await
                .map_err(Into::into)
        })
    }

    fn read<'a>(
        &'a self,
        service: &'a str,
        market: &'a str,
        request: AccountRead,
    ) -> scorebook_core::ports::AppFuture<'a, Value> {
        Box::pin(async move { self.get(service, market, request).await.map_err(Into::into) })
    }
}
async fn credentials(service: &str) -> Result<Credentials> {
    if !service.starts_with("scorebook.exchange.")
        || service.len() > 200
        || service.chars().any(char::is_control)
    {
        return Err(Error::bad("invalid_keychain_reference"));
    }
    let data = super::keychain::Keychain.load(service.to_string()).await?;
    let c: Credentials =
        serde_json::from_slice(&data.0).map_err(|_| Error::bad("invalid_exchange_credentials"))?;
    if c.api_key.is_empty() || c.secret.is_empty() {
        return Err(Error::bad("invalid_exchange_credentials"));
    }
    Ok(c)
}

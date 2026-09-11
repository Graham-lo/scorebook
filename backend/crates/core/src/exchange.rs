//! Read-only account port; there is no order placement/cancellation method.
use crate::ports::AppFuture;
use chrono::{DateTime, Utc};
use serde_json::Value;
#[derive(Clone)]
pub enum AccountRead {
    Trades {
        symbol: String,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        from_id: Option<String>,
    },
    Income {
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        page: u32,
    },
    HistoryExport {
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    },
    IncomeExport {
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    },
    IncomeDownload {
        download_id: String,
    },
    HistoryDownload {
        download_id: String,
    },
}
pub trait AccountHistoryProvider: Send + Sync {
    fn download<'a>(&'a self, _url: String) -> AppFuture<'a, Vec<u8>> {
        Box::pin(async {
            Err(crate::error::Error::deferred(
                "account_export_download_not_supported",
                crate::error::RetryDirective::AwaitCapability,
            ))
        })
    }

    fn read<'a>(
        &'a self,
        keychain_service: &'a str,
        market: &'a str,
        request: AccountRead,
    ) -> AppFuture<'a, Value>;
}
#[derive(Clone, serde::Serialize)]
pub struct EndpointCapability {
    pub id: &'static str,
    pub version: &'static str,
    pub market: &'static str,
    pub path: &'static str,
    pub weight: i32,
    pub max_days: Option<u32>,
    pub retention_months: Option<u32>,
    pub page_limit: Option<u32>,
    pub verified_on: &'static str,
}
pub const ACCOUNT_CAPABILITIES: &[EndpointCapability] = &[
    EndpointCapability {
        id: "account_trades",
        version: "2026-09-10",
        market: "usd_m",
        path: "/fapi/v1/userTrades",
        weight: 5,
        max_days: Some(7),
        retention_months: Some(3),
        page_limit: Some(1000),
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "account_trades",
        version: "2026-09-10",
        market: "coin_m",
        path: "/dapi/v1/userTrades",
        weight: 20,
        max_days: Some(7),
        retention_months: Some(3),
        page_limit: Some(1000),
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "account_income",
        version: "2026-09-10",
        market: "usd_m",
        path: "/fapi/v1/income",
        weight: 30,
        max_days: None,
        retention_months: Some(3),
        page_limit: Some(1000),
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "account_income",
        version: "2026-09-10",
        market: "coin_m",
        path: "/dapi/v1/income",
        weight: 20,
        max_days: Some(365),
        retention_months: None,
        page_limit: Some(1000),
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "history_export",
        version: "2026-09-10",
        market: "usd_m",
        path: "/fapi/v1/trade/asyn",
        weight: 1000,
        max_days: Some(365),
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "history_download",
        version: "2026-09-10",
        market: "usd_m",
        path: "/fapi/v1/trade/asyn/id",
        weight: 10,
        max_days: None,
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "income_export",
        version: "2026-09-10",
        market: "usd_m",
        path: "/fapi/v1/income/asyn",
        weight: 1000,
        max_days: Some(365),
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "income_download",
        version: "2026-09-10",
        market: "usd_m",
        path: "/fapi/v1/income/asyn/id",
        weight: 10,
        max_days: None,
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "income_export",
        version: "2026-09-10",
        market: "coin_m",
        path: "/dapi/v1/income/asyn",
        weight: 1000,
        max_days: Some(365),
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "income_download",
        version: "2026-09-10",
        market: "coin_m",
        path: "/dapi/v1/income/asyn/id",
        weight: 5,
        max_days: None,
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "history_export",
        version: "2026-09-10",
        market: "coin_m",
        path: "/dapi/v1/trade/asyn",
        weight: 1000,
        max_days: Some(365),
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
    EndpointCapability {
        id: "history_download",
        version: "2026-09-10",
        market: "coin_m",
        path: "/dapi/v1/trade/asyn/id",
        weight: 5,
        max_days: None,
        retention_months: None,
        page_limit: None,
        verified_on: "2026-09-10",
    },
];

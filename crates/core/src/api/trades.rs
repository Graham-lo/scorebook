use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum TradeSide {
    Buy,
    Sell,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "UPPERCASE")]
pub enum PositionSide {
    Both,
    Long,
    Short,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FillInput {
    pub trade_id: String,
    pub order_id: Option<String>,
    pub symbol: String,
    pub side: TradeSide,
    pub position_side: PositionSide,
    pub price: String,
    pub quantity: String,
    pub realized_pnl: Option<String>,
    pub settlement_asset: String,
    pub commission: String,
    pub commission_asset: String,
    pub traded_at: DateTime<Utc>,
    pub liquidation: Option<bool>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LedgerEntryInput {
    pub transaction_id: String,
    pub kind: String,
    pub symbol: Option<String>,
    pub asset: String,
    pub amount: String,
    pub occurred_at: DateTime<Utc>,
    pub trade_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExchangeConnectionInput {
    pub name: String,
    pub account_label: String,
    pub market: String,
    /// A Keychain item reference only; plaintext credentials are never accepted by this API.
    pub keychain_service: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TradeImportInput {
    pub dataset: ImportDataset,
    pub connection_id: Uuid,
    pub source: ImportSource,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub symbols: Vec<String>,
    pub fills: Vec<FillInput>,
    #[serde(default)]
    pub ledger_entries: Vec<LedgerEntryInput>,
    pub declared_complete: bool,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ImportSource {
    Csv,
    AccountApi,
    HistoricalExport,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CsvImportInput {
    pub connection_id: Uuid,
    pub csv: String,
    pub schema: String,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub symbols: Vec<String>,
    pub declared_complete: bool,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExchangeSyncInput {
    pub connection_id: Uuid,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub symbols: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PositionSeedInput {
    pub connection_id: Uuid,
    pub symbol: String,
    pub position_side: PositionSide,
    pub effective_at: DateTime<Utc>,
    /// Signed in BOTH mode, nonnegative for LONG/SHORT. Null means unknown opening position.
    pub quantity: Option<String>,
    pub entry_price: Option<String>,
    pub contract_multiplier: String,
    pub settlement_asset: String,
    pub evidence: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct TradeFilter {
    pub connection_id: Option<Uuid>,
    pub symbol: Option<String>,
    pub cursor: Option<String>,
    pub start_at: Option<DateTime<Utc>>,
    pub end_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ReconciliationInput {
    pub connection_id: Uuid,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub statement: Vec<AssetStatement>,
    pub evidence: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AssetStatement {
    pub asset: String,
    pub realized_pnl: String,
    pub commission: String,
    pub funding: String,
    pub tolerance: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExecutionLinkInput {
    pub connection_id: Uuid,
    pub trade_ids: Vec<Uuid>,
    pub call_id: Option<Uuid>,
    pub episode_id: Option<Uuid>,
    pub playbook_id: Option<Uuid>,
    pub relation: String,
    pub evidence: String,
    pub supersedes: Option<Uuid>,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct HistoryExportInput {
    pub connection_id: Uuid,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
}

#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ImportDataset {
    Trades,
    Ledger,
    Both,
}

#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct ImportFilter {
    pub cursor: Option<String>,
    pub connection_id: Option<Uuid>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConnectionControl {
    pub expected_revision: i64,
    pub action: String,
    pub keychain_service: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CsvMapping {
    /// Canonical field -> exact CSV header. No inferred columns or inferred assets.
    pub columns: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub constants: std::collections::BTreeMap<String, String>,
    pub timestamp_format: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExchangeExportInput {
    pub connection_id: Uuid,
    pub start_at: DateTime<Utc>,
    pub end_at: DateTime<Utc>,
    pub dataset: String,
    pub format: String,
    pub mapping: CsvMapping,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExportResolve {
    pub expected_generation: i64,
    pub download_id: String,
    pub evidence: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ExportMappingUpdate {
    pub expected_generation: i64,
    pub mapping: CsvMapping,
}

#[derive(Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct CycleDetailFilter {
    pub cursor: Option<Uuid>,
}

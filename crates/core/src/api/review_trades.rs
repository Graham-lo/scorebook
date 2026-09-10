use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

// The API bounds this value to 20 entries; keep the wire fields explicit.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReviewTrade {
    Manual {
        symbol: String,
        direction: Option<String>,
        opened_at: Option<DateTime<Utc>>,
        closed_at: Option<DateTime<Utc>>,
        quantity: Option<String>,
        quantity_unit: Option<String>,
        leverage: Option<String>,
        entry_price: Option<String>,
        exit_price: Option<String>,
        realized_pnl: Option<String>,
        settlement_asset: Option<String>,
        fees: Option<String>,
        margin_mode: Option<String>,
        note: Option<String>,
    },
    Exchange {
        connection_id: Uuid,
        cycle_id: Uuid,
        /// Explicit manual supplement: historical leverage is not inferred from today's settings.
        leverage: Option<String>,
        note: Option<String>,
    },
}

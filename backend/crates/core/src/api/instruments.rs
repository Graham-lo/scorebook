use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
#[derive(Serialize, Deserialize, ToSchema)]
pub struct InstrumentFilter {
    pub q: Option<String>,
    pub market: Option<String>,
    pub asset_class: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<i64>,
}

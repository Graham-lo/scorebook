use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MarketBoundsQuery {
    // Missing values reach domain validation and receive the documented 422 code.
    #[serde(default)]
    #[schema(required = true)]
    pub market: String,
    #[serde(default)]
    #[schema(required = true)]
    pub symbol: String,
    #[serde(default)]
    #[schema(required = true)]
    pub interval: String,
}

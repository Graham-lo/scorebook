pub mod calls;
pub mod exports;
pub mod jobs;
pub mod knowledge;
pub mod similarity;
use crate::adapters::{db::Database, storage::Storage, vision::Vision};
#[derive(Clone)]
pub struct Services {
    pub db: Database,
    pub storage: Storage,
    pub images: std::sync::Arc<dyn scorebook_core::ports::OriginalImageStore>,
    pub vision: Vision,
    pub market: std::sync::Arc<dyn ports::MarketDataProvider>,
}
pub mod ports;
impl Services {
    pub fn new(db: Database, storage: Storage, vision: Vision) -> anyhow::Result<Self> {
        Ok(Self {
            db: db.clone(),
            images: std::sync::Arc::new(storage.clone()),
            storage,
            vision,
            market: std::sync::Arc::new(crate::adapters::binance::Binance::new(db.pool.clone())?),
        })
    }
    pub fn with_market(mut self, market: std::sync::Arc<dyn ports::MarketDataProvider>) -> Self {
        self.market = market;
        self
    }
}
pub mod evaluation;
pub mod sets;

pub mod dto;
pub mod lifecycle;

pub mod settlement;

pub mod model_access;
pub mod record_changes;

pub mod hybrid_search;
pub mod instruments;

pub mod market;

pub mod history;

pub mod access;

pub mod search_sessions;

pub mod review_workflow;

pub mod history_plans;

pub mod gc;

pub mod attachments;

pub mod sessions;

pub mod review_projection;

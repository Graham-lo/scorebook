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
    pub secrets: std::sync::Arc<dyn scorebook_core::secrets::SecretStore>,
    pub restic: crate::adapters::restic::Restic,
    pub chat: std::sync::Arc<dyn scorebook_core::chat::ChatModelProvider>,
    pub text: std::sync::Arc<dyn scorebook_core::knowledge_index::TextEncoder>,
    pub accounts: std::sync::Arc<dyn scorebook_core::exchange::AccountHistoryProvider>,
    pub archives: crate::adapters::binance_archive::BinanceArchive,
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
            secrets: std::sync::Arc::new(crate::adapters::keychain::Keychain),
            restic: crate::adapters::restic::Restic::new()?,
            chat: std::sync::Arc::new(crate::adapters::chat_model::UnconfiguredChatModel),
            text: std::sync::Arc::new(crate::adapters::text_encoder::LocalTextEncoder::new()?),
            accounts: std::sync::Arc::new(crate::adapters::binance_account::BinanceAccount::new(
                db.pool.clone(),
            )?),
            archives: crate::adapters::binance_archive::BinanceArchive::new()?,
            market: std::sync::Arc::new(crate::adapters::shared_market::SharedMarket::new(
                std::sync::Arc::new(crate::adapters::binance::Binance::new(db.pool.clone())?),
            )),
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

pub mod chart_search;

pub mod history_catalog;

pub mod trades;

pub mod assessment_monitor;

pub mod statistics;

pub mod knowledge_workflow;

pub mod knowledge_index;

pub mod chat;

pub mod backups;

pub mod capabilities;

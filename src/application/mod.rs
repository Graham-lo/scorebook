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
    pub vision: Vision,
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

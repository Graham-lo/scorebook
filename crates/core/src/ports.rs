//! Application boundary used by HTTP. No adapter, SQL, or web-framework types cross it.
use crate::{access::Principal, error::Result};
use serde_json::Value;
use std::{future::Future, pin::Pin};
use uuid::Uuid;
pub type AppFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;
#[derive(Debug, Clone, Copy)]
pub enum Action {
    SessionCreate,
    SessionRevoke,
    CallCreate,
    CallList,
    CallGet,
    CallHistory,
    CallVoid,
    AttachmentUpload,
    AttachmentIndex,
    AttachmentLink,
    Correction,
    CallRevision,
    ReviewCreate,
    ReviewQueue,
    TagList,
    TagCreate,
    TagLink,
    PlaybookList,
    PlaybookCreate,
    EpisodeList,
    EpisodeGet,
    EpisodeLink,
    Events,
    SimilaritySearch,
    SimilarityFeedback,
    SearchSave,
    SearchGet,
    MarketData,
    MarketChart,
    HistoryIndex,
    HistorySearch,
    HistoryIndexes,
    HistoryCoverage,
    HistoryPlanCreate,
    HistoryPlanGet,
    HistoryPlanControl,
    JobGet,
    JobRetry,
    ExportCreate,
    Replay,
    OutcomeRevision,
    SetCreate,
    SetGet,
    DeletePreview,
    DeleteConfirm,
    ToolCall,
    DraftGet,
    DraftSave,
    DraftPublish,
    DraftDiscard,
    ReviewSnooze,
    Instruments,
    Capabilities,
    AttachmentDownload,
    ExportDownload,
}
pub struct Command {
    pub owner: Uuid,
    pub action: Action,
    pub subject: Option<Uuid>,
    pub key: Option<String>,
    pub payload: Value,
    pub bytes: Option<Vec<u8>>,
    pub principal: Option<Principal>,
}
impl Command {
    pub fn new(owner: Uuid, action: Action, payload: Value) -> Self {
        Self {
            owner,
            action,
            subject: None,
            key: None,
            payload,
            bytes: None,
            principal: None,
        }
    }
}
pub struct Resource {
    pub reader: Pin<Box<dyn tokio::io::AsyncRead + Send>>,
    pub content_type: String,
    pub attachment: bool,
}
pub trait Backend: Send + Sync {
    fn execute(&self, command: Command) -> AppFuture<'_, Value>;
    fn resource(&self, command: Command) -> AppFuture<'_, Resource>;
    fn authenticate(&self, token: String) -> AppFuture<'_, Principal>;
    fn upload_permit(&self) -> AppFuture<'_, Box<dyn Send>>;
    fn readiness(&self) -> AppFuture<'_, Value>;
}

pub type ImageReader = Pin<Box<dyn tokio::io::AsyncRead + Send>>;
pub struct ImageMeta {
    pub digest: String,
    pub mime: String,
    pub width: u32,
    pub height: u32,
}
/// Only user-supplied original images are published. Generated market charts never use this port.
pub trait OriginalImageStore: Send + Sync {
    fn publish(&self, owner: Uuid, id: Uuid, bytes: Vec<u8>) -> AppFuture<'_, ImageMeta>;
    fn open(&self, owner: Uuid, id: Uuid) -> AppFuture<'_, ImageReader>;
    fn remove(&self, owner: Uuid, id: Uuid) -> AppFuture<'_, ()>;
}

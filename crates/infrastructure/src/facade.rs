//! Composition of modular use cases behind the application port.
use crate::{
    application::{self as app, Services},
    error::{Error, Result},
};
use scorebook_core::{
    access::Principal,
    ports::{Action, AppFuture, Backend, Command, Resource},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;
pub struct Facade {
    services: Services,
    ready: AtomicBool,
    checked: tokio::sync::Mutex<std::time::Instant>,
}
impl Facade {
    pub fn new(services: Services) -> Self {
        Self {
            services,
            ready: AtomicBool::new(false),
            checked: tokio::sync::Mutex::new(
                std::time::Instant::now() - std::time::Duration::from_secs(60),
            ),
        }
    }
}
fn parse<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| Error::bad("invalid_application_input"))
}
fn cursor(value: &Value) -> Result<Option<Uuid>> {
    parse(value["cursor"].clone())
}
impl Backend for Facade {
    fn execute(&self, command: Command) -> AppFuture<'_, Value> {
        Box::pin(async move { self.dispatch(command).await.map_err(Into::into) })
    }
    fn resource(&self, command: Command) -> AppFuture<'_, Resource> {
        Box::pin(async move { self.download(command).await.map_err(Into::into) })
    }
    fn authenticate(&self, token: String) -> AppFuture<'_, Principal> {
        Box::pin(async move { self.services.db.principal(&token).await.map_err(Into::into) })
    }
    fn upload_permit(&self) -> AppFuture<'_, Box<dyn Send>> {
        Box::pin(async move {
            self.services
                .vision
                .acquire()
                .await
                .map(|v| Box::new(v) as Box<dyn Send>)
                .map_err(Into::into)
        })
    }
    fn readiness(&self) -> AppFuture<'_, Value> {
        Box::pin(async move {
            if let Ok(mut checked) = self.checked.try_lock()
                && checked.elapsed() >= std::time::Duration::from_secs(5)
            {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    sqlx::query("SELECT 1").execute(&self.services.db.pool),
                )
                .await;
                self.ready
                    .store(matches!(result, Ok(Ok(_))), Ordering::Relaxed);
                *checked = std::time::Instant::now();
            }
            if self.ready.load(Ordering::Relaxed) {
                Ok(json!({"status":"ready"}))
            } else {
                Err(scorebook_core::error::Error::transient(
                    "readiness_unavailable",
                ))
            }
        })
    }
}
impl Facade {
    async fn dispatch(&self, command: Command) -> Result<Value> {
        let s = &self.services;
        let Command {
            owner,
            action,
            subject,
            key,
            payload,
            bytes,
            principal,
        } = command;
        let id = || subject.ok_or_else(|| Error::bad("subject_required"));
        let key = || {
            key.as_deref()
                .ok_or_else(|| Error::bad("idempotency_key_required"))
        };
        match action {
            Action::SessionCreate => {
                app::sessions::create(
                    s,
                    principal.ok_or_else(Error::unauthorized)?,
                    parse(payload)?,
                )
                .await
            }
            Action::SessionRevoke => {
                app::sessions::revoke(s, principal.ok_or_else(Error::unauthorized)?, id()?).await
            }
            Action::CallCreate => app::calls::create(s, owner, key()?, parse(payload)?).await,
            Action::CallList => app::calls::list(s, owner, parse(payload)?).await,
            Action::CallHistory => app::calls::history(s, owner, id()?, parse(payload)?).await,
            Action::CallGet => app::calls::get(s, owner, id()?).await,
            Action::CallVoid => app::calls::void(s, owner, id()?, key()?, parse(payload)?).await,
            Action::CallRevision => {
                let mut input: app::dto::CreateCall = parse(payload)?;
                let id = id()?;
                if input.related_call.is_some_and(|v| v != id) {
                    return Err(Error::bad("conflicting_related_call"));
                }
                input.related_call = Some(id);
                app::calls::create(s, owner, key()?, input).await
            }
            Action::AttachmentUpload => {
                app::calls::upload(
                    s,
                    owner,
                    key()?,
                    bytes.ok_or_else(|| Error::bad("file_required"))?,
                    payload["kind"]
                        .as_str()
                        .ok_or_else(|| Error::bad("kind_required"))?
                        .into(),
                    parse(payload["captured_at"].clone())?,
                )
                .await
            }
            Action::AttachmentIndex => {
                app::attachments::index(
                    s,
                    owner,
                    id()?,
                    key()?,
                    payload["model_id"]
                        .as_str()
                        .ok_or_else(|| Error::bad("model_required"))?,
                )
                .await
            }
            Action::AttachmentLink => {
                app::record_changes::supplement(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::Correction => {
                app::record_changes::correction(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::ReviewCreate => app::knowledge::review(s, owner, key()?, parse(payload)?).await,
            Action::ReviewQueue => app::review_workflow::queue(s, owner, parse(payload)?).await,
            Action::TagList => {
                app::knowledge::collection(s, owner, "tags", cursor(&payload)?).await
            }
            Action::TagCreate => app::knowledge::tag(s, owner, key()?, parse(payload)?).await,
            Action::TagLink => app::knowledge::tag_link(s, owner, key()?, parse(payload)?).await,
            Action::PlaybookList => {
                app::knowledge::collection(s, owner, "playbooks", cursor(&payload)?).await
            }
            Action::PlaybookCreate => {
                app::knowledge::playbook(s, owner, key()?, parse(payload)?).await
            }
            Action::EpisodeList => {
                app::knowledge::collection(s, owner, "episodes", cursor(&payload)?).await
            }
            Action::EpisodeGet => app::knowledge::episode(s, owner, id()?).await,
            Action::EpisodeLink => app::knowledge::link(s, owner, key()?, parse(payload)?).await,
            Action::Events => {
                app::knowledge::events(s, owner, payload["after"].as_i64().unwrap_or(0)).await
            }
            Action::SimilaritySearch => {
                app::similarity::search(s, owner, key()?, parse(payload)?).await
            }
            Action::SimilarityFeedback => {
                app::similarity::feedback(s, owner, key()?, parse(payload)?).await
            }
            Action::SearchSave => app::search_sessions::save(s, owner, id()?, key()?).await,
            Action::SearchGet => app::search_sessions::get(s, owner, id()?).await,
            Action::MarketData => app::market::data(s, &parse(payload)?).await,
            Action::MarketChart => Ok(json!({"svg":app::market::svg(s,&parse(payload)?).await?})),
            Action::HistoryCoverage => app::history::coverage(s, parse(payload)?).await,
            Action::HistoryIndex => app::history::request(s, owner, key()?, parse(payload)?).await,
            Action::HistorySearch => app::history::search(s, owner, key()?, parse(payload)?).await,
            Action::HistoryIndexes => app::history::indexes(s, owner, cursor(&payload)?).await,
            Action::HistoryPlanCreate => {
                app::history_plans::create(s, owner, key()?, parse(payload)?).await
            }
            Action::HistoryPlanGet => app::history_plans::get(s, owner, id()?).await,
            Action::HistoryPlanControl => {
                app::history_plans::control(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::JobGet => app::jobs::get(s, owner, id()?).await,
            Action::JobRetry => app::jobs::retry(s, owner, id()?, key()?, parse(payload)?).await,
            Action::ExportCreate => app::exports::request(s, owner, key()?).await,
            Action::Replay => {
                app::evaluation::replay(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::OutcomeRevision => {
                app::settlement::request_revision(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::SetCreate => app::sets::resolve(s, owner, key()?, parse(payload)?).await,
            Action::SetGet => app::sets::get(s, owner, id()?).await,
            Action::DeletePreview => {
                app::lifecycle::preview(s, owner, key()?, parse(payload)?).await
            }
            Action::DeleteConfirm => {
                app::lifecycle::confirm(s, owner, key()?, parse(payload)?).await
            }
            Action::ToolCall => app::model_access::call(s, owner, parse(payload)?).await,
            Action::DraftGet => app::review_workflow::draft(s, owner, id()?).await,
            Action::DraftSave => {
                app::review_workflow::save(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::DraftDiscard => {
                app::review_workflow::discard(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::DraftPublish => {
                app::review_workflow::publish(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::ReviewSnooze => {
                app::review_workflow::snooze(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::Instruments => app::instruments::list(s, parse(payload)?).await,
            Action::Capabilities => Ok(
                json!({"records":"available","reviews":"draft_resume_and_immutable_publish","market_binance":"contracts_only","default_market":"usd_m","image_structure_search":"available_unvalidated","image_visual_search":if s.vision.url.is_some(){"configured"}else{"not_configured"},"vector_database":"pgvector","retrieval":"hnsw_iterative_v2","historical_search":"published_coverage_only","history_plans":"available","model_knowledge_tools":"scoped_ephemeral_compute","chat_generation":"planned","exchange_accounts":"planned","formal_statistics":"exploratory_only","conditional_monitor":"not_implemented","exports":"chunked_v2"}),
            ),
            Action::AttachmentDownload | Action::ExportDownload => {
                Err(Error::bad("resource_operation_required"))
            }
        }
    }
    async fn download(&self, command: Command) -> Result<Resource> {
        let id = command
            .subject
            .ok_or_else(|| Error::bad("subject_required"))?;
        let s = &self.services;
        let (path, mime, attachment) = match command.action {
            Action::AttachmentDownload => {
                let mime: String =
                    sqlx::query_scalar("SELECT mime FROM attachments WHERE owner_id=$1 AND id=$2")
                        .bind(command.owner)
                        .bind(id)
                        .fetch_optional(&s.db.pool)
                        .await?
                        .ok_or_else(Error::not_found)?;
                return Ok(Resource {
                    reader: s.images.open(command.owner, id).await?,
                    content_type: mime,
                    attachment: false,
                });
            }
            Action::ExportDownload => (
                app::exports::download_path(
                    s,
                    command.owner,
                    id,
                    command.payload["name"]
                        .as_str()
                        .ok_or_else(|| Error::bad("file_name_required"))?,
                )
                .await?,
                "application/octet-stream".into(),
                true,
            ),
            _ => return Err(Error::bad("invalid_resource_operation")),
        };
        Ok(Resource {
            reader: Box::pin(tokio::fs::File::open(path).await?),
            content_type: mime,
            attachment,
        })
    }
}

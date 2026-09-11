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
        // PUT/DELETE honour an Idempotency-Key when one is sent, without demanding it.
        let optional_key = key.clone();
        let key = || {
            key.as_deref()
                .ok_or_else(|| Error::bad("idempotency_key_required"))
        };
        match action {
            Action::TradeCycleDetail => {
                app::trades::cycle_detail::get(s, owner, id()?, parse(payload)?).await
            }
            Action::AccountLedger => {
                app::trades::cycle_detail::ledger(s, owner, parse(payload)?).await
            }
            Action::HistoryRevalidate => app::history::revalidate(s, owner, id()?, key()?).await,
            Action::AssessmentSourcePlan => {
                app::assessment_monitor::control::select(s, owner, id()?, key()?, parse(payload)?)
                    .await
            }
            Action::KnowledgeSourceSlice => {
                app::knowledge_index::source_slice(s, owner, parse(payload)?).await
            }
            Action::ImageReindex => app::chart_search::reindex::request(s, owner, key()?).await,
            Action::ImageIndexStatus => app::chart_search::reindex::status(s, owner).await,
            Action::ExchangeExportMapping => {
                app::trades::historical_export::mapping(s, owner, id()?, key()?, parse(payload)?)
                    .await
            }
            Action::ExchangeExportCreate => {
                app::trades::historical_export::create(s, owner, key()?, parse(payload)?).await
            }
            Action::ExchangeExportGet => app::trades::historical_export::get(s, owner, id()?).await,
            Action::ExchangeExportResolve => {
                app::trades::historical_export::resolve(s, owner, id()?, key()?, parse(payload)?)
                    .await
            }
            Action::ConnectionControl => {
                app::trades::control(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::BackupConfigure => {
                app::backups::create(s, owner, key()?, parse(payload)?).await
            }
            Action::BackupInitialize => {
                app::backups::initialize(s, owner, id()?, parse(payload)?).await
            }
            Action::BackupRequest => app::backups::request(s, owner, id()?, key()?).await,
            Action::BackupStatus => app::backups::status(s, owner).await,
            Action::ChatCreate => {
                app::chat::create(
                    s,
                    principal.ok_or_else(Error::unauthorized)?,
                    key()?,
                    parse(payload)?,
                )
                .await
            }
            Action::ChatGet => app::chat::get(s, owner, id()?).await,
            Action::ChatEvents => app::chat::events(s, owner, id()?, parse(payload)?).await,
            Action::ChatCancel => app::chat::cancel(s, owner, id()?, key()?, parse(payload)?).await,

            Action::KnowledgeSemanticSearch => {
                app::knowledge_index::search(s, owner, parse(payload)?).await
            }
            Action::KnowledgeSource => {
                app::knowledge_index::source(s, owner, parse(payload)?).await
            }
            Action::KnowledgeIndexStatus => app::knowledge_index::status(s, owner).await,
            Action::KnowledgeIndexRequest => app::knowledge_index::request(s, owner, key()?).await,

            Action::PlaybookTransition => {
                app::knowledge_workflow::transition(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::EpisodeReview => {
                app::knowledge_workflow::review_episode(s, owner, id()?, key()?, parse(payload)?)
                    .await
            }
            Action::EpisodeReviewContext => {
                app::knowledge_workflow::episode_context(s, owner, id()?).await
            }
            Action::TagRevision => {
                app::knowledge_workflow::revise_tag(s, owner, id()?, key()?, parse(payload)?).await
            }

            Action::StatisticsCreate => {
                app::statistics::create(s, owner, key()?, parse(payload)?).await
            }
            Action::StatisticsGet => app::statistics::get(s, owner, id()?).await,
            Action::StatisticsGroups => {
                app::statistics::groups(s, owner, id()?, parse(payload)?).await
            }
            Action::StatisticsMembers => {
                app::statistics::members(s, owner, id()?, parse(payload)?).await
            }
            Action::BaselineCreate => {
                app::statistics::baseline::create(s, owner, key()?, parse(payload)?).await
            }
            Action::BaselineGet => app::statistics::baseline::get(s, owner, id()?).await,
            Action::BaselineSamples => {
                app::statistics::baseline::samples(s, owner, id()?, parse(payload)?).await
            }
            Action::VerdictRequests => {
                app::statistics::verdicts::list(s, owner, parse(payload)?).await
            }
            Action::VerdictDecide => {
                app::statistics::verdicts::decide(s, owner, key()?, parse(payload)?).await
            }

            Action::ExchangeConnect => {
                app::trades::connection(s, owner, key()?, parse(payload)?).await
            }
            Action::ExchangeConnections => {
                app::trades::connections(s, owner, parse(payload)?).await
            }
            Action::TradeImport => {
                app::trades::import::import(s, owner, key()?, parse(payload)?).await
            }
            Action::TradeCsvImport => {
                app::trades::import::csv(s, owner, key()?, parse(payload)?).await
            }
            Action::TradeImports => app::trades::imports(s, owner, None, parse(payload)?).await,
            Action::TradeImportGet => {
                app::trades::imports(s, owner, Some(id()?), Default::default()).await
            }
            Action::TradeFills => app::trades::fills(s, owner, parse(payload)?).await,
            Action::TradeSeed => app::trades::seed(s, owner, key()?, parse(payload)?).await,
            Action::TradeCycles => app::trades::projection::list(s, owner, parse(payload)?).await,
            Action::TradeReconcile => {
                app::trades::reconciliation::reconcile(s, owner, key()?, parse(payload)?).await
            }
            Action::ExecutionLink => app::trades::link(s, owner, key()?, parse(payload)?).await,
            Action::ExchangeSync => {
                app::trades::sync::create(s, owner, key()?, parse(payload)?).await
            }
            Action::ExchangeSyncGet => app::trades::sync::get(s, owner, id()?).await,

            Action::HistoryCatalog => app::history_catalog::catalog(s, parse(payload)?).await,
            Action::HistoryCatalogRefresh => {
                app::history_catalog::request_refresh(s, owner, key()?).await
            }
            Action::HistoryEstimate => app::history_catalog::estimate(s, parse(payload)?).await,
            Action::HistorySubscribe => {
                app::history_catalog::subscriptions::create(s, owner, key()?, parse(payload)?).await
            }
            Action::HistorySubscriptionGet => {
                app::history_catalog::subscriptions::get(s, owner, id()?).await
            }
            Action::HistorySubscriptionBudget => {
                app::history_catalog::subscriptions::budget(
                    s,
                    owner,
                    id()?,
                    key()?,
                    parse(payload)?,
                )
                .await
            }
            Action::HistorySubscriptionControl => {
                app::history_catalog::subscriptions::control(
                    s,
                    owner,
                    id()?,
                    key()?,
                    parse(payload)?,
                )
                .await
            }
            Action::ArchiveCatalog => {
                app::history_catalog::archives::discover(s, parse(payload)?).await
            }

            Action::ChartAnalyze => {
                app::chart_search::analyze(s, owner, key()?, parse(payload)?).await
            }
            Action::ChartSearchCreate => {
                app::chart_search::create(s, owner, key()?, parse(payload)?).await
            }
            Action::ChartSearchGet => app::chart_search::get(s, owner, id()?).await,
            Action::ChartSearchCancel => {
                app::chart_search::cancel(s, owner, id()?, key()?, parse(payload)?).await
            }
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
            Action::CallScenePut => {
                app::record_changes::set_scene(
                    s,
                    owner,
                    id()?,
                    optional_key.as_deref(),
                    parse(payload)?,
                )
                .await
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
            Action::AttachmentLocationPut => {
                app::replay::put_location(s, owner, id()?, optional_key.as_deref(), parse(payload)?)
                    .await
            }
            Action::AttachmentLocationDelete => {
                app::replay::delete_location(s, owner, id()?, optional_key.as_deref()).await
            }
            Action::AttachmentLocateGet => app::locate::get(s, owner, id()?).await,
            Action::AttachmentLocateRequest => {
                app::locate::request(s, owner, id()?, key()?, parse(payload)?).await
            }
            Action::AttachmentKindPut => {
                app::attachments::set_kind(
                    s,
                    owner,
                    id()?,
                    optional_key.as_deref(),
                    parse(payload)?,
                )
                .await
            }
            Action::ChartSetupPut => {
                app::replay::put_chart_setup(
                    s,
                    owner,
                    id()?,
                    optional_key.as_deref(),
                    parse(payload)?,
                )
                .await
            }
            Action::ReplayGet => app::replay::get(s, owner, id()?, parse(payload)?).await,
            Action::ReplayClear => app::replay::clear(s, owner, id()?).await,
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
            Action::Capabilities => app::capabilities::get(s, owner).await,
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

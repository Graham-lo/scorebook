// Shapes here mirror what the Rust backend actually returns, read from
// src/application/*.rs and confirmed against live responses. OpenAPI schema
// names are not trusted where the handler returns a free-form JSON value.

export type Uuid = string
/** RFC 3339 in UTC. Rendered in the local zone, never re-computed. */
export type Instant = string
/** Prices, ratios and returns stay decimal strings end to end. */
export type Decimal = string

export type Market = 'usd_m' | 'coin_m'
export type Stance = 'unknown' | 'L' | 'S' | '?' | 'C'
export type Path = 'unknown' | 'chart_first' | 'thought_first' | 'interwoven'
export type Template = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5'
export type AttachmentKind = 'scene' | 'supplement' | 'reference' | 'query'

export type OutcomeState =
  | 'realized'
  | 'unrealized'
  | 'not_triggered'
  | 'pending'
  | 'no_criteria'
  | 'insufficient_data'

export interface Trigger {
  kind: string
  comparator: string
  price: Decimal
  window_hours: number
  interval_seconds?: number | null
}

export interface Criteria {
  template: Template
  version: string
  selected_by?: string | null
  direction?: string | null
  horizon_hours?: number | null
  threshold_ratio?: Decimal | null
  atr_multiple?: Decimal | null
  invalidation?: Decimal | null
  boundary?: Decimal | null
  boundary_kind?: string | null
  trigger?: Trigger | null
}

/** The immutable request body stored with every call. */
export interface CallBody {
  original_text: string
  instrument?: string | null
  market?: Market | null
  timeframe?: string | null
  path: Path
  stance: Stance
  confidence?: number | null
  criteria: Criteria[]
  attachments: Uuid[]
  tags: Uuid[]
  related_call?: Uuid | null
  playbook_id?: Uuid | null
  original_claimed_at?: Instant | null
  source_entry: string
}

export interface CallListItem {
  id: Uuid
  submitted_at: Instant
  body: CallBody
  revision: number
  voided: boolean
}

export interface CallList {
  items: CallListItem[]
  next_cursor: string | null
  sort: string
  search_policy: string
}

/**
 * 一张截图被钉到公开行情上的那一段。确认过一次就长期保存：以后重温直接读它，
 * 不再按图找。它和临时的回放缓存不是一回事——那份会过期，这份不会。
 */
export interface AttachmentLocation {
  symbol: string
  market: Market
  interval: string
  start_at: Instant
  end_at: Instant
  bars_count?: number | null
  source: 'rest' | 'monthly_archive'
  score?: Decimal | number | null
  search_run_id?: Uuid | null
  confirmed_at?: Instant
  /** 人自己钉的，还是复盘走完之后后台自动匹配上的。 */
  matched_by?: 'user' | 'auto' | string
}

/**
 * 这条记录的图上要画哪几条线、开哪几个副图。后端只校验形状，不算指标——
 * 值全部在浏览器里从这一段 K 线自己算（见 features/relive/indicators.ts）。
 *
 * 这是「算好的」那一份：每个字段都在。从后端拿回来的那一份是 `ChartSetupWire`，
 * 里面什么都可能缺，进界面之前先过一次 `normalizeSetup`。
 */
export interface ChartSetup {
  /** 主图上的简单均线周期。 */
  ma: number[]
  /** 主图上的指数均线周期。ma + ema 一共不超过 8 条。 */
  ema: number[]
  boll: { n: number; k: string } | null
  atr: { n: number } | null
  /** 成交量副图。开着的时候里面是要叠的几条量均线（最多 6 条）。 */
  volume: { ma: number[] } | null
  /** MACD 副图。fast 必须小于 slow。 */
  macd: { fast: number; slow: number; signal: number } | null
  rsi: { n: number } | null
}

/**
 * 后端回来的样子。新字段还没部署时整片缺失，早先存下来的记录里也只有前四项，
 * 所以这里每一个都是可缺的——缺了就是「这一项没开」，不是错误。
 */
export type ChartSetupWire = Partial<ChartSetup>

/**
 * Rows come back as `to_jsonb(attachments) - owner_id`, so every column of the
 * table is present. `capture_time_proven` is extra on the upload response only:
 * the backend always sends it as false, meaning a claimed capture time is the
 * uploader's word, not evidence.
 */
export interface Attachment {
  id: Uuid
  sha256: string
  mime: string
  size: number
  width: number
  height: number
  uploaded_at: Instant
  captured_at: Instant | null
  kind: AttachmentKind
  capture_time_proven?: boolean
  /** 这张图钉在公开行情的哪一段。没钉过就是 null。 */
  location?: AttachmentLocation | null
}

/**
 * The audit trail. Traders never see these rows; only a few kinds are
 * translated into plain-language timeline entries.
 */
export interface CallEvent {
  sequence: number
  id: Uuid
  call_id: Uuid | null
  kind: string
  body: Record<string, unknown>
  created_at: Instant
}

/** The four relations to the previous review the backend accepts. */
export type ReviewAction = 'did' | 'did_not' | 'new' | 'keep'

export interface ManualReviewTrade {
  source: 'manual'
  symbol: string
  direction: 'long' | 'short' | null
  opened_at: Instant | null
  closed_at: Instant | null
  quantity: string | null
  quantity_unit: string | null
  leverage: string | null
  entry_price: string | null
  exit_price: string | null
  realized_pnl: string | null
  settlement_asset: string | null
  fees: string | null
  margin_mode: 'cross' | 'isolated' | null
  note: string | null
}
export interface ExchangeReviewTrade {
  source: 'exchange'
  connection_id: Uuid
  cycle_id: Uuid
  leverage: string | null
  note: string | null
}
export type ReviewTrade = ManualReviewTrade | ExchangeReviewTrade
export interface ReviewTradeSnapshot {
  source: 'manual' | 'exchange_ledger'
  trade?: ManualReviewTrade
  cycle_id?: Uuid
  cycle?: Cycle
  account_name?: string
  market?: Market
  leverage?: string | null
  totals?: { opened_quantity: string | null; closed_quantity: string | null; exit_price: string | null }
}

export interface ReviewBody {
  trades?: ReviewTrade[]
  trade_snapshots?: ReviewTradeSnapshot[]
  attachment_ids?: Uuid[]
  note: string
  better_play: string | null
  vs_last: string
}

export interface ReviewRecord {
  id: Uuid
  call_id: Uuid
  body: ReviewBody
  created_at: Instant
  /** The evaluation versions the trader had in front of them when publishing. */
  outcome_ids?: Uuid[]
}

/**
 * domain::criteria::Evaluation. Everything numeric stays a decimal string;
 * `signed_return`, `mfe` and `mae` are ratios, not percentages.
 */
export interface Evaluation {
  state: OutcomeState
  reason: string
  signed_return: Decimal | null
  mfe: Decimal | null
  mae: Decimal | null
  trigger_at: Instant | null
  trigger_price: Decimal | null
  end_at: Instant | null
  invalidation_hit: boolean | null
  first_threshold_interval: [Instant, Instant] | null
}

/**
 * One evaluated claim. The evaluation is nested under `result`, not flattened
 * onto the row. `kind` separates the frozen first answer from later re-runs:
 * an `original` row is never replaced.
 */
export interface Outcome {
  id: Uuid
  call_id: Uuid
  claim_no: number
  manifest_id: Uuid
  kind: 'original' | 'data_revision' | 'rule_replay'
  supersedes: Uuid | null
  result: Evaluation
  digest: string
  created_at: Instant
}

export interface EpisodeLinkRecord {
  id: Uuid
  episode_id: Uuid
  call_id: Uuid
  status: 'suggested' | 'confirmed' | 'explicit' | 'rejected'
  created_at: Instant
}

export interface TagRecord {
  id: Uuid
  name: string
  definition: string
  aliases: string[]
  version: number
  created_at: Instant
}

/** A call marked as executed against a playbook. */
export interface AdoptionRecord {
  call_id: Uuid
  playbook_id: Uuid
  executed: 'yes' | 'no' | 'unknown'
  evidence: Record<string, unknown> | null
}

/** GET /v1/calls/{id}: the call row plus every related collection. */
export interface CallDetail {
  id: Uuid
  submitted_at: Instant
  body: CallBody
  original_text: string
  instrument: string | null
  market: Market | null
  timeframe: string | null
  digest: string
  revision: number
  voided: boolean
  attachments: Attachment[]
  events: CallEvent[]
  reviews: ReviewRecord[]
  outcomes: Outcome[]
  /** The head of each claim. Never take the last element of `outcomes`. */
  current_outcomes: Outcome[]
  /** Only the newest 20 of each kind are inlined; older pages need a cursor. */
  history_pages: Record<HistoryKind, { next_cursor: string | null }>
  episode_links: EpisodeLinkRecord[]
  tags: TagRecord[]
  adoptions: AdoptionRecord[]
  /** 这条记录的图上画哪几条线。没设过就是 null，设过也可能只有其中几项。 */
  chart_setup?: ChartSetupWire | null
}

export interface CreatedCall {
  id: Uuid
  display_id: string
  submitted_at: Instant
  revision: number
  criteria_status: { claim_no: number; state: OutcomeState; reason?: string }[]
  evidence_identity: 'submitted_now' | 'historical_unverified'
}

export interface CallPreview {
  original_text: string
  path: Path
  stance: Stance
  criteria: Criteria
  issues: string[]
}

export interface Region {
  x: number
  y: number
  width: number
  height: number
}

export interface ChartRequest {
  /** A visual divider only; subsequent candles never affect the search score. */
  match_end_at?: Instant
  symbol: string
  market: Market
  interval: string
  start_at: Instant
  end_at: Instant
  /**
   * 这一段行情该从哪里取：`rest` 是交易所接口，`monthly_archive` 是月度归档。
   * 后端在候选里给什么就原样带回去——退市或早年的段落只有归档里有，前端把它
   * 改成 REST 会得到一个空结果或者另一段行情。
   */
  source?: 'rest' | 'monthly_archive'
}

export interface HistoryCoverage {
  index_id?: Uuid
  /** v4 的已发布覆盖按代次编号，不按索引编号。 */
  generation_id?: Uuid
  symbol: string
  market: Market
  interval: string
  requested_start: Instant
  requested_end: Instant
  actual_start: Instant | null
  actual_end: Instant | null
  source_bars_fetched: number
  source_range_complete: boolean
  feature_rows: number
  windows_skipped_for_gaps: number
  window_bars: number
  stride_bars: number
  models: string[]
  /** 原始 K 线有没有被留下来。后端一直是 `none`。 */
  raw_market_storage?: string
  /** 系统画出来的行情图有没有被留下来。后端一直是 `none`。 */
  system_chart_storage?: string
}

export interface HistoryIndexRecord {
  id: Uuid
  body: {
    symbol: string
    market: Market
    interval: string
    start_at: Instant
    end_at: Instant
    window_bars: number
    stride_bars: number
    models: string[]
  }
  status: 'queued' | 'ready'
  created_at: Instant
  completed_at: Instant | null
  coverage: HistoryCoverage | null
}

export interface Bar {
  start: Instant
  end: Instant
  open: Decimal
  high: Decimal
  low: Decimal
  close: Decimal
  /**
   * 这一根的成交量。老版本后端不带这个字段，直连交易所取回来的一定带。
   * 缺失和 null 都当作「这一段没有成交量」，不要拿 0 顶上——0 是一根没有人
   * 成交的 K 线，和「没这个数」不是一回事。
   */
  volume?: Decimal | null
}

export interface MarketData {
  bars: Bar[]
  coverage_complete: boolean
  [k: string]: unknown
}

export interface Instrument {
  venue: string
  market: Market
  symbol: string
  refreshed_at: Instant
  body: {
    baseAsset: string
    quoteAsset: string
    contractType: string
    underlyingType?: string
    underlyingSubType?: string[]
    pricePrecision: number
    [k: string]: unknown
  }
}

/** unreviewed_v1: every call with no review row, oldest first, capped at 100. */
/** The four lists the review queue is split into. */
export type ReviewBucket = 'needs_review' | 'in_progress' | 'completed' | 'snoozed'

/** Why this record is in the queue. Never shown as the identifier itself. */
export type ReviewReason = 'first_review' | 'continue_draft' | 'new_outcome' | 'reviewed'

/**
 * 队列行里那一条 assessment 报的是「这次判分跑到哪一步了」，不是判分结果。它
 * 和 OutcomeState 是两套词：结果的对错要去结果版本里读，这里只说算没算完。
 * 后端的取值见 application/jobs.rs 的 finish 分支。
 */
export type AssessmentState =
  | 'queued'
  | 'running'
  | 'waiting_due'
  | 'awaiting_input'
  | 'completed'
  | 'needs_attention'

export interface QueueItem {
  id: Uuid
  submitted_at: Instant
  original_text: string
  instrument: string | null
  timeframe: string | null
  revision: number
  /** Null until this record has ever had a draft saved against it. */
  draft_revision: number | null
  draft_saved_at: Instant | null
  snoozed_until: Instant | null
  /** Version of the reminder preference; null means no preference row yet. */
  preference_revision: number | null
  latest_review_id: Uuid | null
  reviewed_at: Instant | null
  bucket: ReviewBucket
  reason: ReviewReason
  assessments: { claim_no: number; state: AssessmentState; due_at: Instant | null }[]
}

export interface ReviewQueue {
  items: QueueItem[]
  next_cursor: string | null
  bucket: ReviewBucket | 'all'
  order: string
  refresh_on_status_change: boolean
}

/** The stored draft row. `body` is what the trader typed. */
export interface ReviewDraftBody {
  trades?: ReviewTrade[]
  trade_snapshots?: ReviewTradeSnapshot[]
  attachment_ids?: Uuid[]
  note: string
  better_play: string | null
  vs_last: ReviewAction | null
}

export interface ReviewDraftRow {
  call_id: Uuid
  revision: number
  updated_at: Instant
  body: ReviewDraftBody
}

/**
 * GET /v1/calls/{id}/review-draft. `draft_revision` keeps counting up across
 * publish and discard, so it is never restarted from zero by the UI; `draft`
 * is null when nothing has been typed yet.
 */
export interface ReviewDraftState {
  call_revision: number
  current_outcome_ids: Uuid[]
  draft_revision: number
  draft: ReviewDraftRow | null
}

/** POST .../review-draft — the receipt, without the text that was sent. */
export interface DraftSaved {
  call_id: Uuid
  revision: number
  updated_at: Instant
}

export interface ReviewPublished {
  id: Uuid
  revision: number
  saved_at: Instant
  draft_revision: number
}

export interface DraftDiscarded {
  call_id: Uuid
  draft: null
  draft_revision: number
}

export interface ReminderSaved {
  call_id: Uuid
  snoozed_until: Instant | null
  revision: number
  updated_at: Instant
}

/** One page of a record's own history, newest first. */
export interface HistoryPage<T> {
  items: T[]
  next_cursor: string | null
  kind: HistoryKind
  order: string
}

export type HistoryKind = 'reviews' | 'outcomes' | 'events'

/** A fixed window on one instrument that several calls can hang off. */
export interface Episode {
  id: Uuid
  instrument: string
  market: Market
  anchor_at: Instant
  end_at: Instant
}

/** GET /v1/episodes/{id} returns the episode and its links side by side. */
export interface EpisodeDetail {
  episode: Episode
  links: EpisodeLinkRecord[]
}

export interface PlaybookBody {
  parent_id: Uuid | null
  name: string
  applies_to: string
  excludes: string
  old_play: string
  change: string
  evidence_call_ids: Uuid[]
  expected_improvement: string
  cost: string
}

/**
 * Every playbook is written with a single `candidate` status row and there is
 * no route that moves it on, so the UI must not offer adoption or withdrawal.
 */
export interface PlaybookRecord {
  id: Uuid
  parent_id: Uuid | null
  created_at: Instant
  body: PlaybookBody
}

/**
 * Where a piece of background work stands. Six of these mean it is over:
 * `succeeded`, `failed` and `cancelled` for good, and `needs_attention`,
 * `blocked_capability` and `awaiting_input` until a person does something.
 * `retry_wait` is the backend waiting out its own backoff — still working.
 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'needs_attention'
  | 'blocked_capability'
  | 'awaiting_input'
  | 'cancelled'

export interface JobRecord {
  id: Uuid
  kind: string
  status: JobStatus
  attempt: number
  /** Bumped by every retry, pause and resume; a retry must state the one it saw. */
  generation: number
  result: unknown
  error_code: string | null
  created_at: Instant
  run_after: Instant
}

/** POST /v1/jobs/{id}/retry */
export interface JobRetried {
  job_id: Uuid
  status: JobStatus
  generation: number
}

/** GET /v1/history/plans/{id} — a long range prepared chunk by chunk. */
export interface HistoryPlan {
  id: Uuid
  body: {
    symbols: string[]
    market: Market
    intervals: string[]
    start_at: Instant
    end_at: Instant
    window_bars: number
    stride_bars: number
    models: string[]
  }
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'needs_attention'
  revision: number
  symbol_no: number
  interval_no: number
  next_start: Instant
  child_job: Uuid | null
  completed_chunks: number
  created_at: Instant
  updated_at: Instant
}

export interface HistoryPlanStarted {
  plan_id: Uuid
  job_id: Uuid
  status: string
  revision: number
}

/**
 * `GET /v1/capabilities` in v4 no longer answers with a flat map of words. A
 * value is either a sentence naming the shape of what was built, or an object
 * that separates *implemented* from *configured on this machine*. Neither of
 * them says the capability passed acceptance against real data — the backend
 * says so itself in `configuration_status_is_not_live_acceptance`, and
 * `image_structure_search.real_image_quality_validated` is the one place a
 * quality verdict is reported at all.
 */
export interface Capabilities {
  backend_version: string
  records: string
  reviews: string
  market_binance: string
  market_sources: string[]
  raw_market_storage: string
  vector_database: string
  image_structure_search: { model: string; available: boolean; real_image_quality_validated: boolean }
  image_visual_search: { model: string; configured: boolean }
  screenshot_ocr: { configured: boolean; unknown_parameters: string }
  historical_search: string
  history_plans: string
  conditional_monitor: { available: boolean; source_plans: string[]; source_change: string }
  formal_statistics: string
  baseline: string
  trade_ledger: string
  exchange_accounts: { adapter: string; configured: boolean }
  knowledge_index: { model: string; configured: boolean }
  chat_generation: { runtime: string; model_id: string; configured: boolean }
  encrypted_backup: {
    engine_configured: boolean
    repository_configured: boolean
    restore_policy: string
  }
  configuration_status_is_not_live_acceptance: boolean
  [k: string]: unknown
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

// ——— 实盘账本（v4）———
//
// 这里的数字全是后端算好的十进制字符串。前端只排版，不重算：账本的口径由后端
// 定，界面上再算一遍只会得到第二个答案。

export type TradeSide = 'BUY' | 'SELL'
export type PositionSide = 'BOTH' | 'LONG' | 'SHORT'

export interface ExchangeConnection {
  id: Uuid
  venue: string
  market: Market
  name: string
  account_label: string
  ledger_revision: number
  configuration_revision: number
  disabled_at?: Instant | null
  created_at: Instant
  [k: string]: unknown
}

export interface CreatedConnection {
  connection_id: Uuid
  status: string
  /** `referenced_not_yet_verified` 表示只登记了引用，还没有验过。 */
  api_credentials: string
  read_only_adapter: boolean
}

export interface ConnectionControlled {
  connection_id: Uuid
  revision: number
  status: string
  resume_policy: string
  ledger_retained: boolean
}

/** 一笔成交，交易所怎么写就怎么存。 */
export interface Fill {
  trade_id: string
  order_id?: string | null
  symbol: string
  side: TradeSide
  position_side: PositionSide
  price: Decimal
  quantity: Decimal
  realized_pnl?: Decimal | null
  settlement_asset: string
  commission: Decimal
  commission_asset: string
  traded_at: Instant
  liquidation?: boolean | null
}

export interface FillRow {
  id: Uuid
  connection_id: Uuid
  import_id: Uuid
  fill: Fill
  execution_venue: string
}

export interface FillPage {
  items: FillRow[]
  next_cursor?: string | null
  /** 后端自报：这些价格是真实成交价，不是行情图上的价。 */
  price_provenance: string
}

export interface LedgerEntry {
  transaction_id: string
  kind: string
  symbol?: string | null
  asset: string
  amount: Decimal
  occurred_at: Instant
  trade_id?: string | null
}

export interface LedgerRow {
  id: Uuid
  connection_id: Uuid
  import_id: Uuid
  entry: LedgerEntry
}

export interface LedgerPage {
  items: LedgerRow[]
  next_cursor?: string | null
  /** `original_asset_decimal_no_fx`：按原币种记，不折算。 */
  amount_policy: string
}

/** 一轮持仓：从建仓到清零。`opening_unknown` 表示期初不明，不能当成零。 */
export type CycleStatus = 'open' | 'closed' | 'opening_unknown'

export interface Cycle {
  ordinal: number
  symbol: string
  position_side: PositionSide
  direction: 'long' | 'short'
  status: CycleStatus
  opened_at?: Instant | null
  closed_at?: Instant | null
  entry_price?: Decimal | null
  remaining_quantity?: Decimal | null
  computed_realized_pnl?: Decimal | null
  exchange_realized_pnl?: Decimal | null
  settlement_asset: string
  /** 币种 → 手续费金额。多币种手续费不合并。 */
  commissions: Record<string, Decimal>
  fills: number
  opening_evidence: string
}

export interface CycleRow {
  id: Uuid
  connection_id: Uuid
  projection_run_id: Uuid
  cycle: Cycle
  ledger_revision: number
  /** 这一轮是旧账算出来的，之后又导入过东西。 */
  stale: boolean
}

export interface CyclePage {
  items: CycleRow[]
  next_cursor?: string | null
  projection_run_ids: Uuid[]
  time_filter: string
  pagination: string
}

export interface Allocation {
  fill_id: Uuid
  allocation_quantity: Decimal
  allocation_commission: Decimal
  /** `open` / `close` / `opening_unknown`：这笔成交在这一轮里算什么。 */
  portion: string
  actual_fill: Fill
}

export interface CycleDetail {
  cycle: {
    id: Uuid
    cycle: Cycle
    connection_id: Uuid
    projection_run_id: Uuid
    ledger_revision: number
  }
  items: Allocation[]
  next_cursor?: string | null
  allocation_scope: string
  funding: string
}

export interface ImportCoverage {
  start_at: Instant
  end_at: Instant
  symbols: string[]
  declared_complete: boolean
  provenance: string
  entire_account_history_verified: boolean
}

export interface ImportResult {
  import_id: Uuid
  connection_id: Uuid
  status: string
  inserted_fills: number
  duplicate_fills: number
  inserted_entries: number
  ledger_revision: number
  projection_job_id: Uuid
  coverage: ImportCoverage
}

export interface ImportRow {
  id: Uuid
  connection_id: Uuid
  source: string
  dataset?: string | null
  created_at: Instant
  body?: Record<string, unknown>
  [k: string]: unknown
}

export interface SeedResult {
  seed_id: Uuid
  connection_id: Uuid
  ledger_revision: number
  projection_job_id: Uuid
}

export interface ReconciliationDifference {
  metric: 'realized_pnl' | 'commission' | 'funding'
  /** 有成交缺已实现盈亏时为 null——那时候差额是算不出来的，不是零。 */
  actual?: Decimal | null
  actual_known_sum: Decimal
  statement: Decimal
  difference?: Decimal | null
  within_tolerance: boolean
}

export interface ReconciliationAsset {
  asset: string
  items: ReconciliationDifference[]
  fills_missing_realized_pnl: number
  conversion_applied: boolean
}

export interface ReconciliationResult {
  reconciliation_id: Uuid
  ledger_revision: number
  status: 'matched_declared_range' | 'differences' | 'unverified_coverage'
  items: ReconciliationAsset[]
  assets_missing_from_statement: string[]
  funding_policy: string
  declared_range_coverage_complete: boolean
  entire_account_history_verified: boolean
}

export interface ExecutionLinkResult {
  execution_link_id: Uuid
  call_id?: Uuid | null
  episode_id?: Uuid | null
  playbook_id?: Uuid | null
  relation: string
  /** 后端自报：这是事后关联，不是入场前就采纳过。 */
  timing: string
}

export interface SyncStarted {
  sync_run_id: Uuid
  job_id: Uuid
  status: string
  coverage: string
  account_history_complete: boolean
}

export interface ExportStarted {
  export_run_id: Uuid
  job_id: Uuid
  status: string
  quota_scope: string
  account_history_complete: boolean
}

export interface ExportRun {
  id: Uuid
  connection_id: Uuid
  status: string
  job_status: string
  generation: number
  error_code?: string | null
  download_id?: string | null
  imported_rows?: number | null
  body?: Record<string, unknown>
  [k: string]: unknown
}

export interface CsvMapping {
  columns: Record<string, string>
  constants?: Record<string, string>
  timestamp_format: string
}

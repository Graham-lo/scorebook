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

export interface ReviewBody {
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

export interface SimilarityItem {
  attachment_id: Uuid
  call_id: Uuid
  submitted_at: Instant
  original_text: string
  instrument: string | null
  market: Market | null
  timeframe: string | null
  cosine_distance: number
  group_id: string
  source_uri: string
  /** hybrid-v1 only. */
  rank_sources?: string[]
}

export interface SimilarityResult {
  session_id: Uuid
  model_id: string
  cutoff_at: Instant
  items: SimilarityItem[]
  retrieval: string
  grouping: string
  query_quality: unknown
  score_meaning: string
  quality_validated: boolean
}

export interface ChartRequest {
  symbol: string
  market: Market
  interval: string
  start_at: Instant
  end_at: Instant
}

export interface HistoryItem {
  id: Uuid
  index_id: Uuid
  source: string
  source_uri: string
  symbol: string
  market: Market
  interval: string
  start_at: Instant
  end_at: Instant
  bars_count: number
  cosine_distance: number
  source_hash_at_index: string
  chart_request: ChartRequest
  chart_storage: string
}

export interface HistoryCoverage {
  index_id: Uuid
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
}

export interface HistoryResult {
  session_id: Uuid
  items: HistoryItem[]
  model_id: string
  cutoff_at: Instant
  coverage: HistoryCoverage[]
  scope: string
  ranking: string
  score_meaning: string
  quality_validated: boolean
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
  assessments: { claim_no: number; state: OutcomeState; due_at: Instant | null }[]
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

export interface Capabilities {
  records: string
  reviews: string
  image_structure_search: string
  image_visual_search: string
  chat_generation: string
  exchange_accounts: string
  formal_statistics: string
  default_market: Market
  [k: string]: string
}

export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

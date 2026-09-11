// 公开历史这一侧：市场上有什么、哪些已经能搜、这一次准备走到哪儿了。
//
// v4 之后「按图索骥」本身走 chart-search 那条路（见 `chart.ts`）；这个文件管的是
// 它的前提——把一段公开行情按固定长度切开、算好几何特征、发布出去。没有准备过
// 的时间段不会出现在检索结果里，这不是「搜不到」，是「还没有做」。
//
// 三件事不要混成一件：
//
//   目录  `/v1/history/catalog` —— 币安上有过哪些合约，什么时候上的、退没退。
//         目录里有，不等于那段历史能拿到；能不能拿到要问 `/v1/history/archive-catalog`。
//   覆盖  `/v1/history/coverage` —— 哪些代次已经发布，也就是此刻真的能搜到的范围。
//   进度  `/v1/history/indexes`、`/plans`、`/subscriptions` —— 正在准备的走到哪儿了。
//
// 从哪里取行情要说清楚：`rest` 是交易所接口，`monthly_archive` 是官方月度归档。
// 已经退市或者早年的合约只有归档里有——后端会直接拒绝用 REST 去准备它们，而不是
// 悄悄给一段空的。

import { getJson, postJson, type RequestOptions } from './http'
import type {
  HistoryCoverage,
  HistoryIndexRecord,
  Instant,
  Market,
  Page,
  Uuid,
} from './types'

/** v4 的历史索引只有几何这一个向量空间。 */
export const HISTORY_MODELS = ['candle-geometry-v2'] as const
export type HistoryModel = (typeof HISTORY_MODELS)[number]

export function indexes(
  cursor: string | null,
  opts: RequestOptions = {},
): Promise<Page<HistoryIndexRecord>> {
  return getJson<Page<HistoryIndexRecord>>('/v1/history/indexes', {
    ...opts,
    query: { cursor: cursor ?? undefined },
  })
}

/** Walks every coverage page; the list is what "已准备的范围" actually means. */
export async function allIndexes(opts: RequestOptions = {}): Promise<HistoryIndexRecord[]> {
  const all: HistoryIndexRecord[] = []
  let cursor: string | null = null
  for (let page = 0; page < 50; page += 1) {
    const result: Page<HistoryIndexRecord> = await indexes(cursor, opts)
    all.push(...result.items)
    if (!result.next_cursor) break
    cursor = result.next_cursor
  }
  return all
}

export interface IndexRequest {
  /** 不写就是 `rest`。退市或早年的合约必须明写 `monthly_archive`。 */
  source?: HistorySource
  symbol: string
  market: Market
  interval: string
  start_at: string
  end_at: string
  window_bars: number
  stride_bars: number
  models: HistoryModel[]
}

export function requestIndex(
  input: IndexRequest,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ job_id: Uuid; index_id: Uuid; generation_id: Uuid; status: string }> {
  return postJson('/v1/history/indexes', input, { ...opts, idempotencyKey })
}

// ——— 已经发布、现在真的能搜到的那些段 ———

export interface CoverageEntry {
  generation_id: Uuid
  coverage: HistoryCoverage
  published_at: Instant
}

export interface CoverageFilter {
  symbol?: string
  market?: Market
  interval?: string
  model_id?: string
  /** 只看这个时刻之前起点的那些段。 */
  cutoff_at?: Instant
  cursor?: string
}

export interface CoveragePage {
  items: CoverageEntry[]
  next_cursor: string | null
  order: string
  /** `published_derived_market_only`：只包含公开行情算出来的特征，不含原始 K 线。 */
  scope: string
  cutoff_at: Instant | null
}

export function publishedCoverage(
  filter: CoverageFilter = {},
  opts: RequestOptions = {},
): Promise<CoveragePage> {
  return getJson<CoveragePage>('/v1/history/coverage', { ...opts, query: { ...filter } })
}

// ——— 市场上有过哪些合约 ———

/** 一段公开行情从哪里取。 */
export type HistorySource = 'rest' | 'monthly_archive'

/**
 * 目录里的一个合约。`status` 是后端从交易所目录和归档列表里核出来的事实：
 *
 *   `TRADING` 等交易所自己的状态  —— 现在还在交易所目录里。
 *   `archive_only`                —— 只在官方归档里见过，当前目录里没有。
 *   `absent_from_current_catalog` —— 以前见过，最近一次核对时目录里已经没有了。
 *
 * 后两种要准备历史，必须明说走归档。
 */
export interface CatalogEntry {
  market: Market
  symbol: string
  first_seen_at: Instant
  last_seen_at: Instant
  onboard_at: Instant | null
  delivery_at: Instant | null
  status: string
  archive_discovered: boolean
  catalog_version: Uuid
}

export interface CatalogPage {
  items: CatalogEntry[]
  next_cursor: string | null
  /** `catalog_presence_does_not_prove_history_availability` —— 目录里有不代表拿得到。 */
  coverage_policy: string
  availability_endpoint: string
}

export function catalog(
  filter: { market?: Market; symbol?: string; cursor?: string } = {},
  opts: RequestOptions = {},
): Promise<CatalogPage> {
  return getJson<CatalogPage>('/v1/history/catalog', { ...opts, query: { ...filter } })
}

/** 重新核对一次目录。这是一项后台作业，回来的是任务编号。 */
export function refreshCatalog(
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ job_id: Uuid; status: string }> {
  return postJson('/v1/history/catalog/refresh', {}, { ...opts, idempotencyKey })
}

// ——— 某个合约的归档里到底有哪几个月 ———

export interface ArchiveFile {
  source_key: string
  size_bytes: number
}

export interface ArchiveListing {
  items: ArchiveFile[]
  next_cursor: string | null
  /** false 就是这一页没列完，还有下一页。 */
  complete_listing: boolean
  /** `discovered_not_yet_checksum_verified`：只是列到了文件，还没核过校验。 */
  status: string
}

export function archiveCatalog(
  input: { market: Market; symbol: string; interval: string; cursor?: string | null },
  opts: RequestOptions = {},
): Promise<ArchiveListing> {
  return postJson('/v1/history/archive-catalog', { cursor: null, ...input }, opts)
}

// ——— 先算一算这一段有多大 ———

export interface EstimateRow {
  interval: string
  window_bars: number
  stride_bars: number
  upper_bound_vectors: number
}

export interface Estimate {
  symbols: number
  items: EstimateRow[]
  upper_bound_vectors: number
  vector_payload_bytes: number
  /**
   * `declared_range_upper_bound_before_source_availability_probe`：这是按你报的
   * 时间范围算的上限，还没有去问来源那边真有多少，实际只会更少。
   */
  estimate_kind: string
  observed_feature_table_bytes: number
  approximate_observed_rows: number
  includes_index_overhead_in_vector_payload: boolean
  duration_estimate: null
  quality_gate: string
}

export function estimate(
  input: {
    market: Market
    symbols: string[]
    intervals: string[]
    start_at: Instant
    end_at: Instant
  },
  opts: RequestOptions = {},
): Promise<Estimate> {
  return postJson('/v1/history/plans/estimate', input, opts)
}

// ——— 持续跟进：让一组合约一直往前准备 ———

export interface SubscriptionInput {
  market: Market
  symbols: string[]
  intervals: string[]
  start_at: Instant
  source: HistorySource
  /**
   * 一个周期内最多允许写多少条特征。超过就直接拒绝，不会先做一半再说。
   * 想放大要自己明说——这是磁盘和时间的闸门。
   */
  max_vectors: number
}

export interface SubscriptionStarted {
  subscription_id: Uuid
  job_id: Uuid
  revision: number
  status: string
  estimate: Estimate
}

export function subscribe(
  input: SubscriptionInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<SubscriptionStarted> {
  return postJson('/v1/history/subscriptions', input, { ...opts, idempotencyKey })
}

export interface Subscription {
  id: Uuid
  body: { definition: SubscriptionInput; resolved_symbols: string[] }
  /** `active` 在往前走，`paused` 停着，`needs_attention` 要人处理，`cancelled` 不做了。 */
  status: 'active' | 'paused' | 'needs_attention' | 'cancelled'
  revision: number
  /** 已经确认准备好的时间水位：这个时刻之前的都做完了。 */
  watermark: Instant | null
  cycle_end: Instant | null
  cycle: number
  plan_no: number
  child_plan: Uuid | null
  next_run_at: Instant
  created_at: Instant
  last_error: string | null
  job_id: Uuid | null
  job_status: string | null
  error_code: string | null
}

export function subscription(id: Uuid, opts: RequestOptions = {}): Promise<Subscription> {
  return getJson<Subscription>(`/v1/history/subscriptions/${id}`, opts)
}

/**
 * 暂停、继续、不做了。`expected_revision` 是你屏幕上看到的那一版；别处动过了后端
 * 会拒绝，这时候要把新状态读回来再决定，不能盲重试盖过去。
 */
export function subscriptionControl(
  id: Uuid,
  input: { expected_revision: number; action: 'pause' | 'resume' | 'cancel' },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ subscription_id: Uuid; revision: number; status: string }> {
  return postJson(`/v1/history/subscriptions/${id}/control`, input, { ...opts, idempotencyKey })
}

/** 放大配额。只有停着或者要人处理的时候能改，改完还要自己按继续。 */
export function subscriptionBudget(
  id: Uuid,
  input: { expected_revision: number; max_vectors: number },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ subscription_id: Uuid; revision: number; max_vectors: number; next_action: string }> {
  return postJson(`/v1/history/subscriptions/${id}/budget`, input, { ...opts, idempotencyKey })
}

// ——— 来源订正 ———

/**
 * 重新去源头取一遍并核对校验，做出新的一代。旧的一代原样留着当证据，不会被就地
 * 改写——「同一段历史现在读出来不一样了」本身就是要留档的事。
 */
export function revalidate(
  indexId: Uuid,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{
  index_id: Uuid
  job_id: Uuid
  generation_id: Uuid
  supersedes_generation: Uuid
  status: string
  source_policy: string
}> {
  return postJson(`/v1/history/indexes/${indexId}/revalidate`, {}, { ...opts, idempotencyKey })
}

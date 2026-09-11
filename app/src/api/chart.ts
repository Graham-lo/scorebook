// 按图索骥（chart-match-v2）。
//
// 这一整条路只有三步，而且每一步都不替人做决定：
//
// 1. `/v1/chart-analyses` 先认图。它给出的是**这张图上看得见的东西**——数出多少
//    根 K 线、间距是否均匀、字认出了什么。认不出品种和周期就是认不出，形状里没有
//    币种这个信息，前端不能猜。
// 2. `/v1/chart-search/runs` 起一次检索，`scope` 必须由人明说：比自己的截图，还是
//    比币安的公开历史。方向默认保持原样，反向要人自己勾。
// 3. 轮询 `/v1/chart-search/runs/{id}`。中途会出现 `provisional`，那只是候选；只有
//    `final` 才做完了来源哈希核验和几何精排。取消要带 `expected_generation`。
//
// 相似度是结构匹配的排序，不是胜率，也不是上涨概率——这一点在文案里也不能改写。

import { getJson, postJson, type RequestOptions } from './http'
import type { ChartRequest, Instant, Market, Region, Uuid } from './types'

/** v4 只剩这两个向量空间：几何用于结构，dinov2 用于画面。 */
export const GEOMETRY_MODEL = 'candle-geometry-v2'
export const VISUAL_MODEL = 'dinov2-small-v1'
export const CHART_MATCH_PROTOCOL = 'chart-match-v2'

// ——— 第一步：认图 ———

export interface GeometryQuality {
  protocol: string
  model_id: string
  region: Region
  /** 数出来的 K 线根数。太少或者结构不成立，后端会直接报错而不是硬认。 */
  detected_candles: number
  /** 间距一致性，越接近 1 越像一张规整的 K 线图。 */
  spacing_consistency: number
  supported: boolean
  /**
   * 后端自己列出的边界：只认普通红绿 K 线、平均K线（Heikin Ashi）从像素上排除不掉、
   * 品种和周期必须有可见的字、语义质量尚未验收。原样展示，不做加工。
   */
  limitations: string[]
}

export interface RecognizedChart {
  /** 认出来才有；认不出就是 null，不猜。 */
  symbol: string | null
  interval: string | null
  auto_accept_confidence_threshold: number
  precision_validated: boolean
  unknown_fields_are_not_inferred: boolean
}

export interface ChartAnalysis {
  id: Uuid
  attachment_id: Uuid
  geometry: GeometryQuality
  recognized: RecognizedChart
  ocr: unknown
  ocr_status: string
  /** `ordinary_candlestick_candidate`：像普通 K 线，但没法保证不是平均K线。 */
  chart_type: string
  quality_validated: boolean
}

export interface ChartAnalysisInput {
  attachment_id: Uuid
  region?: Region
  /** 图上是不是红涨绿跌。默认按绿涨红跌读。 */
  red_up?: boolean
}

export function analyze(
  input: ChartAnalysisInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ChartAnalysis> {
  return postJson<ChartAnalysis>('/v1/chart-analyses', input, { ...opts, idempotencyKey })
}

// ——— 第二步：起一次检索 ———

/** 比哪一堆图：自己复盘库里的截图，还是币安的公开历史。 */
export type SearchScope = 'private' | 'binance_history'

export interface ChartSearchInput {
  attachment_id: Uuid
  scope: SearchScope
  region?: Region
  /** 只对公开历史有意义；私库按记录自己的品种筛。 */
  symbol?: string
  market?: Market
  /** 选了具体周期就写它；`any_interval` 时必须是 null。 */
  interval: string | null
  /** 缺省 `same_interval`：不写就是老的同周期口径。 */
  interval_policy?: 'same_interval' | 'any_interval'
  /** 只看这个时刻之前的历史。不填就是现在。 */
  cutoff_at?: Instant
  /** 反向匹配（把走势上下翻过来比）。默认关闭，要人自己选。 */
  reverse?: boolean
  red_up?: boolean
  /** 1…30。 */
  limit?: number
}

export interface SearchStarted {
  search_run_id: Uuid
  job_id: Uuid
  status: string
  protocol: string
}

export function startSearch(
  input: ChartSearchInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<SearchStarted> {
  return postJson<SearchStarted>('/v1/chart-search/runs', input, { ...opts, idempotencyKey })
}

// ——— 第三步：读结果 ———

export interface MatchScore {
  score: number
  alignment_cost: number
  direction_consistent: boolean
  reverse: boolean
  /** 后端自报的口径：结构相似，不是概率。 */
  meaning: string
}

interface CandidateCommon {
  match?: MatchScore
  /** `reranked` 表示这条已经过几何精排；候选阶段没有这个字段。 */
  stage?: string
}

/** 公开历史里的一段行情。 */
export interface HistoryCandidate extends CandidateCommon {
  id: Uuid
  source_uri: string
  market: Market
  symbol: string
  interval: string
  start_at: Instant
  end_at: Instant
  bars_count: number
  source_hash_at_index: string
  ann_distance: number
  /** 这一段该从哪里重画：交易所接口，还是月度归档。 */
  market_source: 'rest' | 'monthly_archive'
  /** 精排之后才有。要重画就原样把它交给 /v1/market/data。 */
  chart_request?: ChartRequest
}

/** 自己复盘库里的一张截图。 */
export interface PrivateCandidate extends CandidateCommon {
  attachment_id: Uuid
  call_id: Uuid
  group_id: string
  source_uri: string
  /** 这条记录自己写的周期；记录上没写就是 null。 */
  interval?: string | null
  ann_distance?: number
}

export type SearchCandidate = HistoryCandidate | PrivateCandidate

export function isHistoryCandidate(item: SearchCandidate): item is HistoryCandidate {
  return 'id' in item && 'symbol' in item
}

/** 被排除的候选：来源核验没过，或者那张图的 K 线结构读不出来。 */
export interface ExcludedCandidate {
  id?: Uuid
  attachment_id?: Uuid
  reason: string
}

/** 中途发布的候选。还没核验过来源，也还没精排。 */
export interface ProvisionalResult {
  status: 'provisional'
  items: SearchCandidate[]
  protocol: string
  quality_validated: boolean
}

/** 最终结果。到这一步才做完来源哈希核验和几何精排。 */
export interface FinalResult {
  /** 不限周期时是 null；旧检索也可能没有这个字段。 */
  interval?: string | null
  interval_policy?: 'same_interval_only' | 'any_interval'
  search_run_id: Uuid
  protocol: string
  status: 'final'
  items: SearchCandidate[]
  excluded_candidates: ExcludedCandidate[]
  scope: SearchScope
  cutoff_at: Instant
  quality_validated: boolean
  query_quality: GeometryQuality
  /** 只在已发布的几何索引里找。没准备过的范围不在里面。 */
  coverage: string
  candidate_budget: number
  rerank_budget: number
  /** 后端不存原始行情，`none`。 */
  raw_market_storage: string
}

export type SearchResult = ProvisionalResult | FinalResult

/**
 * 一次检索的当前状态。`result` 在做完之前可能是空的，也可能是 provisional。
 * `generation` 是取消时要带回去的版本。
 */
export interface ChartSearchRun {
  id: Uuid
  attachment_id: Uuid
  body: ChartSearchInput & { cutoff_at?: Instant }
  created_at: Instant
  completed_at: Instant | null
  result: SearchResult | null
  status: string
  generation: number
  error_code: string | null
}

export function searchRun(id: Uuid, opts: RequestOptions = {}): Promise<ChartSearchRun> {
  return getJson<ChartSearchRun>(`/v1/chart-search/runs/${id}`, opts)
}

/**
 * 停掉还在跑的这次检索。`expected_generation` 是刚读到的那个版本；对不上或者
 * 它已经结束了，后端回 `search_generation_conflict`，这时该把状态读回来给人看，
 * 而不是再取消一次。
 */
export function cancelSearch(
  id: Uuid,
  expectedGeneration: number,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ search_run_id: Uuid; status: string; generation: number }> {
  return postJson(
    `/v1/chart-search/runs/${id}/cancel`,
    { expected_generation: expectedGeneration },
    { ...opts, idempotencyKey },
  )
}

// ——— 私库这一侧的前提：截图得先算过特征 ———

export interface ImageIndexItem {
  model_id: string
  /** `ready` 或 `unsupported`。 */
  status: string
  count: number
}

export interface ImageIndexStatus {
  /** 复盘库里一共有多少张现场截图。 */
  originals: number
  items: ImageIndexItem[]
  protocol: string
}

export function imageIndexStatus(opts: RequestOptions = {}): Promise<ImageIndexStatus> {
  return getJson<ImageIndexStatus>('/v1/images/index', opts)
}

/** 把还没算过的截图整批补上。一次跑 8 张，两个模型都算。 */
export function indexAllImages(
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ job_id: Uuid; status: string }> {
  return postJson('/v1/images/index', {}, { ...opts, idempotencyKey })
}

/** 单张截图补算某一个模型的特征。 */
export function indexImage(
  attachmentId: Uuid,
  modelId: string,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ job_id: Uuid; status: string }> {
  return postJson(
    `/v1/attachments/${attachmentId}/index`,
    { model_id: modelId },
    { ...opts, idempotencyKey },
  )
}

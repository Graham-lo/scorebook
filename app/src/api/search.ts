import { getJson, postJson, type RequestOptions } from './http'
import type {
  HistoryIndexRecord,
  HistoryResult,
  Market,
  Page,
  Region,
  SimilarityResult,
  Uuid,
} from './types'

/** Models the review-library search accepts. hybrid-v1 fuses the other two. */
export const LIBRARY_MODELS = ['candle-profile-v1', 'dinov2-small-v1', 'hybrid-v1'] as const
/** The history index stores one vector space per model; no fusion there. */
export const HISTORY_MODELS = ['candle-profile-v1', 'dinov2-small-v1'] as const

export type LibraryModel = (typeof LIBRARY_MODELS)[number]
export type HistoryModel = (typeof HISTORY_MODELS)[number]

export interface LibraryQuery {
  attachment_id: Uuid
  region?: Region
  model_id: LibraryModel
  /** The review library filters by instrument and timeframe. */
  instrument?: string
  market?: Market
  timeframe?: string
  limit?: number
}

export function searchLibrary(
  query: LibraryQuery,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<SimilarityResult> {
  return postJson<SimilarityResult>('/v1/similarity/search', query, { ...opts, idempotencyKey })
}

export interface HistoryQuery {
  attachment_id: Uuid
  region?: Region
  model_id: HistoryModel
  /** The history index filters by symbol and interval, not instrument/timeframe. */
  symbol?: string
  market?: Market
  interval?: string
  limit?: number
}

export function searchHistory(
  query: HistoryQuery,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<HistoryResult> {
  return postJson<HistoryResult>('/v1/history/search', query, { ...opts, idempotencyKey })
}

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
): Promise<{ job_id: Uuid; index_id: Uuid; status: string }> {
  return postJson('/v1/history/indexes', input, { ...opts, idempotencyKey })
}

export function feedback(
  input: { session_id: Uuid; attachment_id: Uuid; relevant: boolean; reason?: string },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ id: Uuid }> {
  return postJson('/v1/similarity/feedback', input, { ...opts, idempotencyKey })
}

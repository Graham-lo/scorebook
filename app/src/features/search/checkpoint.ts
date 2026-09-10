import type { Market, Region } from '../../api/types'
import { SEARCH_PERIODS, type SearchPeriod } from './query-period'

/** Only query references and settings. Never screenshots, answers, or market bytes. */
export interface SearchCheckpoint {
  queryId: string
  queryName: string
  scope: 'private' | 'binance_history'
  region: Region | null
  interval: SearchPeriod | null
  symbol: string | null
  market: Market | null
  redUp: boolean
  reverse: boolean
  limit: number
  runId: string | null
}
export const CHECKPOINT_KEY = 'scorebook.search.checkpoint.v1'
export function readCheckpoint(raw: string | null): SearchCheckpoint | null {
  try {
    const v = JSON.parse(raw ?? 'null') as SearchCheckpoint | null
    const uuid = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)
    if (!v || !uuid(v.queryId) || (v.runId !== null && !uuid(v.runId))) return null
    if (!['private', 'binance_history'].includes(v.scope) || typeof v.queryName !== 'string') return null
    if (v.interval !== null && !SEARCH_PERIODS.includes(v.interval)) return null
    if (v.runId && !v.interval) return null
    if (v.market !== null && !['usd_m', 'coin_m'].includes(v.market)) return null
    if (v.symbol !== null && (typeof v.symbol !== 'string' || v.symbol.length > 100)) return null
    if (typeof v.redUp !== 'boolean' || typeof v.reverse !== 'boolean' || ![3, 5, 10].includes(v.limit)) return null
    if (v.region && (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(v.region![k as keyof Region])) || v.region.x < 0 || v.region.y < 0 || v.region.width <= 0 || v.region.height <= 0)) return null
    return { queryId: v.queryId, queryName: v.queryName.slice(0, 256), scope: v.scope, region: v.region, interval: v.interval, symbol: v.symbol, market: v.market, redUp: v.redUp, reverse: v.reverse, limit: v.limit, runId: v.runId }
  } catch { return null }
}

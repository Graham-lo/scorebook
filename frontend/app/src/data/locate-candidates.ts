import type { HistoryCandidate } from '../api/chart'

// Anchored location candidates have coordinates, but no public index ID.
export type LocateCandidate = Pick<HistoryCandidate, 'symbol' | 'market' | 'interval' | 'start_at' | 'end_at' | 'market_source'> & Partial<Pick<HistoryCandidate, 'id' | 'bars_count' | 'match'>>

export function locateCandidates(input: unknown): LocateCandidate[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((raw: unknown): LocateCandidate[] => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Partial<HistoryCandidate>
    if (typeof item.symbol !== 'string' || !item.symbol || !['usd_m', 'coin_m'].includes(item.market ?? '') ||
      typeof item.interval !== 'string' || !item.interval || typeof item.start_at !== 'string' || typeof item.end_at !== 'string' ||
      !Number.isFinite(Date.parse(item.start_at)) || !Number.isFinite(Date.parse(item.end_at)) || Date.parse(item.start_at) >= Date.parse(item.end_at)) return []
    return [{ symbol: item.symbol, market: item.market!, interval: item.interval, start_at: item.start_at, end_at: item.end_at,
      market_source: item.chart_request?.source === 'monthly_archive' || item.market_source === 'monthly_archive' ? 'monthly_archive' : 'rest',
      ...(typeof item.id === 'string' ? { id: item.id } : {}),
      ...(typeof item.bars_count === 'number' && item.bars_count > 0 ? { bars_count: item.bars_count } : {}),
      ...(item.match ? { match: item.match } : {}) }]
  }).slice(0, 3)
}

// 记录页上的筛选，跨导航留着：打开一条记录再回来，还是刚才那一页。

import type { Market, OutcomeState, Stance } from '../../api/types'

export interface FindState {
  instrument: string | null
  market: Market | null
  timeframe: string | null
  tag: string | null
  stance: Stance | null
  path: string | null
  result: OutcomeState | null
  /** 最近多少天，null 是不限。 */
  days: number | null
}

export const find: FindState = {
  instrument: null,
  market: null,
  timeframe: null,
  tag: null,
  stance: null,
  path: null,
  result: null,
  days: null,
}

export function anyFilter(): boolean {
  return Boolean(
    find.instrument || find.market || find.timeframe || find.tag || find.stance || find.path ||
      find.result || find.days,
  )
}

export function clearFilters(): void {
  find.instrument = null
  find.market = null
  find.timeframe = null
  find.tag = null
  find.stance = null
  find.path = null
  find.result = null
  find.days = null
}

// 刚记下的那一条，回到列表时标一次。第一行认领之后就消掉，不过夜。
let fresh: string | null = null

export function markFresh(id: string): void {
  fresh = id
}

export function consumeFresh(id: string): boolean {
  if (fresh !== id) return false
  fresh = null
  return true
}

/** Identifies the server page set; local filters never reuse a different symbol's rows. */
export function serverFilterKey(state: FindState = find): string {
  return JSON.stringify([state.instrument, state.market, state.timeframe, state.tag])
}

/** A linked symbol and market are one scope; never inherit the prior page's market. */
export function applyInstrumentQuery(query: URLSearchParams, state: FindState = find): void {
  if (!query.has('instrument') && !query.has('market')) return
  state.instrument = query.get('instrument')?.trim().toUpperCase() || null
  const market = query.get('market')
  state.market = market === 'usd_m' || market === 'coin_m' ? market : null
}

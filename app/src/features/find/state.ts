// The recall filters survive navigation: opening a record and coming back
// must land on the same page of the ledger, not reset it.

import type { Market } from '../../api/types'

export interface FindState {
  q: string
  instrument: string | null
  market: Market | null
  timeframe: string | null
  tag: string | null
}

export const find: FindState = {
  q: '',
  instrument: null,
  market: null,
  timeframe: null,
  tag: null,
}

export function anyFilter(): boolean {
  return Boolean(find.instrument || find.market || find.timeframe || find.tag)
}

export function clearFilters(): void {
  find.instrument = null
  find.market = null
  find.timeframe = null
  find.tag = null
}

// The record that was just saved, so the ledger can mark it once when the
// trader lands back on the list. It is consumed by the first row that claims
// it, and never survives a reload.
let fresh: string | null = null

export function markFresh(id: string): void {
  fresh = id
}

export function consumeFresh(id: string): boolean {
  if (fresh !== id) return false
  fresh = null
  return true
}

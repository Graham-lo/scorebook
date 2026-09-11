import { getJson, type RequestOptions } from './http'
import type { Capabilities, Instrument, Market } from './types'

export interface InstrumentPage {
  items: Instrument[]
  next_cursor: string | null
  default_market: Market
  identity_policy: string
}

/** Contract identity comes from the exchange catalog, never from the ticker text. */
export function instruments(
  query: { q?: string; market?: Market; limit?: number; cursor?: string },
  opts: RequestOptions = {},
): Promise<InstrumentPage> {
  return getJson<InstrumentPage>('/v1/instruments', { ...opts, query: { ...query } })
}

export function capabilities(opts: RequestOptions = {}): Promise<Capabilities> {
  return getJson<Capabilities>('/v1/capabilities', opts)
}

export interface CriteriaDefaults {
  version: string
  templates: string[]
  default: string
  crypto_default_hours: number
  threshold_atr_multiple: string
  volatility_atr_multiple: string
  trigger_default: string
}

export function criteriaDefaults(opts: RequestOptions = {}): Promise<CriteriaDefaults> {
  return getJson<CriteriaDefaults>('/v1/criteria', opts)
}

export function health(opts: RequestOptions = {}): Promise<{ status: string; version: string }> {
  return getJson('/v1/health', opts)
}

// Process-wide facts that every page needs and none of them should fetch
// twice: what the backend says it can do, and the contract catalogue.
//
// Capability strings decide what the UI is allowed to offer. The backend does
// not answer with a fixed yes/no: it names the shape of what it has built
// ("draft_resume_and_immutable_publish", "chunked_v2", "published_coverage_only"
// …). So the gate is written the other way round — a small list of words that
// mean "not usable yet" — and everything else counts as usable. Adding a new
// backend capability must not silently switch a working page off.

import { capabilities, instruments } from '../api/catalog'
import type { Capabilities, Instrument, Market } from '../api/types'

let caps: Capabilities | null = null

export async function loadCapabilities(): Promise<Capabilities> {
  if (!caps) caps = await capabilities()
  return caps
}

export function capability(name: string): string {
  return caps?.[name] ?? 'unknown'
}

/**
 * Words the backend uses for something the trader cannot use yet. Everything
 * else — including the shape-describing values above — means it is usable.
 * `unknown` is in the list because it is what we say when /v1/capabilities was
 * never read; offering a feature we could not confirm would be a lie.
 */
const NOT_YET = new Set([
  'planned',
  'not_implemented',
  'unavailable',
  'disabled',
  'exploratory_only',
  'unknown',
])

export function isLive(name: string): boolean {
  return !NOT_YET.has(capability(name))
}

export function defaultMarket(): Market {
  return (caps?.default_market as Market) ?? 'usd_m'
}

export const MARKET_LABELS: Record<Market, string> = {
  usd_m: 'USDⓈ-M',
  coin_m: 'COIN-M',
}

const known = new Map<string, Instrument>()

/** Identity comes from the catalogue row, never from the look of the ticker. */
export function identityOf(instrument: Instrument): string {
  const b = instrument.body
  const sub = Array.isArray(b.underlyingSubType) ? b.underlyingSubType.join(' / ') : null
  const kind = [b.underlyingType, sub].filter(Boolean).join(' · ')
  return [`${instrument.venue} ${MARKET_LABELS[instrument.market]}`, b.contractType, kind]
    .filter(Boolean)
    .join(' · ')
}

export function cached(symbol: string): Instrument | null {
  return known.get(symbol) ?? null
}

/** Server-side typeahead: the catalogue is far too large to hold client side. */
export async function findInstruments(
  q: string,
  opts: { market?: Market; signal?: AbortSignal } = {},
): Promise<Instrument[]> {
  const page = await instruments(
    { q: q || undefined, market: opts.market, limit: 20 },
    { signal: opts.signal },
  )
  for (const item of page.items) known.set(item.symbol, item)
  return page.items
}

/** Fills the cache for one symbol so a detail page can name the contract. */
export async function describe(symbol: string, market: Market): Promise<Instrument | null> {
  const hit = known.get(symbol)
  if (hit) return hit
  const page = await instruments({ q: symbol, market, limit: 5 })
  for (const item of page.items) known.set(item.symbol, item)
  return known.get(symbol) ?? null
}

/** The intervals the backend's chart and history endpoints accept. */
export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const
export type Interval = (typeof INTERVALS)[number]

/** 一根 K 线有多少秒。和后端的表一致，用来算一段时间里有多少根。 */
export const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
}

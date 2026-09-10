// Process-wide facts that every page needs and none of them should fetch
// twice: what the backend says it can do, and the contract catalogue.
//
// v4 answers /v1/capabilities in two registers. A plain sentence names the
// shape of something that is built and needs nothing local ("frozen_members_
// and_rule_groups"). An object separates the two questions that are not the
// same question: is it implemented, and is the piece it needs configured on
// this machine — a local model process, a Keychain reference, a backup
// repository. Neither register claims the capability was accepted against
// real data; the backend says as much in its own last field.
//
// The gate is therefore written to read the shape rather than a fixed list of
// words, so a backend that adds a capability, or renames one of its states,
// cannot silently switch a working page off.

import { capabilities, instruments } from '../api/catalog'
import type { Capabilities, Instrument, Market } from '../api/types'

let caps: Capabilities | null = null

export async function loadCapabilities(): Promise<Capabilities> {
  if (!caps) caps = await capabilities()
  return caps
}

export function allCapabilities(): Capabilities | null {
  return caps
}

/**
 * `ready` 现在就能用；`needs_setup` 后端做了，但这台机器上它要的那一块还没配；
 * `unknown` 没读到 /v1/capabilities，什么都不敢承诺。
 */
export type CapabilityState = 'ready' | 'needs_setup' | 'unknown'

/**
 * 后端用一句话说明一项能力的形态，但其中有几句说的是「还没有这回事」。这几句
 * 不能当成「能用」——把 `planned` 读成开着，页面就会摆出一个点进去什么都没有的
 * 入口，正是这版要避免的事。除此之外一律按形态读，不去猜后端的措辞。
 */
const NOT_BUILT = new Set([
  'planned',
  'not_implemented',
  'not_configured',
  'unavailable',
  'disabled',
  'missing',
  'none',
  'off',
])

export function capabilityState(name: string): CapabilityState {
  const value = caps?.[name]
  if (value === undefined || value === null) return 'unknown'
  if (typeof value === 'string') {
    const word = value.trim().toLowerCase()
    if (!word) return 'needs_setup'
    return NOT_BUILT.has(word) ? 'needs_setup' : 'ready'
  }
  if (typeof value === 'boolean') return value ? 'ready' : 'needs_setup'
  if (Array.isArray(value)) return value.length ? 'ready' : 'needs_setup'
  if (typeof value === 'object') {
    const flags = value as Record<string, unknown>
    // 备份要引擎和仓库两样都在，缺一样都恢复不了。
    if ('engine_configured' in flags || 'repository_configured' in flags) {
      return flags.engine_configured === true && flags.repository_configured === true
        ? 'ready'
        : 'needs_setup'
    }
    if ('configured' in flags) return flags.configured === true ? 'ready' : 'needs_setup'
    if ('available' in flags) return flags.available === true ? 'ready' : 'needs_setup'
    return 'ready'
  }
  return 'unknown'
}

/**
 * 用不了的时候，到底是哪一种用不了。首页和设置页都要照实说：后端没做，和后端
 * 做了但这台机器没配，是两件事——上一版把「适配器已实现、凭证未配置」写成了
 * 「后端还没有做这部分」，被指出来过。
 */
export type CapabilityGap = 'not_built' | 'not_configured' | 'unknown' | null

export function capabilityGap(name: string): CapabilityGap {
  const value = caps?.[name]
  if (value === undefined || value === null) return 'unknown'
  if (capabilityState(name) === 'ready') return null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const flags = value as Record<string, unknown>
    // 带 configured / engine_configured 这类字段的，后端已经把实现做完了，
    // 缺的是本机那一份配置。
    if (
      'configured' in flags ||
      'engine_configured' in flags ||
      'repository_configured' in flags
    ) {
      return 'not_configured'
    }
    if ('available' in flags) return 'not_built'
    return 'not_built'
  }
  return 'not_built'
}

export function isLive(name: string): boolean {
  return capabilityState(name) === 'ready'
}

/**
 * 后端自报的模型或适配器标识，只用在设置页的技术详情里。
 *
 * 能力表里大半的值是给工程看的说明词——`immutable_batch_ingestion_and_incremental_
 * position_rounds` 这种。它们不是型号，写到界面上既占地方又没人看得懂，所以这里
 * 只认真正的模型／适配器名，别的一律当作没有。
 */
export function capabilityDetail(name: string): string | null {
  const value = caps?.[name]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const flags = value as Record<string, unknown>
  for (const key of ['model_id', 'model', 'adapter']) {
    const detail = flags[key]
    if (typeof detail === 'string' && detail && detail !== 'unconfigured') return detail
  }
  return null
}

/**
 * 配置好了不等于验过。后端只在按图索骥这一项上明说过质量有没有验收过，其余
 * 一律按“没有验收结论”处理——界面上不能把“接上了”说成“验过了”。
 */
export function qualityAccepted(name: string): boolean {
  const value = caps?.[name]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>).real_image_quality_validated === true
  }
  return false
}

/**
 * v4 的 /v1/capabilities 不再报默认市场，合约目录报。目录读过一次之后用它报的，
 * 没读过就按 USDⓈ-M，不猜。
 */
let catalogueMarket: Market = 'usd_m'

export function defaultMarket(): Market {
  return catalogueMarket
}

export const MARKET_LABELS: Record<Market, string> = {
  usd_m: 'USDⓈ-M',
  coin_m: 'COIN-M',
}

const known = new Map<string, Instrument>()

/**
 * 合约目录里的这几个字段是交易所的内部枚举（PERPETUAL、TRADIFI_PERPETUAL…）。
 * 它们该说的意思有用，长相不该出现在挑品种的列表上，所以在这里翻成人话；
 * 没见过的值不硬翻，也不丢掉，只把下划线和全大写收拾干净。
 */
const CONTRACT_WORDS: Record<string, string> = {
  PERPETUAL: '永续',
  TRADIFI_PERPETUAL: '永续 · 传统市场标的',
  PERPETUAL_DELIVERING: '永续 · 正在交割下架',
  CURRENT_MONTH: '当月交割',
  NEXT_MONTH: '次月交割',
  CURRENT_QUARTER: '当季交割',
  NEXT_QUARTER: '次季交割',
  CURRENT_QUARTER_DELIVERING: '当季交割 · 正在交割',
  NEXT_QUARTER_DELIVERING: '次季交割 · 正在交割',
}

const UNDERLYING_WORDS: Record<string, string> = {
  COIN: '标的是币',
  INDEX: '标的是指数',
  PREMARKET: '上市前',
}

/** 没收录的枚举退回成普通词：`TRADIFI_PERPETUAL` → `Tradifi perpetual`。 */
function plain(value: string): string {
  const words = value.replace(/_/g, ' ').trim().toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : ''
}

export function contractLabel(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  return CONTRACT_WORDS[value] ?? plain(value)
}

export function underlyingLabel(value: unknown, subTypes?: unknown): string {
  const head = typeof value === 'string' && value ? (UNDERLYING_WORDS[value] ?? plain(value)) : ''
  const sub = Array.isArray(subTypes)
    ? subTypes.filter((s): s is string => typeof s === 'string').map(plain).join(' / ')
    : ''
  return [head, sub].filter(Boolean).join(' · ')
}

/** Identity comes from the catalogue row, never from the look of the ticker. */
export function identityOf(instrument: Instrument): string {
  const b = instrument.body
  return [
    `${instrument.venue} ${MARKET_LABELS[instrument.market]}`,
    contractLabel(b.contractType),
    underlyingLabel(b.underlyingType, b.underlyingSubType),
  ]
    .filter(Boolean)
    .join(' · ')
}

export function cached(symbol: string): Instrument | null {
  return known.get(symbol) ?? null
}

/**
 * 合约目录是交易所那份，里面只有拉丁字母的代码。用中文说「比特币」的人不该被
 * 一句「没找到」打回去，所以在发出去之前把常说的几个中文名换成代码——换的只是
 * 打出来的那几个字，认出来是哪个合约仍然由目录说了算。
 */
const ZH_ALIASES: Record<string, string> = {
  比特币: 'BTC',
  大饼: 'BTC',
  以太: 'ETH',
  以太坊: 'ETH',
  币安币: 'BNB',
  狗狗币: 'DOGE',
  瑞波: 'XRP',
  瑞波币: 'XRP',
  莱特币: 'LTC',
  艾达: 'ADA',
  艾达币: 'ADA',
  波卡: 'DOT',
  柴犬币: 'SHIB',
  黄金: 'XAU',
  白银: 'XAG',
}

function latin(q: string): string {
  const word = q.trim()
  if (!/[\u4e00-\u9fa5]/.test(word)) return q
  const hit = ZH_ALIASES[word] ?? ZH_ALIASES[word.replace(/(合约|永续|币)$/, '')]
  return hit ?? q
}

/** Server-side typeahead: the catalogue is far too large to hold client side. */
export async function findInstruments(
  q: string,
  opts: { market?: Market; signal?: AbortSignal } = {},
): Promise<Instrument[]> {
  const word = latin(q)
  const page = await instruments(
    { q: word || undefined, market: opts.market, limit: 20 },
    { signal: opts.signal },
  )
  if (page.default_market) catalogueMarket = page.default_market
  for (const item of page.items) known.set(item.symbol, item)
  // 打「BTCUSDT」的人自己说清楚了要哪一个，目录怎么排就怎么显示。说「比特币」
  // 的人只说了标的，剩下的是我们替他挑：最常说的那一个（永续、USDT 计价）排在
  // 最前面，其余顺序不动。
  return word === q ? page.items : usualFirst(page.items, word)
}

function usualFirst(items: Instrument[], base: string): Instrument[] {
  const score = (item: Instrument): number => {
    // PERPETUAL 和 TRADIFI_PERPETUAL 都算；PERPETUAL_DELIVERING 是正在下架的，
    // 不该抢在最前面。
    const perpetual = /(^|_)PERPETUAL$/.test(String(item.body.contractType ?? ''))
    if (item.symbol === `${base}USDT` && perpetual) return 0
    if (item.symbol.startsWith(base) && perpetual) return 1
    return 2
  }
  return items
    .map((item, at) => ({ item, at, score: score(item) }))
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .map((row) => row.item)
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

// 直接从浏览器取币安的 K 线。
//
// 为什么绕开后端：重温页要的只是「这一段真实行情长什么样」。这一段是公开数据，
// 谁去取都一样，而后端取一次要落一份临时缓存、要排队、要过期清理，人在页面上
// 就得等着。浏览器自己去取，一次往返就有了。
//
// 三条规矩，破了任何一条都退回后端那一条路（relive 页面负责回落）：
//   · 只在内存，加一份 24 小时就过期的 IndexedDB 热缓存。热缓存里只放已经收盘
//     的整根，正在走的那一根一秒一变，永远不落盘；口径和后端 replay_bars 一致
//     ——临时、过期即清、设置里可一键清空，绝不长期保存；
//   · 有边界。一次最多取 MAX_BARS 根，超时 8 秒，不让一个卡住的请求把页面拖住；
//   · 不改口径。返回的是项目自己的 Bar，时间按 UTC 的 RFC 3339，价格原样留着
//     交易所给的那个字符串，一位小数都不重算。
//
// 取不到是常态而不是异常：某些地区会返回 451，浏览器可能拦跨域，网络也可能就是
// 断的。所以这里的失败一律抛出去，由调用方安静地换一条路，不弹窗、不吓人。

import type { Bar, Market } from './types'

/** 现货不在这里——记录挂的都是合约。 */
const ENDPOINTS: Record<Market, string> = {
  usd_m: 'https://fapi.binance.com/fapi/v1/klines',
  coin_m: 'https://dapi.binance.com/dapi/v1/klines',
}

/** 币安一次最多给 1500 根。 */
const PAGE = 1500
/** 一次重温最多要这么多根；再多就该用后端那条路。 */
export const MAX_BARS = 2000
const TIMEOUT_MS = 8_000

export interface KlineWindow {
  symbol: string
  market: Market
  interval: string
  /** RFC 3339。含。 */
  start_at: string
  /** RFC 3339。不含——和 Bar.end 一个语义。 */
  end_at: string
}

/**
 * 币安的一根：`[开盘时间, 开, 高, 低, 收, 量, 收盘时间, …]`，后面还有成交额、
 * 笔数这些，这里用不上。数字全是字符串。
 */
export type Kline = [number, string, string, string, string, string, number, ...unknown[]]

/**
 * 一根原始 K 线映射成项目的 Bar。
 *
 * `end` 取收盘时间 + 1 毫秒，正好是下一根的开盘时间——项目里判断「某个时刻落在
 * 第几根」用的是 `start <= t < end`，所以 end 必须是开区间的那一头。
 *
 * 认不出来的行返回 null，不猜，也不用 0 顶替。
 */
export function mapKline(row: unknown): Bar | null {
  if (!Array.isArray(row) || row.length < 7) return null
  const openTime = Number(row[0])
  const closeTime = Number(row[6])
  if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) return null
  if (closeTime < openTime) return null
  const [open, high, low, close, volume] = [row[1], row[2], row[3], row[4], row[5]]
  if (![open, high, low, close].every((v) => typeof v === 'string' && v.length > 0)) return null
  return {
    start: new Date(openTime).toISOString(),
    end: new Date(closeTime + 1).toISOString(),
    open: open as string,
    high: high as string,
    low: low as string,
    close: close as string,
    volume: typeof volume === 'string' && volume.length > 0 ? volume : null,
  }
}

/** 把一页原始数据整理成 Bar，扔掉认不出来的行。 */
export function mapKlines(rows: unknown): Bar[] {
  if (!Array.isArray(rows)) return []
  const out: Bar[] = []
  for (const row of rows) {
    const bar = mapKline(row)
    if (bar) out.push(bar)
  }
  return out
}

/** 去重（按开盘时间）、排序、只留窗口里的那些。 */
export function tidy(bars: Bar[], startMs: number, endMs: number): Bar[] {
  const seen = new Map<number, Bar>()
  for (const bar of bars) {
    const at = new Date(bar.start).getTime()
    if (!Number.isFinite(at) || at < startMs || at >= endMs) continue
    if (!seen.has(at)) seen.set(at, bar)
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, bar]) => bar)
}

class Timeout extends Error {
  constructor() {
    super('取行情超时')
    this.name = 'BinanceTimeout'
  }
}

/** 一次请求：8 秒不回来就算了；外面取消也立刻停。 */
async function page(
  url: string,
  signal: AbortSignal | undefined,
  query: Record<string, string | number>,
): Promise<unknown> {
  const target = new URL(url)
  for (const [k, v] of Object.entries(query)) target.searchParams.set(k, String(v))
  const stopper = new AbortController()
  const timer = setTimeout(() => stopper.abort(new Timeout()), TIMEOUT_MS)
  const onAbort = () => stopper.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort)
  try {
    const response = await fetch(target.toString(), {
      method: 'GET',
      signal: stopper.signal,
      // 公开行情，别带任何凭证过去。
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new Error(`币安返回 ${response.status}`)
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 取一段窗口里的 K 线。
 *
 * 一次给 1500 根，窗口上限 2000 根，所以最多两次往返：每次都带上 startTime 和
 * endTime，下一次从上一页最后一根的下一毫秒接着要，直到覆盖到 end 或者交易所
 * 没有更多了（这一段真的没有行情，比如合约当时还没上市）。
 */
export async function fetchKlines(window: KlineWindow, signal?: AbortSignal): Promise<Bar[]> {
  const startMs = new Date(window.start_at).getTime()
  const endMs = new Date(window.end_at).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('这一段的起止时间说不通')
  }
  const url = ENDPOINTS[window.market]
  if (!url) throw new Error('不认识这个市场')

  const collected: Bar[] = []
  let cursor = startMs
  // 2000 根最多两页；多留一页的余量，免得边界上少一根就退回后端。
  for (let round = 0; round < 3; round += 1) {
    const rows = await page(url, signal, {
      symbol: window.symbol,
      interval: window.interval,
      startTime: cursor,
      endTime: endMs - 1,
      limit: PAGE,
    })
    const bars = mapKlines(rows)
    if (!bars.length) break
    collected.push(...bars)
    if (collected.length > MAX_BARS + PAGE) break
    const lastStart = new Date(bars[bars.length - 1]!.start).getTime()
    const lastEnd = new Date(bars[bars.length - 1]!.end).getTime()
    if (bars.length < PAGE || lastEnd >= endMs) break
    const next = Math.max(lastStart + 1, lastEnd)
    if (!(next > cursor)) break
    cursor = next
  }

  const tidied = tidy(collected, startMs, endMs)
  if (!tidied.length) throw new Error('这一段行情币安没有给')
  if (tidied.length > MAX_BARS) throw new Error('这一段太长了')
  return tidied
}

/**
 * 按格子取一段：一次请求，要多少给多少，空的就是空的。
 *
 * 和 `fetchKlines` 的差别只在规矩上：那一条是重温页的「这一段」，超过 2000 根
 * 就该换后端那条路，取不到还要报错；这一条是全屏懒加载的一格，取回来几根都算
 * 数——上市之前、退市之后本来就没有行情，空数组是答案而不是故障。
 */
export async function fetchRange(
  window: KlineWindow & { limit?: number },
  signal?: AbortSignal,
): Promise<Bar[]> {
  const startMs = new Date(window.start_at).getTime()
  const endMs = new Date(window.end_at).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error('这一段的起止时间说不通')
  }
  const url = ENDPOINTS[window.market]
  if (!url) throw new Error('不认识这个市场')
  const rows = await page(url, signal, {
    symbol: window.symbol,
    interval: window.interval,
    startTime: startMs,
    endTime: endMs - 1,
    limit: Math.min(Math.max(1, Math.floor(window.limit ?? PAGE)), PAGE),
  })
  return tidy(mapKlines(rows), startMs, endMs)
}

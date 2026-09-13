// 行情按「格子」寻址：一格 = 固定的一段时间，长度是 1000 根那么久。
//
// 为什么是时间桶而不是「第几根到第几根」：下标会随着往前补历史整体平移，缓存键
// 就跟着变；时间不会。任意时刻落进唯一一格，任意视野对应一串连续的格子，同一格
// 谁去取都是同一段，天然可去重、可缓存。
//
// 格子只是时间范围。桶里每一根仍旧按交易所给的真实开盘时间存，不做任何对齐——
// 交易所的周线从周一开、月线从 1 号开，硬去凑桶边界只会把数据挪错位置。

import { INTERVAL_SECONDS, type Interval } from '../../../data/session'
import type { Bar, Market } from '../../../api/types'

/** 一格装多少根。币安一次给 1000 根，正好一次请求一格。 */
export const TILE_BARS = 1000

const DAY_MS = 86_400_000

/** 一格有多长（毫秒）。 */
export function tileSpanMs(interval: string): number {
  if (interval === '1w') return TILE_BARS * 7 * DAY_MS
  if (interval === '1M') return TILE_BARS * 30 * DAY_MS
  const seconds = INTERVAL_SECONDS[interval as Interval] ?? 60
  return TILE_BARS * seconds * 1000
}

/** 一根有多长（毫秒）。1M 按 30 天算，只用来估根数。 */
export function barSpanMs(interval: string): number {
  if (interval === '1M') return 30 * DAY_MS
  return (INTERVAL_SECONDS[interval as Interval] ?? 60) * 1000
}

export function tileIndex(ms: number, interval: string): number {
  return Math.floor(ms / tileSpanMs(interval))
}

export function tileRange(index: number, interval: string): { startMs: number; endMs: number } {
  const span = tileSpanMs(interval)
  return { startMs: index * span, endMs: (index + 1) * span }
}

/** 覆盖 [fromMs, toMs] 的那一串格子，升序。 */
export function tilesBetween(fromMs: number, toMs: number, interval: string): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return []
  const first = tileIndex(fromMs, interval)
  const last = tileIndex(toMs, interval)
  const out: number[] = []
  // 视野再离谱也不该一次排出几万格来；这是防呆，不是业务上限。
  const cap = Math.min(last, first + 4096)
  for (let i = first; i <= cap; i += 1) out.push(i)
  return out
}

export interface TileKey {
  market: Market
  symbol: string
  interval: string
  index: number
}

export function tileKeyString(key: TileKey): string {
  return `${key.market}/${key.symbol}/${key.interval}/${key.index}`
}

/** 一个 (market, symbol, interval) 的键，不含格子号。 */
export function spaceKeyString(key: Omit<TileKey, 'index'>): string {
  return `${key.market}/${key.symbol}/${key.interval}`
}

type Span = [number, number]

/** 第一个 `end >= at` 的区间下标。二分。 */
function lowerBound(list: readonly Span[], at: number): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((list[mid] as Span)[1] >= at) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * 有序、不相交的时间区间表。「这一段取过了没有」只问它。
 *
 * 相邻（前一段的终点正好是后一段的起点）也合并：那是同一段连续行情被切成两次
 * 取回来，中间没有洞。
 */
export class Coverage {
  private list: Span[] = []

  add(startMs: number, endMs: number): void {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !(endMs > startMs)) return
    const lo = lowerBound(this.list, startMs)
    let hi = lo
    let start = startMs
    let end = endMs
    while (hi < this.list.length && (this.list[hi] as Span)[0] <= endMs) {
      const span = this.list[hi] as Span
      start = Math.min(start, span[0])
      end = Math.max(end, span[1])
      hi += 1
    }
    this.list.splice(lo, hi - lo, [start, end])
  }

  /** [fromMs, toMs] 里还缺的那几段。 */
  missing(fromMs: number, toMs: number): Span[] {
    const out: Span[] = []
    if (!(toMs > fromMs)) return out
    let at = fromMs
    let i = lowerBound(this.list, fromMs)
    while (i < this.list.length && at < toMs) {
      const [s, e] = this.list[i] as Span
      if (s >= toMs) break
      if (s > at) out.push([at, Math.min(s, toMs)])
      at = Math.max(at, e)
      i += 1
    }
    if (at < toMs) out.push([at, toMs])
    return out
  }

  covers(fromMs: number, toMs: number): boolean {
    return this.missing(fromMs, toMs).length === 0
  }

  ranges(): Span[] {
    return this.list.map((span) => [span[0], span[1]] as Span)
  }
}

const at = (iso: string): number => Date.parse(iso)

/**
 * 两份 bars 并成一条升序数组，同一根保留已有的那一份。
 *
 * 为什么不覆盖：同一根 K 线直连交易所和经服务端取回来，末位小数可能差一点点。
 * 两边来回覆盖会让图上那一根跳来跳去，所以先到先得。
 */
export function mergeBars(existing: readonly Bar[], incoming: readonly Bar[]): Bar[] {
  if (!incoming.length) return existing.slice()
  const fresh = [...incoming].sort((a, b) => at(a.start) - at(b.start))
  const out: Bar[] = []
  let i = 0
  let j = 0
  let last = Number.NEGATIVE_INFINITY
  while (i < existing.length || j < fresh.length) {
    const a = existing[i]
    const b = fresh[j]
    let pick: Bar
    if (a && (!b || at(a.start) <= at(b.start))) {
      pick = a
      i += 1
      if (b && at(b.start) === at(a.start)) j += 1
    } else {
      pick = b as Bar
      j += 1
    }
    const stamp = at(pick.start)
    if (stamp === last) continue
    last = stamp
    out.push(pick)
  }
  return out
}

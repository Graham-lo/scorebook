// 一格行情从哪里取。
//
// 先走浏览器直连币安：一次往返就有，按 IP 计权重，和后端那份预算互不相干，回来
// 的也没有服务端那份重复的 raw 数组。直连这条路一旦走不通（某些地区 451、浏览器
// 拦跨域、或者就是慢到 8 秒没回来），这个对话框余下的时间固定改走后端，不来回
// 试探——反复试的代价是每一格都先等一次超时。
//
// 退市或早年的合约（source 是 monthly_archive）只有后端拿得到，从一开始就不试
// 直连。
//
// 浏览器 API 只出现在这个文件里：上面那几层是纯逻辑，node 里能直接测。

import { fetchRange } from '../../../api/binance'
import { ApiError } from '../../../api/errors'
import { data as marketData } from '../../../api/market'
import type { RequestOptions } from '../../../api/http'
import type { Bar, ChartRequest, Market, MarketData } from '../../../api/types'
import { TILE_BARS, barSpanMs, tileRange, type TileKey } from './tiles'

export type HoleReason = 'before_listing' | 'after_delisting' | 'gap'

export interface TileResult {
  bars: Bar[]
  /** 这一格已经问干净了：没有更多能取的了。 */
  complete: boolean
  hole?: HoleReason
}

export const DIRECT_NAME = '币安'
export const BACKEND_NAME = '币安 · 经服务端'

export interface TileSource {
  name: typeof DIRECT_NAME | typeof BACKEND_NAME
  fetch(key: TileKey, signal: AbortSignal): Promise<TileResult>
}

export interface SourceSpace {
  market: Market
  symbol: string
  interval: string
  source?: ChartRequest['source']
}

export interface SourceDeps {
  direct: (window: {
    symbol: string
    market: Market
    interval: string
    start_at: string
    end_at: string
    limit: number
  }, signal: AbortSignal) => Promise<Bar[]>
  backend: (request: ChartRequest, opts: RequestOptions) => Promise<MarketData>
  now: () => number
  wait: (ms: number) => Promise<void>
}

const defaults: SourceDeps = {
  direct: (window, signal) => fetchRange(window, signal),
  backend: (request, opts) => marketData(request, opts),
  now: () => Date.now(),
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** 把时刻往下取整到这一档的一根上：后端不接受「半根」的区间。 */
function floorToBar(ms: number, interval: string): number {
  const span = barSpanMs(interval)
  return Math.floor(ms / span) * span
}

/** 直连这条路算不算断了。断了就整场改走后端，别的错（比如 400）不算。 */
export function shouldFallBack(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error instanceof Error) {
    if (error.name === 'BinanceTimeout') return true
    if (error.name === 'AbortError') return false
    if (/\b451\b/.test(error.message)) return true
  }
  return false
}

export interface SourcePool {
  fetch(key: TileKey, signal: AbortSignal): Promise<TileResult>
  /** 图例里显示的那个名字。 */
  name(): string
  /** 直连时并发 3，走后端只排 1 路。 */
  concurrency(): number
}

export function sourcePool(space: SourceSpace, overrides: Partial<SourceDeps> = {}): SourcePool {
  const deps: SourceDeps = { ...defaults, ...overrides }
  // 归档那一类从一开始就只有后端有。
  let mode: 'direct' | 'backend' = space.source === 'monthly_archive' ? 'backend' : 'direct'

  async function viaDirect(key: TileKey, signal: AbortSignal): Promise<TileResult> {
    const { startMs, endMs } = tileRange(key.index, key.interval)
    const now = deps.now()
    if (startMs >= now) return { bars: [], complete: true }
    const bars = await deps.direct({
      symbol: space.symbol,
      market: space.market,
      interval: key.interval,
      start_at: iso(startMs),
      end_at: iso(endMs),
      limit: TILE_BARS,
    }, signal)
    // 桶止在未来：未来那一段本来就没有，这一格问不出更多了。
    if (endMs > now) return { bars, complete: true }
    if (!bars.length) return { bars, complete: false, hole: 'gap' }
    return { bars, complete: bars.length < TILE_BARS }
  }

  async function viaBackend(key: TileKey, signal: AbortSignal): Promise<TileResult> {
    const { startMs, endMs } = tileRange(key.index, key.interval)
    const now = deps.now()
    const end = Math.min(endMs, floorToBar(now, key.interval))
    if (end <= startMs) return { bars: [], complete: true }
    // 翻格子一律不带 match_end_at：截止线在这一格之外，后端会按边界不合法拒掉。
    const request: ChartRequest = {
      symbol: space.symbol,
      market: space.market,
      interval: key.interval,
      start_at: iso(startMs),
      end_at: iso(end),
      ...(space.source ? { source: space.source } : {}),
    }
    let waited = false
    for (;;) {
      try {
        const result = await deps.backend(request, { signal })
        const bars = result.bars ?? []
        if (endMs > now) return { bars, complete: true }
        if (!bars.length) return { bars, complete: false, hole: 'gap' }
        return { bars, complete: bars.length < TILE_BARS }
      } catch (error) {
        if (signal.aborted) throw error
        // 限流回的是 503 加一条 retry：按它说的等一次再发一次，不自己造重试风暴。
        if (!waited && error instanceof ApiError && error.status === 503 && error.retry) {
          waited = true
          await deps.wait(error.retryAfterMs ?? 1000)
          if (signal.aborted) throw error
          continue
        }
        if (waited) return { bars: [], complete: false, hole: 'gap' }
        throw error
      }
    }
  }

  // 并发在这一层硬卡：直连 3 路、走后端 1 路。调度器自己也按这个数排队，但
  // 换档那一下会有两拨请求擦肩而过，真正保证「同时最多几路」的是这道闸。
  const limit = (): number => (mode === 'direct' ? 3 : 1)
  let active = 0
  const waiting: (() => void)[] = []

  function release(): void {
    active = Math.max(0, active - 1)
    if (active >= limit()) return
    const next = waiting.shift()
    if (next) next()
  }

  const aborted = (): Error => Object.assign(new Error('已取消'), { name: 'AbortError' })

  function acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(aborted())
    if (active < limit()) { active += 1; return Promise.resolve() }
    return new Promise<void>((go, stop) => {
      const enter = (): void => {
        signal.removeEventListener('abort', bail)
        active += 1
        go()
      }
      const bail = (): void => {
        const at = waiting.indexOf(enter)
        if (at >= 0) waiting.splice(at, 1)
        stop(aborted())
      }
      signal.addEventListener('abort', bail, { once: true })
      waiting.push(enter)
    })
  }

  async function once(key: TileKey, signal: AbortSignal): Promise<TileResult> {
    if (mode === 'direct') {
      try {
        return await viaDirect(key, signal)
      } catch (error) {
        if (signal.aborted) throw error
        if (!shouldFallBack(error)) throw error
        mode = 'backend'
      }
    }
    return viaBackend(key, signal)
  }

  return {
    name: () => (mode === 'direct' ? DIRECT_NAME : BACKEND_NAME),
    concurrency: limit,
    async fetch(key, signal) {
      await acquire(signal)
      try {
        return await once(key, signal)
      } finally {
        release()
      }
    },
  }
}

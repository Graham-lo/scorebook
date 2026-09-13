// 全屏那张图的行情源：外面只跟这一个门面说话。
//
// 图要的东西其实只有两句：「我现在看这一段」和「给我这一段能画的 bars」。格子怎
// 么切、谁先取、取回来放哪儿、直连还是走后端——都锁在这一层里面。换句话说，
// `trading-chart` 和 `market-view` 不认识桶，也不认识调度器。
//
// 窗口态那份数据不浪费：进全屏先 `seed()` 一次，被它完整盖住的格子就算取过了，
// 视野落在锚定段上时一根网络都不用发，人立刻看见图。

import { catalog } from '../../../api/history'
import { bounds as askBounds, boundsPrior } from '../../../api/market'
import type { Bar, ChartRequest, Market } from '../../../api/types'
import { sourcePool, type SourceDeps, type TileResult } from './sources'
import { scheduler, type Bounds, type Scheduler } from './scheduler'
import { tileStore, type SpaceKey, type TileStore } from './store'
import { unsupportedInterval } from './periods'
import { hot, type HotCache } from './store-idb'
import {
  TILE_BARS,
  mergeBars,
  tileIndex,
  tileKeyString,
  tileRange,
  type TileKey,
} from './tiles'

export interface FeedSpace {
  market: Market
  symbol: string
  /** 记录本身的周期。换档之后每一档各有各的格子。 */
  interval: string
  source?: ChartRequest['source']
}

export interface FeedWindow {
  bars: Bar[]
  /** 这一段连续行情的头尾（毫秒）。没有数据时两个都是 0。 */
  from: number
  to: number
  /** 这一档已知的上市时间；还没摸到就没有这个字段。 */
  floor?: number
  loadingLeft: boolean
  loadingRight: boolean
  failedLeft: boolean
  failedRight: boolean
  /** 这一段有多少根。 */
  loaded: number
}

export interface HistoryFeedDeps {
  sources?: Partial<SourceDeps>
  /** 上市 / 交割时间。默认问一次目录，失败当作「不知道」。 */
  bounds?: () => Promise<Bounds>
  now?: () => number
  store?: TileStore
  /** 24 小时热缓存。默认那一份是 IndexedDB；没有 IndexedDB 就是 null。 */
  hot?: HotCache | null
  /** 后端不认这个周期（走服务端那条路才会有）。周期条据此把那一颗置灰。 */
  onUnsupported?: (interval: string) => void
}

export interface HistoryFeed {
  seed(bars: readonly Bar[], interval?: string): void
  focus(level: string, fromMs: number, toMs: number, velocity: number): void
  window(level: string, fromMs: number, toMs: number): FeedWindow
  /** 指标预热要往左多铺多少根。 */
  warmup(bars: number): void
  onChange(cb: () => void): () => void
  retryFailed(): void
  /** 活的那一根收盘了：并进内存，从此它跟别的历史 bar 一样。 */
  commitClosed(bar: Bar, interval: string): void
  sourceName(): string
  /** 后端说的那几条边界（上市、交割、缺口）。还没问到就是 null。 */
  edges(): Bounds | null
  destroy(): void
}

const at = (iso: string): number => Date.parse(iso)

/**
 * 这个合约的边界先验。先问 `/v1/market/bounds`——它知道真正的第一根在哪、中间
 * 缺哪几段，比目录准；后端不认识这个合约（404）就退回目录那份。
 */
async function askEdges(space: FeedSpace, nowMs: number): Promise<Bounds> {
  try {
    const found = await askBounds({ market: space.market, symbol: space.symbol, interval: space.interval })
    if (found) {
      const prior = boundsPrior(found, nowMs)
      skew = prior.skewMs
      return {
        onboardMs: prior.onboardMs,
        deliveryMs: prior.deliveryMs,
        ...(prior.gaps.length ? { gaps: prior.gaps } : {}),
      }
    }
  } catch {
    /* 读不着就退回目录，和以前一样 */
  }
  return askCatalog(space)
}

/** 本机时钟和后端差了多少（本机 − 后端）。活的最新一根靠它校正「贴近现在」。 */
let skew = 0
export function serverSkewMs(): number { return skew }

/** 目录里这个合约的上市 / 交割时间；问不到就是两个 null，不当错误。 */
async function askCatalog(space: FeedSpace): Promise<Bounds> {
  const page = await catalog({ market: space.market, symbol: space.symbol })
  const found = page.items.find(
    (entry) => entry.symbol === space.symbol && entry.market === space.market,
  )
  if (!found) return { onboardMs: null, deliveryMs: null }
  const onboard = found.onboard_at ? Date.parse(found.onboard_at) : Number.NaN
  const delivery = found.delivery_at ? Date.parse(found.delivery_at) : Number.NaN
  return {
    onboardMs: Number.isFinite(onboard) ? onboard : null,
    deliveryMs: Number.isFinite(delivery) ? delivery : null,
  }
}

export function historyFeed(space: FeedSpace, deps: HistoryFeedDeps = {}): HistoryFeed {
  const store = deps.store ?? tileStore()
  const now = deps.now ?? (() => Date.now())
  const cache = deps.hot === undefined ? hot() : deps.hot
  // 进全屏先扫一遍：过期的清掉，占太多的按最久没碰过的淘汰。失败静默。
  void cache?.sweep(now())
  const pool = sourcePool(space, deps.sources ?? {})
  const listeners = new Set<() => void>()
  let dead = false
  let edges: Bounds | null = null
  const askOnce = deps.bounds ?? (() => askEdges(space, now()))

  const spaceAt = (level: string): SpaceKey => ({
    market: space.market,
    symbol: space.symbol,
    interval: level,
  })

  const tell = (): void => {
    for (const cb of [...listeners]) cb()
  }

  /** 把一格并进内存：同一根先到先得，已经是 complete 的不会被降级。 */
  function land(key: TileKey, result: TileResult): void {
    const had = store.get(key)
    const bars = had ? mergeBars(had.bars, result.bars) : result.bars.slice()
    const complete = (had?.complete ?? false) || result.complete
    store.set(key, {
      bars,
      complete,
      ...(result.hole ? { hole: result.hole } : had?.hole ? { hole: had.hole } : {}),
      fetchedAt: now(),
    })
  }

  const engine: Scheduler = scheduler(
    { market: space.market, symbol: space.symbol },
    {
      // 已经在内存里、而且问干净了的格子不再出门。窗口态 seed 进来的那几格走的
      // 就是这条路：进全屏第一帧不发任何请求。
      fetch: (key, signal) => {
        const had = store.get(key)
        if (had?.complete) {
          return Promise.resolve({
            bars: had.bars,
            complete: true,
            ...(had.hole ? { hole: had.hole } : {}),
          })
        }
        return fromCacheOrNet(key, signal)
      },
      concurrency: () => pool.concurrency(),
      bounds: () => askOnce().then((found) => { edges = found; return found }),
      now,
      onTile: (key, result) => {
        if (dead) return
        land(key, result)
        tell()
      },
      onFail: (key, error) => {
        if (dead) return
        if (unsupportedInterval(error)) deps.onUnsupported?.(key.interval)
        tell()
      },
      has: (key) => store.get(key) !== null,
    },
  )

  /**
   * 先问本机那份 24 小时热缓存，再出门。
   *
   * 命中的那一格直接当成刚取回来的结果交上去——调度器和内存 LRU 都不必知道它是
   * 从盘上读的。缓存里只有收盘了的整格，所以不存在「读到半根活的」这回事。
   */
  async function fromCacheOrNet(key: TileKey, signal: AbortSignal): Promise<TileResult> {
    const found = await cache?.read(key, now())
    if (found && found.bars.length) return { bars: found.bars, complete: found.complete }
    const result = await pool.fetch(key, signal)
    if (result.complete && !result.hole) void cache?.write(key, result, now())
    return result
  }

  /** 在途 / 失败的格子落在视野哪一边。中点比中点，永远只算一边。 */
  function sides(keys: readonly TileKey[], level: string, fromMs: number, toMs: number): {
    left: boolean
    right: boolean
  } {
    const middle = (fromMs + toMs) / 2
    let left = false
    let right = false
    for (const key of keys) {
      if (key.interval !== level) continue
      const { startMs, endMs } = tileRange(key.index, key.interval)
      if ((startMs + endMs) / 2 < middle) left = true
      else right = true
    }
    return { left, right }
  }

  return {
    seed(bars, interval) {
      const level = interval ?? space.interval
      if (!bars.length) return
      const groups = new Map<number, Bar[]>()
      for (const bar of bars) {
        const start = at(bar.start)
        if (!Number.isFinite(start)) continue
        const index = tileIndex(start, level)
        let bag = groups.get(index)
        if (!bag) { bag = []; groups.set(index, bag) }
        bag.push(bar)
      }
      // 只有被这段数据从头盖到尾的格子才算取过了；两端那两格还缺半截，留给调度器。
      const first = at(bars[0]!.start)
      const last = at(bars[bars.length - 1]!.end)
      for (const [index, bag] of groups) {
        const key: TileKey = { ...spaceAt(level), index }
        const { startMs, endMs } = tileRange(index, level)
        const whole = first <= startMs && last >= endMs
        const had = store.get(key)
        store.set(key, {
          bars: had ? mergeBars(had.bars, bag) : bag.slice(),
          complete: (had?.complete ?? false) || whole,
          ...(had?.hole ? { hole: had.hole } : {}),
          fetchedAt: now(),
        })
      }
      tell()
    },
    focus(level, fromMs, toMs, velocity) {
      if (dead) return
      engine.focus(level, fromMs, toMs, velocity)
    },
    warmup(count) { engine.warmup(count) },
    window(level, fromMs, toMs) {
      const bars = store.window(spaceAt(level), fromMs, toMs)
      const floor = engine.floorOf(level)
      const flying = sides(engine.loading(), level, fromMs, toMs)
      const broken = sides(engine.failed(), level, fromMs, toMs)
      return {
        bars,
        from: bars.length ? at(bars[0]!.start) : 0,
        to: bars.length ? at(bars[bars.length - 1]!.end) : 0,
        ...(floor === null ? {} : { floor }),
        loadingLeft: flying.left,
        loadingRight: flying.right,
        failedLeft: broken.left,
        failedRight: broken.right,
        loaded: bars.length,
      }
    },
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    retryFailed() { engine.retryFailed() },
    commitClosed(bar, interval) {
      if (dead) return
      const start = at(bar.start)
      if (!Number.isFinite(start)) return
      const key: TileKey = { ...spaceAt(interval), index: tileIndex(start, interval) }
      const had = store.get(key)
      if (!had) return
      store.set(key, {
        bars: mergeBars(had.bars, [bar]),
        complete: had.complete,
        ...(had.hole ? { hole: had.hole } : {}),
        fetchedAt: now(),
      })
      tell()
    },
    sourceName: () => pool.name(),
    edges: () => edges,
    destroy() {
      dead = true
      engine.stop()
      listeners.clear()
      store.clear()
    },
  }
}

export { TILE_BARS, tileKeyString }

// 谁先取、谁后取、谁不必取了。
//
// 人在图上拖，眼睛只在视野那一屏；再往前的两三屏是「马上就要看到的」，更远的是
// 「也许永远不看」。所以队列按优先级排：屏上缺的先补，再补两侧各一屏（行进方向
// 那一侧优先），速度不为零时再往前多铺两屏，最后才是给长周期指标预热的那一段。
//
// 拖得快的时候视野一秒钟换十几次，所以还有两条相反的规矩：同一格同时只在飞一次；
// 已经被甩到兴趣区之外的格子立刻取消——它的结果没人要了，占着并发就是在拖慢眼前
// 这一屏。
//
// 地板和天花板：某一档连着两格空、而它右边已经有数据，就说明左边到头了（上市之
// 前），从此不再往左发请求。目录里的 onboard_at / delivery_at 当先验用，能省掉
// 这一轮试探；读不到就忽略，靠空格子自己摸出来。天花板就是现在——活的最新一根是
// 二期的事。
//
// 这里一根网络都不发：fetch、时钟、先验全是注进来的，node 里能直接测。

import type { Market } from '../../../api/types'
import { barSpanMs, tileKeyString, tileRange, tilesBetween, type TileKey } from './tiles'
import type { TileResult } from './sources'

/** gap 不是永久的：中段缺口一小时后可以再试一次。 */
export const GAP_RETRY_MS = 3_600_000

export interface SchedulerSpace {
  market: Market
  symbol: string
}

export interface Bounds {
  onboardMs: number | null
  deliveryMs: number | null
  /** 后端说这几段本来就没有行情（停机、下架前的空窗）。登记成洞，别反复去要。 */
  gaps?: { startMs: number; endMs: number }[]
}

export interface SchedulerDeps {
  fetch(key: TileKey, signal: AbortSignal): Promise<TileResult>
  /** 直连 3 路、走后端 1 路；来源自己说了算。 */
  concurrency(): number
  /** 目录里的上市 / 交割时间。读不到给两个 null，不当成错误。 */
  bounds(): Promise<Bounds>
  now(): number
  onTile(key: TileKey, result: TileResult): void
  onFail(key: TileKey, error: unknown): void
  /** 这一格还在不在内存里（被 LRU 淘汰了就得重来）。 */
  has?(key: TileKey): boolean
}

type State = 'loading' | 'done' | 'failed' | 'gap'

export interface Scheduler {
  focus(level: string, fromMs: number, toMs: number, velocity: number): void
  /** 指标预热要往左多铺多少根。0 就是不铺。 */
  warmup(bars: number): void
  floorOf(level: string): number | null
  ceiling(): number
  loading(): TileKey[]
  failed(): TileKey[]
  retryFailed(): void
  stop(): void
}

export function scheduler(space: SchedulerSpace, deps: SchedulerDeps): Scheduler {
  const states = new Map<string, State>()
  const broken = new Map<string, TileKey>()
  const gapAt = new Map<string, number>()
  const flying = new Map<string, { key: TileKey; stop: AbortController }>()
  const floors = new Map<string, number>()
  const haveBars = new Map<string, Set<number>>()
  const empties = new Map<string, Set<number>>()
  const earliest = new Map<string, number>()
  let queue: TileKey[] = []
  let warmBars = 0
  let bounds: Bounds | null = null
  let asked = false
  let stopped = false
  let ignoreGaps = false
  let view: { level: string; from: number; to: number; velocity: number } | null = null

  const set = (map: Map<string, Set<number>>, level: string, index: number): void => {
    let bag = map.get(level)
    if (!bag) { bag = new Set(); map.set(level, bag) }
    bag.add(index)
  }

  function skip(key: TileKey): boolean {
    const id = tileKeyString(key)
    const state = states.get(id)
    if (state === 'loading') return true
    if (state === 'failed') return true
    if (state === 'done') return deps.has ? deps.has(key) : true
    if (state === 'gap') {
      const when = gapAt.get(id) ?? 0
      if (deps.now() - when < GAP_RETRY_MS) return true
      states.delete(id)
      return false
    }
    const { startMs, endMs } = tileRange(key.index, key.interval)
    const floor = floors.get(key.interval)
    if (floor !== undefined && endMs <= floor) return true
    if (bounds?.onboardMs != null && endMs <= bounds.onboardMs) return true
    if (bounds?.deliveryMs != null && startMs >= bounds.deliveryMs) return true
    if (startMs >= deps.now()) return true
    // 后端报过的缺口：整格都落在缺口里就别去要了。按「重试」会把这份名单清掉。
    if (!ignoreGaps) for (const gap of bounds?.gaps ?? []) {
      if (startMs >= gap.startMs && endMs <= gap.endMs) return true
    }
    return false
  }

  /** 想要哪几格，按优先级从高到低排好。 */
  function wanted(level: string, from: number, to: number, velocity: number): TileKey[] {
    const span = Math.max(barSpanMs(level), to - from)
    const seen = new Set<number>()
    const out: TileKey[] = []
    const push = (a: number, b: number): void => {
      for (const index of tilesBetween(a, b, level)) {
        if (seen.has(index)) continue
        seen.add(index)
        out.push({ market: space.market, symbol: space.symbol, interval: level, index })
      }
    }
    push(from, to)
    if (velocity >= 0) { push(to, to + span); push(from - span, from) }
    else { push(from - span, from); push(to, to + span) }
    if (velocity > 0) push(to + span, to + 3 * span)
    else if (velocity < 0) push(from - 3 * span, from - span)
    if (warmBars > 0) push(from - warmBars * barSpanMs(level), from)
    return out
  }

  /** 兴趣区：可见加三屏。出了这个范围的在途请求没人要了。 */
  function interest(): { from: number; to: number } | null {
    if (!view) return null
    const span = Math.max(barSpanMs(view.level), view.to - view.from)
    return { from: view.from - 3 * span, to: view.to + 3 * span }
  }

  function cancelStrays(): void {
    const zone = interest()
    for (const [id, entry] of [...flying]) {
      const outside = !zone || entry.key.interval !== view?.level
        || tileRange(entry.key.index, entry.key.interval).endMs < zone.from
        || tileRange(entry.key.index, entry.key.interval).startMs > zone.to
      if (!outside) continue
      flying.delete(id)
      states.delete(id)
      entry.stop.abort()
    }
  }

  function land(key: TileKey, result: TileResult): void {
    const level = key.interval
    if (result.bars.length) {
      set(haveBars, level, key.index)
      const first = Date.parse((result.bars[0] as { start: string }).start)
      const known = earliest.get(level)
      if (Number.isFinite(first) && (known === undefined || first < known)) earliest.set(level, first)
      empties.get(level)?.delete(key.index)
    } else {
      set(empties, level, key.index)
    }
    considerFloor(level)
  }

  /** 连着两格空、右边又确实有数据，左边就到头了。 */
  function considerFloor(level: string): void {
    const have = haveBars.get(level)
    const empty = empties.get(level)
    if (!have?.size || !empty?.size) return
    if (floors.has(level)) return
    const min = Math.min(...have)
    if (!empty.has(min - 1) || !empty.has(min - 2)) return
    floors.set(level, earliest.get(level) ?? tileRange(min, level).startMs)
  }

  function start(key: TileKey): void {
    const id = tileKeyString(key)
    const stop = new AbortController()
    states.set(id, 'loading')
    flying.set(id, { key, stop })
    deps.fetch(key, stop.signal).then((result) => {
      if (stopped || !flying.has(id)) return
      flying.delete(id)
      broken.delete(id)
      if (result.hole === 'gap') { states.set(id, 'gap'); gapAt.set(id, deps.now()) }
      else states.set(id, 'done')
      land(key, result)
      deps.onTile(key, result)
      pump()
    }).catch((error: unknown) => {
      if (stopped || !flying.has(id)) return
      flying.delete(id)
      if (stop.signal.aborted) { states.delete(id); return }
      states.set(id, 'failed')
      broken.set(id, key)
      deps.onFail(key, error)
      pump()
    })
  }

  function pump(): void {
    if (stopped) return
    const limit = Math.max(1, deps.concurrency())
    while (flying.size < limit) {
      const key = queue.shift()
      if (!key) break
      if (skip(key)) continue
      start(key)
    }
  }

  function replan(): void {
    if (stopped || !view) { queue = []; return }
    queue = wanted(view.level, view.from, view.to, view.velocity).filter((key) => !skip(key))
    pump()
  }

  return {
    focus(level, fromMs, toMs, velocity) {
      if (stopped) return
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !(toMs > fromMs)) {
        // 空视野 = 先停一停（退出全屏就是这样），在途的留着，不再排新的。
        view = null
        queue = []
        return
      }
      view = { level, from: fromMs, to: toMs, velocity }
      if (!asked) {
        asked = true
        deps.bounds().then((found) => {
          if (stopped) return
          bounds = found
          if (found.onboardMs != null && view) floors.set(view.level, found.onboardMs)
          replan()
        }).catch(() => { /* 先验读不到就靠空格子自己摸，不算错误 */ })
      }
      cancelStrays()
      replan()
    },
    warmup(bars) { warmBars = Math.max(0, Math.floor(bars)) },
    floorOf(level) {
      const own = floors.get(level)
      if (own !== undefined) return own
      return bounds?.onboardMs ?? null
    },
    ceiling: () => deps.now(),
    loading: () => [...flying.values()].map((entry) => entry.key),
    failed: () => [...broken.values()],
    retryFailed() {
      for (const id of broken.keys()) states.delete(id)
      broken.clear()
      // 「重试」连后端报过的缺口一起再试一次：那份名单只是先验，可能已经补上了。
      ignoreGaps = true
      replan()
    },
    stop() {
      stopped = true
      for (const entry of flying.values()) entry.stop.abort()
      flying.clear()
      queue = []
    },
  }
}

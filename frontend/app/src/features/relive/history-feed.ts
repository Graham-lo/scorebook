// 窗口态那张图往前预热用的一条链：只往前接，接够就停。
//
// 开着 MA256 这类长周期指标的时候，锚定段左边那半屏本来是空的——这里按 1900 根
// 一页往前串行地要，把左边补齐。并发打过去只会把限流撞出来，而且拼接顺序还得自
// 己收拾。取回来的每一页按开盘时间并进同一条升序数组，重叠的那几根按时间去重，
// 谁先来的算谁。
//
// 什么时候停：要够了，或者某一页一根都没有（再往前就是上市之前），或者目录里的
// onboard_at 已经到了。全屏那条「从上市到现在」的懒加载不在这里，在 `history/`。

import { catalog as catalogPage } from '../../api/history'
import { ApiError } from '../../api/errors'
import { data as marketData } from '../../api/market'
import type { RequestOptions } from '../../api/http'
import type { Bar, ChartRequest, MarketData } from '../../api/types'
import { historyStart } from '../../data/chart-window'

/** 一页要多少根。后端的上限是 2000，留一点余量。 */
export const PAGE = 1900

export interface Feed {
  /** 连续、按时间升序。 */
  bars: Bar[]
  /** 让匹配区间起点之前至少有 count 根（到上市或者没数据为止）。 */
  ensureBefore(count: number, signal: AbortSignal): Promise<void>
  /** 已知最早的那一根（上市日）。 */
  earliest: string | null
  /** 前面已经没有了。 */
  exhaustedBefore: boolean
}

/** 取数这两件事可以换掉，纯逻辑就能单测。 */
export interface FeedDeps {
  fetch: (request: ChartRequest, opts: RequestOptions) => Promise<MarketData>
  onboard: (
    filter: { symbol: string; market: ChartRequest['market'] },
    opts: RequestOptions,
  ) => Promise<string | null>
}

const defaults: FeedDeps = {
  fetch: (request, opts) => marketData(request, opts),
  onboard: async (filter, opts) => {
    const page = await catalogPage(filter, opts)
    const hit = page.items.find((item) => item.symbol === filter.symbol) ?? page.items[0]
    return hit?.onboard_at ?? null
  },
}

const at = (iso: string): number => Date.parse(iso)

/** 两条升序数组并成一条，时间相同的保留已有的那一根。 */
function merge(have: Bar[], incoming: Bar[]): Bar[] {
  if (!incoming.length) return have
  const fresh = [...incoming].sort((a, b) => at(a.start) - at(b.start))
  const out: Bar[] = []
  let i = 0
  let j = 0
  let last = Number.NEGATIVE_INFINITY
  while (i < have.length || j < fresh.length) {
    const a = have[i]
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

export function feed(request: ChartRequest, initial: MarketData, deps: FeedDeps = defaults): Feed {
  let bars = merge([], initial.bars)
  let exhaustedBefore = false
  let floor: number | null = null
  let askedOnboard = false
  let running: Promise<void> | null = null

  const matchStart = at(request.start_at)
  // 候选带来的 chart_request 里有 match_end_at（截止线）。翻页要的区间在它之外，
  // 后端会按 invalid_match_boundary 拒掉，所以翻页一律不带截止线。
  const { match_end_at: _cutoff, ...page } = request
  void _cutoff

  const countBefore = (): number => bars.filter((bar) => at(bar.start) < matchStart).length

  async function askOnboard(signal: AbortSignal): Promise<void> {
    if (askedOnboard) return
    askedOnboard = true
    try {
      const found = await deps.onboard({ symbol: request.symbol, market: request.market }, { signal })
      if (found) floor = at(found)
    } catch {
      /* 目录读不着就靠空页判断，不当成错误 */
    }
  }

  /** 往前要一页。返回这一页有没有带回新的一根。 */
  async function pageBefore(signal: AbortSignal): Promise<boolean> {
    const first = bars[0]
    if (!first) return false
    const end = first.start
    let start = historyStart(end, request.interval, PAGE)
    if (floor !== null && at(start) < floor) start = new Date(floor).toISOString()
    if (at(start) >= at(end)) {
      exhaustedBefore = true
      return false
    }
    let got: MarketData
    try {
      got = await deps.fetch({ ...page, start_at: start, end_at: end }, { signal })
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ApiError) {
        exhaustedBefore = true
      }
      throw error
    }
    const before = bars.length
    bars = merge(bars, got.bars.filter((bar) => at(bar.start) < at(end)))
    const grew = bars.length > before
    if (!grew) exhaustedBefore = true
    if (floor !== null && bars[0] && at(bars[0].start) <= floor) exhaustedBefore = true
    return grew
  }

  /** 一次只跑一条取数链：两处同时要（预热和懒加载）就排队。 */
  function queue(work: () => Promise<void>): Promise<void> {
    const next = (running ?? Promise.resolve()).catch(() => {}).then(work)
    running = next.catch(() => {})
    return next
  }

  async function ensureBefore(count: number, signal: AbortSignal): Promise<void> {
    return queue(async () => {
      await askOnboard(signal)
      while (countBefore() < count && !exhaustedBefore) {
        signal.throwIfAborted()
        if (!(await pageBefore(signal))) return
      }
    })
  }

  return {
    get bars() {
      return bars
    },
    get earliest() {
      return bars[0]?.start ?? null
    },
    get exhaustedBefore() {
      return exhaustedBefore
    },
    ensureBefore,
  }
}

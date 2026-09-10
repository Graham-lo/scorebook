// 把一张截图钉到真实行情的某一段上。
//
// 钉过一次就长期存着（`attachment_locations`），以后重温直接读它，不再按图找。
// 所以这里只做一件事：确认这张图在哪一段，写下来。没人点「就是这一段」就什么
// 都不写——猜错一段行情比没有更糟。
//
// 顺序固定，同一时刻只有一条匹配在跑（规格 §2.3）：
//   1. 已经有位置 → 什么都不发起，直接显示钉在哪；
//   2. 没有位置 → 先问后端这张图的定位任务（GET locate）。在跑就每 2 秒问一次；
//   3. 任务跑完但拿不准 → 把它给的前三段画成小图，让人点一段；拿不出候选就直说；
//   4. 从来没跑过、或者上次没找着 → 人按「钉到真实行情」才 POST 一次，回到第 2 步。
//
// 定位只走这两条路由。认图（chart.analyze）和自己起检索（chart.startSearch）
// 都不再用在定位上——那是「找相似形态」页面的事。

import { isHistoryCandidate, type HistoryCandidate, type SearchCandidate } from '../../api/chart'
import { Latest, WriteAction } from '../../api/http'
import { data as marketData } from '../../api/market'
import {
  deleteLocation,
  getLocate,
  postLocate,
  putLocation,
  type AttachmentLocation,
  type LocateJob,
  type LocateState,
  type LocationInput,
} from '../../api/replay'
import type { Attachment, Bar, CallDetail, ChartRequest } from '../../api/types'
import { INTERVALS, MARKET_LABELS } from '../../data/session'
import { utcRange } from '../../data/time'
import { h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { problem, toast } from '../../ui/toast'
import { miniCandles } from './candles'

const MOVING = ['queued', 'running', 'retry_wait']

export interface LocateOptions {
  call: CallDetail
  attachment: Attachment
  /** 后端说这张图正有一条定位任务在跑：进来就是「正在按图找位置」。 */
  pending?: boolean
  /** 钉上或者撤销之后回调。null 表示撤销。 */
  onChange: (location: AttachmentLocation | null) => void
}

export interface LocatePanel {
  node: HTMLElement
  /** 看一眼这张图有没有位置、有没有任务在跑。不会自己开新任务。 */
  start: () => void
  destroy: () => void
}

type Phase =
  | { at: 'idle' }
  | { at: 'working' }
  | { at: 'picked'; items: HistoryCandidate[]; runId: string | null }
  | { at: 'nomatch' }
  | { at: 'failed'; line: string }

export function locatePanel(options: LocateOptions): LocatePanel {
  const { call, attachment } = options
  let phase: Phase = options.pending ? { at: 'working' } : { at: 'idle' }
  let location = attachment.location ?? null
  const interval = pickInterval(call)
  let alive = true
  let polling = 0
  const lane = new Latest()
  const writeAction = new WriteAction()
  const locateAction = new WriteAction()

  const node = h('div.rlv-locate')

  function repaint(): void {
    if (!alive) return
    node.replaceChildren(...body())
    stagger(node.children, 6)
  }

  function body(): HTMLElement[] {
    if (location) {
      const row = h(
        'div.rlv-lrow',
        {},
        h('span.rlv-lok', { text: '已钉到' }),
        h('span.mono', { text: `${location.symbol} · ${location.interval}` }),
        h('span.mono.faint', { text: `${utcRange(location.start_at, location.end_at)} UTC` }),
      )
      if (location.matched_by === 'auto') row.appendChild(h('span.rlv-lauto', { text: '自动' }))
      row.appendChild(h('button.btn.sm.ghost', { text: '撤销', on: { click: () => void undo() } }))
      return [row]
    }
    if (phase.at === 'working') {
      return [h('div.rlv-lrow', {}, h('i.rlv-spin'), h('span', { text: '正在按图找位置' }))]
    }
    if (phase.at === 'failed') {
      return [
        h(
          'div.rlv-lrow',
          {},
          h('span.rlv-lbad', { text: phase.line }),
          h('button.btn.sm', { text: '再找一次', on: { click: () => void run(true) } }),
        ),
      ]
    }
    if (phase.at === 'nomatch') {
      return [
        h(
          'div.rlv-lrow',
          {},
          h('span', { text: '公开历史里没有对得上的一段。' }),
          h('button.btn.sm.ghost', { text: '再找一次', on: { click: () => void run(true) } }),
        ),
      ]
    }
    if (phase.at === 'picked') {
      const run0 = phase
      const list = h('div.rlv-cands')
      run0.items.forEach((item, index) => {
        list.appendChild(candidate(item, index, run0.runId))
      })
      return [
        h(
          'div.rlv-lrow',
          {},
          h('span', { text: '哪一段是这张图？' }),
          // 三段都不是的时候要有路走：再让后端找一次，而不是被迫钉一段错的。
          h('button.btn.sm.ghost', { text: '都不是', on: { click: () => void run(true) } }),
        ),
        list,
      ]
    }
    return [
      h(
        'div.rlv-lrow',
        {},
        h('button.btn.sm.primary', { text: '钉到真实行情', on: { click: () => void run(true) } }),
        interval ? h('span.rlv-lmeta.mono', { text: interval }) : null,
      ),
    ]
  }

  function candidate(item: HistoryCandidate, index: number, runId: string | null): HTMLElement {
    const chart = h('div.rlv-cchart')
    void drawCandidate(item, chart)
    return h(
      'div.rlv-cand',
      { style: `--i:${index}` },
      h(
        'div.rlv-chead',
        {},
        h('span.rank', { text: `#${index + 1}` }),
        h('b.mono', { text: item.symbol }),
        h('span.mono.faint', { text: `${MARKET_LABELS[item.market]} · ${item.interval}` }),
      ),
      chart,
      h('div.rlv-cwhen.mono', { text: `${utcRange(item.start_at, item.end_at)} UTC` }),
      h('button.btn.sm.primary', {
        text: '就是这一段',
        on: { click: (e) => void confirm(item, runId, e.currentTarget as HTMLButtonElement) },
      }),
    )
  }

  async function drawCandidate(item: HistoryCandidate, host: HTMLElement): Promise<void> {
    const request: ChartRequest = item.chart_request ?? {
      symbol: item.symbol,
      market: item.market,
      interval: item.interval,
      start_at: item.start_at,
      end_at: item.end_at,
      source: item.market_source,
    }
    try {
      const result = await marketData(request)
      if (!alive || !host.isConnected) return
      const bars: Bar[] = result.bars ?? []
      if (!bars.length) return
      host.replaceChildren(miniCandles(bars) as unknown as HTMLElement)
    } catch {
      if (!alive) return
      host.replaceChildren(h('span.rlv-cfail', { text: '这一段行情暂时取不到' }))
    }
  }

  async function confirm(
    item: HistoryCandidate,
    runId: string | null,
    button: HTMLButtonElement,
  ): Promise<void> {
    const input: LocationInput = {
      symbol: item.symbol,
      market: item.market,
      interval: item.interval,
      start_at: item.start_at,
      end_at: item.end_at,
      bars_count: item.bars_count,
      source: item.market_source,
      ...(item.match ? { score: item.match.score } : {}),
      ...(runId ? { search_run_id: runId } : {}),
    }
    button.disabled = true
    try {
      const saved = await putLocation(attachment.id, input, writeAction.keyFor(input))
      writeAction.reset()
      if (!alive) return
      settle(saved)
      toast('已钉到这一段行情。')
    } catch (error) {
      button.disabled = false
      if (!alive) return
      problem(error instanceof Error ? error.message : '没有写进去。')
    }
  }

  async function undo(): Promise<void> {
    try {
      await deleteLocation(attachment.id)
      if (!alive) return
      location = null
      phase = { at: 'idle' }
      repaint()
      options.onChange(null)
    } catch (error) {
      if (!alive) return
      problem(error instanceof Error ? error.message : '没有撤销成功。')
    }
  }

  function settle(saved: AttachmentLocation): void {
    location = saved
    phase = { at: 'idle' }
    repaint()
    options.onChange(saved)
  }

  function start(): void {
    if (phase.at === 'working' && polling > 0) return
    void run(false)
  }

  /** manual 表示这一次是人按的：只有人按了才会让后端新开一次匹配。 */
  async function run(manual: boolean): Promise<void> {
    if (location) return
    const mine = ++polling
    const signal = lane.begin()
    const current = () => alive && mine === polling && !signal.aborted

    phase = { at: 'working' }
    repaint()
    let state: LocateState
    try {
      state = await getLocate(attachment.id, { signal })
    } catch (error) {
      if (Latest.aborted(error) || !current()) return
      phase = { at: 'failed', line: error instanceof Error ? error.message : '没有问到。' }
      repaint()
      return
    }
    await follow(state, manual, current, signal)
  }

  async function follow(
    state: LocateState,
    manual: boolean,
    current: () => boolean,
    signal: AbortSignal,
  ): Promise<void> {
    if (!current()) return
    if (state.location) {
      settle(state.location)
      return
    }
    const job = state.job
    if (job && MOVING.includes(job.status)) {
      // 已经有一条在跑（POST 回来 deduplicated 的也是这一条），只盯着它，不再开第二条。
      await watch(current, signal)
      return
    }
    if (job && !manual) {
      settleJob(job)
      return
    }
    if (!manual) {
      phase = { at: 'idle' }
      repaint()
      return
    }
    phase = { at: 'working' }
    repaint()
    try {
      const started = await postLocate(attachment.id, locateAction.keyFor({ id: attachment.id }), {
        signal,
      })
      locateAction.reset()
      if (!current()) return
      await follow(started, false, current, signal)
    } catch (error) {
      if (Latest.aborted(error) || !current()) return
      phase = { at: 'failed', line: error instanceof Error ? error.message : '没有开始找。' }
      repaint()
    }
  }

  async function watch(current: () => boolean, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (!current()) return
      phase = { at: 'working' }
      repaint()
      await sleep(2_000)
      if (!current()) return
      let state: LocateState
      try {
        state = await getLocate(attachment.id, { signal })
      } catch (error) {
        if (Latest.aborted(error) || !current()) return
        continue
      }
      if (!current()) return
      if (state.location) {
        settle(state.location)
        return
      }
      const job = state.job
      if (job && MOVING.includes(job.status)) continue
      settleJob(job)
      return
    }
  }

  /** 任务到终态了：有候选就让人挑，没候选就把这个事实说出来。 */
  function settleJob(job: LocateJob | null): void {
    const items = ambiguous(job)
    if (items.length) {
      phase = { at: 'picked', items, runId: runIdOf(job) }
      repaint()
      return
    }
    if (job && job.status !== 'succeeded') {
      phase = { at: 'failed', line: job.error_code ?? '这一次没有找完。' }
      repaint()
      return
    }
    phase = { at: 'nomatch' }
    repaint()
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  repaint()

  return {
    node,
    start,
    destroy: () => {
      alive = false
      polling += 1
      lane.cancel()
    },
  }
}

/** 任务跑完但拿不准的时候，后端把前三段放在 result.candidates 里。 */
function ambiguous(job: LocateJob | null): HistoryCandidate[] {
  const list = job?.result?.candidates
  if (!Array.isArray(list)) return []
  return (list as SearchCandidate[]).filter(isHistoryCandidate).slice(0, 3)
}

function runIdOf(job: LocateJob | null): string | null {
  const value = job?.result?.['search_run_id']
  return typeof value === 'string' ? value : null
}

function pickInterval(call: CallDetail): string | null {
  const value = call.timeframe ?? call.body.timeframe ?? null
  return value && (INTERVALS as readonly string[]).includes(value) ? value : null
}

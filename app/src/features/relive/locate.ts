// 把一张截图钉到真实行情的某一段上。
//
// 钉过一次就长期存着（`attachment_locations`），以后重温直接读它，不再按图找。
// 所以这里只做一件事：确认这张图在哪一段，写下来。没人点「就是这一段」就什么
// 都不写——猜错一段行情比没有更糟。
//
// 一条记录上挂的几张图未必是同一个品种：SK 海力士那条挂了三张 1h 图，另外两张
// 是同板块的对比图（闪迪、美光）。按记录的品种去定位，那两张必然钉错一段。
// 所以每张图自己说清楚要找什么：
//   · 品种、市场、周期各有一个选择器，缺省是这条记录的那一个，可以改；
//   · 对比图可以标成参考图，标了就不再参与自动定位（要手动钉还是能钉）。
//
// 顺序固定，同一时刻只有一条匹配在跑（规格 §2.3）：
//   1. 已经有位置 → 什么都不发起，直接显示钉在哪；
//   2. 没有位置 → 先问后端这张图的定位任务（GET locate）。在跑就每 2 秒问一次；
//   3. 任务跑完但拿不准 → 把它给的前三段画成小图，让人点一段；拿不出候选就直说；
//   4. 从来没跑过、或者上次没找着 → 人按「钉到真实行情」才 POST 一次，回到第 2 步。
//
// 定位只走这两条路由。认图（chart.analyze）和自己起检索（chart.startSearch）
// 都不再用在定位上——那是「找相似形态」页面的事。

import { patchKind } from '../../api/attachments'
import { isHistoryCandidate, type HistoryCandidate, type SearchCandidate } from '../../api/chart'
import { ApiError } from '../../api/errors'
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
import type { Attachment, Bar, CallDetail, ChartRequest, Market } from '../../api/types'
import { INTERVALS, MARKET_LABELS, cached, findInstruments } from '../../data/session'
import { utcRange } from '../../data/time'
import { h } from '../../ui/dom'
import { attachmentImage } from '../../ui/media'
import { stagger } from '../../ui/motion'
import { popChip, type PopItem } from '../../ui/pop'
import { foldout } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { miniCandles } from './candles'

const MOVING = ['queued', 'running', 'retry_wait']

/** 这张图要按什么去找。缺省跟着记录走，人可以逐项改。 */
export interface LocateTarget {
  symbol: string
  market: Market
  interval: string
}

export interface LocateOptions {
  call: CallDetail
  attachment: Attachment
  /** 后端说这张图正有一条定位任务在跑：进来就是「正在按图找位置」。 */
  pending?: boolean
  /** 参考图：不自动找，手动那一排也收起来。 */
  quiet?: boolean
  /** 钉上或者撤销之后回调。null 表示撤销。 */
  onChange: (location: AttachmentLocation | null) => void
  /** 身份改了（现场图 ↔ 参考图）。 */
  onKind?: (attachment: Attachment) => void
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
  let kind = attachment.kind
  const target: LocateTarget = {
    symbol: location?.symbol ?? call.instrument ?? '',
    market: location?.market ?? call.market ?? 'usd_m',
    interval: location?.interval ?? pickInterval(call) ?? '1h',
  }
  let alive = true
  let polling = 0
  const lane = new Latest()
  const writeAction = new WriteAction()
  const locateAction = new WriteAction()
  const kindAction = new WriteAction()

  const node = h('div.rlv-locate')

  function repaint(): void {
    if (!alive) return
    node.replaceChildren(...body())
    stagger(node.children, 6)
  }

  /* ------------------------------------------------------- 找什么 */

  /** 品种、市场、周期三个选择器。改了只影响下一次「找位置」。 */
  function targetRow(): HTMLElement {
    const row = h('div.rlv-ltarget')
    row.appendChild(h('span.rlv-slabel', { text: '按' }))
    row.appendChild(
      popChip({
        label: () => target.symbol || '选品种',
        active: () => Boolean(target.symbol),
        search: '搜合约，比如 SKHYUSDT',
        items: async (query) => {
          const found = await findInstruments(query, { market: target.market })
          const rows: PopItem[] = found.map((item) => ({
            label: item.symbol,
            value: item.symbol,
            hint: MARKET_LABELS[item.market],
            on: item.symbol === target.symbol,
          }))
          return rows.length ? rows : [{ label: '没有匹配的合约', value: '' }]
        },
        onPick: (value) => {
          if (!value) return
          target.symbol = value
          // 目录里这个合约挂在哪个市场，市场就跟着走，不让人再猜一次。
          const found = cached(value)
          if (found) target.market = found.market
          repaint()
        },
      }).node,
    )
    row.appendChild(
      popChip({
        label: () => MARKET_LABELS[target.market],
        active: () => true,
        items: () => [
          { label: MARKET_LABELS.usd_m, value: 'usd_m', on: target.market === 'usd_m' },
          { label: MARKET_LABELS.coin_m, value: 'coin_m', on: target.market === 'coin_m' },
        ],
        onPick: (value) => {
          target.market = value as Market
          repaint()
        },
      }).node,
    )
    row.appendChild(
      popChip({
        label: () => target.interval,
        active: () => true,
        items: () =>
          INTERVALS.map((value) => ({ label: value, value, on: value === target.interval })),
        onPick: (value) => {
          target.interval = value
          repaint()
        },
        footer: () => '截图上是哪个周期就选哪个，和记录写的周期可以不一样。',
      }).node,
    )
    return row
  }

  /** 现场图 ↔ 参考图。参考图不参与自动定位。 */
  function kindButton(): HTMLElement | null {
    if (kind !== 'scene' && kind !== 'reference') return null
    const toReference = kind === 'scene'
    const button = h('button.btn.sm.ghost', {
      text: toReference ? '标为参考图' : '改回场景图',
      on: {
        click: () => {
          button.disabled = true
          const next = toReference ? 'reference' : 'scene'
          void patchKind(attachment.id, next, { idempotencyKey: kindAction.keyFor({ id: attachment.id, kind: next }) })
            .then((saved) => {
              kindAction.reset()
              if (!alive) return
              kind = saved.kind
              toast(next === 'reference' ? '这张图不再自动定位了。' : '这张图回到场景图。')
              options.onKind?.(saved)
              repaint()
            })
            .catch((error: unknown) => {
              if (!alive) return
              button.disabled = false
              // 后端还没上这条路由的时候照实说，不要装作改好了。
              if (error instanceof ApiError && error.status === 404) {
                problem('后端还没有「改图片身份」这条接口，等它上线再试。')
                return
              }
              problem(error instanceof Error ? error.message : '这张图的身份没有改成。')
            })
        },
      },
    }) as HTMLButtonElement
    return button
  }

  function body(): HTMLElement[] {
    const tail = kindButton()
    if (location) {
      const row = h(
        'div.rlv-lrow',
        {},
        h('span.rlv-lok', { text: '已钉到' }),
        h('span.mono', { text: `${location.symbol} · ${location.interval}` }),
        h('span.mono.faint', { text: `${utcRange(location.start_at, location.end_at)} UTC` }),
      )
      if (location.matched_by === 'auto') row.appendChild(h('span.rlv-lauto', { text: '自动' }))
      // 钉错了（比如对比图按记录品种钉上了）要能撤：撤了才好换个品种重钉。
      row.appendChild(h('button.btn.sm.ghost', { text: '取消钉住', on: { click: () => void undo() } }))
      if (tail) row.appendChild(tail)
      return [row]
    }
    if (phase.at === 'working') {
      const row = h('div.rlv-lrow', {}, h('i.rlv-spin'), h('span', { text: '正在按图找位置' }))
      return [row]
    }
    if (phase.at === 'failed') {
      return [
        h(
          'div.rlv-lrow',
          {},
          h('span.rlv-lbad', { text: phase.line }),
          h('button.btn.sm', { text: '再找一次', on: { click: () => void run(true) } }),
          tail,
        ),
        targetRow(),
      ]
    }
    if (phase.at === 'nomatch') {
      return [
        h(
          'div.rlv-lrow',
          {},
          h('span', { text: '公开历史里没有对得上的一段。' }),
          h('button.btn.sm.ghost', { text: '再找一次', on: { click: () => void run(true) } }),
          tail,
        ),
        targetRow(),
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
          tail,
        ),
        list,
      ]
    }
    const go = h('div.rlv-lrow', {}, h('button.btn.sm.primary', { text: '钉到真实行情', on: { click: () => void run(true) } }), tail)
    // 参考图平时不劝人去定位，入口收在一层折叠里。
    if (options.quiet) return [foldout('手动钉这张图', targetRow(), go)]
    return [go, targetRow()]
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
      ...(item.match ? { score: String(item.match.score) } : {}),
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
      // 这张图要按哪个品种、哪个周期找，一起发过去；后端认不认新字段都不影响
      // 旧行为——不填就是记录自己的品种。
      const wanted = target.symbol ? { ...target } : null
      const started = await postLocate(
        attachment.id,
        locateAction.keyFor({ id: attachment.id, ...(wanted ?? {}) }),
        wanted,
        { signal },
      )
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

/* --------------------------------------------------------------- 一整块 */

export interface LocateBoardOptions {
  call: CallDetail
  /** 后端说这条记录正有定位任务在跑。 */
  pending?: boolean
  /** 自动去看一眼没钉住的场景图。 */
  auto?: boolean
  /** 哪些图已经在这次会话里问过了，别重复问。 */
  asked?: Set<string>
  /** 位置或者身份变了：这一段窗口要重新取。 */
  onChange: () => void
}

export interface LocateBoard {
  node: HTMLElement
  destroy: () => void
}

/**
 * 一条记录上所有图片的定位板。
 *
 * 分三堆，因为它们要的动作不一样：
 *   · 还没钉住的现场图——这一堆才自动去找；
 *   · 已经钉住的——只需要看一眼钉在哪，钉错了能取消；
 *   · 参考图——同板块的对比图，不定位；想钉还是能手动钉，入口收起来。
 */
export function locateBoard(options: LocateBoardOptions): LocateBoard {
  const { call } = options
  const panels: LocatePanel[] = []
  const node = h('div.rlv-board')

  const shots = call.attachments.filter((a) => a.kind === 'scene' || a.kind === 'reference')
  if (!shots.length) return { node, destroy: () => undefined }

  const scenes = shots.filter((a) => a.kind === 'scene')
  const references = shots.filter((a) => a.kind === 'reference')
  const waiting = scenes.filter((a) => !a.location)
  const pinned = scenes.filter((a) => a.location)

  function card(shot: Attachment, quiet: boolean): HTMLElement {
    const panel = locatePanel({
      call,
      attachment: shot,
      pending: options.pending && !shot.location && shot.kind === 'scene',
      quiet,
      onChange: () => options.onChange(),
      onKind: () => options.onChange(),
    })
    panels.push(panel)
    if (
      options.auto &&
      shot.kind === 'scene' &&
      !shot.location &&
      (options.pending || !options.asked?.has(shot.id))
    ) {
      options.asked?.add(shot.id)
      panel.start()
    }
    return h(
      'div.rlv-bcard',
      {},
      h(
        'div.rlv-bthumb',
        {},
        attachmentImage(shot.id, {
          alt: shot.kind === 'reference' ? '参考图' : '这条记录的图',
          ratio: { width: shot.width, height: shot.height },
          maxWidth: 180,
          lazy: false,
        }),
      ),
      panel.node,
    )
  }

  function group(title: string, note: string | null, list: Attachment[], quiet: boolean): void {
    if (!list.length) return
    const box = h(
      'div.rlv-bgroup',
      {},
      h('div.rlv-bhead', {}, h('b', { text: title }), note ? h('span.faint', { text: note }) : null),
    )
    for (const shot of list) box.appendChild(card(shot, quiet))
    node.appendChild(box)
  }

  group('还没钉住', waiting.length > 1 ? '一张一张来，钉错了可以取消' : null, waiting, false)
  group('已钉住', null, pinned, false)
  group('参考图不定位', '同板块的对比图，不按这条记录的品种去找', references, true)

  return {
    node,
    destroy: () => {
      for (const panel of panels) panel.destroy()
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

export function pickInterval(call: CallDetail): string | null {
  const value = call.timeframe ?? call.body.timeframe ?? null
  return value && (INTERVALS as readonly string[]).includes(value) ? value : null
}

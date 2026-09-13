// 对上行情 —— 把一张截图对到真实行情的某一段上。
//
// 对上一次就长期存着（`attachment_locations`），以后重温直接读它，不再按图找。
// 所以这里只写人确认过的那一段：猜错一段行情比没有更糟。
//
// 一条记录上挂的几张图未必是同一个品种：SK 海力士那条挂了三张 1h 图，另外两张
// 是同板块的对比图（闪迪、美光）。所以每张图自己说清楚要按什么去找——品种、
// 市场、周期、最后一根的时间，四样都能改。
//
// 顺序固定，同一时刻只有一条匹配在跑：
//   1. 已经对上 → 只显示对在哪，可以解开；
//   2. 没对上 → 问后端这张图的定位任务（GET locate）。在跑就每 2 秒问一次；
//   3. 任务给出候选 → 摆出来让人点「就是这段」；
//   4. 认不出、或者候选都不对 → 人自己填，右边拿真实 K 线对照。

import { locateCandidates, type LocateCandidate } from '../../data/locate-candidates'
import { Latest, WriteAction } from '../../api/http'
import { data as marketData } from '../../api/market'
import {
  deleteLocation,
  getLocate,
  postLocate,
  putLocation,
  previewLocation,
  type AttachmentLocation,
  type LocateAnchors,
  type LocateJob,
  type LocateState,
  type LocationInput,
} from '../../api/replay'
import type { Attachment, Bar, CallDetail, ChartRequest, Market } from '../../api/types'
import { INTERVALS, INTERVAL_SECONDS, MARKET_LABELS, cached, findInstruments, type Interval } from '../../data/session'
import { dateTime } from '../../data/time'
import { locationEndAt } from '../../data/location-time'
import { h } from '../../ui/dom'
import { attachmentImage } from '../../ui/media'
import { stagger } from '../../ui/motion'
import { popChip, type PopItem } from '../../ui/pop'
import { problem, toast } from '../../ui/toast'
import { levelWord } from '../search/score'
import { miniCandles } from './candles'
import { openMarketChart } from './market-view'

const MOVING = ['queued', 'running', 'retry_wait']

/**
 * 对照那一段的结论。后端按 §5.2 给 `sure|likely|weak`，老一点的只给一个分数，
 * 两条路都收；什么都没给就不写这一句——宁可不说，也不替它下结论。
 */
const VERDICT: Record<string, string> = {
  sure: '对上了',
  strong: '对上了',
  located: '对上了',
  likely: '大致对上，看一眼再确认',
  ambiguous: '大致对上，看一眼再确认',
  similar: '大致对上，看一眼再确认',
  weak: '对不上，改一下时间或周期',
  needs_manual: '对不上，改一下时间或周期',
}

function verdictOf(outcome: unknown, level: unknown, score: unknown): string | null {
  const named = typeof level === 'string' ? VERDICT[level] : null
  if (named) return named
  const byOutcome = typeof outcome === 'string' ? VERDICT[outcome] : null
  if (byOutcome) return byOutcome
  const value = typeof score === 'number' ? score : typeof score === 'string' ? Number(score) : NaN
  if (!Number.isFinite(value)) return null
  if (value >= 0.75) return '对上了'
  if (value >= 0.6) return '大致对上，看一眼再确认'
  return '对不上，改一下时间或周期'
}

/** 图上数不出根数时按这个长度取一段来对照。 */
const DEFAULT_BARS = 120

/** 这张图要按什么去找。缺省跟着记录走，人可以逐项改。 */
export interface LocateTarget {
  symbol: string
  market: Market
  interval: string
}

export interface LocateOptions {
  call?: Pick<CallDetail, 'instrument' | 'market' | 'timeframe' | 'submitted_at'>
  attachment: Pick<Attachment, 'id'> & Partial<Attachment>
  /** 后端说这张图正有一条定位任务在跑。 */
  pending?: boolean
  /** 对上或者解开之后回调。null 表示解开。 */
  onChange: (location: AttachmentLocation | null) => void
  /** 人按了「先不对」。 */
  onCancel?: () => void
}

export interface LocatePanel {
  node: HTMLElement
  /** 看一眼这张图有没有位置、有没有任务在跑。 */
  start: () => void
  destroy: () => void
}

type Phase =
  | { at: 'idle' }
  | { at: 'working' }
  | { at: 'picked'; items: LocateCandidate[]; runId: string | null }
  | { at: 'manual' }
  | { at: 'unreadable' }

export function locatePanel(options: LocateOptions): LocatePanel {
  const { attachment } = options
  const call = attachment.kind === 'scene' ? options.call : undefined
  let phase: Phase = options.pending ? { at: 'working' } : { at: 'idle' }
  let location = attachment.location ?? null
  /** 后端从这张截图上认出来的。认不出的那一项就是 null，前端不补。 */
  let read: LocateAnchors = {}
  /** 人自己改过一次，轮询回来就不许再动这几格。 */
  let touched = false
  /** 人说「都不是」看过的那些候选窗口。 */
  const rejected = new Set<string>()
  /** 后端对「图上认出来的那一段」下的结论。人一改字段就作废。 */
  let verdict: string | null = null

  let alive = true
  let asked = false
  let polling = 0
  const lane = new Latest()
  const previewLane = new Latest()
  const candidateReads = new Set<AbortController>()
  const writeAction = new WriteAction()
  const locateAction = new WriteAction()

  const node = h('div.loc')

  /** 按什么去找：对上的位置最大，其次图上认出来的，再次这条记录。 */
  function wanted(): LocateTarget {
    return {
      symbol: location?.symbol ?? read.symbol ?? call?.instrument ?? '',
      market: location?.market ?? call?.market ?? 'usd_m',
      interval: location?.interval ?? read.interval ?? (call?.timeframe && INTERVALS.includes(call.timeframe as Interval) ? call.timeframe : null) ?? '1h',
    }
  }

  let target: LocateTarget = wanted()
  /** 手填那一格：最右一根的时间，本地时区的 `YYYY-MM-DDTHH:mm`。 */
  let endLocal = ''
  /** 图上数出来多少根，手填时用它反推起点。 */
  function barsGuess(): number {
    const n = read.bars_guess
    return typeof n === 'number' && n >= 10 && n <= 1_000 ? Math.trunc(n) : DEFAULT_BARS
  }

  function repaint(): void {
    if (!alive) return
    previewLane.cancel()
    for (const read of candidateReads) read.abort()
    candidateReads.clear()
    node.replaceChildren(...body().filter((one): one is HTMLElement => one !== null))
    stagger(node.children, 6)
  }

  /* --------------------------------------------------------- 各段 */

  /** 一样都没认出来就不摆这一行（§7：没有 anchors 就不显示识别行）。 */
  function readAny(): boolean {
    return Boolean(read.symbol || read.interval || read.end_at_guess)
  }

  /** 图上认出：品种 · 周期 · 最后一根 时间。认不出的那一项写「？」。 */
  function readLine(): HTMLElement | null {
    if (!readAny()) return null
    const symbol = read.symbol ?? '？'
    const interval = read.interval ?? '？'
    const at = read.end_at_guess ? dateTime(read.end_at_guess) : '？'
    return h('div.loc-read', { text: `图上认出：${symbol} · ${interval} · 最后一根 ${at}` })
  }

  function okRow(at: AttachmentLocation): HTMLElement {
    return h(
      'div.loc-on',
      {},
      h('span', { text: `已对上 ${at.symbol} · ${at.interval} · ${dateTime(at.start_at)} – ${dateTime(at.end_at)}` }),
      h('button.btn.sm.ghost', { text: '解开', on: { click: () => void undo() } }),
    )
  }

  function body(): (HTMLElement | null)[] {
    if (location) return [okRow(location)]
    if (phase.at === 'working') {
      return [h('div.loc-wait', {}, h('i.rlv-spin'), h('span', { text: '正在对行情' }))]
    }
    if (phase.at === 'unreadable') {
      return [
        h('div.loc-bad', {}, h('b', { text: '这张图认不出 K 线' }), h('span', { text: '换一张，或者手动填' })),
        manualBlock(),
      ]
    }
    if (phase.at === 'picked') {
      const now = phase
      const list = h('div.loc-cands')
      now.items.forEach((item, index) => list.appendChild(candidate(item, index, now.runId)))
      return [
        readLine(),
        h('div.eyebrow.noline', { text: '选出截图对应的这段行情' }),
        list,
        h(
          'div.acts',
          {},
          h('button.btn.sm.ghost', {
            text: '都不是，我来填',
            on: {
              click: () => {
                for (const item of now.items) if (item.id) rejected.add(item.id)
                phase = { at: 'manual' }
                repaint()
              },
            },
          }),
          cancelButton(),
        ),
      ]
    }
    return [readLine(), manualBlock()]
  }

  function cancelButton(): HTMLElement {
    return h('button.btn.sm.ghost', { text: '先不对', on: { click: () => options.onCancel?.() } })
  }

  /* ------------------------------------------------------ 候选那几段 */

  function candidate(item: LocateCandidate, index: number, runId: string | null): HTMLElement {
    const chart = h('div.loc-cchart')
    const window: ChartRequest = { symbol: item.symbol, market: item.market, interval: item.interval,
      start_at: item.start_at, end_at: item.end_at, source: item.market_source }
    void drawWindow(window, chart)
    const word = levelWord(item.match)
    return h(
      'div.loc-cand',
      { style: `--i:${index}` },
      chart,
      h(
        'div.loc-cbody',
        {},
        h('b', { text: `${item.symbol} · ${dateTime(item.start_at)} – ${dateTime(item.end_at)}` }),
        word ? h('span.loc-word', { text: word }) : null,
      ),
      h('button.btn.sm.ghost', { text: '放大对比', on: { click: () => openMarketChart(window, '候选区间', { queryAttachmentId: attachment.id }) } }),
      h('button.btn.sm.primary', {
        text: '就是这段',
        on: { click: (e) => void confirm(windowOf(item), runId, item.match?.score ?? null, e.currentTarget as HTMLButtonElement) },
      }),
    )
  }

  /* --------------------------------------------------------- 手填 */

  /**
   * 四格加一块对照。填的是「最后一根的时间」——截图右边缘那一根，图上数出来的
   * 根数往回推就是起点。右边按这四格取一段真实 K 线摆着，对不对眼睛看得出来。
   */
  function manualBlock(): HTMLElement {
    if (!endLocal) endLocal = toLocalInput(read.end_at_guess ?? (call?.submitted_at ?? attachment.uploaded_at ?? new Date().toISOString()))
    const fields = h('div.loc-fields')
    fields.append(
      field('品种', symbolChip()),
      field('市场', marketChip()),
      field('周期', intervalChip()),
      field('最后一根的时间', timeInput()),
    )
    const shot = h(
      'div.loc-half',
      {},
      attachmentImage(attachment.id, {
        alt: '当时图',
        ratio: attachment.width && attachment.height ? { width: attachment.width, height: attachment.height } : undefined,
        maxWidth: 320,
        lazy: false,
      }),
    )
    const real = h('div.loc-half')
    const box = h(
      'div.loc-check',
      {},
      h(
        'div.loc-chead',
        {},
        h('div.eyebrow.noline', { text: '对照' }),
        verdict && !touched ? h('span.loc-word', { text: verdict }) : null,
      ),
      h('div.loc-pair', {}, shot, real),
    )
    const decision = h('span.loc-word', { text: '正在对行情' })
    box.querySelector('.loc-chead')?.append(decision)
    const save = h('button.btn.sm.primary', { text: '就是这段', disabled: true }) as HTMLButtonElement
    let checked: LocationInput | null = null
    save.addEventListener('click', () => { if (checked) void confirm(checked, null, null, save) })
    const signal = previewLane.begin()
    const window = manualWindow()
    const { start_at: _start, source: _source, ...request } = window
    void previewLocation(attachment.id, request, { signal }).then((result) => {
      if (!alive || signal.aborted || !real.isConnected) return
      real.replaceChildren(miniCandles(result.preview.bars, 320, 132) as unknown as HTMLElement)
      decision.textContent = verdictOf(null, result.preview.match?.level, result.preview.match?.score) ?? '看一眼再确认'
      real.appendChild(h('button.btn.sm.ghost', { text: '全屏对比 K 线', on: { click: () => openMarketChart({ symbol: result.symbol, market: result.market, interval: result.interval, start_at: result.start_at, end_at: result.end_at, source: result.source ?? 'rest' }, '校准区间', { queryAttachmentId: attachment.id, fullscreen: true }) } }))
      checked = { symbol: result.symbol, market: result.market, interval: result.interval,
        start_at: result.start_at, end_at: result.end_at, bars_count: result.bars_count,
        source: result.source ?? 'rest' }
      save.disabled = false
    }).catch((error) => {
      if (!alive || signal.aborted || !real.isConnected) return
      decision.textContent = error instanceof Error ? error.message : '这段行情没取到，再试一次'
    })
    return h(
      'div.loc-manual',
      {},
      fields,
      box,
      h(
        'div.acts',
        {},
        save,
        cancelButton(),
      ),
    )
  }

  function field(label: string, control: HTMLElement): HTMLElement {
    return h('label.loc-field', {}, h('span', { text: label }), control)
  }

  function symbolChip(): HTMLElement {
    return popChip({
      label: () => target.symbol || '品种',
      active: () => Boolean(target.symbol),
      search: '品种',
      items: async (query) => {
        const found = await findInstruments(query, { market: target.market })
        const rows: PopItem[] = found.map((item) => ({
          label: item.symbol,
          value: item.symbol,
          hint: MARKET_LABELS[item.market],
          on: item.symbol === target.symbol,
        }))
        return rows.length ? rows : [{ label: '没有找到', value: '' }]
      },
      onPick: (value) => {
        if (!value) return
        touched = true
        verdict = null
        target.symbol = value
        const found = cached(value)
        if (found) target.market = found.market
        repaint()
      },
    }).node
  }

  function marketChip(): HTMLElement {
    return popChip({
      label: () => MARKET_LABELS[target.market],
      active: () => true,
      items: () => [
        { label: MARKET_LABELS.usd_m, value: 'usd_m', on: target.market === 'usd_m' },
        { label: MARKET_LABELS.coin_m, value: 'coin_m', on: target.market === 'coin_m' },
      ],
      onPick: (value) => {
        touched = true
        verdict = null
        target.market = value as Market
        repaint()
      },
    }).node
  }

  function intervalChip(): HTMLElement {
    return popChip({
      label: () => target.interval,
      active: () => true,
      items: () => INTERVALS.map((value) => ({ label: value, value, on: value === target.interval })),
      onPick: (value) => {
        touched = true
        verdict = null
        target.interval = value
        repaint()
      },
    }).node
  }

  function timeInput(): HTMLElement {
    const input = h('input.input.loc-when', {
      type: 'datetime-local',
      value: endLocal,
    }) as HTMLInputElement
    input.addEventListener('change', () => {
      touched = true
      verdict = null
      endLocal = input.value
      repaint()
    })
    return input
  }

  /** 这四格算出来的那一段。 */
  function manualWindow(): LocationInput {
    const last = endLocal ? new Date(endLocal) : new Date((call?.submitted_at ?? attachment.uploaded_at ?? new Date().toISOString()))
    const seconds = INTERVAL_SECONDS[target.interval as Interval] ?? 3_600
    const bars = barsGuess()
    // 用户填最后一根的开盘时间，接口窗口的终点则是这一根收盘后的边界。
    const end = new Date(locationEndAt(last, target.interval as Interval))
    const start = new Date(end.getTime() - bars * seconds * 1_000)
    return {
      symbol: target.symbol,
      market: target.market,
      interval: target.interval,
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      bars_count: bars,
      source: 'rest',
    }
  }

  function windowOf(item: LocateCandidate): LocationInput {
    return {
      symbol: item.symbol,
      market: item.market,
      interval: item.interval,
      start_at: item.start_at,
      end_at: item.end_at,
      bars_count: item.bars_count,
      source: item.market_source,
    }
  }

  /** 把一段真实行情画进这一格。取不到就空着，不在对照里编一段出来。 */
  async function drawWindow(input: ChartRequest, host: HTMLElement): Promise<void> {
    if (!input.symbol) return
    const controller = new AbortController()
    candidateReads.add(controller)
    const signal = controller.signal
    try {
      const result = await marketData(
        {
          symbol: input.symbol,
          market: input.market,
          interval: input.interval,
          start_at: input.start_at,
          end_at: input.end_at,
          ...(input.source ? { source: input.source } : {}),
        },
        { signal },
      )
      if (!alive || !host.isConnected) return
      const bars: Bar[] = result.bars ?? []
      if (!bars.length) return
      host.replaceChildren(miniCandles(bars, 320, 132) as unknown as HTMLElement)
    } catch {
      if (alive && !signal.aborted && host.isConnected) host.replaceChildren(h('span.faint', { text: '这段行情暂未取到，可放大后重试' }))
    } finally {
      candidateReads.delete(controller)
    }
  }

  /* ------------------------------------------------------ 写进去 */

  async function confirm(
    input: LocationInput,
    runId: string | null,
    score: number | null,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!input.symbol) {
      problem('没保存上，再试一次')
      return
    }
    const payload: LocationInput = {
      ...input,
      ...(score !== null ? { score: String(score) } : {}),
      ...(runId ? { search_run_id: runId } : {}),
    }
    button.disabled = true
    try {
      const saved = await putLocation(attachment.id, payload, writeAction.keyFor(payload))
      writeAction.reset()
      if (!alive) return
      settle(saved)
      toast('记下了')
    } catch (error) {
      button.disabled = false
      if (!alive) return
      problem(error instanceof Error ? error.message : '没保存上，再试一次')
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
      problem(error instanceof Error ? error.message : '没保存上，再试一次')
    }
  }

  function settle(saved: AttachmentLocation): void {
    location = saved
    phase = { at: 'idle' }
    repaint()
    options.onChange(saved)
  }

  /* -------------------------------------------------- 问后端那一路 */

  function start(): void {
    if (phase.at === 'working' && polling > 0) return
    asked = true
    void run(false)
  }

  /** 把后端从图上认出来的那几样收下来。人改过就不再动。 */
  function absorb(state: LocateState): void {
    if (!alive) return
    const anchors = state.anchors ?? {}
    if (!touched) {
      const best = (state as { match?: { level?: unknown; score?: unknown } }).match
      verdict = verdictOf(state.outcome, best?.level, best?.score)
    }
    read = {
      ...anchors,
      symbol: anchors.symbol ?? state.symbol ?? null,
      interval: anchors.interval ?? state.interval ?? null,
    }
    if (touched) return
    const next = wanted()
    if (next.symbol === target.symbol && next.market === target.market && next.interval === target.interval) return
    target = next
  }

  /** manual 表示这一次是人按的：只有人按了才会让后端新开一次匹配。 */
  async function run(manual: boolean): Promise<void> {
    if (location) return
    asked = true
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
      phase = { at: 'manual' }
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
    absorb(state)
    if (state.location) {
      settle(state.location)
      return
    }
    if (state.outcome === 'unreadable') {
      phase = { at: 'unreadable' }
      repaint()
      return
    }
    const loose = candidatesOf(state.candidates)
    if (loose.length) {
      phase = { at: 'picked', items: loose, runId: null }
      repaint()
      return
    }
    const job = state.job
    if (job && MOVING.includes(job.status)) {
      await watch(current, signal)
      return
    }
    if (job && !manual) {
      settleJob(job)
      return
    }
    if (!manual) {
      phase = { at: 'manual' }
      repaint()
      return
    }
    phase = { at: 'working' }
    repaint()
    try {
      const refused = [...rejected]
      const ask = target.symbol ? { ...target, ...(refused.length ? { exclude: refused } : {}) } : null
      const started = await postLocate(
        attachment.id,
        locateAction.keyFor({ id: attachment.id, ...(ask ?? {}), refused }),
        ask,
        { signal },
      )
      locateAction.reset()
      if (!current()) return
      await follow(started, false, current, signal)
    } catch (error) {
      if (Latest.aborted(error) || !current()) return
      phase = { at: 'manual' }
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
      absorb(state)
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

  /** 任务到终态了：有候选就让人挑，没候选就让人自己填。 */
  function settleJob(job: LocateJob | null): void {
    const anchors = job?.result?.anchors
    if (anchors) absorb({ location: null, job: null, anchors, outcome: job?.result?.outcome ?? null })
    else if (!touched) verdict = verdictOf(job?.result?.outcome, null, null)
    const items = candidatesOf(job?.result?.candidates)
    if (items.length) {
      phase = { at: 'picked', items, runId: runIdOf(job) }
      repaint()
      return
    }
    phase = job?.result?.outcome === 'unreadable' ? { at: 'unreadable' } : { at: 'manual' }
    repaint()
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  repaint()
  if (!location && !asked && !options.pending) void run(false)

  return {
    node,
    start,
    destroy: () => {
      alive = false
      polling += 1
      lane.cancel()
      previewLane.cancel()
      for (const read of candidateReads) read.abort()
      candidateReads.clear()
      rejected.clear()
    },
  }
}

/* --------------------------------------------------------------- 小工具 */

/** 后端拿不准时给的那几段，最多三段。 */
function candidatesOf(list: unknown): LocateCandidate[] {
  return locateCandidates(list)
}

function runIdOf(job: LocateJob | null): string | null {
  const value = job?.result?.['search_run_id']
  return typeof value === 'string' ? value : null
}

/** ISO 时刻 → `datetime-local` 认的那种本地写法。 */
function toLocalInput(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function pickInterval(call: CallDetail): string | null {
  const value = call.timeframe ?? call.body.timeframe ?? null
  return value && (INTERVALS as readonly string[]).includes(value) ? value : null
}

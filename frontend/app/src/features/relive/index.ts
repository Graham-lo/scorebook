import { openMarketChart } from './market-view'
// 重温一遍 —— 把一次判断放回它当时那段真实行情里，从头走一次。
//
// 五屏一个网址：`#/relive/<call_id>/<n>`，n = 1…5。
//   1 当时    画到判断时刻停住，判断之后一根不画
//   2 逐根看  一根一根往后长，当时定下的价位画成水平线
//   3 答案    市场给的那个结果；还没判就在这儿判
//   4 复盘    写过的复盘，和这一段里真实成交、同段行情的其它判断
//   5 打法    这类局面后来归到哪一套打法上
//
// 这几屏只摆事实：品种、周期、时间、当时的原话、算出来的价位、市场给的数字。
// 没有一句解说，也没有一句提示——那些属于写记录和写复盘的流程，不属于看。
//
// K 线是真的行情，不是那张截图。记录上每一张**已经对上行情**的图在舞台上方各
// 占一个 tab，点谁播谁：同一条记录里的对比图品种可以不一样。
// 这一段行情是临时借来的：离开这个页面就发 DELETE 还回去。

import { MAX_BARS, fetchKlines } from '../../api/binance'
import { judge } from '../../api/calls'
import { ApiError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import { get as getJob, isRunning } from '../../api/jobs'
import { closedIndex, closedWindow } from '../../data/replay-time'
import { episode as fetchEpisode } from '../../api/knowledge'
import {
  deleteReplay,
  getReplay,
  type ChartSetup,
  type Replay,
  type ReplayTrack,
} from '../../api/replay'
import * as trades from '../../api/trades'
import type {
  Attachment,
  Bar,
  CallDetail,
  Evaluation,
  FillRow,
  Market,
  OutcomeState,
  ReviewRecord,
  Uuid,
} from '../../api/types'
import { STANCES } from '../../data/criteria'
import { percent, price as decimalPrice } from '../../data/decimal'
import { VERDICTS, figures, head as headOutcome } from '../../data/outcome'
import { INTERVAL_SECONDS, MARKET_LABELS, type Interval } from '../../data/session'
import { detail, invalidate } from '../../data/store'
import { DASH, dateTime } from '../../data/time'
import { go, route } from '../../router'
import { stamp } from '../../ui/bits'
import { h } from '../../ui/dom'
import { openScreenshot } from './screenshot'
import { attachmentImage } from '../../ui/media'
import { prefersReducedMotion, stagger } from '../../ui/motion'
import { anyPopOpen, popChip } from '../../ui/pop'
import { REVIEW_ACTIONS } from '../review/draft'
import { empty, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { createCandles, type CandleStage, type LevelLine, type StageBand, type StageMark } from './candles'
import { normalizeSetup } from './setup'
import { maxPeriod, readChoice, setupFor, writeChoice, seededNames, menuItems, menuFooter, LINE_ORDER, type Choice, type LineName } from './indicator-choice'
import { data as marketData } from '../../api/market'
import { historyStart } from '../../data/chart-window'

const TITLES = ['当时', '逐根看', '答案', '复盘', '打法']

/**
 * 这一段行情在后端是按 24 小时过期的临时缓存，五屏之间来回走不该每次都重取，
 * 所以整条记录的回放在这里留到人离开为止。离开时连它一起丢掉。
 */
let holdId: Uuid | null = null
let holdTrackKey = ''
let holdCall: CallDetail | null = null
let holdReplay: Replay | null = null
let holdStart: 'shot' | 'judgment' = 'shot'
let holdProgressAt: string | null = null
/** 窗口之前那一段只取一次：换屏、换 tab 都用同一份。 */
let holdLead: { key: string; bars: Bar[] } | null = null

/* --------------------------------------------------------------- 页面 */

export function relivePage(host: HTMLElement, arg: string): () => void {
  const parts = arg.split('/')
  const id = parts[0] ?? ''
  const wanted = Number(parts[1] ?? '1')
  const step = Number.isFinite(wanted) ? Math.min(5, Math.max(1, Math.trunc(wanted))) : 1

  let alive = true
  const lifetime = new AbortController()
  let stage: CandleStage | null = null
  let locateTimer = 0
  let locateFailures = 0
  let choice: Choice = readChoice()
  /** 这条记录截图上认出来的那一份参数种子。开了哪条线还是人自己说了算。 */
  const record = (): ChartSetup => normalizeSetup(holdCall?.chart_setup ?? null)
  /** 现在舞台上放的是哪一条轨：换指标的时候还要按它去补前置那一段。 */
  let lastLook: Look | null = null
  const judgeAction = new WriteAction()
  // 舞台在的时候，键盘就归它：左右逐根，空格播放/暂停。
  let stepBy: ((delta: number) => void) | null = null
  let playAgain: (() => void) | null = null
  let pauseNow: (() => void) | null = null
  let isPlaying: (() => boolean) | null = null

  /** 现在放的是哪一张图那一条轨。空的就是记录自己那一条。 */
  let activeKey = holdId === id ? holdTrackKey : ''
  /** 后取回来的那几条轨的 K 线，按轨的 key 存着。 */
  const trackBars = new Map<string, Bar[]>()
  const fetching = new Set<string>()
  const failedTracks = new Set<string>()
  let fullFallback: Promise<Replay> | null = null

  const top = h('header.rlv-top')
  const body = h('section.rlv-body')
  const root = h('div.rlv', {}, top, body)
  host.appendChild(root)

  if (!id) {
    body.replaceChildren(empty({ title: '没有指定记录' }))
    return () => {
      alive = false
    }
  }

  if (holdId !== id) {
    holdId = id
    holdCall = null
    holdReplay = null
    holdTrackKey = ''
    holdStart = 'shot'
    holdProgressAt = null
  }

  paintTop(null)
  body.replaceChildren(spinner('正在把那一段行情取回来…'))
  void load()

  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector('[aria-modal="true"]') || anyPopOpen()) return
    const target = e.target as HTMLElement | null
    if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return
    if (target?.closest('button, a, [role=button]') && e.key === ' ') return
    if (e.key === 'ArrowRight' && stepBy) {
      e.preventDefault()
      stepBy(1)
    } else if (e.key === 'ArrowLeft' && stepBy) {
      e.preventDefault()
      stepBy(-1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      go(`call/${id}`)
    } else if (e.key === ' ' && playAgain && pauseNow && isPlaying) {
      e.preventDefault()
      if (isPlaying()) pauseNow()
      else playAgain()
    }
  }
  document.addEventListener('keydown', onKey)

  const onHide = () => {
    if (route().page !== 'relive') return
    deleteReplay(id)
  }
  const onVisibility = () => { if (document.hidden) pauseNow?.() }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onHide)

  async function load(): Promise<void> {
    try {
      const call = holdCall ?? (await detail(id))
      if (!alive) return
      holdCall = call
      let replay = holdReplay
      let failure: ApiError | null = null
      if (!replay) {
        try {
          replay = await pullReplay()
          holdReplay = replay
        } catch (error) {
          if (!alive) return
          if (error instanceof ApiError) failure = error
          else throw error
        }
      }
      if (!alive) return
      paintTop(replay)
      paint(call, replay, failure)
    } catch (error) {
      if (!alive) return
      body.replaceChildren(
        empty({
          title: error instanceof Error ? error.message : '这一段读不出来',
          action: h('a.btn.sm', { href: `#/call/${id}`, text: '退出重温' }),
        }),
      )
    }
  }

  /**
   * 取这一段行情。
   *
   * 先只要这一段的身份和边界（`bars=none`），K 线自己去交易所拿——那是公开数据，
   * 浏览器一次往返就有了，不用后端再落一份临时缓存。拿不到、或者拿回来的和窗口
   * 对不上，就安安静静退回后端那一条路：人不该为这件事看见一个报错。
   *
   * 后端还没部署 `bars=none` 的时候，它会照旧把 K 线一起给回来（没有
   * `bars_included` 这个字段），那就直接用，什么都不用变。
   */
  async function pullReplay(): Promise<Replay> {
    let meta: Replay
    try {
      meta = await getReplay(id, { bars: 'none', signal: lifetime.signal })
    } catch (error) {
      // 连这一条都不认（老后端可能挑参数），退回原来那一条路。
      if (!(error instanceof ApiError)) throw error
      return getReplay(id, { signal: lifetime.signal })
    }
    // 没有 bars_included 就是老后端：它给什么就是什么。
    if (meta.bars_included !== false) return meta
    if (meta.bars.length) return meta
    return meta
  }

  /** 直连交易所取一段。取回来的必须和窗口对得上，对不上就当没取到。 */
  async function directBars(
    symbol: string,
    market: Market,
    interval: string,
    startAt: string,
    endAt: string,
  ): Promise<Bar[] | null> {
    const seconds = INTERVAL_SECONDS[interval as Interval]
    const start = Date.parse(startAt)
    const end = Date.parse(endAt)
    if (!seconds || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
    const expected = Math.floor((end - start) / (seconds * 1_000))
    if (expected < 2 || expected > MAX_BARS) return null
    const bars = await fetchKlines({ symbol, market, interval, start_at: startAt, end_at: endAt }, lifetime.signal)
    // 根数对不上（多出来、或者缺了一大半）就不要：宁可慢一点用后端那份，
    // 也不能拿一段残缺的行情去看一次判断。
    if (bars.length < 2 || bars.length > expected + 2) return null
    if (bars.length < Math.max(2, Math.floor(expected * 0.5))) return null
    const first = Date.parse(bars[0]!.start)
    const lastEnd = Date.parse(bars[bars.length - 1]!.end)
    if (!(first >= start) || !(lastEnd <= end + seconds * 1_000 + 1_000)) return null
    return bars
  }

  /* ------------------------------------------------------------ 顶部 */

  function paintTop(replay: Replay | null): void {
    const call = holdCall
    const line = h(
      'div.rlv-id',
      {},
      h('a.rlv-back', { href: `#/call/${id}`, text: '退出重温' }),
      h('b.rlv-sym', { text: replay?.symbol ?? call?.instrument ?? '未标品种' }),
      h('span.rlv-mk.mono', {
        text: [
          replay ? MARKET_LABELS[replay.market] : call?.market ? MARKET_LABELS[call.market] : null,
          replay?.interval ?? call?.timeframe ?? null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    )
    const rail = h('nav.rlv-steps')
    TITLES.forEach((title, i) => {
      const n = i + 1
      rail.appendChild(
        h(
          'a',
          { href: `#/relive/${id}/${n}`, class: n === step ? 'on' : n < step ? 'past' : '' },
          h('i.n', { text: String(n) }),
          h('span.t', { text: title }),
        ),
      )
    })
    top.replaceChildren(line, rail)
  }

  /* ------------------------------------------------------------ 对比图 */

  /** 记录自己那一条永远排第一，后面每一条对应一张已经对上行情的图。 */
  function tracksOf(replay: Replay): ReplayTrack[] {
    const tracks = (replay.tracks ?? []).filter(track => track.symbol && track.interval)
    if (tracks.length) return tracks
    const own: ReplayTrack = {
      kind: 'scene',
      symbol: replay.symbol,
      market: replay.market,
      interval: replay.interval,
      window: replay.window,
      bars: replay.bars,
    }
    return [own]
  }

  function keyOf(track: ReplayTrack): string {
    return track.attachment_id ?? `${track.symbol}-${track.interval}`
  }

  function tabLabel(track: ReplayTrack): string {
    const word = track.kind === 'reference' ? '参考' : track.kind === 'supplement' ? '之后' : '当时'
    return `${track.symbol} ${word}`
  }

  function activeTrack(replay: Replay): ReplayTrack {
    const all = tracksOf(replay)
    return all.find((track) => keyOf(track) === activeKey) ?? (all[0] as ReplayTrack)
  }

  /** 这一条轨的 K 线。后端只给了边界时自己去交易所取一次，取到就存着。 */
  function barsOf(track: ReplayTrack): Bar[] | null {
    if (track.bars?.length) return track.bars
    const key = keyOf(track)
    const held = trackBars.get(key)
    if (held) return held
    if (!fetching.has(key) && !failedTracks.has(key)) {
      fetching.add(key)
      void (async () => {
        try {
          let bars = await directBars(
            track.symbol,
            track.market,
            track.interval,
            track.window.start_at,
            track.window.end_at,
          ).catch(() => null)
          if (!alive) return
          if (!bars) {
            fullFallback ??= getReplay(id, { signal: lifetime.signal }).catch(error => { fullFallback = null; throw error })
            const full = await fullFallback
            bars = tracksOf(full).find(one => keyOf(one) === key)?.bars ?? null
          }
          if (!bars?.length) throw new Error('这一段行情暂时没取到')
          trackBars.set(key, bars)
          track.bars = bars
        } catch {
          failedTracks.add(key)
        }
        fetching.delete(key)
        if (!alive || !holdReplay || keyOf(activeTrack(holdReplay)) !== key) return
        if (holdCall && holdReplay) paint(holdCall, holdReplay, null)
      })()
    }
    return null
  }

  function tabsRow(replay: Replay): HTMLElement | null {
    const all = tracksOf(replay)
    if (all.length < 2) return null
    const row = h('div.rlv-tabs')
    for (const track of all) {
      const key = keyOf(track)
      row.appendChild(
        h('button.rlv-tab', {
          text: tabLabel(track),
          class: key === activeKey || (!activeKey && track === all[0]) ? 'on' : '',
          on: {
            click: () => {
              if (activeKey === key) return
              activeKey = key
              holdTrackKey = key
              if (holdCall && holdReplay) paint(holdCall, holdReplay, null)
            },
          },
        }),
      )
    }
    return row
  }

  /* ------------------------------------------------------------ 主体 */

  function paint(call: CallDetail, replay: Replay | null, failure: ApiError | null): void {
    clearTimeout(locateTimer)
    stage?.destroy()
    stage = null
    stepBy = null
    playAgain = null
    pauseNow = null
    isPlaying = null

    const screen = h('div.rlv-screen', { data: { step: String(step) } })
    body.replaceChildren(screen)

    if (!replay || (!replay.bars.length && !(replay.tracks ?? []).length)) {
      void failure
      if (replay?.locating && ['queued', 'running', 'retry_wait'].includes(replay.locating.status)) {
        screen.appendChild(spinner('正在对上行情…'))
        followLocation(replay.locating.job_id, screen)
        return
      }
      screen.appendChild(
        empty({
          title: '没有对上行情的图',
          action: h('a.btn.sm.primary', { href: `#/call/${id}`, text: '去对上' }),
        }),
      )
      stagger(screen.children, 6)
      return
    }

    const track = activeTrack(replay)
    const bars = barsOf(track)
    if (!bars) {
      screen.appendChild(tabsRow(replay) ?? h('div', { hidden: true }))
      if (failedTracks.has(keyOf(track))) screen.appendChild(empty({
        title: '这一段行情暂时没取到', action: h('button.btn.sm', { text: '再试一次', on: { click: () => {
          failedTracks.delete(keyOf(track)); paint(call, replay, null)
        } } }),
      }))
      else screen.appendChild(spinner('正在把那一段行情取回来…'))
      stagger(screen.children, 6)
      return
    }
    const look: Look = {
      track,
      bars,
      own: track.symbol === replay.symbol && track.interval === replay.interval && track.market === replay.market,
    }

    if (step === 1) screenOne(screen, call, replay, look)
    else if (step === 2) screenTwo(screen, call, replay, look)
    else if (step === 3) screenThree(screen, call, replay, look)
    else if (step === 4) screenFour(screen, call, replay, look)
    else screenFive(screen, call)

    screen.appendChild(walkRow())
    stagger(screen.children, 8)
  }

  function followLocation(jobId: string, screen: HTMLElement): void {
    locateTimer = window.setTimeout(() => { void (async () => {
      try {
        const job = await getJob(jobId, { signal: lifetime.signal })
        if (!alive) return
        locateFailures = 0
        if (isRunning(job)) { followLocation(jobId, screen); return }
        if (job.status === 'succeeded') { holdReplay = null; holdCall = await detail(id, { refresh: true }); await load(); return }
        screen.replaceChildren(empty({ title: '这张图还需要你确认', action: h('a.btn.sm', { href: `#/call/${id}`, text: '查看定位结果' }) }))
      } catch {
        if (!alive) return
        if (++locateFailures < 3) { followLocation(jobId, screen); return }
        screen.replaceChildren(empty({ title: '定位进度暂时没读到', action: h('button.btn.sm', { text: '重试', on: { click: () => { locateFailures = 0; screen.replaceChildren(spinner('正在对上行情…')); followLocation(jobId, screen) } } }) }))
      }
    })() }, 3000)
  }

  function startPoint(screen: HTMLElement, call: CallDetail, replay: Replay, look: Look): { end: string; start?: string; shot: boolean } {
    const location = call.attachments.find(attachment => attachment.id === look.track.attachment_id)?.location
    const shot = holdStart === 'shot' && Boolean(location)
    const end = shot && location ? location.end_at : replay.judgment.at
    const start = shot && location ? location.start_at : undefined
    const choices = h('div.rlv-tools', { style: 'margin-bottom:10px' })
    for (const [mode, label] of [['shot', '图中窗口'], ['judgment', '判断时刻']] as const) {
      if (mode === 'shot' && !location) continue
      choices.appendChild(h('button.chip', { text: label, class: (shot ? mode === 'shot' : mode === 'judgment') ? 'on' : '', attrs: { 'aria-pressed': String(shot ? mode === 'shot' : mode === 'judgment') }, on: { click: () => { holdStart = mode; holdProgressAt = null; paint(call, replay, null) } } }))
    }
    screen.append(choices, h('div.faint', { style: 'margin-bottom:10px', text: shot ? `${dateTime(start)} – ${dateTime(end)}` : `判断于 ${dateTime(end)} · 仅展示此前已收盘 K 线` }))
    return { start, end, shot }
  }

  function walkRow(): HTMLElement {
    const row = h('div.rlv-walk')
    row.appendChild(
      step > 1
        ? h('a.btn.sm.ghost', { href: `#/relive/${id}/${step - 1}`, text: `上一屏 · ${TITLES[step - 2]}` })
        : h('a.btn.sm.ghost', { href: `#/call/${id}`, text: '退出重温' }),
    )
    if (step < 5) {
      row.appendChild(h('a.btn.sm.primary', { href: `#/relive/${id}/${step + 1}`, text: `下一屏 · ${TITLES[step]}` }))
    }
    return row
  }

  /* ------------------------------------------------------- 第 1 屏 当时 */

  function screenOne(screen: HTMLElement, call: CallDetail, replay: Replay, look: Look): void {
    const point = startPoint(screen, call, replay, look)
    const visible = closedWindow(look.bars, point.end, point.start)
    if (!visible.length) { screen.appendChild(empty({ title: '这个时刻之前没有已收盘 K 线' })); return }
    look = { ...look, bars: visible }
    const judgeIndex = visible.length - 1
    const words = call.original_text.trim()
    const badge = [
      STANCES[call.body.stance] ?? '',
      call.body.confidence === null || call.body.confidence === undefined ? '' : `把握 ${call.body.confidence}%`,
    ]
      .filter(Boolean)
      .join(' · ')

    const marks: StageMark[] = point.shot ? [] : [
      {
        id: 'judgment',
        index: judgeIndex,
        price: look.own && replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
        label: look.own ? badge || '判断前' : `${replay.symbol} 判断前`,
        sub: words ? cut(words, 60) : null,
        brief: true,
        kind: 'judgment',
        ...(words.length > 60 ? { onClick: () => showWords(words) } : {}),
      },
    ]

    const built = mount(screen, replay, look, {
      bars: look.bars,
      interval: look.track.interval,
      marks,
      judgmentAt: replay.judgment.at,
    })
    built.showUpTo(judgeIndex)
    // 判断点右边留一段空白：判断气泡站在空白里，不压住判断前那几根。
    built.zoom({ from: 0, to: judgeIndex + Math.max(6, Math.ceil((judgeIndex + 1) * 0.16)) })

    const shot = call.attachments.find(one => one.id === look.track.attachment_id) ?? (look.own ? sceneShot(call) : null)
    if (shot) {
      const corner = h('div.rlv-shot')
      corner.hidden = true
      corner.appendChild(
        attachmentImage(shot.id, {
          alt: '当时图',
          ratio: { width: shot.width, height: shot.height },
          maxWidth: 220,
          lazy: false,
          onReady: (_url, image) => {
            image.addEventListener('click', () => openScreenshot(shot.id, '当时图', shot.location, { call, attachment: shot, onChange: (at) => { shot.location = at } }))
          },
        }),
      )
      corner.appendChild(h('span.rlv-shotl', { text: '当时图' }))
      built.node.appendChild(corner)
      screen.appendChild(h('button.btn.sm.ghost', {
        text: '对照原图', attrs: { 'aria-expanded': 'false' }, on: { click: (event) => {
          corner.hidden = !corner.hidden
          const button = event.currentTarget as HTMLButtonElement
          button.textContent = corner.hidden ? '对照原图' : '收起原图'
          button.setAttribute('aria-expanded', String(!corner.hidden))
        } },
      }))
    }

    if (words) screen.appendChild(h('blockquote.rlv-words', { text: words }))
  }

  function showWords(words: string): void {
    const panel = root.querySelector('.rlv-words')
    if (panel) {
      panel.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
      panel.classList.add('lit')
      window.setTimeout(() => panel.classList.remove('lit'), 1200)
      return
    }
    toast(words)
  }

  /* ----------------------------------------------------- 第 2 屏 逐根看 */

  function screenTwo(screen: HTMLElement, call: CallDetail, replay: Replay, look: Look): void {
    const point = startPoint(screen, call, replay, look)
    const judgeIndex = closedIndex(look.bars, replay.judgment.at)
    const startIndex = closedIndex(look.bars, point.end)
    const initialAt = holdProgressAt ?? point.end
    const initialIndex = closedIndex(look.bars, initialAt)
    const last = look.bars.length - 1
    const levels = look.own ? levelLines(replay) : []
    const horizonEnd = replay.levels?.horizon_end_at ?? null
    const horizonIndex = horizonEnd ? indexIn(look.bars, horizonEnd) : judgeIndex
    const bands: StageBand[] =
      horizonEnd && horizonIndex > judgeIndex
        ? [{ id: 'horizon', from: judgeIndex, to: horizonIndex, label: dateTime(horizonEnd), kind: 'horizon' }]
        : []

    const marks: StageMark[] = [
      {
        id: 'judgment',
        index: judgeIndex,
        price: look.own && replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
        label: '判断',
        kind: 'judgment',
      },
    ]

    let speed = 1
    const built = mount(screen, replay, look, {
      bars: look.bars,
      interval: look.track.interval,
      levels,
      bands,
      judgmentAt: replay.judgment.at,
      marks,
      onEnd: () => paintPlay(),
      onFrame: count => { holdProgressAt = look.bars[count - 1]?.end ?? initialAt },
    })
    built.showUpTo(initialIndex)

    const playBtn = h('button.btn.sm.primary', {
      text: '播放',
      on: {
        click: () => {
          if (built.playing()) {
            built.pause()
          } else {
            if (built.shown() - 1 >= last) built.showUpTo(startIndex)
            built.play(speed)
          }
          paintPlay()
        },
      },
    })

    function paintPlay(): void {
      playBtn.textContent = built.playing() ? '暂停' : '播放'
    }

    function move(delta: number): void {
      built.pause()
      const next = Math.min(last, Math.max(-1, built.shown() - 1 + delta))
      built.showUpTo(next)
      paintPlay()
    }

    const speeds = h('span.seg')
    for (const value of [1, 2, 4]) {
      speeds.appendChild(
        h('button', {
          text: `${value}×`,
          class: value === speed ? 'on' : '',
          on: {
            click: (e) => {
              speed = value
              for (const other of Array.from(speeds.children)) other.classList.remove('on')
              ;(e.currentTarget as HTMLElement).classList.add('on')
              if (built.playing()) {
                built.pause()
                built.play(speed)
              }
            },
          },
        }),
      )
    }

    screen.appendChild(
      h(
        'div.rlv-controls',
        {},
        h('button.btn.sm.ghost', { text: '上一根', on: { click: () => move(-1) } }),
        playBtn,
        h('button.btn.sm.ghost', { text: '下一根', on: { click: () => move(1) } }),
        speeds,
        h('button.btn.sm.ghost', {
          text: point.shot ? '回到图中末尾' : '跳到判断时刻',
          on: {
            click: () => {
              built.pause()
              built.showUpTo(startIndex)
              paintPlay()
            },
          },
        }),
      ),
    )

    stepBy = move
    playAgain = () => {
      if (built.shown() - 1 >= last) built.showUpTo(startIndex)
      built.play(speed)
      paintPlay()
    }
    pauseNow = () => {
      built.pause()
      paintPlay()
    }
    isPlaying = () => built.playing()
    paintPlay()
    void call
  }

  /* ------------------------------------------------------- 第 3 屏 答案 */

  function screenThree(screen: HTMLElement, call: CallDetail, replay: Replay, look: Look): void {
    const judgeIndex = indexIn(look.bars, replay.judgment.at)
    const last = look.bars.length - 1
    const answer = replay.marks
    const marks: StageMark[] = [
      {
        id: 'judgment',
        index: judgeIndex,
        price: look.own && replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
        label: '判断',
        kind: 'judgment',
      },
    ]
    if (look.own && answer) {
      if (answer.trigger_at) {
        marks.push({
          id: 'trigger',
          index: indexIn(look.bars, answer.trigger_at),
          price: answer.trigger_price ? Number(answer.trigger_price) : null,
          label: '触发',
          sub: dateTime(answer.trigger_at),
          kind: 'trigger',
        })
      }
      if (answer.first_threshold_interval) {
        marks.push({
          id: 'threshold',
          index: indexIn(look.bars, answer.first_threshold_interval[0]),
          label: '首次达标',
          sub: dateTime(answer.first_threshold_interval[0]),
          kind: 'threshold',
        })
      }
      if (answer.mfe_at) {
        marks.push({ id: 'mfe', index: indexIn(look.bars, answer.mfe_at), label: '最有利', sub: percent(answer.mfe), kind: 'mfe' })
      }
      if (answer.mae_at) {
        marks.push({ id: 'mae', index: indexIn(look.bars, answer.mae_at), label: '最不利', sub: percent(answer.mae), kind: 'mae' })
      }
      if (answer.end_at) {
        marks.push({
          id: 'end',
          index: indexIn(look.bars, answer.end_at),
          label: answer.invalidation_hit ? '碰到失效价' : stateLabel(replay),
          sub: percent(answer.signed_return),
          kind: answer.invalidation_hit ? 'invalidation' : 'end',
        })
      }
    }

    const built = mount(screen, replay, look, {
      bars: look.bars,
      interval: look.track.interval,
      levels: look.own ? levelLines(replay) : [],
      judgmentAt: replay.judgment.at,
      marks,
    })
    built.showUpTo(last)
    built.zoom({ from: 0, to: last })

    const now = headOutcome(call)
    const state: OutcomeState = now ? now.result.state : 'pending'
    const box = h('div.rlv-answer')
    box.appendChild(h('div.eyebrow.noline', { text: '市场的答案' }))
    box.appendChild(h('div.rlv-verdict', {}, stamp(state, true)))
    const rows = figures(now?.result ?? answer ? evaluationOf(now?.result ?? null, answer) : null)
    if (rows.length) box.appendChild(facts(...rows.map((row) => [row.key, row.value] as [string, string])))
    const decided = state === 'realized' || state === 'unrealized' || state === 'not_triggered'
    if (!decided && !call.voided) {
      const acts = h('div.rlv-acts')
      for (const [key, label] of Object.entries(VERDICTS)) {
        acts.appendChild(
          h('button.btn.sm.ghost', {
            text: label,
            on: { click: () => void setVerdict(call, key as keyof typeof VERDICTS) },
          }),
        )
      }
      box.appendChild(acts)
    }
    screen.appendChild(box)
  }

  async function setVerdict(call: CallDetail, state: keyof typeof VERDICTS): Promise<void> {
    const payload = { state, expected_revision: call.revision }
    try {
      await judge(call.id, payload, judgeAction.keyFor(payload))
      judgeAction.reset()
      toast('记下了')
      invalidate(id)
      holdCall = null
      holdReplay = null
      await load()
    } catch (error) {
      problem(error instanceof Error ? error.message : '没保存上，再试一次')
    }
  }

  /* ------------------------------------------------------- 第 4 屏 复盘 */

  function screenFour(screen: HTMLElement, call: CallDetail, replay: Replay, look: Look): void {
    const last = look.bars.length - 1
    const marks: StageMark[] = []
    const bands: StageBand[] = []

    const later = h('div.rlv-later')

    call.reviews.forEach((review: ReviewRecord, i) => {
      marks.push({
        id: `review-${review.id}`,
        index: indexIn(look.bars, review.created_at),
        label: `复盘 ${i + 1}`,
        sub: dateTime(review.created_at),
        kind: 'review',
        rail: true,
        onClick: () => showReview(review),
      })
    })

    for (const shot of call.attachments) {
      if (shot.kind !== 'supplement') continue
      if (shot.location) {
        bands.push({
          id: `shot-${shot.id}`,
          from: indexIn(look.bars, shot.location.start_at),
          to: indexIn(look.bars, shot.location.end_at),
          label: '之后',
          kind: 'shot',
          onClick: () => openShot(shot),
        })
      } else {
        marks.push({
          id: `shot-${shot.id}`,
          index: indexIn(look.bars, shot.captured_at ?? shot.uploaded_at),
          label: '之后',
          sub: dateTime(shot.captured_at ?? shot.uploaded_at),
          kind: 'shot',
          rail: true,
          onClick: () => openShot(shot),
        })
      }
    }

    const built = mount(screen, replay, look, {
      bars: look.bars,
      interval: look.track.interval,
      levels: look.own ? levelLines(replay) : [],
      judgmentAt: replay.judgment.at,
      marks,
      bands,
    })
    built.showUpTo(last)
    built.zoom({ from: 0, to: last })

    // 成交和同段行情里的其它判断是后到的，到了就并进来重画一次标注。
    let live = marks
    const addMarks = (extra: StageMark[]) => {
      if (!extra.length) return
      live = [...live, ...extra]
      built.setMarks(live, bands)
    }

    if (call.reviews.length) {
      showReview(call.reviews[call.reviews.length - 1] as ReviewRecord)
    }
    screen.appendChild(later)
    if (!call.voided) {
      screen.appendChild(
        h(
          'div.rlv-acts',
          {},
          h('a.btn.sm.primary', { href: `#/review/${call.id}/step/1`, text: '写复盘' }),
        ),
      )
    }

    function showReview(review: ReviewRecord): void {
      const rows: [string, string][] = []
      if (review.body.note) rows.push(['这次看到了什么', review.body.note])
      if (review.body.better_play) rows.push(['更好的打法', review.body.better_play])
      if (review.body.vs_last) rows.push(['和上次比', REVIEW_ACTIONS.find(action => action.value === review.body.vs_last)?.label ?? review.body.vs_last])
      later.replaceChildren(
        h('div.rlv-rhead', {}, h('b', { text: dateTime(review.created_at) })),
        ...rows.map(([k, v]) => h('div.rlv-rrow', {}, h('i', { text: k }), h('p', { text: v }))),
      )
    }

    function openShot(shot: Attachment): void {
      later.replaceChildren(
        attachmentImage(shot.id, {
          alt: '之后',
          ratio: { width: shot.width, height: shot.height },
          lazy: false,
          onReady: (_url, image) => {
            image.addEventListener('click', () => openScreenshot(shot.id, '之后的走势', shot.location, { call, attachment: shot, onChange: (at) => { shot.location = at } }))
          },
        }),
      )
    }

    void addFills(built, call, look, replay, addMarks)
    void addEpisode(built, call, look, addMarks)
  }

  /** 这一段时间里这个品种上真实成交的几笔。读不到就不画。 */
  async function addFills(
    built: CandleStage,
    call: CallDetail,
    look: Look,
    replay: Replay,
    addMarks: (extra: StageMark[]) => void,
  ): Promise<void> {
    if (!call.instrument || !look.own) return
    try {
      const page = await trades.fills({
        symbol: call.instrument,
        start_at: replay.window.start_at,
        end_at: replay.window.end_at,
      })
      if (!alive || stage !== built) return
      const extra: StageMark[] = page.items.slice(0, 20).map((row: FillRow) => ({
        id: `fill-${row.id}`,
        index: indexIn(look.bars, row.fill.traded_at),
        price: Number(row.fill.price),
        label: row.fill.side === 'BUY' ? '买入' : '卖出',
        sub: `${row.fill.quantity} @ ${decimalPrice(row.fill.price) ?? row.fill.price}`,
        kind: 'trade' as const,
      }))
      addMarks(extra)
    } catch {
      /* 没连账户、或者这一段没有成交：这一屏就不画三角，不报错 */
    }
  }

  /** 同一段行情里其它记录的判断时刻。 */
  async function addEpisode(
    built: CandleStage,
    call: CallDetail,
    look: Look,
    addMarks: (extra: StageMark[]) => void,
  ): Promise<void> {
    const link = call.episode_links.find((l) => l.status !== 'rejected')
    if (!link) return
    try {
      const found = await fetchEpisode(link.episode_id)
      if (!alive || stage !== built) return
      const others = found.links.filter((l) => l.call_id !== call.id).slice(0, 12)
      if (!others.length) return
      const extra: StageMark[] = others.map((l) => ({
        id: `ep-${l.id}`,
        index: indexIn(look.bars, l.created_at),
        label: '另一次判断',
        kind: 'other' as const,
        rail: true,
        onClick: () => go(`call/${l.call_id}`),
      }))
      addMarks(extra)
    } catch {
      /* 读不到同段行情就不画 */
    }
  }

  /* ------------------------------------------------------- 第 5 屏 打法 */

  function screenFive(screen: HTMLElement, call: CallDetail): void {
    const box = h('div.rlv-play')
    box.appendChild(h('div.eyebrow.noline', { text: '这类局面的打法' }))
    if (call.adoptions.length) {
      const first = call.adoptions[0] as { playbook_id: Uuid }
      box.appendChild(
        h('a.btn.sm', { href: `#/archive/${first.playbook_id}`, text: '看这类局面' }),
      )
    } else if (call.tags.length) {
      for (const tag of call.tags) box.appendChild(h('a.btn.sm', { href: `#/archive/${tag.id}`, text: tag.name }))
    } else {
      box.appendChild(h('p.rlv-say', { text: '还没归类' }))
      if (!call.voided) {
        box.appendChild(h('a.btn.sm.ghost', { href: `#/archive?call=${call.id}`, text: '归到一类局面' }))
      }
    }
    screen.appendChild(box)
  }

  /* ---------------------------------------------------------- 工具 */

  function mount(
    screen: HTMLElement,
    replay: Replay,
    look: Look,
    options: Omit<Parameters<typeof createCandles>[0], 'setup'>,
  ): CandleStage {
    const line = h('div.rlv-factline')
    let visibleEnd = look.track.window.end_at
    const tabs = tabsRow(replay)
    const paintLine = (count: number) => {
      const bar = look.bars[Math.max(0, Math.min(look.bars.length - 1, count - 1))] ?? null
      if (bar) visibleEnd = bar.end
      line.textContent = factText(look, bar)
    }
    lastLook = look
    const built = createCandles({
      ...options,
      setup: setupFor(choice, record()),
      onFrame: (count) => {
        paintLine(count)
        options.onFrame?.(count)
      },
    })
    stage = built
    if (tabs) screen.appendChild(tabs)
    const expand = h('button.btn.sm.ghost', { text: '全屏 K 线', attrs: { 'aria-label': '全屏查看当前走势' }, on: { click: () => { const at = look.track.window; openMarketChart({ symbol: look.track.symbol, market: look.track.market, interval: look.track.interval, start_at: at.start_at, end_at: visibleEnd, source: holdCall?.attachments.find(shot => shot.id === look.track.attachment_id)?.location?.source ?? (replay.source === 'monthly_archive' ? 'monthly_archive' : 'rest') }, '这段走势', { attachmentId: look.track.attachment_id ?? undefined, fullscreen: true, record: record(), choice }) } } })
    screen.appendChild(h('div.rlv-chart-heading', {}, line, expand))
    screen.appendChild(h('div.rlv-plate', {}, built.node))
    screen.appendChild(tools(built))
    paintLine(look.bars.length)
    void warmLead(look, built)
    return built
  }

  /** 轨道来源：定位过的那张图记着自己是从哪儿来的，没有就按这次回放的来源。 */
  function trackSource(look: Look): 'rest' | 'monthly_archive' | undefined {
    return (
      holdCall?.attachments.find((shot) => shot.id === look.track.attachment_id)?.location?.source ??
      (holdReplay?.source === 'monthly_archive' ? 'monthly_archive' : 'rest')
    )
  }

  /**
   * 开着长周期指标时，把窗口开头之前那一段也取回来喂给指标。取不到就算了：
   * 线从窗口里能算出值的地方开始画，和以前一样。
   */
  async function warmLead(look: Look, built: CandleStage): Promise<void> {
    const need = maxPeriod(setupFor(choice, record()))
    if (need <= 0) return
    const track = look.track
    const key = `${track.symbol}|${track.market}|${track.interval}|${track.window.start_at}`
    if (holdLead?.key === key) {
      built.setLead(holdLead.bars)
      return
    }
    const want = Math.min(1900, Math.ceil(need * 1.5))
    try {
      const got = await marketData(
        {
          symbol: track.symbol,
          market: track.market,
          interval: track.interval,
          start_at: historyStart(track.window.start_at, track.interval, want),
          end_at: track.window.start_at,
          source: trackSource(look),
        },
        { signal: lifetime.signal },
      )
      const edge = Date.parse(track.window.start_at)
      const bars = got.bars.filter((bar) => Date.parse(bar.start) < edge)
      holdLead = { key, bars }
      if (alive && stage === built) built.setLead(bars)
    } catch {
      /* 取不到前置那一段：指标照旧从窗口里能算的位置起头 */
    }
  }

  /** 舞台下面那一条：只有指标那一颗按钮，开哪几条线人自己说了算。 */
  function tools(built: CandleStage): HTMLElement {
    const chip = popChip({
      label: () => '指标',
      active: () => LINE_ORDER.some((name) => name !== 'volume' && choice[name]),
      items: () => menuItems(choice, record()),
      footer: () => menuFooter(record()),
      onPick: (value) => {
        if (value === '__shot') {
          const next: Choice = { ...choice }
          for (const name of seededNames(record())) next[name] = true
          choice = next
        } else if (value === '__none') {
          // 「全部关」不关成交量：那是这张图的底座，不是一条指标。
          const next: Choice = { ...choice }
          for (const name of LINE_ORDER) if (name !== 'volume') next[name] = false
          choice = next
        } else {
          const name = value as LineName
          choice = { ...choice, [name]: !choice[name] }
        }
        writeChoice(choice)
        built.setSetup(setupFor(choice, record()))
        chip.refresh()
        if (lastLook) void warmLead(lastLook, built)
      },
    })
    return h('div.rlv-toolbox', {}, h('div.rlv-tools', {}, chip.node,
      h('button.chip', { text: '−', title: '缩小', attrs: { 'aria-label': '缩小 K 线图' }, on: { click: () => built.zoomBy(1.4) } }),
      h('button.chip', { text: '+', title: '放大', attrs: { 'aria-label': '放大 K 线图' }, on: { click: () => built.zoomBy(1 / 1.4) } }),
      h('button.chip', { text: '复位', title: '恢复视野；也可双击图表', on: { click: () => built.resetView() } }),
    ))
  }

  function facts(...rows: FactRow[]): HTMLElement {
    const box = h('div.rlv-facts')
    for (const [key, value, note] of rows) {
      box.appendChild(
        h(
          'div.f',
          {},
          h('i', { text: key }),
          h('b', { text: value }),
          note ? h('u.rlv-fnote', { text: note }) : null,
        ),
      )
    }
    return box
  }

  return () => {
    alive = false
    clearTimeout(locateTimer)
    lifetime.abort()
    stage?.destroy()
    stage = null
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('pagehide', onHide)
    document.removeEventListener('visibilitychange', onVisibility)
    // 换屏还在同一条记录上就留着这一段行情；真的离开了才还回去。
    const next = route()
    if (next.page === 'relive' && next.arg.split('/')[0] === id) return
    deleteReplay(id)
    if (holdId === id) {
      holdId = null
      holdCall = null
      holdReplay = null
    }
  }
}

/* ------------------------------------------------------------- 小工具 */

/** 舞台上现在放的是哪一条轨，以及它是不是记录自己那一条。 */
interface Look {
  track: ReplayTrack
  bars: Bar[]
  /** 品种和周期都跟记录一致：价位线、成交、结果标注才对得上。 */
  own: boolean
}

/** 事实标签：名字、值，外加一句说明这个值是哪来的（可选）。 */
type FactRow = [string, string] | [string, string, string]

/** 舞台上面那一行：品种 · 周期 · 这一根的时间 · 开高低收。 */
function factText(look: Look, bar: Bar | null): string {
  const parts = [look.track.symbol, look.track.interval]
  if (bar) {
    parts.push(dateTime(bar.start))
    parts.push(
      [
        `开 ${decimalPrice(bar.open) ?? DASH}`,
        `高 ${decimalPrice(bar.high) ?? DASH}`,
        `低 ${decimalPrice(bar.low) ?? DASH}`,
        `收 ${decimalPrice(bar.close) ?? DASH}`,
      ].join(' '),
    )
  }
  return parts.join(' · ')
}

function indexIn(bars: Bar[], iso: string | null | undefined): number {
  if (!iso || !bars.length) return 0
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return 0
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (Date.parse(bars[i]!.start) <= at) return i
  }
  return 0
}

function levelLines(replay: Replay): LevelLine[] {
  const rules = replay.levels
  const out: LevelLine[] = []
  if (replay.judgment.base_price) {
    out.push({ id: 'base', price: Number(replay.judgment.base_price), label: `当时 ${decimalPrice(replay.judgment.base_price) ?? ''}`, kind: 'base' })
  }
  if (!rules) return out
  if (rules.target_price) {
    out.push({ id: 'target', price: Number(rules.target_price), label: `目标 ${decimalPrice(rules.target_price) ?? ''}`, kind: 'target' })
  }
  if (rules.invalidation_price) {
    out.push({ id: 'invalid', price: Number(rules.invalidation_price), label: `失效 ${decimalPrice(rules.invalidation_price) ?? ''}`, kind: 'invalidation' })
  }
  if (rules.boundary_price) {
    out.push({ id: 'boundary', price: Number(rules.boundary_price), label: `边界 ${decimalPrice(rules.boundary_price) ?? ''}`, kind: 'boundary' })
  }
  if (rules.trigger) {
    out.push({ id: 'trigger', price: Number(rules.trigger.price), label: `触发 ${decimalPrice(rules.trigger.price) ?? ''}`, kind: 'trigger' })
  }
  return out.filter((level) => Number.isFinite(level.price))
}

/** 回放里的那一组数字就是判分用的那一组，原样交给 `figures` 排。 */
function evaluationOf(result: Evaluation | null, marks: Replay['marks']): Evaluation | null {
  if (result) return result
  if (!marks) return null
  return {
    state: (marks.state as OutcomeState) ?? 'pending',
    reason: marks.reason,
    signed_return: marks.signed_return,
    mfe: marks.mfe,
    mae: marks.mae,
    trigger_at: marks.trigger_at,
    trigger_price: marks.trigger_price,
    end_at: marks.end_at,
    invalidation_hit: marks.invalidation_hit,
    first_threshold_interval: marks.first_threshold_interval,
  }
}

function stateLabel(replay: Replay): string {
  const state = replay.marks?.state ?? ''
  if (state === 'realized') return '对'
  if (state === 'unrealized') return '错'
  if (state === 'not_triggered') return '不算'
  if (state === 'insufficient_data') return '数据不足'
  return '到期'
}

function sceneShot(call: CallDetail): Attachment | null {
  const shots = call.attachments.filter((a) => a.kind === 'scene')
  if (shots.length) return shots[0] as Attachment
  const reference = call.attachments.filter((a) => a.kind === 'reference')
  return (reference[0] as Attachment | undefined) ?? null
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// 重温一遍 —— 把一次判断放回它当时那段真实行情里，从头走一次。
//
// 五屏一个网址：`#/relive/<call_id>/<n>`，n = 1…5。
//   1 回到那一刻   画到判断时刻停住，判断之后一根不画
//   2 定下的标准   当时写下的价位画成水平线，观察期拉成一段
//   3 市场的答案   一根一根往后长，走到哪一步就打哪一个标
//   4 后来         复盘、成交、后来那张图、同一段行情里的其它判断
//   5 全貌         整段缩到一屏，结论和两张截图并排
//
// 这几屏只摆事实：品种、周期、时间、当时的原话、算出来的价位、市场给的数字。
// 没有一句解说，也没有一句提示——那些属于写记录和写复盘的流程，不属于看。
//
// K 线是真的行情，不是那张截图。截图只在第 1 屏角落里做个对照。
// 这一段行情是临时借来的：离开这个页面就发 DELETE 还回去。

import { MAX_BARS, fetchKlines } from '../../api/binance'
import { ApiError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import { episode as fetchEpisode } from '../../api/knowledge'
import {
  deleteReplay,
  getReplay,
  putChartSetup,
  type ChartSetup,
  type Replay,
} from '../../api/replay'
import * as trades from '../../api/trades'
import type {
  Attachment,
  Bar,
  CallDetail,
  Evaluation,
  FillRow,
  OutcomeState,
  ReviewRecord,
  Uuid,
} from '../../api/types'
import { STANCES, TEMPLATES } from '../../data/criteria'
import { percent, price as decimalPrice } from '../../data/decimal'
import { figures, head as headOutcome } from '../../data/outcome'
import { INTERVAL_SECONDS, MARKET_LABELS, type Interval } from '../../data/session'
import { detail, invalidate } from '../../data/store'
import { DASH, dateTime, utcRange } from '../../data/time'
import { go, route } from '../../router'
import { stamp, stanceBadge } from '../../ui/bits'
import { h, type Child } from '../../ui/dom'
import { lightbox } from '../../ui/lightbox'
import { attachmentImage } from '../../ui/media'
import { prefersReducedMotion, stagger } from '../../ui/motion'
import { empty, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { createCandles, type CandleStage, type LevelLine, type StageBand, type StageMark } from './candles'
import { locateBoard } from './locate'
import {
  EMPTY as EMPTY_SETUP,
  MAX_LINES,
  MAX_VOL_LINES,
  SHOT_DEFAULT,
  cloneSetup,
  normalizeSetup,
  setupIsEmpty,
  validateSetup,
} from './setup'

const TITLES = ['回到那一刻', '定下的标准', '市场的答案', '后来', '全貌']

/**
 * 这一段行情在后端是按 24 小时过期的临时缓存，五屏之间来回走不该每次都重取，
 * 所以整条记录的回放在这里留到人离开为止。离开时连它一起丢掉。
 */
let holdId: Uuid | null = null
let holdCall: CallDetail | null = null
let holdReplay: Replay | null = null
/** 这一份 K 线是浏览器直连交易所取的，还是后端缓存给的。 */
type Source = 'binance' | 'backend'
let holdSource: Source = 'backend'

/** 这次会话里已经自动找过一遍的截图，不再重复起检索。 */
const searched = new Set<Uuid>()

export function relivePage(host: HTMLElement, arg: string): () => void {
  const parts = arg.split('/')
  const id = parts[0] ?? ''
  const wanted = Number(parts[1] ?? '1')
  const step = Number.isFinite(wanted) ? Math.min(5, Math.max(1, Math.trunc(wanted))) : 1

  let alive = true
  let stage: CandleStage | null = null
  let locate: { destroy: () => void } | null = null
  const setupAction = new WriteAction()
  // 第 3 屏把这三个交给键盘用；别的屏就是空的。
  let playAgain: (() => void) | null = null
  let pauseNow: (() => void) | null = null
  let isPlaying: (() => boolean) | null = null

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
    holdSource = 'backend'
  }

  paintTop(null)
  body.replaceChildren(spinner('正在把那一段行情取回来…'))
  void load()

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null
    if (target && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return
    if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (step < 5) go(`relive/${id}/${step + 1}`)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (step > 1) go(`relive/${id}/${step - 1}`)
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
          const got = await pullReplay()
          replay = got.replay
          holdReplay = replay
          holdSource = got.source
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
          action: h('a.btn.sm', { href: `#/call/${id}`, text: '回到记录' }),
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
  async function pullReplay(): Promise<{ replay: Replay; source: Source }> {
    let meta: Replay
    try {
      meta = await getReplay(id, { bars: 'none' })
    } catch (error) {
      // 连这一条都不认（老后端可能挑参数），退回原来那一条路。
      if (!(error instanceof ApiError)) throw error
      return { replay: await getReplay(id), source: 'backend' }
    }
    // 没有 bars_included 就是老后端：它给什么就是什么。
    if (meta.bars_included !== false) return { replay: meta, source: 'backend' }
    if (meta.bars.length) return { replay: meta, source: 'backend' }
    try {
      const bars = await directBars(meta)
      if (bars) return { replay: { ...meta, bars, bars_included: true }, source: 'binance' }
    } catch {
      /* 451、跨域、超时、网络断了——都不是人要处理的事，换一条路就是 */
    }
    return { replay: await getReplay(id), source: 'backend' }
  }

  /** 直连交易所取这一段。取回来的必须和窗口对得上，对不上就当没取到。 */
  async function directBars(meta: Replay): Promise<Bar[] | null> {
    const seconds = INTERVAL_SECONDS[meta.interval as Interval]
    const start = Date.parse(meta.window.start_at)
    const end = Date.parse(meta.window.end_at)
    if (!seconds || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
    const expected = Math.floor((end - start) / (seconds * 1_000))
    if (expected < 2 || expected > MAX_BARS) return null
    const bars = await fetchKlines({
      symbol: meta.symbol,
      market: meta.market,
      interval: meta.interval,
      start_at: meta.window.start_at,
      end_at: meta.window.end_at,
    })
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
      h('a.rlv-back', { href: `#/call/${id}`, text: '回到记录' }),
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

  /* ------------------------------------------------------------ 主体 */

  function paint(call: CallDetail, replay: Replay | null, failure: ApiError | null): void {
    stage?.destroy()
    stage = null
    locate?.destroy()
    locate = null
    playAgain = null
    pauseNow = null
    isPlaying = null

    const screen = h('div.rlv-screen', { data: { step: String(step) } })
    body.replaceChildren(screen)

    if (!replay) {
      screen.appendChild(
        h('div.rlv-flat', {}, h('p.rlv-say', { text: failure?.message ?? '这一段行情取不到。' })),
      )
      if (failure?.code !== 'replay_interval_unsupported') screen.appendChild(board(call, false))
      screen.appendChild(
        h('div.rlv-acts', {}, h('a.btn.sm', { href: `#/call/${id}`, text: '回到记录' })),
      )
      stagger(screen.children, 6)
      return
    }

    if (!replay.bars.length) {
      screen.appendChild(h('div.rlv-flat', {}, h('p.rlv-say', { text: '这一段行情里没有 K 线。' })))
      stagger(screen.children, 6)
      return
    }

    if (step === 1) screenOne(screen, call, replay)
    else if (step === 2) screenTwo(screen, call, replay)
    else if (step === 3) screenThree(screen, call, replay)
    else if (step === 4) screenFour(screen, call, replay)
    else screenFive(screen, call, replay)

    screen.appendChild(walkRow())
    stagger(screen.children, 8)
  }

  function walkRow(): HTMLElement {
    const row = h('div.rlv-walk')
    row.appendChild(
      step > 1
        ? h('a.btn.sm.ghost', { href: `#/relive/${id}/${step - 1}`, text: `上一屏 · ${TITLES[step - 2]}` })
        : h('a.btn.sm.ghost', { href: `#/call/${id}`, text: '回到记录' }),
    )
    // 最后一屏自己带着「再看一遍」和「回到记录」，这里就不再重复一遍。
    if (step < 5) {
      row.appendChild(h('a.btn.sm.primary', { href: `#/relive/${id}/${step + 1}`, text: `下一屏 · ${TITLES[step]}` }))
    }
    return row
  }

  /* ------------------------------------------------------- 第 1 屏 */

  function screenOne(screen: HTMLElement, call: CallDetail, replay: Replay): void {
    const judgeIndex = indexOf(replay, replay.judgment.at)
    const words = call.original_text.trim()
    const badge = [STANCES[call.body.stance] ?? '', call.body.confidence === null || call.body.confidence === undefined ? '' : `把握 ${call.body.confidence}`]
      .filter(Boolean)
      .join(' · ')

    const marks: StageMark[] = [
      {
        id: 'judgment',
        index: judgeIndex,
        price: replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
        label: badge || '这一刻',
        sub: words ? cut(words, 60) : null,
        kind: 'judgment',
        ...(words.length > 60 ? { onClick: () => showWords(words) } : {}),
      },
    ]

    const built = mount(screen, call, {
      bars: replay.bars,
      interval: replay.interval,
      marks,
      judgmentAt: replay.judgment.at,
    })
    built.showUpTo(judgeIndex)
    built.zoom({ from: 0, to: judgeIndex })

    const shot = sceneShot(call)
    if (shot) {
      const corner = h('div.rlv-shot')
      corner.appendChild(
        attachmentImage(shot.id, {
          alt: '当时那张图',
          ratio: { width: shot.width, height: shot.height },
          maxWidth: 220,
          lazy: false,
          onReady: (url, image) => {
            image.addEventListener('click', () => lightbox(url, `当时那张图 · ${dateTime(shot.uploaded_at)}`))
          },
        }),
      )
      corner.appendChild(h('span.rlv-shotl', { text: '当时那张图' }))
      built.node.appendChild(corner)
    }

    screen.appendChild(
      facts(
        ['品种', replay.symbol],
        ['周期', replay.interval],
        ['判断时刻', dateTime(replay.judgment.at)],
        judgmentPrice(replay, judgeIndex),
      ),
    )
    if (words) screen.appendChild(h('blockquote.rlv-words', { text: words }))
    // 后台正在给这条记录的图找位置的话，进来就接着看那一条任务。
    screen.appendChild(board(call, true, !!replay.locating))
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

  /**
   * 这条记录上所有图片的定位板。
   *
   * 一条记录可以挂好几张图，未必都是这条记录的现场——同板块的对比图就不是。
   * 所以不再只拿第一张场景图去钉，而是把每一张都摆出来，各自说清楚要按哪个
   * 品种、哪个周期去找。
   */
  function board(call: CallDetail, auto: boolean, running = false): HTMLElement {
    const built = locateBoard({
      call,
      auto,
      pending: running,
      asked: searched,
      onChange: () => {
        // 钉的位置变了、或者哪张图换了身份：记录详情的缓存也旧了，一起重新取。
        invalidate(id)
        holdReplay = null
        holdCall = null
        void load()
      },
    })
    locate = built
    return built.node
  }

  /* ------------------------------------------------------- 第 2 屏 */

  function screenTwo(screen: HTMLElement, call: CallDetail, replay: Replay): void {
    const judgeIndex = indexOf(replay, replay.judgment.at)
    const levels = levelLines(replay)
    const horizonEnd = replay.levels?.horizon_end_at ?? null
    const horizonIndex = horizonEnd ? indexOf(replay, horizonEnd) : judgeIndex
    const bands: StageBand[] = horizonEnd && horizonIndex > judgeIndex
      ? [{ id: 'horizon', from: judgeIndex, to: horizonIndex, label: `观察到 ${dateTime(horizonEnd)}`, kind: 'horizon' }]
      : []

    const built = mount(screen, call, {
      bars: replay.bars,
      interval: replay.interval,
      levels,
      bands,
      judgmentAt: replay.judgment.at,
      marks: [
        {
          id: 'judgment',
          index: judgeIndex,
          price: replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
          label: STANCES[call.body.stance] ?? '这一刻',
          kind: 'judgment',
        },
      ],
    })
    built.showUpTo(judgeIndex)
    built.zoom({ from: 0, to: Math.max(judgeIndex, horizonIndex) })

    const rules = replay.levels
    if (!rules || !levels.length) {
      screen.appendChild(h('p.rlv-say', { text: '没有定标准。' }))
      return
    }
    const rows: [string, string][] = []
    // 模板号认不出来就不写这一行，界面上不出现后端自己的代号。
    const named = TEMPLATES[rules.template as keyof typeof TEMPLATES]
    if (named) rows.push(['标准', named])
    if (rules.target_price) rows.push(['目标价', decimalPrice(rules.target_price) ?? rules.target_price])
    if (rules.threshold_abs) rows.push(['幅度', decimalPrice(rules.threshold_abs) ?? rules.threshold_abs])
    if (rules.invalidation_price) rows.push(['失效价', decimalPrice(rules.invalidation_price) ?? rules.invalidation_price])
    if (rules.boundary_price) rows.push(['边界', decimalPrice(rules.boundary_price) ?? rules.boundary_price])
    if (rules.trigger) {
      rows.push([
        '触发价',
        `${rules.trigger.comparator === 'lte' ? '跌到' : '涨到'} ${decimalPrice(rules.trigger.price) ?? rules.trigger.price}`,
      ])
    }
    if (rules.horizon_end_at) rows.push(['观察到', dateTime(rules.horizon_end_at)])
    screen.appendChild(facts(...rows))
  }

  /* ------------------------------------------------------- 第 3 屏 */

  function screenThree(screen: HTMLElement, call: CallDetail, replay: Replay): void {
    const judgeIndex = indexOf(replay, replay.judgment.at)
    const last = replay.bars.length - 1
    const answer = replay.marks
    const marks: StageMark[] = [
      {
        id: 'judgment',
        index: judgeIndex,
        price: replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
        label: STANCES[call.body.stance] ?? '这一刻',
        kind: 'judgment',
      },
    ]
    if (answer?.trigger_at) {
      marks.push({
        id: 'trigger',
        index: indexOf(replay, answer.trigger_at),
        price: answer.trigger_price ? Number(answer.trigger_price) : null,
        label: '触发',
        sub: dateTime(answer.trigger_at),
        kind: 'trigger',
        hold: 900,
      })
    }
    if (answer?.first_threshold_interval) {
      marks.push({
        id: 'threshold',
        index: indexOf(replay, answer.first_threshold_interval[0]),
        label: '首次达标',
        sub: dateTime(answer.first_threshold_interval[0]),
        kind: 'threshold',
        hold: 1200,
      })
    }
    if (answer?.mfe_at) {
      marks.push({ id: 'mfe', index: indexOf(replay, answer.mfe_at), label: '最有利', sub: percent(answer.mfe), kind: 'mfe' })
    }
    if (answer?.mae_at) {
      marks.push({ id: 'mae', index: indexOf(replay, answer.mae_at), label: '最不利', sub: percent(answer.mae), kind: 'mae' })
    }
    if (answer?.end_at && answer.invalidation_hit) {
      marks.push({ id: 'end', index: indexOf(replay, answer.end_at), label: '碰到失效价', sub: dateTime(answer.end_at), kind: 'invalidation' })
    } else if (answer?.end_at) {
      marks.push({
        id: 'end',
        index: indexOf(replay, answer.end_at),
        label: stateLabel(replay),
        sub: percent(answer.signed_return),
        kind: 'end',
        hold: 1400,
      })
    }

    const result = h('div.rlv-result', { hidden: true })
    const status = h('span.rlv-status', { text: dateTime(replay.judgment.at) })
    const counter = h('span.rlv-count.mono', { text: `${judgeIndex + 1} / ${replay.bars.length}` })
    let speed = 1

    const built = mount(screen, call, {
      bars: replay.bars,
      interval: replay.interval,
      levels: levelLines(replay),
      judgmentAt: replay.judgment.at,
      marks,
      onMark: (mark) => {
        status.textContent = mark.sub ? `${mark.label} · ${mark.sub}` : mark.label
        if (mark.kind === 'invalidation') {
          built.pause()
          reveal()
          paintPlay()
        } else if (mark.kind === 'end') {
          reveal()
        }
      },
      onFrame: (count) => {
        counter.textContent = `${count} / ${replay.bars.length}`
        const bar = replay.bars[Math.max(0, count - 1)]
        if (bar && !built.playing()) return
        if (bar) status.textContent = dateTime(bar.start)
      },
      onEnd: () => {
        reveal()
        paintPlay()
        if (!answer) status.textContent = '还在等'
      },
    })
    built.showUpTo(judgeIndex)

    function reveal(): void {
      if (answer) result.hidden = false
    }

    function paintPlay(): void {
      playBtn.textContent = built.playing() ? '暂停' : built.shown() - 1 >= last ? '重新播放' : '播放'
    }

    const playBtn = h('button.btn.sm.primary', {
      text: '播放',
      on: {
        click: () => {
          if (built.playing()) {
            built.pause()
          } else {
            if (built.shown() - 1 >= last) {
              built.showUpTo(judgeIndex)
              result.hidden = true
            }
            built.play(speed)
          }
          paintPlay()
        },
      },
    })

    const speeds = h('span.seg')
    for (const value of [1, 2, 4]) {
      speeds.appendChild(
        h('button', {
          text: `×${value}`,
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

    const rewind = h('button.btn.sm.ghost', {
      text: '回到判断时刻',
      on: {
        click: () => {
          built.pause()
          built.showUpTo(judgeIndex)
          result.hidden = true
          status.textContent = dateTime(replay.judgment.at)
          paintPlay()
        },
      },
    })

    screen.appendChild(h('div.rlv-controls', {}, playBtn, speeds, rewind, counter, status))
    playAgain = () => {
      if (built.shown() - 1 >= last) built.showUpTo(judgeIndex)
      built.play(speed)
      paintPlay()
    }
    pauseNow = () => {
      built.pause()
      paintPlay()
    }
    isPlaying = () => built.playing()

    const rows = figures(answer ? evaluationOf(answer) : null)
    if (rows.length) {
      result.appendChild(facts(...rows.map((row) => [row.key, row.value] as [string, string])))
      screen.appendChild(result)
    } else {
      screen.appendChild(h('p.rlv-say', { text: answer ? '这一段还没有数字。' : '还在等。' }))
    }
    paintPlay()
  }

  /* ------------------------------------------------------- 第 4 屏 */

  function screenFour(screen: HTMLElement, call: CallDetail, replay: Replay): void {
    const last = replay.bars.length - 1
    const marks: StageMark[] = []
    const bands: StageBand[] = []

    const later = h('div.rlv-later')

    call.reviews.forEach((review: ReviewRecord, i) => {
      marks.push({
        id: `review-${review.id}`,
        index: indexOf(replay, review.created_at),
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
          from: indexOf(replay, shot.location.start_at),
          to: indexOf(replay, shot.location.end_at),
          label: '后来那张图',
          kind: 'shot',
          onClick: () => openShot(shot),
        })
      } else {
        marks.push({
          id: `shot-${shot.id}`,
          index: indexOf(replay, shot.captured_at ?? shot.uploaded_at),
          label: '后来那张图',
          sub: dateTime(shot.captured_at ?? shot.uploaded_at),
          kind: 'shot',
          rail: true,
          onClick: () => openShot(shot),
        })
      }
    }

    const built = mount(screen, call, {
      bars: replay.bars,
      interval: replay.interval,
      levels: levelLines(replay),
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

    if (!call.reviews.length) {
      screen.appendChild(
        h(
          'div.rlv-acts',
          {},
          h('button.btn.sm.primary', { text: '现在就写', on: { click: () => go(`review/${call.id}/step/1`) } }),
        ),
      )
    } else {
      screen.appendChild(
        facts(
          ['复盘', `${call.reviews.length} 条`],
          ['最近一条', dateTime(call.reviews[call.reviews.length - 1]!.created_at)],
        ),
      )
      showReview(call.reviews[call.reviews.length - 1] as ReviewRecord)
    }
    screen.appendChild(later)

    function showReview(review: ReviewRecord): void {
      const rows: [string, string][] = []
      if (review.body.note) rows.push(['这次看到了什么', review.body.note])
      if (review.body.better_play) rows.push(['更好的打法', review.body.better_play])
      if (review.body.vs_last) rows.push(['和上次比', review.body.vs_last])
      later.replaceChildren(
        h('div.rlv-rhead', {}, h('b', { text: dateTime(review.created_at) }), h('span.faint', { text: '复盘' })),
        ...rows.map(([k, v]) => h('div.rlv-rrow', {}, h('i', { text: k }), h('p', { text: v }))),
      )
    }

    function openShot(shot: Attachment): void {
      later.replaceChildren(
        attachmentImage(shot.id, {
          alt: '后来那张图',
          ratio: { width: shot.width, height: shot.height },
          lazy: false,
          onReady: (url, image) => {
            image.addEventListener('click', () => lightbox(url, `后来那张图 · ${dateTime(shot.uploaded_at)}`))
          },
        }),
      )
    }

    void addFills(built, call, replay, addMarks)
    void addEpisode(built, call, replay, addMarks)
  }

  /** 这一段时间里这个品种上真实成交的几笔。读不到就不画。 */
  async function addFills(
    built: CandleStage,
    call: CallDetail,
    replay: Replay,
    addMarks: (extra: StageMark[]) => void,
  ): Promise<void> {
    if (!call.instrument) return
    try {
      const page = await trades.fills({
        symbol: call.instrument,
        start_at: replay.window.start_at,
        end_at: replay.window.end_at,
      })
      if (!alive || stage !== built) return
      const extra: StageMark[] = page.items.slice(0, 20).map((row: FillRow) => ({
        id: `fill-${row.id}`,
        index: indexOf(replay, row.fill.traded_at),
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
    replay: Replay,
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
        index: indexOf(replay, l.created_at),
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

  /* ------------------------------------------------------- 第 5 屏 */

  function screenFive(screen: HTMLElement, call: CallDetail, replay: Replay): void {
    const last = replay.bars.length - 1
    const judgeIndex = indexOf(replay, replay.judgment.at)
    const answer = replay.marks
    const now = headOutcome(call)
    const marks: StageMark[] = [
      {
        id: 'judgment',
        index: judgeIndex,
        price: replay.judgment.base_price ? Number(replay.judgment.base_price) : null,
        label: STANCES[call.body.stance] ?? '这一刻',
        kind: 'judgment',
      },
    ]
    if (answer?.trigger_at) {
      marks.push({ id: 'trigger', index: indexOf(replay, answer.trigger_at), price: answer.trigger_price ? Number(answer.trigger_price) : null, label: '触发', kind: 'trigger' })
    }
    if (answer?.mfe_at) marks.push({ id: 'mfe', index: indexOf(replay, answer.mfe_at), label: '最有利', sub: percent(answer.mfe) ?? null, kind: 'mfe' })
    if (answer?.mae_at) marks.push({ id: 'mae', index: indexOf(replay, answer.mae_at), label: '最不利', sub: percent(answer.mae) ?? null, kind: 'mae' })
    if (answer?.end_at) {
      marks.push({ id: 'end', index: indexOf(replay, answer.end_at), label: stateLabel(replay), sub: percent(answer.signed_return) ?? null, kind: answer.invalidation_hit ? 'invalidation' : 'end' })
    }
    for (const review of call.reviews) {
      marks.push({ id: `review-${review.id}`, index: indexOf(replay, review.created_at), label: '复盘', kind: 'review', rail: true })
    }

    const verdict = h(
      'div.rlv-verdict',
      {},
      stanceBadge(call.body.stance),
      now ? stamp(now.result.state, true) : stamp('pending', true),
      ...figures(now?.result ?? null).map((row) =>
        h('span.rlv-fig', {}, h('i', { text: row.key }), h('b.mono', { text: row.value })),
      ),
    )
    screen.appendChild(verdict)

    const built = mount(screen, call, {
      bars: replay.bars,
      interval: replay.interval,
      levels: levelLines(replay),
      judgmentAt: replay.judgment.at,
      marks,
    })
    built.showUpTo(last)
    built.zoom({ from: 0, to: last })


    const before = sceneShot(call)
    const after = [...call.attachments].find((a) => a.kind === 'supplement') ?? null
    if (before || after) {
      const pair = h('div.rlv-pair')
      if (before) pair.appendChild(shotCard(before, '拍下时'))
      if (after) pair.appendChild(shotCard(after, '后来'))
      screen.appendChild(pair)
    }

    screen.appendChild(
      facts(
        ['品种', replay.symbol],
        ['周期', replay.interval],
        ['这一段', `${utcRange(replay.window.start_at, replay.window.end_at)} UTC`],
        ['K 线', `${replay.bars.length} 根${replay.window.truncated ? '（截断）' : ''}`],
      ),
    )

    screen.appendChild(
      h(
        'div.rlv-acts',
        {},
        h('a.btn.sm', { href: `#/relive/${id}/3`, text: '再看一遍' }),
        h('a.btn.sm.ghost', { href: `#/call/${id}`, text: '回到记录' }),
      ),
    )
  }

  function shotCard(shot: Attachment, label: string): HTMLElement {
    return h(
      'figure.rlv-card',
      {},
      attachmentImage(shot.id, {
        alt: label,
        ratio: { width: shot.width, height: shot.height },
        maxWidth: 420,
        lazy: false,
        onReady: (url, image) => {
          image.addEventListener('click', () => lightbox(url, `${label} · ${dateTime(shot.uploaded_at)}`))
        },
      }),
      h('figcaption', {}, h('b', { text: label }), h('span.mono.faint', { text: dateTime(shot.captured_at ?? shot.uploaded_at) })),
    )
  }

  /* ------------------------------------------------------- 画线设置 */

  /**
   * 图上画什么，人自己说了算。
   *
   * 面板只改形状，不算指标——算在 candles.ts 里，改完立刻重画一次，看得见才知道
   * 是不是要的那条线。改稳了（半秒不动）再存回后端：调一个周期不该发五次请求。
   * 存不上就照实说一句，图上那条线留着不撤，人下次进来再改一次就是。
   *
   * 「截图默认」是记录截图上那一套（MA30/120/256 + VOL + MACD(10,30,9)）；
   * 手调乱了按一下就回去。「清空」是一条不画，只看 K 线本身。
   */
  function setupPanel(call: CallDetail, built: CandleStage): HTMLElement {
    let setup: ChartSetup = chartSetup(call)
    const box = h('div.rlv-setup')
    let timer = 0

    /** 改一次：先自己看一遍规矩，过得去才画、才存。 */
    function apply(next: ChartSetup): void {
      const bad = validateSetup(next)
      if (bad) {
        problem(bad)
        repaint()
        return
      }
      setup = next
      built.setSetup(setup)
      repaint()
      save()
    }

    function save(): void {
      window.clearTimeout(timer)
      const payload = cloneSetup(setup)
      timer = window.setTimeout(() => {
        void putChartSetup(call.id, payload, setupAction.keyFor(payload))
          .then(() => {
            setupAction.reset()
            if (holdCall) holdCall = { ...holdCall, chart_setup: payload }
          })
          .catch((error: unknown) => {
            problem(error instanceof Error ? error.message : '这几条线没有存上。')
          })
      }, 500)
    }

    /* --------------------------------------------------- 几个小零件 */

    function numberBox(value: string | number, width: string, onDone: (raw: string) => void): HTMLElement {
      const input = h('input.rlv-num', {
        type: 'number',
        value: String(value),
        style: `width:${width}`,
        attrs: { min: '0', step: 'any' },
      }) as HTMLInputElement
      input.addEventListener('change', () => onDone(input.value.trim()))
      return input
    }

    function intOf(raw: string): number | null {
      const n = Number(raw)
      return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null
    }

    /** 一行开关：标题按一下开，再按一下关。 */
    function switcher(label: string, on: boolean, flip: () => void): HTMLElement {
      return h('button.rlv-sw', { text: label, class: on ? 'on' : '', on: { click: flip } })
    }

    /** 一串周期：每个都能单独去掉，后面跟一个空格填新的。 */
    function periodList(name: string, values: number[], onSet: (next: number[]) => void): HTMLElement {
      const wrap = h('span.rlv-chips')
      for (const n of values) {
        wrap.appendChild(
          h('button.rlv-chip', {
            text: `${name}${n}`,
            title: '去掉这一条',
            on: { click: () => onSet(values.filter((v) => v !== n)) },
          }, h('u', { text: '×' })),
        )
      }
      const input = h('input.rlv-num.add', {
        type: 'number',
        placeholder: '加',
        style: 'width:4.2em',
        attrs: { min: '1', max: '500', step: '1' },
      }) as HTMLInputElement
      const take = () => {
        const raw = input.value.trim()
        if (!raw) return
        const n = intOf(raw)
        if (n === null) {
          problem('周期要填 1 到 500 之间的整数')
          return
        }
        input.value = ''
        if (values.includes(n)) return
        onSet([...values, n].sort((a, b) => a - b))
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          take()
        }
      })
      input.addEventListener('blur', take)
      wrap.appendChild(input)
      return wrap
    }

    function row(head: Child, ...rest: Child[]): HTMLElement {
      return h('div.rlv-srow', {}, head, ...rest)
    }

    /* ------------------------------------------------------ 重画一遍 */

    function repaint(): void {
      const boll = setup.boll
      const volume = setup.volume
      const macd = setup.macd
      const rsi = setup.rsi
      const atr = setup.atr

      box.replaceChildren(
        row(
          h('i.rlv-sname', { text: '预设' }),
          h('button.btn.xs', {
            text: '截图默认',
            on: { click: () => apply(cloneSetup(SHOT_DEFAULT)) },
          }),
          h('button.btn.xs.ghost', {
            text: '清空',
            disabled: setupIsEmpty(setup),
            on: { click: () => apply(cloneSetup(EMPTY_SETUP)) },
          }),
          h('span.rlv-snote', { text: `主图均线最多 ${MAX_LINES} 条` }),
        ),
        row(
          h('i.rlv-sname', { text: 'MA' }),
          periodList('MA', setup.ma, (ma) => apply({ ...cloneSetup(setup), ma })),
        ),
        row(
          h('i.rlv-sname', { text: 'EMA' }),
          periodList('EMA', setup.ema, (ema) => apply({ ...cloneSetup(setup), ema })),
        ),
        row(
          switcher('BOLL', boll !== null, () =>
            apply({ ...cloneSetup(setup), boll: boll ? null : { n: 20, k: '2' } }),
          ),
          boll ? h('span.rlv-sub', { text: '周期' }) : null,
          boll
            ? numberBox(boll.n, '4.2em', (raw) => {
                const n = intOf(raw)
                if (n === null) {
                  problem('布林周期要在 1 到 500 之间')
                  repaint()
                  return
                }
                apply({ ...cloneSetup(setup), boll: { n, k: boll.k } })
              })
            : null,
          boll ? h('span.rlv-sub', { text: '倍数' }) : null,
          boll
            ? numberBox(boll.k, '4.2em', (raw) => {
                const k = Number(raw)
                if (!Number.isFinite(k) || k <= 0 || k > 10) {
                  problem('布林倍数要在 0 到 10 之间')
                  repaint()
                  return
                }
                apply({ ...cloneSetup(setup), boll: { n: boll.n, k: raw } })
              })
            : null,
        ),
        row(
          switcher('VOL', volume !== null, () =>
            apply({ ...cloneSetup(setup), volume: volume ? null : { ma: [5, 10] } }),
          ),
          volume
            ? periodList('MAVOL', volume.ma, (ma) => apply({ ...cloneSetup(setup), volume: { ma } }))
            : null,
          volume ? h('span.rlv-snote', { text: `量均线最多 ${MAX_VOL_LINES} 条` }) : null,
        ),
        row(
          switcher('MACD', macd !== null, () =>
            apply({ ...cloneSetup(setup), macd: macd ? null : { fast: 12, slow: 26, signal: 9 } }),
          ),
          ...(macd
            ? ([
                h('span.rlv-sub', { text: '快' }),
                numberBox(macd.fast, '4.2em', (raw) => {
                  const fast = intOf(raw)
                  if (fast === null) return repaint()
                  apply({ ...cloneSetup(setup), macd: { ...macd, fast } })
                }),
                h('span.rlv-sub', { text: '慢' }),
                numberBox(macd.slow, '4.2em', (raw) => {
                  const slow = intOf(raw)
                  if (slow === null) return repaint()
                  apply({ ...cloneSetup(setup), macd: { ...macd, slow } })
                }),
                h('span.rlv-sub', { text: '信号' }),
                numberBox(macd.signal, '4.2em', (raw) => {
                  const signal = intOf(raw)
                  if (signal === null) return repaint()
                  apply({ ...cloneSetup(setup), macd: { ...macd, signal } })
                }),
              ] as Child[])
            : []),
        ),
        row(
          switcher('RSI', rsi !== null, () =>
            apply({ ...cloneSetup(setup), rsi: rsi ? null : { n: 14 } }),
          ),
          rsi ? h('span.rlv-sub', { text: '周期' }) : null,
          rsi
            ? numberBox(rsi.n, '4.2em', (raw) => {
                const n = intOf(raw)
                if (n === null) {
                  problem('RSI 周期要在 1 到 500 之间')
                  return repaint()
                }
                apply({ ...cloneSetup(setup), rsi: { n } })
              })
            : null,
        ),
        row(
          switcher('ATR', atr !== null, () =>
            apply({ ...cloneSetup(setup), atr: atr ? null : { n: 14 } }),
          ),
          atr ? h('span.rlv-sub', { text: '周期' }) : null,
          atr
            ? numberBox(atr.n, '4.2em', (raw) => {
                const n = intOf(raw)
                if (n === null) {
                  problem('ATR 周期要在 1 到 500 之间')
                  return repaint()
                }
                apply({ ...cloneSetup(setup), atr: { n } })
              })
            : null,
        ),
      )
    }

    repaint()
    return box
  }

  /* ---------------------------------------------------------- 工具 */

  function mount(
    screen: HTMLElement,
    call: CallDetail,
    options: Omit<Parameters<typeof createCandles>[0], 'setup'>,
  ): CandleStage {
    const built = createCandles({ ...options, setup: chartSetup(call) })
    stage = built
    screen.appendChild(h('div.rlv-plate', {}, built.node))
    screen.appendChild(tools(call, built, options.judgmentAt ?? null))
    return built
  }

  /**
   * 图下面那一条：指标面板的开关、回到判断那一根、还有这一段行情是哪来的。
   *
   * 数据来源写出来是因为两条路给的东西不完全一样——直连交易所的那份带成交量，
   * 后端缓存里的旧数据可能没有。看图的人有权知道自己在看哪一份。
   */
  function tools(call: CallDetail, built: CandleStage, judgmentAt: string | null): HTMLElement {
    const panel = setupPanel(call, built)
    panel.hidden = true
    const toggle = h('button.btn.sm.ghost', {
      text: '指标',
      on: {
        click: () => {
          panel.hidden = !panel.hidden
          toggle.classList.toggle('on', !panel.hidden)
        },
      },
    })
    const row = h(
      'div.rlv-tools',
      {},
      toggle,
      judgmentAt
        ? h('button.btn.sm.ghost', {
            text: '回到判断点',
            on: { click: () => built.focus(built.indexAt(judgmentAt)) },
          })
        : null,
      h('button.btn.sm.ghost', { text: '看全段', on: { click: () => built.resetView() } }),
      h('span.rlv-src', {
        text: holdSource === 'binance' ? '行情来自币安 · 直连' : '行情来自后端缓存',
        title:
          holdSource === 'binance'
            ? '这一段 K 线是浏览器直接问交易所要的，后端没有留副本。'
            : '这一段 K 线是后端取回来的临时缓存，离开这个页面就还回去。',
      }),
    )
    return h('div.rlv-toolbox', {}, row, panel)
  }

  /** 这条记录要画什么：存过就照存的画，从来没存过就用截图上那一套。 */
  function chartSetup(call: CallDetail): ChartSetup {
    if (!call.chart_setup) return cloneSetup(SHOT_DEFAULT)
    return normalizeSetup(call.chart_setup)
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
    stage?.destroy()
    stage = null
    locate?.destroy()
    locate = null
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('pagehide', onHide)
    // 换屏还在同一条记录上就留着这一段行情；真的离开了才还回去。
    const next = route()
    if (next.page === 'relive' && next.arg.split('/')[0] === id) return
    deleteReplay(id)
    if (holdId === id) {
      holdId = null
      holdCall = null
      holdReplay = null
      holdSource = 'backend'
    }
  }
}

/* ------------------------------------------------------------- 小工具 */

/** 事实标签：名字、值，外加一句说明这个值是哪来的（可选）。 */
type FactRow = [string, string] | [string, string, string]

function indexOf(replay: Replay, iso: string | null | undefined): number {
  if (!iso || !replay.bars.length) return 0
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return 0
  const first = new Date(replay.bars[0]!.start).getTime()
  if (at <= first) return 0
  for (let i = 0; i < replay.bars.length; i += 1) {
    const bar = replay.bars[i]!
    if (at >= new Date(bar.start).getTime() && at < new Date(bar.end).getTime()) return i
  }
  return replay.bars.length - 1
}

/**
 * 当时价格。记录里存着就用记录里的；没存（后端拿不到 base_price）就退到判断时刻
 * 那一根 K 线的收盘价——同一根，舞台上标的也是它。标一句「按 K 线收盘」，免得
 * 被当成当时记下来的价。
 */
function judgmentPrice(replay: Replay, judgeIndex: number): FactRow {
  const recorded = replay.judgment.base_price
  if (recorded) return ['当时价格', decimalPrice(recorded) ?? DASH]
  const bar = replay.bars[judgeIndex]
  if (!bar) return ['当时价格', DASH]
  return ['当时价格', decimalPrice(bar.close) ?? DASH, '按 K 线收盘']
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
function evaluationOf(marks: NonNullable<Replay['marks']>): Evaluation {
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
  if (state === 'realized') return '兑现'
  if (state === 'unrealized') return '未兑现'
  if (state === 'not_triggered') return '未触发'
  if (state === 'insufficient_data') return '数据不足'
  return '观察期结束'
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

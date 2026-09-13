// 全屏那张真 K 线的外壳：面板、工具条、候选切换、完整历史、指标开关。
//
// 图上除了左上角那行「品种 · 周期」和右下角那行版权，一个字都不留：统计、免责、
// 「全屏看完整历史」都已经删掉。桌面照 TradingView 的规矩——周期在图例上点，品种
// 在右边那一栏挑；手机照 AICoin 的骨架——周期条贴在画布上方（横屏贴左边），品种
// 从顶栏那个名字掀起一张底部抽屉。排布按宽高自己算，不看是不是触屏。

import { outline, type ChartOutline } from '../../api/chart'
import { ApiError } from '../../api/errors'
import { data } from '../../api/market'
import type { Bar, ChartRequest, ChartSetup, MarketData } from '../../api/types'
import { marketOutline } from '../../data/chart-comparison'
import { instruments } from '../../api/catalog'
import { getLocate } from '../../api/replay'
import { historyEnd } from '../../data/chart-window'
import { prefs } from '../../data/prefs'
import { debounce, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { sheet } from '../../ui/sheet'
import { objectUrl } from '../../ui/media'
import { lightbox } from '../../ui/lightbox'
import { problem } from '../../ui/toast'
import { anyPopOpen, closePops, popChip } from '../../ui/pop'
import { topModal } from '../../ui/modal'
import { recoverChunk } from '../../ui/chunks'
import {
  LINE_ORDER, maxPeriod, menuFooter, menuItems, readChoice, seededNames, setupFor, writeChoice,
  type Choice, type LineName,
} from './indicator-choice'
import { feed as makeFeed, type Feed } from './history-feed'
import { historyFeed, serverSkewMs, type HistoryFeed } from './history'
import { chartNavigator, NAV_H, NAV_H_SHORT, type ChartNavigator } from './history/navigator'
import { liveStream, nearNow, pinnedToLatest, streamable, type LiveStream } from './history/live'
import { correctedNow } from '../../api/market'
import { fetchRange } from '../../api/binance'
import { SHORTCUT_TITLE, shortcutItems } from './shortcuts'
import { moreSet, periodAt, quickSet, readPeriod, savePeriod } from './history/periods'
import { TARGET_PX, TARGET_PX_MOBILE, barsIn, ladderFor, levelForSpan, pickLevel, pxPerBar } from './history/lod'
import { NARROW_PX, holdOk, showsJudgment } from './view-rules'
import { bindWake, chromeHeight, navBottom } from './chrome'
import {
  PERIOD_AUTO, chartLayout, isMobileLayout, periodMenu, readScale, readWatchOpen, saveScale,
  saveWatchOpen, scrollCenter, scrollShift, segmentOrder, toggleLog, type ChartLayout,
  type ScaleMode,
} from './chart-ui'
import { spanForPeriod, spanOnBars } from './chart-span'
import { barSpanMs } from './history/tiles'
import type { TradingChart } from './trading-chart'

interface ComparisonOptions {
  queryAttachmentId?: string
  attachmentId?: string
  fullscreen?: boolean
  related?: ChartRequest[]
  /** 这条记录截图上认出来的那几条指标，只当参数种子用，不自动画。 */
  record?: ChartSetup | null
  /** 从重温页带过来的开关状态，省得同一台机器上两处不一致。 */
  choice?: Choice
}
const IDLE_MS = 2400
/** 换档提示在图例上停多久。 */
/** 刚换过档，先别急着再换：阶梯有几档正好卡在滞回区间上。 */
const SETTLE_MS = 400

/** 动效关了就不缓动。 */
function calm(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** 触屏。 */
function coarse(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches } catch { return false }
}

/**
 * 窗口态要多画几根真实后续：锚定段的 25%，最少 16 根、最多 200 根，连锚定段
 * 一起不超过后端一次能给的 2000 根。
 */
export function followCount(startAt: string, cutoffAt: string, interval: string): number {
  const seg = barsIn(Date.parse(startAt), Date.parse(cutoffAt), interval)
  if (!seg) return 0
  const want = Math.min(200, Math.max(16, Math.round(seg * 0.25)))
  return Math.max(0, Math.min(want, 2000 - seg))
}

export function openMarketChart(initial: ChartRequest, _label = '图中这段', options: ComparisonOptions = {}): void {
  const related = options.related?.length ? options.related : [initial]
  let selected = Math.max(0, related.indexOf(initial))
  /** 这条记录自己那一段：丁香带、截止线、`.chip-dot`、回锚定都按它。 */
  let anchorReq = related[selected]!
  /** 此刻画在图上的那一段。换品种、窗口态换周期只改它，`anchorReq` 不动。 */
  let request = anchorReq
  /** 眼前这张图就是这条记录本身吗。不是的话那几样标记一概不画。 */
  const onRecord = (): boolean => request.symbol === anchorReq.symbol && request.market === anchorReq.market
  let showOutline = true
  let full = false
  let closed = false
  let stage: TradingChart | null = null
  let controller: AbortController | null = null
  const lifetime = new AbortController()
  const cache = new Map<string, MarketData>()
  let contour: Pick<ChartOutline, 'values' | 'symbol'> | null = null
  let contourLoading = false
  const record = options.record ?? null
  let choice: Choice = options.choice ? { ...options.choice } : readChoice()
  const body = h('div.market-comparison')
  const candidates = h('div.market-candidates', { attrs: { 'aria-label': '本次相似结果' } })
  const controls = h('div.market-controls')
  const plot = h('div.market-plot')
  // 轮廓只在读不出来的时候说话：成功了图上那条橙虚线自己会说，不用再写一行字。
  // 这两颗挂在工具条末尾（原来那一整行「K 线 · 历史真实行情」已经取消）。
  const outlineStatus = h('span.market-outline-status', { hidden: true })
  const outlineRetry = h('button.chip', { text: '重读轮廓', hidden: true, on: { click: () => void readOutline() } })
  // 原来那块 `.market-stats` 整块取消了；数据本身有问题的那两句话搬到工具条末尾。
  const dataNote = h('span.market-outline-status', { hidden: true })
  const overlayToggle = h('button.chip', { text: '截图轮廓', hidden: !options.queryAttachmentId,
    title: '截图轮廓（O）',
    attrs: { 'aria-pressed': 'true' }, on: { click: () => toggleOutline() } })
  const volumeToggle = h('button.chip', { text: '成交量', title: '成交量（V）', attrs: { 'aria-pressed': String(choice.volume) }, on: { click: () => toggleVolume() } })
  const fullscreen = h('button.chip', { text: '全屏', title: '全屏（F）', attrs: { 'aria-label': '全屏 K 线' }, on: { click: () => setFull(!full) } })
  const previous = h('button.chip', { text: '← 上一个', title: '上一个（[）', on: { click: () => pick(selected - 1) } })
  const next = h('button.chip', { text: '下一个 →', title: '下一个（]）', on: { click: () => pick(selected + 1) } })
  const counter = h('span.market-counter')
  if (related.length > 1) candidates.append(previous, counter, next)
  // 候选那一排不再露脸：右边品种栏的「本次相关」就是它，`[` `]` 照常切。
  candidates.hidden = true
  const picks = related.length > 1 ? related.map((item, i) => {
    const b = h('button.chip', { text: item.symbol, on: { click: () => pick(i) } }); candidates.appendChild(b); return b
  }) : []

  /* ------------------------------------------------------ 指标那一颗 */

  const indicatorChip = popChip({
    label: () => '指标',
    active: () => LINE_ORDER.some((name) => name !== 'volume' && choice[name]),
    items: () => menuItems(choice, record),
    footer: () => menuFooter(record),
    onPick: (value) => {
      if (value === '__shot') {
        const on = seededNames(record)
        const next: Choice = { ...choice }
        for (const name of on) next[name] = true
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
      applyIndicators()
      indicatorChip.refresh()
    },
  })
  indicatorChip.node.querySelector('.chip')?.setAttribute('title', '指标（I）')

  /* ------------------------------------------------------ 坐标那一颗 */

  // 价格轴三选一。默认对数：同一张图上从上市那几分钱看到今天的几万块，常规轴会
  // 把早年那一段压成一条直线。选了哪一档记在本机上，下次打开还是它。
  let scaleMode: ScaleMode = readScale()
  const scaleChip = popChip({
    label: () => '坐标',
    active: () => scaleMode !== 'log',
    items: () => [
      { label: '对数', value: 'log', on: scaleMode === 'log' },
      { label: '常规', value: 'normal', on: scaleMode === 'normal' },
      { label: '百分比', value: 'percent', on: scaleMode === 'percent' },
    ],
    onPick: (value) => setScale(value as ScaleMode),
  })
  scaleChip.node.querySelector('.chip')?.setAttribute('title', '坐标（Alt+L 切换对数/常规）')
  function setScale(mode: ScaleMode): void {
    scaleMode = mode
    saveScale(mode)
    stage?.setScaleMode(mode)
    scaleChip.refresh()
  }

  /* -------------------------------------------------- 完整历史（全屏） */

  // 窗口态只画锚定段加一小段真实后续；完整历史是全屏那张图的事，人一进全屏就
  // 开始按视野往两边取，不再有「完整历史」这颗按钮，也不再有「之后 N 根」。

  let feed: Feed | null = null
  let history: HistoryFeed | null = null
  /** 当前 feed 对应的 (市场, 品种, 周期, 来源)。换候选换到别的品种才重建。 */
  let historySpace = ''
  let windowBars: MarketData['bars'] = []
  /** windowBars 是哪一个候选取回来的。 */
  let loadedFor: ChartRequest | null = null
  let level = request.interval
  let ladder: string[] = ladderFor(request.interval)
  let lockedLevel = false
  let settling = 0
  let moved: { at: number; middle: number } | null = null
  let painting = 0

  /** 本机时钟和后端对过表之后的「现在」。活的那一根、导航条右端都按它算。 */
  const nowMs = (): number => correctedNow(Date.now(), serverSkewMs())

  /** 右边缘钉在最新那一根上。 */
  let follow = false
  const followChip = h('button.chip', {
    text: '跟到最新', title: '跟到最新（End）', hidden: true,
    attrs: { 'aria-pressed': 'false' }, on: { click: () => setFollow(!follow) },
  })
  let magnetOn = false
  const magnetChip = h('button.chip', {
    text: '吸附', title: '吸附（M）', hidden: true,
    attrs: { 'aria-pressed': 'false' }, on: { click: () => setMagnet(!magnetOn) },
  })
  const keysChip = popChip({
    label: () => '快捷键',
    active: () => false,
    // 标题单独占一条：pop 遇到带 header 的 item 只画标题就跳过，挂在第 0 行上会把
    // 「拖拽 / Shift+滚轮 / ← → · 平移」这一行吃掉。
    items: () => [
      { header: SHORTCUT_TITLE, label: '', value: '__keys_head' },
      ...shortcutItems(),
    ],
    onPick: () => { /* 只是一张表，点哪一行都不做事 */ },
  })
  keysChip.node.hidden = true
  keysChip.node.querySelector('.chip')?.setAttribute('title', '快捷键（?）')

  function paintFollow(): void {
    followChip.setAttribute('aria-pressed', String(follow))
    stage?.setFollowLatest(follow)
  }
  function setFollow(on: boolean): void {
    follow = on
    paintFollow()
    if (on) toNow()
    syncLive()
  }
  function setMagnet(on: boolean): void {
    magnetOn = on
    magnetChip.setAttribute('aria-pressed', String(on))
    stage?.setMagnet(on)
  }

  /* ------------------------------------------------ 周期条（全屏常驻） */

  // 看盘的人要的是交易所那种一眼可见、一点就换的周期条，不是藏在弹层里的一颗
  // 「周期」。条上永远有这条记录自己的那一档，选了就锁，`自动` 回一期的按密度
  // 换档。条上露哪几颗由 `periods.ts` 那个纯函数说了算。

  /** 这一次从「更多」里挑出来、临时露在条上的那一颗。 */
  let picked: string | null = null
  /** 后端说不支持的那几档（直连币安时永远是空的）。 */
  const unsupported = new Set<string>()
  /** 条上此刻从左到右是哪几颗。数字键按的就是它。 */
  let shownPeriods: string[] = []
  const periodChips = new Map<string, HTMLButtonElement>()

  const periodBar = h('div.tv-periods', {
    hidden: true, attrs: { role: 'radiogroup', 'aria-label': '周期' },
  })
  // 竖屏这一条横着滚，滚的只是中间这一段：`自动` 和 `更多` 留在两头不动，`更多`
  // 的弹层也就不会被滚动容器裁掉。
  const periodList = h('div.tv-periods-list')
  const periodSep = h('span.tv-periods-sep', { hidden: true, attrs: { 'aria-hidden': 'true' } })
  const autoChip = h('button.chip.chip-period.chip-auto', {
    text: '自动', attrs: { 'aria-pressed': 'false' }, on: { click: () => setAuto() },
  })
  const moreChip = popChip({
    label: () => '更多',
    active: () => false,
    items: () => moreSet(shownPeriods).map((step) => ({
      label: step,
      value: step,
      on: step === level,
      ...(unsupported.has(step) ? { hint: '这个周期后端暂不支持' } : {}),
    })),
    onPick: (value) => pickPeriod(value),
  })

  /** 上一次把条滚到哪一档上。人自己滚过之后不再抢，除非档变了或者条重铺了。 */
  let scrolledTo: string | null = null

  function buildPeriods(list: readonly string[]): void {
    scrolledTo = null
    periodChips.clear()
    periodList.textContent = ''
    periodBar.textContent = ''
    periodBar.append(autoChip, periodList, moreChip.node)
    for (const step of list) {
      const chip = h('button.chip.chip-period', {
        text: step, attrs: { role: 'radio', 'aria-checked': 'false' },
        on: { click: () => pickPeriod(step) },
      }) as HTMLButtonElement
      // 这条记录自己那一档右上角点一个点，人一眼认得出「我当时看的是这张图」。
      if (step === anchorReq.interval) {
        chip.appendChild(h('i.chip-dot', { title: '这条记录的周期', attrs: { 'aria-hidden': 'true' } }))
      }
      periodChips.set(step, chip)
      periodList.appendChild(chip)
    }
  }

  function paintPeriods(): void {
    const list = quickSet(window.innerWidth, window.innerHeight, anchorReq.interval, picked)
    if (list.join(' ') !== shownPeriods.join(' ')) { shownPeriods = list; buildPeriods(list) }
    paintTitle()
    const lockTitle = `周期已锁定 ${level} · 按 A 回自动`
    const autoTitle = `周期自动 · 现在是 ${level}`
    autoChip.setAttribute('aria-pressed', String(!lockedLevel))
    autoChip.classList.toggle('on', !lockedLevel)
    autoChip.title = lockedLevel ? lockTitle : autoTitle
    for (const [step, chip] of periodChips) {
      const here = step === level
      chip.setAttribute('aria-checked', String(here))
      // 锁定的那一档填充，自动落到的那一档描边——两者一眼能分开。
      chip.classList.toggle('on', here && lockedLevel)
      chip.classList.toggle('at', here && !lockedLevel)
      const off = unsupported.has(step)
      chip.disabled = off
      chip.title = off ? '这个周期后端暂不支持' : here ? (lockedLevel ? lockTitle : autoTitle) : ''
    }
    moreChip.refresh()
    showPeriod()
  }

  /**
   * 把当前这一档整颗滚进可见区。
   *
   * 手机上条里放不下十来颗，不滚的话当前档常常半个字压在两头钉着的 `自动` /
   * `更多` 边上，只看得见一半。只在档变了或者条刚重铺时滚一次：人自己滑到别处
   * 看的时候，不能每次重绘都把他拽回来。竖屏横着滚，横屏竖着滚，同一段代码。
   */
  function showPeriod(): void {
    if (periodBar.hidden) return
    if (scrolledTo === level) return
    const chip = periodChips.get(level)
    if (!chip) return
    const box = periodList.getBoundingClientRect()
    if (!(box.width > 0) || !(box.height > 0)) return
    const seen = chip.getBoundingClientRect()
    if (!(seen.width > 0)) return
    // 条还没被挤成「要滚」的样子——刚挂上文档的那一帧、画布还是占位图的时候都
    // 是这样：这会儿谁都整颗露着，算出来当然不用挪。别把「滚过了」记下来，不然
    // 等它真变窄，当前档被两头钉着的 `更多` 盖住半颗，也再没人来滚一次。
    const wide = periodList.scrollWidth > periodList.clientWidth + 1
    const tall = periodList.scrollHeight > periodList.clientHeight + 1
    if (!wide && !tall) return
    scrolledTo = level
    const offX = scrollShift({ start: box.left, end: box.right }, { start: seen.left, end: seen.right })
    const offY = scrollShift({ start: box.top, end: box.bottom }, { start: seen.top, end: seen.bottom })
    // 露全了就别动。真要挪就一次挪到居中：那是吸附点，浏览器不会再把它吸回边上。
    if (offX) periodList.scrollLeft += scrollCenter({ start: box.left, end: box.right }, { start: seen.left, end: seen.right })
    if (offY) periodList.scrollTop += scrollCenter({ start: box.top, end: box.bottom }, { start: seen.top, end: seen.bottom })
  }

  /**
   * 人手点的那一档（图例菜单、周期条、`更多`、数字键，都走这里）。
   *
   * 人手换档保「一根多宽」，不保「看了多长一段时间」：周期越大 K 线越粗，是这张
   * 图最劝退的一件事。按当前根宽和画布宽反算出新的跨度，中心那一刻钉住不动，换
   * 完每根还是那么粗。按密度自动换档（`goTo` / `onView` 那一路）照旧保跨度。
   */
  function pickPeriod(step: string): void {
    if (unsupported.has(step)) return
    const base = quickSet(window.innerWidth, window.innerHeight, anchorReq.interval, null)
    // 从「更多」里挑的那一颗临时露在条上；再选一颗快捷周期它就收回去。
    picked = base.includes(step) ? null : step
    lockedLevel = true
    savePeriod(request.market, request.symbol, step)
    if (!full) { windowPeriod(step); return }
    if (step !== level) handSwitch(step)
    else paintPeriods()
  }

  /** 这一刻视野中心不动、每根还是这么宽，换成 `step` 之后该看哪一段。 */
  function heldSpan(step: string): { from: number; to: number } | null {
    if (!stage) return null
    const range = stage.visibleTime()
    if (!range) return null
    const stepMs = barSpanMs(step)
    const held = spanForPeriod(range.from, range.to, stage.paneWidth(), stage.barSpacing(), stepMs)
    // 上一档被未来封顶推过之后，中点可能已经在上市之前的空白里；照中点换档会换出
    // 一张一根 K 线都没有的图。跨度不动，把这一段平移到最近的真 K 线上。
    const edge = history?.edges() ?? null
    const span = edge
      ? spanOnBars(held, stepMs, { firstMs: edge.onboardMs, lastMs: edge.deliveryMs })
      : held
    return span.to > span.from ? span : null
  }

  /** 全屏里人手换档：保根宽、保中心。 */
  function handSwitch(step: string): void {
    if (!stage || !history) { switchLevel(step); return }
    const span = heldSpan(step)
    if (!span) { switchLevel(step); return }
    applyLevel(step, span.from, span.to)
    settling = Date.now() + SETTLE_MS
    stage.setVisibleTime(span.from, span.to, false, barsAt(span.from, span.to))
    pumpFocus(span.from, span.to, 0)
    schedulePaint()
  }

  /** 窗口态换档：这里没有懒加载，重新取一段就是了，根宽照样保住。 */
  function windowPeriod(step: string): void {
    if (step === request.interval && step === level) { paintPeriods(); return }
    pendingSpan = heldSpan(step)
    request = { ...request, interval: step }
    level = step
    ladder = ladderFor(step)
    paintPeriods()
    void load()
  }

  /** 回自动：按密度换档，这个品种存的那一档也一并忘掉。 */
  function setAuto(): void {
    lockedLevel = false
    savePeriod(request.market, request.symbol, null)
    paintPeriods()
  }

  const zoomOut = h('button.chip', { text: '−', title: '缩小（−）', attrs: { 'aria-label': '缩小 K 线图' }, on: { click: () => zoomBy(1.35) } })
  const zoomIn = h('button.chip', { text: '+', title: '放大（+）', attrs: { 'aria-label': '放大 K 线图' }, on: { click: () => zoomBy(1 / 1.35) } })
  const resetChip = h('button.chip', { text: '复位', title: '复位（0）', on: { click: () => home() } })
  const shotToggle = options.attachmentId
    ? h('button.chip', { text: '原图', attrs: { 'aria-label': '查看原始截图' }, on: { click: () => openShot() } })
    : null
  const similarChip = options.attachmentId
    ? h('button.chip', { text: '找相似', on: { click: () => { window.location.hash = `/search/like/${options.attachmentId}` } } })
    : null

  /** 工具条上从左到右是哪几颗。桌面一套、手机一套，顺序都是定死的。 */
  function orderControls(): void {
    const line = isMobileLayout(layoutNow)
      ? [volumeToggle, indicatorChip.node, scaleChip.node, overlayToggle, followChip, magnetChip,
        resetChip, shotToggle, similarChip]
      : [followChip, magnetChip, overlayToggle, volumeToggle, indicatorChip.node, scaleChip.node,
        zoomOut, zoomIn, resetChip, similarChip, shotToggle, keysChip.node]
    controls.replaceChildren(
      ...line.filter((node): node is HTMLElement => !!node),
      outlineStatus, outlineRetry, dataNote,
    )
  }

  const credit = h('a.market-credit', { text: 'TradingView Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc.', attrs: { href: 'https://www.tradingview.com/', target: '_blank', rel: 'noopener noreferrer' } })
  // 周期条贴着画布：手机竖屏在上边一条，横屏在左边一竖列，桌面根本不露（周期在
  // 图例上点）。所以它和画布得在同一个盒子里，方向由排布说了算。
  const stageRow = h('div.market-stage', {}, periodBar, plot)
  const panel = sheet(`${request.symbol} · ${request.interval}`, body, () => {
    closed = true; controller?.abort(); lifetime.abort(); stage?.destroy(); cache.clear(); contour = null
    history?.destroy(); history = null
    navFeed?.destroy(); navFeed = null
    nav?.destroy(); nav = null
    live?.stop(); live = null
    document.removeEventListener('visibilitychange', onHidden)
    if (painting) cancelAnimationFrame(painting)
    if (chromeFrame) cancelAnimationFrame(chromeFrame)
    chromeWatch?.disconnect()
    periodWatch?.disconnect()
    window.removeEventListener('resize', onViewport)
    window.removeEventListener('orientationchange', onViewport)
    document.removeEventListener('click', onDocClick)
    window.clearTimeout(idleTimer)
    document.removeEventListener('fullscreenchange', onFullChange)
    document.removeEventListener('keydown', onKey)
    if (document.fullscreenElement === panel.node) void document.exitFullscreen().catch(() => {})
  }, { onEscape: () => {
    // Esc 一层一层退：先收菜单，再收品种栏，最后才出全屏。
    if (anyPopOpen() || periodPop) { closePops(); closePeriodMenu(); return true }
    if (watchOpen) { setWatch(false); return true }
    if (!full) return false
    setFull(false); return true
  } })
  panel.node.classList.add('market-dialog')
  const head = panel.node.querySelector('.sheet-h')!
  head.insertBefore(fullscreen, panel.node.querySelector('.sheet-x'))
  fullscreen.classList.add('market-expand')

  /* ---------------------------------------------------------- 全屏 */

  /** 全屏时工具条搬进画布；窗口态搬回去。版权一直贴在画布右下角。 */
  function placeChrome(): void {
    // 底下这几下 append 是在挪节点，挪完浏览器会把周期条滚回原点；先记着，摆完放回去。
    const keptLeft = periodList.scrollLeft
    const keptTop = periodList.scrollTop
    if (full) {
      head.insertBefore(candidates, fullscreen)
      plot.append(controls)
      if (pip) plot.appendChild(pip)
    } else if (isMobileLayout(layoutNow)) {
      // 手机上工具条在画布下面（周期条在画布上面），这是 AICoin 那张图的骨架。
      body.append(candidates, stageRow, controls)
      pip?.remove()
    } else {
      body.append(candidates, controls, stageRow)
      pip?.remove()
    }
    // 版权只在全屏时贴画布右下角（那儿有工具条留出的空）；窗口态回到图下方的
    // 正常文档流里，压在时间轴刻度上就看不清刻度了。
    if (full) plot.appendChild(credit)
    else body.append(credit)
    placeWatch()
    periodList.scrollLeft = keptLeft
    periodList.scrollTop = keptTop
    // 周期条是这会儿才进的文档（窗口态首次展示、转屏、进出全屏都走这儿）：之前
    // 它还没挂上去，量出来的宽高全是 0，滚不了。等一帧让布局落定再把当前档滚进来。
    requestAnimationFrame(() => { if (!closed) showPeriod() })
  }
  function paintFull(): void {
    // 进出全屏等于这条又「第一次展示」一遍：条的宽窄全变了，重新把当前档滚进来。
    scrolledTo = null
    panel.node.classList.toggle('market-fullscreen', full)
    panel.node.parentElement?.classList.toggle('market-fullscreen-box', full)
    fullscreen.textContent = full ? '退出全屏' : '全屏'
    fullscreen.title = full ? '退出全屏（F）' : '全屏（F）'
    fullscreen.setAttribute('aria-label', full ? '退出全屏 K 线' : '全屏 K 线')
    if (!full) { pipOn = false; shotToggle?.setAttribute('aria-pressed', 'false'); pip?.remove(); pip = null }
    applyLayout()
    followChip.hidden = !full
    magnetChip.hidden = !full
    keysChip.node.hidden = !full || coarse() || isMobileLayout(layoutNow)
    placeChrome()
    if (full) { wake(); beginHistory() }
    else { window.clearTimeout(idleTimer); panel.node.classList.remove('market-idle'); endHistory() }
    measureChrome()
  }
  function setFull(on: boolean): void {
    full = on; paintFull()
    if (on && document.fullscreenEnabled && panel.node.requestFullscreen) void panel.node.requestFullscreen().catch(() => { /* Retain viewport-sized fallback on mobile/LAN. */ })
    else if (!on && document.fullscreenElement === panel.node) void document.exitFullscreen().catch(() => {})
  }
  function onFullChange(): void { if (document.fullscreenElement !== panel.node && full) { full = false; paintFull() } }
  document.addEventListener('fullscreenchange', onFullChange)

  /* ------------------------------------ 桌面 / 手机竖屏 / 手机横屏 三套排布 */

  // 按宽高算，不看是不是触屏：桌面浏览器窗口拖到 760 以下，就该是手机那一套。
  let layoutNow: ChartLayout = chartLayout(window.innerWidth, window.innerHeight)
  /** 品种栏开着没有。桌面记在本机上，手机每次掀起来都是新的。 */
  let watchOpen = isMobileLayout(layoutNow) ? false : readWatchOpen()
  /** 这一批候选里，这条记录自己是第几个。品种栏里它永远排第一。 */
  const recordAt = Math.max(0, related.indexOf(initial))
  /** 换周期、换品种之后要落到的那一段（保住根宽算出来的）。 */
  let pendingSpan: { from: number; to: number } | null = null
  /** 下一次重建完成之后按锚定复位（点「本次相关」里的记录行走这条）。 */
  let homeOnLoad = false

  function applyLayout(): void {
    const was = isMobileLayout(layoutNow)
    const wasLayout = layoutNow
    layoutNow = chartLayout(window.innerWidth, window.innerHeight)
    const mobile = isMobileLayout(layoutNow)
    // 跨过 760 那条线：手机上品种栏不记状态，桌面上按本机记的那份来。
    if (mobile !== was) watchOpen = mobile ? false : readWatchOpen()
    panel.node.classList.toggle('market-desktop', !mobile)
    panel.node.classList.toggle('market-mobile', mobile)
    panel.node.classList.toggle('market-portrait', layoutNow === 'portrait')
    panel.node.classList.toggle('market-landscape', layoutNow === 'landscape')
    // 桌面上周期在图例上点，底下那条就不露了；手机上窗口态、全屏都露。
    periodBar.hidden = !mobile
    periodSep.hidden = true
    // 价格轴收窄、K 线和量柱画细一号：每次布局变化都递一发，首次也递。
    stage?.setMobile(mobile)
    keysChip.node.hidden = !full || coarse() || mobile
    orderControls()
    paintTitle()
    paintLegend()
    placeWatch()
    // 跨过 760px 或者转屏：周期条、工具条、版权在文档流里的先后也得跟着翻一遍。
    if (mobile !== was) placeChrome()
    // 条的方向和宽度都变了，上一次滚到哪儿不算数：重新把当前档滚进来。
    if (layoutNow !== wasLayout) scrolledTo = null
    paintPeriods()
  }

  /** 顶栏那行字：桌面是「品种 · 周期」，手机只留品种，点它掀品种抽屉。 */
  function paintTitle(): void {
    // 顶栏那行字和图例是同一句话：换品种换周期都跟着走，两处不许说不一样的话。
    const title = `${request.symbol} · ${level}`
    panel.node.setAttribute('aria-label', title)
    const slot = panel.node.querySelector('.sheet-t')
    if (!slot) return
    slot.textContent = isMobileLayout(layoutNow) ? request.symbol : title
    slot.classList.toggle('market-title-tap', isMobileLayout(layoutNow))
  }
  panel.node.querySelector('.sheet-t')?.addEventListener('click', (event) => {
    if (!isMobileLayout(layoutNow)) return
    event.stopPropagation()
    setWatch(!watchOpen)
  })

  /* ---------------------------------------------- 图例那一行是两颗按钮 */

  function paintLegend(): void {
    const parts = stage?.legendParts()
    if (!parts) return
    const mobile = isMobileLayout(layoutNow)
    const sym = parts.symbol as HTMLButtonElement
    const per = parts.period as HTMLButtonElement
    sym.disabled = mobile
    per.disabled = mobile
    parts.line.classList.toggle('tv-legend-flat', mobile)
    // 品种栏开着的时候，品种那半一直带着下划线。
    sym.classList.toggle('on', watchOpen && !mobile)
    sym.setAttribute('aria-expanded', String(watchOpen && !mobile))
    per.setAttribute('aria-expanded', String(!!periodPop))
  }

  function bindLegend(): void {
    const parts = stage?.legendParts()
    if (!parts) return
    parts.symbol.addEventListener('click', (event) => {
      event.stopPropagation()
      if (isMobileLayout(layoutNow)) return
      setWatch(!watchOpen)
    })
    parts.period.addEventListener('click', (event) => {
      event.stopPropagation()
      if (isMobileLayout(layoutNow)) return
      togglePeriodMenu()
    })
  }

  /* -------------------------------------------- 图例上点开的那张周期菜单 */

  let periodPop: HTMLElement | null = null
  function closePeriodMenu(): void {
    if (!periodPop) return
    periodPop.remove()
    periodPop = null
    paintLegend()
  }
  function togglePeriodMenu(): void {
    if (periodPop) { closePeriodMenu(); return }
    const parts = stage?.legendParts()
    if (!parts) return
    closePops()
    const list = h('div.pop-list')
    for (const row of periodMenu({ level, auto: !lockedLevel, record: anchorReq.interval, unsupported })) {
      const button = h('button', {
        class: row.on ? 'on' : '',
        disabled: row.off,
        ...(row.off ? { title: '这个周期后端暂不支持' } : {}),
        on: {
          click: (event: Event) => {
            event.stopPropagation()
            closePeriodMenu()
            if (row.value === PERIOD_AUTO) setAuto()
            else pickPeriod(row.value)
          },
        },
      }, h('span.chk', {}, icon('check')), row.label)
      if (row.dot) button.appendChild(h('i.chip-dot', { title: '这条记录的周期', attrs: { 'aria-hidden': 'true' } }))
      list.appendChild(button)
    }
    periodPop = h('div.pop.tv-period-pop', { on: { click: (event: Event) => event.stopPropagation() } }, list)
    parts.line.appendChild(periodPop)
    paintLegend()
    wake()
  }
  function onDocClick(): void { closePeriodMenu() }
  document.addEventListener('click', onDocClick)

  /* ------------------------------------------------ 右边（手机是底下）那一栏品种 */

  const watchSearch = h('input.input.tv-watch-search', {
    placeholder: '搜索品种，如 BTC',
    attrs: { type: 'search', 'aria-label': '搜索品种' },
  }) as HTMLInputElement
  const watchBody = h('div.tv-watch-body')
  const watch = h('aside.tv-watch', { hidden: true, attrs: { 'aria-label': '品种' } },
    h('div.tv-watch-h', {},
      h('span.tv-watch-t', { text: '品种' }),
      h('button.tv-watch-x', {
        text: '×', attrs: { 'aria-label': '收起品种列表' }, on: { click: () => setWatch(false) },
      })),
    watchSearch, watchBody)
  watch.addEventListener('click', (event) => event.stopPropagation())
  const searchLater = debounce(() => void fillWatch(watchSearch.value.trim()), 250)
  watchSearch.addEventListener('input', () => searchLater())

  function placeWatch(): void {
    const mobile = isMobileLayout(layoutNow)
    watch.classList.toggle('tv-watch-sheet', mobile)
    stage?.node.classList.toggle('tv-chart-watching', watchOpen && !mobile)
    if (!watchOpen) { watch.remove(); watch.hidden = true; return }
    // 手机上是一张贴着屏幕底边的抽屉，桌面上是画布右边那一竖条。
    const host = mobile ? panel.node : stage?.node ?? null
    if (!host) { watch.remove(); return }
    watch.hidden = false
    if (watch.parentElement !== host) host.appendChild(watch)
    // 上次开着、这次一进来就摆在那儿：名单还没读过就顺手读一次。
    if (!watchBody.childElementCount) void fillWatch(watchSearch.value.trim())
  }

  function setWatch(on: boolean): void {
    // 画布一窄一宽，图默认会把右边钉住、左边吞掉一截。先记下中心和根宽，铺完再
    // 按同样的根宽把中心摆回原处——看的那一段既不跳，中心也不挪。
    const before = !isMobileLayout(layoutNow) ? stage?.visibleTime() ?? null : null
    watchOpen = on
    if (!isMobileLayout(layoutNow)) saveWatchOpen(on)
    placeWatch()
    paintLegend()
    if (before) holdCentre(before)
    if (!on) return
    void fillWatch(watchSearch.value.trim())
    wake()
  }

  /** 画布宽度变了：中心那一刻钉住，每根还是这么宽。 */
  function holdCentre(before: { from: number; to: number }): void {
    const mine = stage
    if (!mine) return
    const spacing = mine.barSpacing()
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (closed || stage !== mine) return
      const span = spanForPeriod(before.from, before.to, mine.paneWidth(), spacing, barSpanMs(level))
      if (!(span.to > span.from)) return
      if (full) { settling = Date.now() + SETTLE_MS; pumpFocus(span.from, span.to, 0) }
      mine.setVisibleTime(span.from, span.to, false, full ? barsAt(span.from, span.to) : undefined)
    }))
  }

  function watchRow(symbol: string, step: string | null, act: () => void, seg?: number): HTMLElement {
    const row = h('button.tv-watch-row', {
      on: { click: (event: Event) => { event.stopPropagation(); act() } },
    }, h('span.tv-watch-sym', { text: symbol }), step ? h('span.tv-watch-step', { text: step }) : null)
    row.dataset['sym'] = symbol
    if (seg !== undefined) row.dataset['seg'] = String(seg)
    return row
  }

  /** 选中态就地重画：换品种、回记录段之后不必再去要一次目录。 */
  function markWatch(): void {
    for (const row of watchBody.querySelectorAll<HTMLElement>('.tv-watch-row')) {
      const seg = row.dataset['seg']
      const on = seg === undefined
        ? row.dataset['sym'] === request.symbol
        : Number(seg) === selected && onRecord()
      row.classList.toggle('on', on)
    }
  }

  let watchTurn = 0
  async function fillWatch(query: string): Promise<void> {
    const mine = ++watchTurn
    watchBody.replaceChildren(h('div.tv-watch-ph', { text: '读取中…' }))
    let page: Awaited<ReturnType<typeof instruments>>
    try {
      page = await instruments(
        { ...(query ? { q: query } : {}), market: request.market, limit: 40 },
        { signal: lifetime.signal })
    } catch {
      if (closed || mine !== watchTurn) return
      watchBody.replaceChildren(
        h('div.tv-watch-ph', { text: '品种列表暂时没取到' }),
        h('button.chip', { text: '重试', on: { click: (event: Event) => { event.stopPropagation(); void fillWatch(query) } } }))
      return
    }
    if (closed || mine !== watchTurn) return
    const rows: HTMLElement[] = []
    // 「本次相关」一直立着：换去别的品种之后，回这条记录的路就在这一组的第一行。
    if (!query) {
      rows.push(h('div.tv-watch-g', { text: '本次相关' }))
      const order = segmentOrder(related.length, recordAt)
      for (const i of order) {
        const item = related[i]
        if (!item) continue
        rows.push(watchRow(item.symbol, item.interval, () => gotoSegment(i), i))
      }
    }
    rows.push(h('div.tv-watch-g', { text: query ? '搜索结果' : '全部' }))
    // 按 symbol 排。用码点比大小，数字、字母、中文各自成段，不会被本地规则打散。
    const list = [...page.items].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    if (!list.length) rows.push(h('div.tv-watch-ph', { text: '没有这个品种' }))
    for (const item of list) {
      rows.push(watchRow(item.symbol, null, () => pickSymbol(item.symbol)))
    }
    watchBody.replaceChildren(...rows)
    markWatch()
  }

  /**
   * 点「本次相关」里的一行：回这一段，效果和「复位」一样。
   *
   * 不是「换到这一档再让它自己找密度」——那样换完又会按当时的视野密度选回人手锁
   * 的那一档（15m 之类），跟行里写的周期对不上。回记录段就是回这条记录当时的那
   * 一档、那一段，根宽和第一次进全屏一模一样。
   */
  function gotoSegment(index: number): void {
    if (isMobileLayout(layoutNow)) setWatch(false)
    const item = related[index]
    if (!item) return
    selected = index
    request = item
    anchorReq = item
    pendingSpan = null
    picked = null
    lockedLevel = false
    // 这个品种这一会话里锁过的那一档也一并忘掉，不然重建之后它又把档抢回去。
    savePeriod(item.market, item.symbol, null)
    level = item.interval
    ladder = ladderFor(item.interval)
    paintPeriods()
    markWatch()
    // 图和数据都还是这一份：不用重建，直接按锚定重定就是复位。
    if (full && stage && history && historySpace === spaceKey(request)) { home(); return }
    homeOnLoad = true
    void load()
  }

  /** 从「全部」里挑一个品种：同一档、同一段时间，换一张图。 */
  function pickSymbol(symbol: string): void {
    if (isMobileLayout(layoutNow)) setWatch(false)
    if (symbol === request.symbol) return
    if (symbol === anchorReq.symbol) {
      // 回这条记录自己那个品种：回它原来那一段，标记才对得上；人挑的那一档留着。
      request = { ...anchorReq, interval: level }
      pendingSpan = null
      markWatch()
      void load()
      return
    }
    const range = full && stage ? stage.visibleTime() : null
    const from = range ? new Date(range.from).toISOString() : request.start_at
    const to = range ? new Date(range.to).toISOString() : request.end_at
    request = { symbol, market: anchorReq.market, interval: level, start_at: from, end_at: to, source: 'rest' }
    pendingSpan = range
    markWatch()
    void load()
  }

  /* ------------------------------------------------------ 闲置淡出 */

  let idleTimer = 0
  function wake(): void {
    if (!full) return
    panel.node.classList.remove('market-idle')
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => {
      if (!full || closed) return
      if (anyPopOpen() || periodPop || watchOpen || controls.matches(':hover')) { wake(); return }
      panel.node.classList.add('market-idle')
    }, IDLE_MS)
  }
  bindWake(panel.node, controls, () => wake())
  // chip 上的 click 先唤醒再干活：淡出时人直接点下去，这一下就该同时算「醒」。
  controls.addEventListener('click', () => wake(), { capture: true })

  /* ---------------------------------------- 底边那一套占多高（手机竖屏） */

  // 工具条会换行，高度只有量出来才准。量到的值写成 CSS 变量，画布的留白和统计
  // 那一行的位置都跟着它走——写死 80px 的话，竖屏两行工具条就压到时间轴上去了。
  let chromeFrame = 0
  function measureChrome(): void {
    if (chromeFrame) return
    chromeFrame = requestAnimationFrame(() => {
      chromeFrame = 0
      if (closed) return
      if (!full) {
        plot.style.removeProperty('--market-chrome-h')
        plot.style.removeProperty('--market-controls-h')
        plot.style.removeProperty('--market-nav-h')
        plot.style.removeProperty('--market-nav-b')
        return
      }
      paintPeriods()
      const controlsH = controls.offsetHeight
      const stacked = narrow() && window.innerHeight > window.innerWidth
      const navH = navHeight()
      // 横屏工具条贴到 8px，不是桌面那 26px；导航条和画布留白都要跟着它上去。
      const tight = window.innerHeight <= 500 && window.innerHeight <= window.innerWidth
      const bottom = tight ? 8 : undefined
      plot.style.setProperty('--market-chrome-h', `${chromeHeight({ controlsH, stacked, navH, bottom })}px`)
      plot.style.setProperty('--market-controls-h', `${controlsH}px`)
      plot.style.setProperty('--market-nav-h', `${navH}px`)
      plot.style.setProperty('--market-nav-b', `${navBottom(controlsH, stacked, bottom)}px`)
      // 竖屏不放导航条，那会儿它根本没建出来；转成横屏后得补建，不能只在「已经
      // 有」的时候才管。
      if (navH) beginNav()
      else if (nav) endNav()
    })
  }
  // 周期条量出真尺寸、或者被挤窄到要滚的那一刻（窗口态首次挂上去、画布从占位图
  // 换成真图、转屏）才滚得动；那几下都不在任何一次重绘里，只能盯着它的尺寸。
  const periodWatch = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (!closed) showPeriod() })
    : null
  periodWatch?.observe(periodList)

  const chromeWatch = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => measureChrome())
    : null
  chromeWatch?.observe(controls)
  /** 窗口一变（宽窄、转屏）：排布重算一遍，底边那一摞重量一遍。 */
  function onViewport(): void { applyLayout(); measureChrome() }
  window.addEventListener('resize', onViewport, { passive: true })
  window.addEventListener('orientationchange', onViewport, { passive: true })

  /* ---------------------------------------------------------- 键盘 */

  function typing(): boolean {
    const at = document.activeElement as HTMLElement | null
    if (!at) return false
    if (at.isContentEditable) return true
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(at.tagName)
  }
  let heldAt = Number.NEGATIVE_INFINITY
  /** 按住 `-` / `+` 不放：照常一步一步缩，只是最快 120 ms 一步。 */
  function holdStep(event: KeyboardEvent): boolean {
    const now = Date.now()
    if (!holdOk(event.repeat, heldAt, now)) return false
    heldAt = now
    return true
  }
  function onKey(event: KeyboardEvent): void {
    if (closed || !topModal(panel.node) || typing()) return
    if (event.metaKey || event.ctrlKey) return
    const hit = () => { event.preventDefault(); wake() }
    // macOS 上 Alt+L 打出来的是「¬」，只有 code 认得出按的是哪一颗。
    if (event.altKey) {
      if (event.code === 'KeyL') { hit(); setScale(toggleLog(scaleMode)) }
      return
    }
    // 菜单开着的时候键盘只认一件事：再按一次 P 把它收回去。
    if (anyPopOpen() || periodPop) {
      if (event.key === 'p' || event.key === 'P') { hit(); closePops(); closePeriodMenu() }
      return
    }
    if (full && event.shiftKey && event.key === 'Home') { hit(); toListing(); return }
    if (full && event.key === '?' && !coarse()) { hit(); keysChip.node.querySelector<HTMLElement>('.chip')?.click(); return }
    if (event.shiftKey) return
    switch (event.key) {
      case 'f': case 'F': hit(); setFull(!full); break
      case 'ArrowLeft': hit(); stage?.pan(full ? -0.25 : -0.12); break
      case 'ArrowRight': hit(); stage?.pan(full ? 0.25 : 0.12); break
      case '+': case '=': hit(); if (holdStep(event)) zoomBy(1 / 1.35); break
      case '-': case '_': hit(); if (holdStep(event)) zoomBy(1.35); break
      case '0': case 'Home': hit(); home(); break
      case 'End': if (full) { hit(); setFollow(true) } break
      case 'g': case 'G': if (full) { hit(); openDateJump() } break
      case 'm': case 'M': if (full) { hit(); setMagnet(!magnetOn) } break
      case 'v': case 'V': hit(); toggleVolume(); break
      case 'o': case 'O': if (!overlayToggle.hidden) { hit(); toggleOutline() } break
      case 'i': case 'I': hit(); indicatorChip.node.querySelector<HTMLElement>('.chip')?.click(); break
      case 'a': case 'A': if (full) { hit(); setAuto() } break
      case 'p': case 'P': if (!isMobileLayout(layoutNow)) { hit(); togglePeriodMenu() } break
      case 'l': case 'L': hit(); setWatch(!watchOpen); break
      case '[': if (related.length > 1) { hit(); pick(selected - 1) } break
      case ']': if (related.length > 1) { hit(); pick(selected + 1) } break
      default:
        if (/^[1-9]$/.test(event.key)) {
          // 数字键按的是条上从左到右第几颗，不是阶梯下标——人看见几就按几。
          const step = periodAt(shownPeriods, event.key)
          if (step) { hit(); pickPeriod(step) }
        }
        break
    }
  }
  document.addEventListener('keydown', onKey)

  /* -------------------------------------------------------- 原图小窗 */

  let pip: HTMLElement | null = null
  let pipOn = false
  function openShot(): void {
    const id = options.attachmentId
    if (!id) return
    if (!full) {
      void objectUrl(id).then(url => { if (!closed) lightbox(url, '原始截图') }).catch(() => problem('原图暂时读不出来'))
      return
    }
    pipOn = !pipOn
    shotToggle?.setAttribute('aria-pressed', String(pipOn))
    if (!pipOn) { pip?.remove(); pip = null; return }
    void objectUrl(id).then(url => {
      if (closed || !pipOn) return
      const shot = h('img', { attrs: { src: url, alt: '原始截图' } })
      pip = h('button.tv-pip', { attrs: { 'aria-label': '放大原始截图' }, on: { click: () => lightbox(url, '原始截图') } }, shot)
      plot.appendChild(pip)
    }).catch(() => problem('原图暂时读不出来'))
  }

  /* ---------------------------------------------------------- 开关 */

  function toggleOutline(): void {
    showOutline = !showOutline
    overlayToggle.setAttribute('aria-pressed', String(showOutline))
    stage?.showOutline(showOutline)
  }
  function toggleVolume(): void {
    choice = { ...choice, volume: !choice.volume }
    writeChoice(choice)
    applyIndicators()
  }
  function applyIndicators(): void {
    volumeToggle.setAttribute('aria-pressed', String(choice.volume))
    indicatorChip.refresh()
    stage?.setIndicators(setupFor(choice, record))
    warmFeed()
  }

  function pick(index: number): void {
    if (index < 0 || index >= related.length || index === selected) return
    // 候选每一段都是「这条记录自己的」：锚定跟着换，丁香带、截止线照画。
    selected = index; request = related[selected]!; anchorReq = request
    markWatch()
    // 全屏里换到同一个品种同一档的另一段：图和数据都不用重建，挪一下锚定就是了。
    if (full && stage && history && historySpace === spaceKey(request)) { reanchor(); return }
    void load()
  }

  /* ------------------------------------------------ 完整历史（全屏） */

  const spaceKey = (item: ChartRequest): string =>
    `${item.market}|${item.symbol}|${item.interval}|${item.source ?? 'rest'}`
  const cutoffOf = (item: ChartRequest): string => item.match_end_at ?? item.end_at

  /** 指标开着就让左边多铺一段，省得 MA256 在屏幕左半边是空的。 */
  function warmFeed(): void {
    const need = maxPeriod(setupFor(choice, record))
    history?.warmup(need > 0 ? Math.ceil(need * 1.5) : 0)
  }

  /* ------------------------------------------------ 导航条（全屏） */

  // 导航条走的是这个品种的 1d 收盘线，和主图不是一档，也不能共用一个 feed：
  // `focus()` 只认一个视野，拿主图那份去要 1d 会把主图正在取的那几格挤掉。所以
  // 单开一个 1d 的 feed，只问一次「上市到现在」，之后就不动了。

  let nav: ChartNavigator | null = null
  let navFeed: HistoryFeed | null = null
  let navFromMs = 0

  /** 导航条多高：桌面 28，横屏 20，手机竖屏不放。 */
  function navHeight(): number {
    if (!full) return 0
    const portrait = window.innerHeight > window.innerWidth
    if (narrow() && portrait) return 0
    if (!portrait && window.innerHeight <= 500) return NAV_H_SHORT
    return NAV_H
  }

  /** 整条命从哪天起：后端说的上市优先，其次是 1d 那一档自己摸到的地板。 */
  function navFrom(): number {
    const edge = history?.edges()?.onboardMs
    if (edge != null && Number.isFinite(edge)) return edge
    return navFromMs
  }

  function beginNav(): void {
    if (!stage) return
    const height = navHeight()
    if (!height) { endNav(); return }
    if (!nav) {
      nav = chartNavigator({
        view: () => {
          const range = stage?.visibleTime()
          return range ? { fromMs: range.from, toMs: range.to } : null
        },
        onDrag: (fromMs, toMs) => { stage?.setVisibleTime(fromMs, toMs, false) },
        onSettle: (fromMs, toMs) => { goTo(fromMs, toMs, false, 0) },
        onAnchor: () => home(),
        onLongPress: () => openDateJump(),
      })
      plot.appendChild(nav.node)
    }
    nav.node.hidden = false
    const key = spaceKey(request)
    if (!navFeed || navSpace !== key) {
      navFeed?.destroy()
      navSpace = key
      navFromMs = Math.min(Date.parse(request.start_at) || nowMs(), nowMs() - 3 * 365 * 86_400_000)
      navFeed = historyFeed({
        market: request.market,
        symbol: request.symbol,
        interval: '1d',
        ...(request.source ? { source: request.source } : {}),
      })
      navFeed.onChange(() => paintNav())
    }
    navFeed.focus('1d', navFrom(), nowMs(), 0)
    paintNav()
  }
  let navSpace = ''

  function endNav(): void {
    navFeed?.focus('1d', 0, 0, 0)
    if (nav) { nav.node.hidden = true }
  }

  function paintNav(): void {
    if (!nav || !navFeed || !full) return
    const now = nowMs()
    const view = navFeed.window('1d', navFrom(), now)
    if (view.floor !== undefined && Number.isFinite(view.floor)) navFromMs = view.floor
    const first = view.bars[0]
    if (first) {
      const head = Date.parse(first.start)
      if (Number.isFinite(head) && head < navFromMs) navFromMs = head
    }
    const from = navFrom()
    if (!(now > from)) return
    nav.setSpan(from, now)
    nav.setLine(view.bars)
    nav.setLoaded(view.bars.length ? [{ fromMs: view.from, toMs: view.to }] : [])
    const cut = Date.parse(cutoffOf(request))
    nav.setAnchor(Number.isFinite(cut) ? cut : null)
    nav.refresh()
  }

  /* ---------------------------------------------- 跳到日期（G / 长按） */

  let dateJump: HTMLElement | null = null
  function closeDateJump(): void {
    dateJump?.remove()
    dateJump = null
  }
  function openDateJump(): void {
    if (!full || !stage || closed) return
    closeDateJump()
    const input = h('input.tv-datejump-in', {
      attrs: { type: 'date', 'aria-label': '跳到哪天', placeholder: '跳到哪天' },
    }) as HTMLInputElement
    const jump = (): void => {
      const day = Date.parse(`${input.value}T00:00:00Z`)
      if (!Number.isFinite(day)) return
      closeDateJump()
      const range = stage?.visibleTime()
      const span = range ? range.to - range.from : barSpanMs(level) * 120
      goTo(day - span / 2, day + span / 2, true, 0)
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); jump() }
      else if (event.key === 'Escape') { event.preventDefault(); closeDateJump(); panel.node.focus() }
    })
    dateJump = h('div.tv-datejump', {}, input,
      h('button.chip', { text: '跳过去', on: { click: () => jump() } }))
    plot.appendChild(dateJump)
    input.focus()
    wake()
  }

  /* ------------------------------------------ 活的最新一根（全屏） */

  let live: LiveStream | null = null
  let liveLevel = ''

  function stopLive(): void {
    live?.stop()
    live = null
    liveLevel = ''
  }

  function startLive(): void {
    if (closed || !full) return
    const market = request.market
    const symbol = request.symbol
    const step = level
    liveLevel = step
    live = liveStream({
      market,
      symbol,
      interval: step,
      onBar: (bar) => {
        if (closed || !full || !stage || liveLevel !== step) return
        stage.updateLast(bar)
      },
      onClosed: (bar) => {
        if (closed || liveLevel !== step) return
        history?.commitClosed(bar, step)
        schedulePaint()
      },
      poll: async () => {
        const span = barSpanMs(step)
        const end = nowMs() + span
        return fetchRange({
          market, symbol, interval: step,
          start_at: new Date(end - 3 * span).toISOString(),
          end_at: new Date(end).toISOString(),
          limit: 2,
        })
      },
    })
  }

  /** 该不该开着这条流。视野一变、切一次标签就问一次，幂等。 */
  function syncLive(): void {
    if (closed || !full || !stage) { stopLive(); return }
    const ok = streamable({
      ...(request.source ? { source: request.source } : {}),
      deliveryMs: history?.edges()?.deliveryMs ?? null,
      nowMs: nowMs(),
    })
    if (!ok) { stopLive(); return }
    if (!live || liveLevel !== level) { stopLive(); startLive() }
    const range = stage.visibleTime()
    const near = !!range && !document.hidden
      && nearNow({ fromMs: range.from, toMs: range.to }, nowMs())
    live?.want(near)
  }
  function onHidden(): void { syncLive() }
  document.addEventListener('visibilitychange', onHidden)

  /** 进全屏：复用或新建这一个 space 的 feed，先用手上的数据把视野挪过去。 */
  function beginHistory(): void {
    if (!stage || !windowBars.length) return
    const key = spaceKey(request)
    if (!history || historySpace !== key) {
      history?.destroy()
      historySpace = key
      history = historyFeed({
        market: request.market,
        symbol: request.symbol,
        interval: request.interval,
        ...(request.source ? { source: request.source } : {}),
      }, {
        onUnsupported: (interval: string) => {
          if (unsupported.has(interval)) return
          unsupported.add(interval)
          paintPeriods()
        },
      })
      history.onChange(() => schedulePaint())
    }
    history.seed(windowBars)
    stage.setPadding(true)
    level = request.interval
    ladder = ladderFor(request.interval)
    lockedLevel = false
    picked = null
    moved = null
    paintPeriods()
    stage.setInterval(level)
    warmFeed()
    stage.setGestures(true)
    stage.setMagnet(magnetOn)
    stage.setFollowLatest(follow)
    beginNav()
    syncLive()
    // 等两帧再落到锚定段：F 是在 keydown 里同步走到这儿的，这会儿 ResizeObserver
    // 还没把图铺到全屏宽，按窄屏算出来的格子和根宽会把视野撑成将近两倍。第一帧
    // 让浏览器把布局做完，第二帧让图自己的 resize 走完。
    const mine = stage
    // 这个品种这一会话里锁过哪一档就回到哪一档：锚定段还是那一段，只是档不同。
    // 但这一次是「回记录段」的话，锁过的那一档不算数，就按记录自己那一档落。
    const back = homeOnLoad
    homeOnLoad = false
    const remembered = back ? null : readPeriod(request.market, request.symbol)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (closed || !full || stage !== mine) return
      anchorNow(true, back ? anchorReq.interval : undefined)
      if (remembered) pickPeriod(remembered)
    }))
  }

  /** 退出全屏：调度停下（feed 留着），图回到窗口态那一段。 */
  function endHistory(): void {
    history?.focus(level, 0, 0, 0)
    stopLive()
    closeDateJump()
    endNav()
    follow = false
    magnetOn = false
    followChip.setAttribute('aria-pressed', 'false')
    magnetChip.setAttribute('aria-pressed', 'false')
    stage?.setGestures(false)
    stage?.setMagnet(false)
    stage?.setFollowLatest(false)
    if (painting) { cancelAnimationFrame(painting); painting = 0 }
    level = request.interval
    lockedLevel = false
    picked = null
    paintPeriods()
    if (!stage) return
    stage.setPadding(false)
    stage.setAnchor(null)
    stage.setJudgment(null)
    stage.setEdge('left', 'idle')
    stage.setEdge('right', 'idle')
    stage.setInterval(request.interval)
    // 全屏里换过候选的话，窗口态那份数据已经不是这一条了，重新取。
    if (loadedFor !== request) { void load(); return }
    if (!windowBars.length) return
    stage.setBars(windowBars, 'logical')
    stage.reset()
  }

  /**
   * 视野落到锚定段上：截止线在右边 62% 处，整段占屏宽的六成。
   *
   * `forceLevel` 是「回锚定」那一路专用的：回这一段就该回这条记录当时的那一档，
   * 哪怕人刚刚在 15m 上看过——否则按跨度自动挑档，`3` 之后按 `0` 还停在 15m。
   */
  function anchorNow(animate: boolean, forceLevel?: string): void {
    if (!stage) return
    const start = Date.parse(request.start_at)
    const cut = Date.parse(cutoffOf(request))
    if (!Number.isFinite(start) || !Number.isFinite(cut) || !(cut > start)) return
    if (!onRecord()) {
      // 换到别的品种了：截止线、丁香带、判断三角一概不画，照原来那段时间看就是。
      stage.setAnchor(null)
      stage.setJudgment(null)
      goTo(start, cut, animate, 0, forceLevel)
      return
    }
    const span = (cut - start) / 0.6
    const left = cut - 0.62 * span
    const right = left + span
    stage.setAnchor({ startMs: start, endMs: cut })
    if (showsJudgment(options)) stage.setJudgment(cut)
    goTo(left, right, animate, 0, forceLevel)
  }

  /**
   * 程序性跳转统一走这里：先按目标跨度定档（可以一次跨好几档），再设视野。
   * 反过来先设视野的话，图会落在一根都没加载的地方，档位判断当场就错了。
   */
  function goTo(fromMs: number, toMs: number, animate: boolean, velocity = 0, forceLevel?: string): void {
    if (!stage || !(toMs > fromMs)) return
    const next = forceLevel && !lockedLevel
      ? forceLevel
      : levelForSpan(
        stage.paneWidth(), fromMs, toMs, ladder, level, lockedLevel, request.interval,
        isMobileLayout(layoutNow) ? TARGET_PX_MOBILE : TARGET_PX,
      )
    if (next !== level) applyLevel(next, fromMs, toMs)
    settling = Date.now() + SETTLE_MS
    stage.setVisibleTime(fromMs, toMs, animate && !calm(), barsAt(fromMs, toMs))
    pumpFocus(fromMs, toMs, velocity)
    schedulePaint()
  }

  /** 缩放：跨度乘一下，然后照样先定档再设视野。窗口态还是图自己缩。 */
  function zoomBy(factor: number): void {
    if (!full || !stage) { stage?.zoom(factor); return }
    const range = stage.visibleTime()
    if (!range) { stage.zoom(factor); return }
    const middle = (range.from + range.to) / 2
    const half = Math.max(barSpanMs(level) * 2, ((range.to - range.from) * factor) / 2)
    goTo(middle - half, middle + half, false, 0)
  }

  /** 全屏里换了候选：标题、事实行、截止线、丁香带都跟着走。 */
  function reanchor(): void {
    if (!stage) return
    paintCandidates()
    stage.setCutoff(request.end_at)
    anchorNow(true)
  }

  function pumpFocus(from: number, to: number, velocity: number): void {
    if (!history || !full) return
    history.focus(level, from, to, velocity)
  }

  /** 视野每变一次：先看要不要换档，再把兴趣区告诉调度器。 */
  function onView(range: { from: number; to: number; programmatic: boolean }): void {
    if (closed || !full || !stage || !history) return
    // 程序自己设的视野不参与换档，也不算速度：锚定、换档、回位会互相触发，
    // 一旦让它们回灌，视野就被钉死在那儿了。
    if (range.programmatic) { schedulePaint(); return }
    const now = Date.now()
    const middle = (range.from + range.to) / 2
    let velocity = 0
    if (moved && now > moved.at && now - moved.at < 1200) velocity = (middle - moved.middle) / (now - moved.at)
    moved = { at: now, middle }
    if (now >= settling) {
      const px = pxPerBar(stage.paneWidth(), range.from, range.to, level)
      const next = pickLevel(level, px, ladder, lockedLevel)
      if (next !== level) { switchLevel(next); return }
    }
    // 往左一拖就松开「跟到最新」：人已经在看历史了，再把视野拽回去就成了打架。
    if (follow && !pinnedToLatest({ toMs: range.to }, nowMs(), level)) { follow = false; paintFollow() }
    pumpFocus(range.from, range.to, velocity)
    schedulePaint()
  }

  /** 这一档、这一段时间，手头已经加载好的那些 bar。没有就不给。 */
  function barsAt(fromMs: number, toMs: number): Bar[] | undefined {
    if (!history || !(toMs > fromMs)) return undefined
    const view = history.window(level, fromMs, toMs)
    return view.bars.length ? view.bars : undefined
  }

  /** 换一档：把这一段时间在新档上的数据换上去。视野由调用方负责。 */
  function applyLevel(next: string, fromMs: number, toMs: number): void {
    if (!stage || !history) return
    level = next
    settling = Date.now() + SETTLE_MS
    // 先按新档、目标视野把格子重铺出来；这一档的 bar 由紧接着的 setVisibleTime
    // 一并换上去（换档和远跳走同一条路，不再各填各的）。反过来先填数据的话，
    // 新数据会落在按旧档算出来的下标上，轴刻度和 K 线当场就对不上。
    stage.setInterval(next, toMs > fromMs ? { from: fromMs, to: toMs } : undefined)
    paintPeriods()
  }

  /** 人手缩放缩到了换档线上：同一段时间还在同一个位置，只是每根变粗或者变细。 */
  function switchLevel(next: string): void {
    if (!stage || !history) return
    const range = stage.visibleTime()
    applyLevel(next, range?.from ?? 0, range?.to ?? 0)
    if (range) {
      stage.setVisibleTime(range.from, range.to, false, barsAt(range.from, range.to))
      pumpFocus(range.from, range.to, 0)
    }
    schedulePaint()
  }


  /* ---------------------------------------------- 回锚定 / 到头去 */

  function home(): void {
    if (!full) { stage?.reset(); return }
    // 回锚定就是回到「这条记录当时那一段」：锁着的档也一并松开，按锚定跨度重定。
    picked = null
    setAuto()
    // 回锚定 = 回这条记录当时的那一档、那一段（换过品种也照它来，不是眼前这档）。
    anchorNow(true, anchorReq.interval)
  }
  /** 视野右端 = 现在，跨度不变。 */
  function toNow(): void {
    if (!stage) return
    const range = stage.visibleTime()
    if (!range) return
    const span = range.to - range.from
    const right = Date.now()
    goTo(right - span, right, true, 1)
  }
  /** 视野左端 = 上市；地板还没摸到就先去已知最早的那一根。 */
  function toListing(): void {
    if (!stage || !history) return
    const range = stage.visibleTime()
    if (!range) return
    const span = range.to - range.from
    const view = history.window(level, range.from, range.to)
    const first = view.bars[0]
    const floorMs = view.floor ?? (first ? Date.parse(first.start) : null)
    if (floorMs === null || !Number.isFinite(floorMs)) return
    goTo(floorMs, floorMs + span, true, -1)
  }

  /* ------------------------------------------------ 图例上那一行 */

  /** 窄屏（手机竖屏那一档）：底下那一摞的排法和导航条高度都看它。 */
  function narrow(): boolean {
    return window.innerWidth <= NARROW_PX
  }
  /* ------------------------------------------------ 一帧最多重画一次 */

  function schedulePaint(): void {
    if (closed || painting) return
    painting = requestAnimationFrame(() => {
      painting = 0
      paintFeed()
    })
  }
  function paintFeed(): void {
    if (closed || !full || !stage || !history) return
    const range = stage.visibleTime()
    if (!range) return
    const view = history.window(level, range.from, range.to)
    // 上市时刻一摸到就交给图：视野的左墙按它算，人再怎么拖也拖不出「上市前一屏」。
    stage.setFloor(view.floor ?? null)
    // 这一段一根都没有（跳到上市之前那种）就没有 setBars 可发，图会停在被钳过
    // 的地方不动——催它按还没兑现的目标再落一次位。已经落到了它自己会不动。
    if (view.bars.length) stage.setBars(view.bars, 'time')
    else {
      stage.reassert()
      // 空白的这一段照样要去问一遍。人拖到上市之前再拖回来的时候，视野的变化
      // 常常还挂着「程序自己设的」这个标，`onView` 不会催取数；这儿不补一发，
      // 就成了「一片空白 + 再也不取」。取不到（真在上市之前）也不吃亏。
      pumpFocus(range.from, range.to, 0)
    }
    stage.setEdge('left', view.failedLeft ? 'failed' : view.loadingLeft ? 'loading' : 'idle')
    stage.setEdge('right', view.failedRight ? 'failed' : view.loadingRight ? 'loading' : 'idle')
    paintNav()
    syncLive()
  }

  /* -------------------------------------------------------- 轮廓 */

  async function readOutline(): Promise<void> {
    if (!options.queryAttachmentId || contourLoading) return
    contourLoading = true; outlineStatus.hidden = true; outlineRetry.hidden = true
    try {
      const pin = await getLocate(options.queryAttachmentId, { signal: lifetime.signal }).catch(() => null)
      if (closed) return
      let found: Pick<ChartOutline, 'values' | 'symbol'>
      if (pin?.location) {
        const at = pin.location
        const real = await data({ symbol: at.symbol, market: at.market, interval: at.interval, start_at: at.start_at, end_at: at.end_at, source: at.source }, { signal: lifetime.signal })
        found = { values: marketOutline(real.bars, at.start_at, at.end_at), symbol: at.symbol }
        if (!found.values.length) throw new Error('empty source window')
      } else {
        found = await outline({ attachment_id: options.queryAttachmentId, red_up: prefs().updown === 'red_up' }, { signal: lifetime.signal })
      }
      if (closed) return
      contour = found
      stage?.setOutline(found.values)
      stage?.showOutline(showOutline)
    } catch {
      if (closed) return
      outlineStatus.textContent = '截图轮廓未读出'; outlineStatus.hidden = false; outlineRetry.hidden = false
    } finally { contourLoading = false }
  }

  /* ---------------------------------------------------------- 取数 */


  /** 候选那一排：第几个、上一个下一个能不能按。 */
  function paintCandidates(): void {
    picks.forEach((b, i) => b.setAttribute('aria-pressed', String(i === selected)))
    previous.toggleAttribute('disabled', selected === 0)
    next.toggleAttribute('disabled', selected === related.length - 1)
    counter.textContent = `${selected + 1} / ${related.length}`
    paintTitle()
  }

  async function load(): Promise<void> {
    controller?.abort()
    const current = new AbortController(); controller = current
    const kept = stage?.view() ?? null
    stage?.destroy(); stage = null
    dataNote.hidden = true; dataNote.textContent = ''
    feed = null
    const target = request
    paintCandidates()
    plot.replaceChildren(h('div.market-loading', { text: '正在加载真实行情' }))
    placeChrome()
    let followUnavailable = false
    // 窗口态只画锚定段加一小段真实后续；再往前往后是全屏的事。
    const follow = followCount(target.start_at, cutoffOf(target), target.interval)
    async function fetch(request: ChartRequest): Promise<MarketData> {
      const key = JSON.stringify(request)
      const cached = cache.get(key)
      if (cached) return cached
      const result = await data(request, { signal: current.signal })
      if (!closed && !current.signal.aborted) cache.set(key, result)
      return result
    }
    try {
      let result: MarketData
      try { result = await fetch({ ...target, end_at: historyEnd(target.end_at, target.interval, follow) }) }
      catch (error) {
        if (current.signal.aborted || !follow) throw error
        result = await fetch(target); followUnavailable = true
      }
      if (closed || current.signal.aborted) return
      if (!result.bars.length) throw new Error('这段行情暂时没取到')
      let tradingChart: typeof import('./trading-chart')['tradingChart']
      try {
        ({ tradingChart } = await import('./trading-chart'))
      } catch (error) {
        if (closed || current.signal.aborted) return
        if (recoverChunk(error)) return
        plot.replaceChildren(h('div.market-loading', { text: '页面已更新，刷新一下再看' }),
          h('button.btn.sm', { text: '刷新', on: { click: () => window.location.reload() } }))
        return
      }
      if (closed || current.signal.aborted) return
      stage = tradingChart(
        result.bars, target.end_at, target.symbol, target.interval, target.start_at,
        isMobileLayout(layoutNow),
      )
      stage.setMobile(isMobileLayout(layoutNow))
      if (!options.queryAttachmentId) stage.node.setAttribute('aria-label', `${target.symbol} 真实 K 线和成交量`)
      plot.replaceChildren(stage.node)
      // 不是这条记录自己的品种：截图轮廓和截止线都不属于这张图，一概不画。
      if (contour && onRecord()) stage.setOutline(contour.values)
      stage.showOutline(showOutline && onRecord())
      stage.showCutoff(onRecord())
      stage.setScaleMode(scaleMode)
      bindLegend()
      paintLegend()
      applyIndicators()
      const built = stage
      windowBars = result.bars
      loadedFor = target
      built.onVisibleTime((range) => onView(range))
      built.onEdgeRetry(() => { history?.retryFailed(); schedulePaint() })
      const mine = makeFeed(target, result)
      feed = mine
      placeChrome()
      requestAnimationFrame(() => {
        if (closed || stage !== built) return
        if (full) { beginHistory(); return }
        // 窗口态换周期换品种：按根宽算好的那一段，落下去就是它。
        const span = pendingSpan
        pendingSpan = null
        const back = homeOnLoad
        homeOnLoad = false
        if (span) built.setVisibleTime(span.from, span.to, false)
        else if (kept && !back) built.setView(kept)
        else built.reset()
      })
      // 数据本身有问题的那两句，挂在工具条末尾；原来那一串涨跌幅统计取消了。
      const says: string[] = []
      if (followUnavailable) says.push('后续行情暂未取到，先展示匹配区间')
      if (result.coverage_complete === false) says.push('这段行情有缺口')
      dataNote.textContent = says.join(' · ')
      dataNote.hidden = !says.length
      preheat(built, mine)
    } catch (error) {
      if (closed || current.signal.aborted) return
      plot.replaceChildren(h('div.market-loading', { text: error instanceof ApiError ? error.message : '这段行情暂时没取到' }),
        h('button.btn.sm', { text: '再试一次', on: { click: () => void load() } }))
      placeChrome()
    }
  }

  /** 开着长周期指标的时候先悄悄往前补一段，省得 MA256 在屏幕左半边是空的。 */
  function preheat(built: TradingChart, mine: Feed): void {
    const need = maxPeriod(setupFor(choice, record))
    if (need <= 0) return
    mine.ensureBefore(Math.ceil(need * 1.5), lifetime.signal)
      .then(() => { if (!closed && stage === built && feed === mine) built.appendBars(mine.bars) })
      .catch(() => { /* 补不上就按现有这一段算，和以前一样 */ })
  }

  paintPeriods()
  applyLayout()
  if (options.fullscreen) setFull(true)
  void load()
  void readOutline()
}

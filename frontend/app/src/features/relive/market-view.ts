// 全屏那张真 K 线的外壳：面板、工具条、候选切换、完整历史、指标开关。
//
// 全屏不是「把同一块东西撑大」。全屏的时候顶栏收成一条 44px 的深色条，候选切换
// 搬进顶栏，工具条变成浮在底边中间的一颗药丸，统计、免责和版权各自贴角叠在图
// 上，两秒四不动就淡出去——屏幕上只剩这张图。窗口态则一切照旧，节点是同一批，
// 只是换个地方挂。

import { outline, type ChartOutline } from '../../api/chart'
import { ApiError } from '../../api/errors'
import { data } from '../../api/market'
import type { Bar, ChartRequest, ChartSetup, MarketData } from '../../api/types'
import { followingStats, marketOutline } from '../../data/chart-comparison'
import { getLocate } from '../../api/replay'
import { historyEnd } from '../../data/chart-window'
import { prefs } from '../../data/prefs'
import { h } from '../../ui/dom'
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
import { barsIn, ladderFor, levelForSpan, pickLevel, pxPerBar } from './history/lod'
import { NARROW_PX, holdOk, showsJudgment } from './view-rules'
import { bindWake, chromeHeight, navBottom, statsBottom } from './chrome'
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
const percent = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
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

export function openMarketChart(initial: ChartRequest, label = '图中这段', options: ComparisonOptions = {}): void {
  const related = options.related?.length ? options.related : [initial]
  let selected = Math.max(0, related.indexOf(initial))
  let request = related[selected]!
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
  const stats = h('div.market-stats', { attrs: { 'aria-live': 'polite' } })
  // 轮廓只在读不出来的时候说话：成功了图上那条橙虚线自己会说，不用再写一行字。
  // 这两颗挂在工具条末尾（原来那一整行「K 线 · 历史真实行情」已经取消）。
  const outlineStatus = h('span.market-outline-status', { hidden: true })
  const outlineRetry = h('button.chip', { text: '重读轮廓', hidden: true, on: { click: () => void readOutline() } })
  const overlayToggle = h('button.chip', { text: '截图轮廓', hidden: !options.queryAttachmentId,
    title: '截图轮廓（O）',
    attrs: { 'aria-pressed': 'true' }, on: { click: () => toggleOutline() } })
  const volumeToggle = h('button.chip', { text: '成交量', title: '成交量（V）', attrs: { 'aria-pressed': String(choice.volume) }, on: { click: () => toggleVolume() } })
  const fullscreen = h('button.chip', { text: '全屏', title: '全屏（F）', attrs: { 'aria-label': '全屏 K 线' }, on: { click: () => setFull(!full) } })
  const previous = h('button.chip', { text: '← 上一个', title: '上一个（[）', on: { click: () => pick(selected - 1) } })
  const next = h('button.chip', { text: '下一个 →', title: '下一个（]）', on: { click: () => pick(selected + 1) } })
  const counter = h('span.market-counter')
  if (related.length > 1) candidates.append(previous, counter, next)
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

  function buildPeriods(list: readonly string[]): void {
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
      if (step === request.interval) {
        chip.appendChild(h('i.chip-dot', { title: '这条记录的周期', attrs: { 'aria-hidden': 'true' } }))
      }
      periodChips.set(step, chip)
      periodList.appendChild(chip)
    }
  }

  function paintPeriods(): void {
    const list = quickSet(window.innerWidth, window.innerHeight, request.interval, picked)
    if (list.join(' ') !== shownPeriods.join(' ')) { shownPeriods = list; buildPeriods(list) }
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
      if (here && full) chip.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    }
    moreChip.refresh()
  }

  /** 点条上（或「更多」里）某一档：锁定 + 换档，视野中心和跨度不动。 */
  function pickPeriod(step: string): void {
    if (unsupported.has(step)) return
    const base = quickSet(window.innerWidth, window.innerHeight, request.interval, null)
    // 从「更多」里挑的那一颗临时露在条上；再选一颗快捷周期它就收回去。
    picked = base.includes(step) ? null : step
    lockedLevel = true
    savePeriod(request.market, request.symbol, step)
    if (step !== level) switchLevel(step)
    else paintPeriods()
  }

  /** 回自动：按密度换档，这个品种存的那一档也一并忘掉。 */
  function setAuto(): void {
    lockedLevel = false
    savePeriod(request.market, request.symbol, null)
    paintPeriods()
  }

  controls.append(periodBar, periodSep, followChip, magnetChip, overlayToggle, volumeToggle, indicatorChip.node,
    h('button.chip', { text: '−', title: '缩小（−）', attrs: { 'aria-label': '缩小 K 线图' }, on: { click: () => zoomBy(1.35) } }),
    h('button.chip', { text: '+', title: '放大（+）', attrs: { 'aria-label': '放大 K 线图' }, on: { click: () => zoomBy(1 / 1.35) } }),
    h('button.chip', { text: '复位', title: '复位（0）', on: { click: () => home() } }))
  // 触屏没有 F 这颗键，就别在提示里许一个按不出来的快捷键。
  const marketHint = h('span.market-hint', { text: coarse() ? '全屏看完整历史' : '全屏看完整历史 · F' })
  const shotToggle = options.attachmentId
    ? h('button.chip', { text: '原图', attrs: { 'aria-label': '查看原始截图' }, on: { click: () => openShot() } })
    : null
  if (options.attachmentId) controls.append(
    h('button.chip', { text: '找相似', on: { click: () => { window.location.hash = `/search/like/${options.attachmentId}` } } }),
    shotToggle!)
  // 全屏最右那一颗是「快捷键」；窗口态藏着，那一格让给下面这句话。
  // 触屏没有键盘，这一颗只占地方——横屏 812×375 的工具条正好差它这一格才排成一行。
  if (!coarse()) controls.appendChild(keysChip.node)
  // 工具条最右那一句：告诉人完整历史在全屏里。全屏时由样式藏起来。
  controls.appendChild(marketHint)
  controls.append(outlineStatus, outlineRetry)
  const notice = options.queryAttachmentId
    ? '橙色虚线是截图轮廓，仅缩放时间和幅度，不代表截图品种的真实价格。竖线右侧是历史真实后续。'
    : '竖线右侧为这段历史的真实后续走势。'
  const note = h('p.market-note', { text: notice })
  const credit = h('a.market-credit', { text: 'TradingView Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc.', attrs: { href: 'https://www.tradingview.com/', target: '_blank', rel: 'noopener noreferrer' } })
  body.append(candidates, controls, plot, stats, note, credit)
  const panel = sheet(`${request.symbol} · ${request.interval} · 币安`, body, () => {
    closed = true; controller?.abort(); lifetime.abort(); stage?.destroy(); cache.clear(); contour = null
    history?.destroy(); history = null
    navFeed?.destroy(); navFeed = null
    nav?.destroy(); nav = null
    live?.stop(); live = null
    document.removeEventListener('visibilitychange', onHidden)
    if (painting) cancelAnimationFrame(painting)
    if (chromeFrame) cancelAnimationFrame(chromeFrame)
    chromeWatch?.disconnect()
    window.removeEventListener('resize', measureChrome)
    window.removeEventListener('orientationchange', measureChrome)
    window.clearTimeout(idleTimer)
    document.removeEventListener('fullscreenchange', onFullChange)
    document.removeEventListener('keydown', onKey)
    if (document.fullscreenElement === panel.node) void document.exitFullscreen().catch(() => {})
  }, { onEscape: () => { if (anyPopOpen()) { closePops(); return true } if (!full) return false; setFull(false); return true } })
  panel.node.classList.add('market-dialog')
  const head = panel.node.querySelector('.sheet-h')!
  head.insertBefore(fullscreen, panel.node.querySelector('.sheet-x'))
  fullscreen.classList.add('market-expand')

  /* ---------------------------------------------------------- 全屏 */

  /** 全屏时候选栏搬进顶栏，叠加层搬进画布；窗口态原样搬回去。 */
  function placeChrome(): void {
    if (full) {
      head.insertBefore(candidates, fullscreen)
      plot.append(controls, stats, note, credit)
      if (pip) plot.appendChild(pip)
    } else {
      body.append(candidates, controls, plot, stats, note, credit)
      pip?.remove()
    }
  }
  function paintFull(): void {
    panel.node.classList.toggle('market-fullscreen', full)
    panel.node.parentElement?.classList.toggle('market-fullscreen-box', full)
    fullscreen.textContent = full ? '退出全屏' : '全屏'
    fullscreen.title = full ? '退出全屏（F）' : '全屏（F）'
    fullscreen.setAttribute('aria-label', full ? '退出全屏 K 线' : '全屏 K 线')
    if (!full) { pipOn = false; shotToggle?.setAttribute('aria-pressed', 'false'); pip?.remove(); pip = null }
    periodBar.hidden = !full
    periodSep.hidden = !full
    followChip.hidden = !full
    magnetChip.hidden = !full
    keysChip.node.hidden = !full || coarse()
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

  /* ------------------------------------------------------ 闲置淡出 */

  let idleTimer = 0
  function wake(): void {
    if (!full) return
    panel.node.classList.remove('market-idle')
    window.clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => {
      if (!full || closed) return
      if (anyPopOpen() || controls.matches(':hover')) { wake(); return }
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
        plot.style.removeProperty('--market-stats-b')
        plot.style.removeProperty('--market-nav-h')
        plot.style.removeProperty('--market-nav-b')
        return
      }
      paintPeriods()
      const controlsH = controls.offsetHeight
      const statsH = stats.offsetHeight
      const stacked = narrow() && window.innerHeight > window.innerWidth
      const navH = navHeight()
      // 横屏工具条贴到 8px，不是桌面那 26px；导航条和画布留白都要跟着它上去。
      const tight = window.innerHeight <= 500 && window.innerHeight <= window.innerWidth
      const bottom = tight ? 8 : undefined
      plot.style.setProperty('--market-chrome-h', `${chromeHeight({ controlsH, statsH, stacked, navH, bottom })}px`)
      plot.style.setProperty('--market-controls-h', `${controlsH}px`)
      plot.style.setProperty('--market-stats-b', `${statsBottom(controlsH)}px`)
      plot.style.setProperty('--market-nav-h', `${navH}px`)
      plot.style.setProperty('--market-nav-b', `${navBottom(controlsH, stacked, bottom)}px`)
      // 竖屏不放导航条，那会儿它根本没建出来；转成横屏后得补建，不能只在「已经
      // 有」的时候才管。
      if (navH) beginNav()
      else if (nav) endNav()
    })
  }
  const chromeWatch = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => measureChrome())
    : null
  chromeWatch?.observe(controls)
  chromeWatch?.observe(stats)
  window.addEventListener('resize', measureChrome, { passive: true })
  window.addEventListener('orientationchange', measureChrome, { passive: true })

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
    if (closed || !topModal(panel.node) || typing() || anyPopOpen()) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const hit = () => { event.preventDefault(); wake() }
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
      case '[': if (related.length > 1) { hit(); pick(selected - 1) } break
      case ']': if (related.length > 1) { hit(); pick(selected + 1) } break
      default:
        if (full && /^[1-9]$/.test(event.key)) {
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
    selected = index; request = related[selected]!
    // 全屏里换到同一个品种同一档的另一段：图和数据都不用重建，挪一下锚定就是了。
    if (full && stage && history && historySpace === spaceKey(request)) { reanchor(); return }
    void load()
  }

  /* ------------------------------------------------ 完整历史（全屏） */

  const spaceKey = (item: ChartRequest): string =>
    `${item.market}|${item.symbol}|${item.interval}|${item.source ?? 'rest'}`
  const cutoffOf = (item: ChartRequest): string => item.match_end_at ?? item.end_at

  /** 丁香带上沿那一行：这段是哪来的、有多少根。 */
  function anchorLabel(): string {
    const startMs = Date.parse(request.start_at)
    const cutMs = Date.parse(cutoffOf(request))
    const bars = windowBars.filter((bar) => {
      const end = Date.parse(bar.end)
      return end > startMs && end <= cutMs
    }).length
    // 从截图进来的（详情页「看真实走势」、记一笔里的那张图）就是「截图这段」；
    // 手动校准那条路自己说自己是校准区间；剩下的是找相似匹配出来的。
    const shot = options.attachmentId ?? options.queryAttachmentId
    const name = label === '校准区间' ? '校准区间' : shot ? '截图这段' : '匹配这段'
    return `${name} · ${bars} 根`
  }

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
    const remembered = readPeriod(request.market, request.symbol)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (closed || !full || stage !== mine) return
      anchorNow(true)
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
    const span = (cut - start) / 0.6
    const left = cut - 0.62 * span
    const right = left + span
    stage.setAnchor({ startMs: start, endMs: cut, label: anchorLabel() })
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
      : levelForSpan(stage.paneWidth(), fromMs, toMs, ladder, level, lockedLevel, request.interval)
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
    // 回锚定 = 回这条记录当时的那一档、那一段。
    anchorNow(true, request.interval)
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
        note.textContent = '橙色虚线来自截图对应的真实收盘价，仅缩放时间和幅度。竖线右侧是历史真实后续。'
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
    const title = `${request.symbol} · ${request.interval} · 币安`
    panel.node.setAttribute('aria-label', title)
    panel.node.querySelector('.sheet-t')!.textContent = title
  }

  async function load(): Promise<void> {
    controller?.abort()
    const current = new AbortController(); controller = current
    const kept = stage?.view() ?? null
    stage?.destroy(); stage = null; stats.replaceChildren()
    feed = null
    const target = request
    paintCandidates()
    plot.replaceChildren(h('div.market-loading', { text: '正在加载真实行情' }))
    if (full) placeChrome()
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
      stage = tradingChart(result.bars, target.end_at, target.symbol, target.interval, target.start_at)
      if (!options.queryAttachmentId) stage.node.setAttribute('aria-label', `${target.symbol} 真实 K 线和成交量`)
      plot.replaceChildren(stage.node)
      if (contour) stage.setOutline(contour.values)
      stage.showOutline(showOutline)
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
        if (kept) built.setView(kept)
        else built.reset()
      })
      const after = followingStats(result.bars, target.end_at)
      if (after) stats.appendChild(h('span', { text: `后续 ${after.count} 根：收盘 ${percent(after.close)} · 最高 ${percent(after.high)} · 最低 ${percent(after.low)}` }))
      if (followUnavailable) stats.appendChild(h('span', { text: '后续行情暂未取到，先展示匹配区间' }))
      else if (follow && (!after || after.count < follow)) stats.appendChild(h('span', { text: '后续已收盘行情不足所选根数' }))
      if (result.coverage_complete === false) stats.appendChild(h('span', { text: '这段行情有缺口' }))
      preheat(built, mine)
    } catch (error) {
      if (closed || current.signal.aborted) return
      plot.replaceChildren(h('div.market-loading', { text: error instanceof ApiError ? error.message : '这段行情暂时没取到' }),
        h('button.btn.sm', { text: '再试一次', on: { click: () => void load() } }))
      if (full) placeChrome()
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

  if (options.fullscreen) setFull(true)
  void load()
  void readOutline()
}

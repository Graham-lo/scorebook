// 全屏那张真 K 线。用 lightweight-charts 画，但穿的是这个产品自己的深靛「夜窗」，
// 不是 TradingView 出厂的那身深灰。
//
// 三件当初露白的事都在这里收掉：多面板之间那条 1px 分隔条改成舞台底色；容器底色
// 和图一致（哪怕还剩半个像素的缝也看不见）；尺寸自己用 ResizeObserver 量，取整数
// 再 resize——autoSize 会按小数像素铺，底下就留一条白。
//
// 图例不再是顶上一条白带，而是叠在图左上角的一小块：品种那一行、十字线那一根的
// 开高低收，以及开着的指标读数。指标一律由外面传进来，这里不自己开任何一条线。

import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, PriceScaleMode,
  createChart, TrackingModeExitMode,
  type IPriceLine, type IPrimitivePaneView, type ISeriesApi, type ISeriesPrimitive, type Logical,
  type LogicalRange, type SeriesType, type Time, type UTCTimestamp,
} from 'lightweight-charts'
import type { Bar, ChartSetup } from '../../api/types'
import {
  clampSpan, farJump, flingSpan, flingSpeed, glideAt, keepInView, latticeEnds, latticeHolds,
  nearEdge, needsReassert, nowShowing, planLattice, sameLattice, slotFor, slotOf, swapCover,
  timeOfSlot, viewAim,
  type FlingSample, type Lattice, type ViewBounds,
} from './chart-span'
import { barSpanMs } from './history/tiles'
import { guarded, jumpTo, refill, retire, selfMark, type Stage } from './view-rules'
import { measureText, pinLabel, pinToggle } from './measure'
import { compareOutline } from '../../data/chart-comparison'
import { prefs } from '../../data/prefs'
import { h } from '../../ui/dom'
import { boll as bollLines, ema as emaLine, macd as macdLines, rsi as rsiLine, sma, type Line } from './indicators'

/** 「夜窗」这一套颜色。图上出现的每一个颜色都从这里来。 */
export const NIGHT = {
  bg: '#161A3F',
  bg2: '#0F1230',
  grid: '#232858',
  text: '#A6A9C0',
  axisLine: '#2A2E6E',
  crosshair: '#8A8FBF',
  crosshairLabel: '#2A2E6E',
  up: '#2FBF8F',
  down: '#F0567B',
  outline: '#FFB454',
  cutoff: '#8C95FF',
  boll: '#C8B6FF',
  anchor: '#C4B5FD',
  lines: ['#FFB454', '#8C95FF', '#4FD1B5', '#F78FB3', '#C8B6FF', '#7FD0FF', '#FFE08A', '#9AE6B4'],
} as const

const time = (bar: Bar) => (Date.parse(bar.start) / 1000) as UTCTimestamp
const utc = (stamp: number) => new Date(stamp * 1000).toISOString().slice(0, 16).replace('T', ' ')

function monoFont(): string {
  try {
    const stack = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
    return stack || 'system-ui'
  } catch {
    return 'system-ui'
  }
}

export interface TradingChart {
  node: HTMLElement
  setOutline(values: readonly number[]): void
  showOutline(show: boolean): void
  /** 画哪几条线。传进来什么画什么，这里不记偏好。 */
  setIndicators(setup: ChartSetup): void
  /** 换一整份 bars（往前补了历史，或者往后接了行情），视野不动。 */
  appendBars(next: Bar[]): void
  /**
   * 换一整份 bars，指定视野按什么守恒：`'time'` 是同一段时间还在同一个位置
   * （换档、前插、补洞都要这个），`'logical'` 是同样是第几根到第几根。
   */
  setBars(next: Bar[], keep: 'time' | 'logical'): void
  /** 当前视野的时间范围（毫秒）。拖到数据以外也给得出来，靠这一档的根宽外推。 */
  visibleTime(): { from: number; to: number } | null
  /**
   * 还没落到的那个目标，再落一次位。
   *
   * 兜底用：数据到了、可这一段还是一根都没有（跳到上市之前那种），外面没有
   * `setBars` 可发，图就会一直停在被钳过的地方。已经落到了就什么都不做。
   */
  reassert(): void
  /**
   * 落到这一段时间上。`next` 给了就先把这一档的 bar 换上去再落位：远跳的时候
   * 新格子上一根真 bar 都没有，图会把落位钳到格子边上，位置当场就偏。
   */
  setVisibleTime(from: number, to: number, animate: boolean, next?: Bar[]): void
  /** 时间轴那块画布有多宽（像素）。换档按它和时间跨度算，不看 barSpacing。 */
  paneWidth(): number
  /** 此刻一根多宽（像素）。人手换周期时要按它反算跨度，K 线才等大等粗。 */
  barSpacing(): number
  /** 价格轴怎么画：对数、常规、百分比。 */
  setScaleMode(mode: 'log' | 'normal' | 'percent'): void
  /** 图例那一行的两半，外面挂点击、挂菜单用。 */
  legendParts(): { symbol: HTMLElement; period: HTMLElement; line: HTMLElement }
  /**
   * 未加载的那一段要不要用留白撑住时间轴。全屏懒加载要，窗口态不要。
   */
  setPadding(on: boolean): void
  /**
   * 视野变了。`programmatic` 为真表示这一次是程序自己设的（锚定、换档、回位），
   * 外面不该拿它当人手缩放去判断档位，也不该拿它算速度。
   */
  onVisibleTime(handler: (range: { from: number; to: number; programmatic: boolean }) => void): void
  /**
   * 换档：图例里的周期文字、时间轴的粗细，以及按新档重铺格子。`view` 是这一次
   * 要落到的那一段时间（毫秒），不传就按当前视野重铺。
   */
  setInterval(interval: string, view?: { from: number; to: number }): void
  /** 锚定段那条丁香色时间带。传 null 收起来。 */
  setAnchor(band: { startMs: number; endMs: number } | null): void
  /** 两侧边缘的呼吸条。 */
  setEdge(side: 'left' | 'right', state: 'idle' | 'loading' | 'failed'): void
  /** 边缘那颗「重试」被按了。 */
  onEdgeRetry(handler: (side: 'left' | 'right') => void): void
  /** 截止那一根下面那个「记下判断」。传 null 取消。 */
  setJudgment(atMs: number | null): void
  /**
   * 这一档的上市时刻。视野的左墙就按它算：再往左最多让人看到一屏空白，拖不出
   * 去，也就不会拖到一片什么都没有、连回来的路都找不到的地方。不知道就传 null。
   */
  setFloor(atMs: number | null): void
  /**
   * 活的最新一根变了：只改这一根，不动别的。收盘之后那一根会从历史那条路再进
   * 来一次，两边是同一个口径，不会变成两根。
   */
  updateLast(bar: Bar): void
  /** 右边缘钉不钉在最新那一根上（新数据来了整体往右挪一根）。 */
  setFollowLatest(on: boolean): void
  /** 十字线吸不吸附到 K 线上。 */
  setMagnet(on: boolean): void
  magnet(): boolean
  /** 全屏专属的那几个手势：Shift 拖出量尺、Alt 点钉价格线。 */
  setGestures(on: boolean): void
  /** 钉到第六条那种话，交给外面用图例说。 */
  onHint(handler: (text: string) => void): void
  /** 换一个候选之后，截止线挪到新的那一刻。 */
  setCutoff(at: string): void
  /** 截止那条虚线画不画。换到不是这条记录的品种上就不画。 */
  showCutoff(on: boolean): void
  /** 当前视野相对截止那一根的根数；人没动过缩放就是 null。 */
  view(): { before: number; after: number } | null
  setView(view: { before: number; after: number }): void
  reset(): void
  zoom(factor: number): void
  /** 左右平移，fraction 是当前视野宽度的比例。 */
  pan(fraction: number): void
  onRange(handler: (range: LogicalRange | null) => void): void
  destroy(): void
}

export function tradingChart(
  initial: Bar[],
  cutoff: string,
  symbol: string,
  interval: string,
  startAt?: string,
): TradingChart {
  // 图例就这一行：品种 · 周期。开高低收、指标数值、来源、倒计时都不在这儿——
  // 那些字浮在 K 线上就是噪音，价格轴、时间轴、指标线本身已经把它们说完了。
  const legendSymbol = h('button.tv-legend-btn.tv-legend-sym', { type: 'button', text: symbol })
  const legendSep = h('span.tv-legend-sep', { text: ' · ', attrs: { 'aria-hidden': 'true' } })
  const legendRest = h('button.tv-legend-btn.tv-legend-rest', { type: 'button', text: interval })
  const legend = h('div.tv-legend', { attrs: { 'aria-live': 'off' } }, legendSymbol, legendSep, legendRest)
  const canvas = h('div.tv-canvas', { role: 'img', attrs: { 'aria-label': `${symbol} 真实 K 线、成交量和截图轮廓对比` } })
  const node = h('div.tv-chart', {}, canvas, legend)

  const up = prefs().updown === 'red_up' ? NIGHT.down : NIGHT.up
  const down = prefs().updown === 'red_up' ? NIGHT.up : NIGHT.down
  const mono = monoFont()

  const chart = createChart(canvas, {
    autoSize: false,
    layout: {
      background: { type: ColorType.Solid, color: NIGHT.bg },
      textColor: NIGHT.text,
      fontFamily: mono,
      fontSize: 12,
      attributionLogo: true,
      panes: { separatorColor: NIGHT.bg2, separatorHoverColor: 'rgba(140,149,255,.28)', enableResize: true },
    },
    grid: { vertLines: { color: NIGHT.grid }, horzLines: { color: NIGHT.grid } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: NIGHT.crosshair, labelBackgroundColor: NIGHT.crosshairLabel },
      horzLine: { color: NIGHT.crosshair, labelBackgroundColor: NIGHT.crosshairLabel },
    },
    rightPriceScale: { borderColor: NIGHT.axisLine, autoScale: true, minimumWidth: 72 },
    // shiftVisibleRangeOnNewBar 默认开着：最后一根在屏内的时候，来一根新数据图就
    // 把视野整体往右挪一根。回放是「看那一段」，不是「跟到最新」，挪了就等于把
    // 刚落好的位又推走——一律关掉。
    timeScale: {
      borderColor: NIGHT.axisLine, timeVisible: true, secondsVisible: false, rightOffset: 5,
      fixLeftEdge: false, minBarSpacing: 0.4, shiftVisibleRangeOnNewBar: false,
    },
    localization: { locale: 'zh-CN', timeFormatter: (t: Time) => typeof t === 'number' ? utc(t) + ' UTC' : String(t) },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    // 触屏一甩要有惯性，鼠标不要：鼠标拖到哪儿就停在哪儿，飘过去反而不好对位。
    kineticScroll: { mouse: false, touch: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true, axisDoubleClickReset: true },
    // 触屏长按出十字线，再点一下退出——按住不放读数，松手图还在原处。
    trackingMode: { exitMode: TrackingModeExitMode.OnNextTap },
  })

  /* ------------------------------------------------------------ 尺寸 */

  // 进全屏那一下：keydown 里同步走到锚定，这时 ResizeObserver 还没把图铺到全屏
  // 宽，格子和根宽都按窄屏算；下一帧图 resize 过来，它保根宽不保跨度，视野就被
  // 拉宽了。所以 resize 之后把最后一次程序性落位按毫秒重放一遍。
  // （用一个可写的槽，是因为它要用到下面才声明的那几样。）
  let onResized: (() => void) | null = null
  function measure(): void {
    const width = Math.floor(canvas.clientWidth)
    const height = Math.floor(canvas.clientHeight)
    if (!(width > 0 && height > 0)) return
    chart.resize(width, height)
    onResized?.()
  }
  const watcher = new ResizeObserver(() => measure())
  watcher.observe(canvas)
  measure()

  /* ------------------------------------------------------------ 数据 */

  // 截图轮廓永远按当初那一段缩放：往前补了几万根历史之后，轮廓不能跟着拉长。
  const windowBars = initial.slice()
  let bars = initial.slice()
  let cutAt = Date.parse(cutoff)
  let cutIndex = 0
  let closes: number[] = []
  let vols: number[] = []
  const anchorFrom = startAt ?? initial[0]?.start ?? cutoff
  const anchorTo = initial.at(-1)?.start ?? cutoff

  function recompute(): void {
    closes = bars.map((bar) => Number(bar.close))
    vols = bars.map((bar) => (bar.volume === null || bar.volume === undefined ? 0 : Number(bar.volume)))
    let matched = 0
    for (const bar of bars) if (Date.parse(bar.end) <= cutAt) matched += 1
    cutIndex = Math.max(0, matched - 1)
  }
  recompute()

  /* ------------------------------------------------------------ 格子 */

  // 全屏懒加载的时候，当前这一档的数据集是一排等距格子：真实 bar 按 slot 填进
  // 对应的格里，其余的格子是 whitespace。于是 logical = (ms − origin) / step 在
  // 整条轴上精确成立，往 2019 年跳也不用外推、不会被钳回数据里。窗口态不铺格子，
  // 数据就是 bars 本身。
  let level = interval
  let padded = false
  let lat: Lattice | null = null
  /** 这一档的上市时刻（调度器摸出来的地板）。不知道就是 null。 */
  let floorMs: number | null = null
  /** `setData` 正在跑。跑的当中图打出来的范围变化是一笔假账，见下面订阅那一段。 */
  let painting = false
  /** 正在被人拖着。按下的位置和当时看的那一段，见下面 onPanDown。 */
  let panning:
    | { id: number; x: number; from: number; to: number; touch: boolean; trail: FlingSample[] }
    | null = null
  /** 手指甩完松手，正在惯性往下滑。见下面 startFling。 */
  let fling: { raf: number } | null = null
  const stamp = (ms: number): UTCTimestamp => Math.floor(ms / 1000) as UTCTimestamp
  const startOf = (bar: Bar): number => Date.parse(bar.start)
  /** 格子上的时刻 → 真实第几根。十字线读图例要用。 */

  /** 真实第 i 根在轴上的下标。 */
  function logicalOf(realIndex: number): number {
    const bar = bars[realIndex]
    if (!lat || !bar) return realIndex
    return Math.round(slotOf(lat, startOf(bar)))
  }

  /**
   * 把「每根一条值」摆到格子上：格子外的 bar 不进图，空着的格放 whitespace。
   * 没铺格子（窗口态）就还是一根一条。
   */
  function gridData<T extends object>(
    make: (bar: Bar, i: number) => T | null,
  ): ({ time: UTCTimestamp } | (T & { time: UTCTimestamp }))[] {
    const out: ({ time: UTCTimestamp } | (T & { time: UTCTimestamp }))[] = []
    const grid = lat
    if (!grid) {
      bars.forEach((bar, i) => {
        const made = make(bar, i)
        out.push(made === null ? { time: time(bar) } : { ...made, time: time(bar) })
      })
      return out
    }
    const filled = new Map<number, T>()
    bars.forEach((bar, i) => {
      const slot = slotFor(grid, startOf(bar))
      if (slot === null) return
      const made = make(bar, i)
      if (made !== null) filled.set(slot, made)
    })
    for (let i = 0; i < grid.count; i += 1) {
      const at = stamp(timeOfSlot(grid, i))
      const made = filled.get(i)
      out.push(made === undefined ? { time: at } : { ...made, time: at })
    }
    return out
  }

  type Candle = { open: number; high: number; low: number; close: number }
  function candleData(): ({ time: UTCTimestamp } | (Candle & { time: UTCTimestamp }))[] {
    return gridData((bar) => ({
      open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close),
    }))
  }

  const minimum = Math.min(...initial.map((bar) => Number(bar.low)))
  const precision = Math.max(2, Math.min(8, 3 - Math.floor(Math.log10(Math.max(minimum, 1e-8)))))
  // 均线读数和价格轴用同一位数，别把 190.96133333 这种算出来的尾巴亮给人看。
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: up, downColor: down, wickUpColor: up, wickDownColor: down,
    borderVisible: false, priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
  })
  candles.setData(candleData())

  /**
   * 一根看不见的针，钉在整排格子的最后一格上。
   *
   * 图内部量「还能往右滚多远」用的不是格子，是「最后一根真 K 线」——留白一根都
   * 不算。人往回拖得比数据取回来快的时候，那道内部的墙就横在窗口里那批 K 线的
   * 右边一屏处，拖到那儿就再也拖不动，画面一动不动、也一直是空白。把针钉在格子
   * 的最后一格，那道墙就跟着格子走，而格子是我们按视野铺的，人拖到哪儿它跟到
   * 哪儿。它挂在自己的价格轴上，不参与主图的自动缩放，也不画任何东西。
   */
  const ruler = chart.addSeries(LineSeries, {
    visible: false, priceScaleId: '', lastValueVisible: false, priceLineVisible: false,
    crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
  })
  function pinRuler(): void {
    if (!lat) { ruler.setData([]); return }
    ruler.setData([{ time: stamp(timeOfSlot(lat, lat.count - 1)), value: 0 }])
  }
  pinRuler()

  const comparison = chart.addSeries(LineSeries, {
    color: NIGHT.outline, lineWidth: 2, lineStyle: LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    priceScaleId: 'right', autoscaleInfoProvider: () => null,
  })

  /* -------------------------------------------------- 匹配截止那条线 */

  const marker: ISeriesPrimitive = (() => {
    const boundary = (width: number): number | null => {
      const left = chart.timeScale().logicalToCoordinate(logicalOf(cutIndex) as Logical)
      const right = chart.timeScale().logicalToCoordinate(logicalOf(cutIndex + 1) as Logical)
      const x = left === null || right === null ? null : (left + right) / 2
      if (x === null || x < 0 || x > width) return null
      return x
    }
    // 截止处只留一根细虚线。字（「匹配截止」「真实后续 →」）和右侧那层底色都不画了——
    // 用户要的是「给个简单标记即可，不要影响 k 线的视觉」，剩下的话由 .tv-judge 小标去说。
    const line: IPrimitivePaneView = {
      zOrder: () => 'top',
      renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        const x = boundary(mediaSize.width)
        if (x === null) return
        ctx.save()
        ctx.strokeStyle = NIGHT.cutoff; ctx.lineWidth = 1; ctx.setLineDash([3, 4])
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mediaSize.height); ctx.stroke()
        ctx.restore()
      }) }),
    }
    const views = [line]
    return { paneViews: () => views }
  })()
  let cutShown = cutIndex > 0 || bars.length > 0
  if (cutShown) candles.attachPrimitive(marker)

  /* ------------------------------------------------------------ 指标 */

  let setup: ChartSetup | null = null
  let extras: ISeriesApi<SeriesType>[] = []
  /** 量柱那一条。活的最新一根要连量一起改，所以留个引用。 */
  let volumeSeries: ISeriesApi<'Histogram'> | null = null

  function points(values: Line): ({ time: UTCTimestamp } | { time: UTCTimestamp; value: number })[] {
    return gridData((_bar, i) => {
      const v = values[i]
      return v === null || v === undefined ? null : { value: v }
    })
  }

  function addLine(pane: number, values: Line, color: string, style: LineStyle = LineStyle.Solid, volume = false): void {
    const series = chart.addSeries(LineSeries, {
      color, lineWidth: 1, lineStyle: style,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      ...(volume ? { priceFormat: { type: 'volume' as const } } : {}),
    }, pane)
    series.setData(points(values))
    extras.push(series)
  }

  function rebuildPanes(): void {
    // 先把名单摘下来换成空的再删：删的过程中重入进来会换上一批新的，外层要是还
    // 拿着旧名单接着删，同一条就删两次，图直接抛 `Series not found`。
    retire(extras, (series) => chart.removeSeries(series))
    volumeSeries = null
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1)
    if (!setup) {
      chart.panes()[0]?.setStretchFactor(6)
      return
    }
    let slot = 0
    const nextColor = (): string => NIGHT.lines[slot++ % NIGHT.lines.length] as string

    for (const n of setup.ma) {
      const values = sma(closes, n)
      addLine(0, values, nextColor())
    }
    for (const n of setup.ema) {
      const values = emaLine(closes, n)
      addLine(0, values, nextColor())
    }
    if (setup.boll) {
      const k = Number(setup.boll.k)
      const band = bollLines(closes, setup.boll.n, Number.isFinite(k) ? k : 2)
      addLine(0, band.upper, NIGHT.boll, LineStyle.Dashed)
      addLine(0, band.mid, NIGHT.boll)
      addLine(0, band.lower, NIGHT.boll, LineStyle.Dashed)
    }

    let pane = 0
    if (setup.volume) {
      pane += 1
      const histogram = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, pane)
      histogram.setData(gridData((bar) => {
        if (bar.volume === null || bar.volume === undefined) return null
        const value = Number(bar.volume)
        if (!Number.isFinite(value)) return null
        return { value, color: (Number(bar.close) >= Number(bar.open) ? up : down) + '99' }
      }))
      extras.push(histogram)
      volumeSeries = histogram
      for (const n of setup.volume.ma) addLine(pane, sma(vols, n), nextColor(), LineStyle.Solid, true)
      chart.panes()[pane]?.setStretchFactor(1.4)
    }
    if (setup.macd) {
      pane += 1
      const { fast, slow, signal } = setup.macd
      const lines = macdLines(closes, fast, slow, signal)
      const histogram = chart.addSeries(HistogramSeries, { priceFormat: { type: 'price', precision: 4, minMove: 0.0001 }, priceLineVisible: false, lastValueVisible: false }, pane)
      histogram.setData(gridData((_bar, i) => {
        const v = lines.hist[i]
        return v === null || v === undefined ? null : { value: v, color: (v >= 0 ? up : down) + '99' }
      }))
      extras.push(histogram)
      addLine(pane, lines.dif, NIGHT.outline)
      addLine(pane, lines.dea, NIGHT.cutoff)
      chart.panes()[pane]?.setStretchFactor(1.4)
    }
    if (setup.rsi) {
      pane += 1
      const n = setup.rsi.n
      const values = rsiLine(closes, n)
      const series = chart.addSeries(LineSeries, {
        color: NIGHT.boll, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      }, pane)
      series.setData(points(values))
      extras.push(series)
      for (const level of [30, 70]) {
        series.createPriceLine({ price: level, color: 'rgba(255,255,255,.22)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      }
      chart.panes()[pane]?.setStretchFactor(1.2)
    }
    chart.panes()[0]?.setStretchFactor(6)
  }


  /* ------------------------------------------------------------ 视野 */

  let touched = false
  // 人一动手（滚轮、按下、触摸），上一次甩出去的惯性当场作废。
  const mark = () => { touched = true; stopFling() }
  canvas.addEventListener('wheel', mark, { passive: true })
  canvas.addEventListener('pointerdown', mark)
  canvas.addEventListener('touchstart', mark, { passive: true })

  function indexAt(iso: string): number {
    const want = Date.parse(iso)
    let lo = 0
    for (let i = 0; i < bars.length; i += 1) {
      if (Date.parse((bars[i] as Bar).start) <= want) lo = i
      else break
    }
    return lo
  }

  function reset(): void {
    applyScale()
    const from = logicalOf(indexAt(anchorFrom))
    const to = logicalOf(indexAt(anchorTo))
    asProgrammatic(() => chart.timeScale().setVisibleLogicalRange({ from: from - 0.5, to: to + 5 }))
    touched = false
  }

  function view(): { before: number; after: number } | null {
    if (!touched) return null
    const range = chart.timeScale().getVisibleLogicalRange()
    if (!range) return null
    return { before: logicalOf(cutIndex) - range.from, after: range.to - logicalOf(cutIndex) }
  }

  function setView(next: { before: number; after: number }): void {
    chart.timeScale().setVisibleLogicalRange({ from: logicalOf(cutIndex) - next.before, to: logicalOf(cutIndex) + next.after })
    touched = true
  }

  let lastOutline: readonly number[] | null = null
  function setOutline(values: readonly number[]): void {
    lastOutline = values
    const drawn = compareOutline(values, windowBars, cutoff)
    const grid = lat
    if (!grid) {
      comparison.setData(drawn.map((point) => ({ ...point, time: point.time as UTCTimestamp })))
      return
    }
    // 轮廓的时刻来自窗口态那一份数据，和当前档的格子不一定对得上：摆到最近的
    // 格上，摆不进去的丢掉——多一个格子外的时间点，整条轴的线性就废了。
    const slots = new Map<number, number>()
    for (const point of drawn) {
      const slot = slotFor(grid, point.time * 1000)
      if (slot !== null) slots.set(slot, point.value)
    }
    comparison.setData([...slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, value]) => ({ time: stamp(timeOfSlot(grid, slot)), value })))
  }

  function appendBars(next: Bar[]): void {
    if (!next.length) return
    // 往前补历史会把所有下标往右推：视野按「原来第一根现在排第几」平移，
    // 不依赖画布此刻有没有算出时间范围（全屏切换、刚挂载时它可能是空的）。
    // 铺了格子就不存在「下标整体右推」这回事：格子是按时间划的，往前补多少根，
    // 每一格代表的时刻都没变，视野一个字都不用动。
    if (lat) {
      bars = next
      repaint()
      layout()
      return
    }
    const range = chart.timeScale().getVisibleLogicalRange()
    const firstAt = bars[0] ? Date.parse(bars[0].start) : null
    bars = next
    recompute()
    candles.setData(candleData())
    rebuildPanes()
    if (lastOutline) setOutline(lastOutline)
    if (!range) { reset(); return }
    const shift = firstAt === null ? 0 : Math.max(0, bars.findIndex((bar) => Date.parse(bar.start) >= firstAt))
    chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift })
  }

  /* -------------------------------------------- 全屏：时间、档位、覆盖层 */

  // 全屏那张图要按时间说话：往左拖出数据之外还得知道「现在看的是哪一段」，
  // 所以时间和下标之间自己留了一对换算——数据里面用相邻两根插值，数据外面按
  // 这一档一根多宽外推。lightweight-charts 自己的 getVisibleRange 到数据边界
  // 就停住了，懒加载正需要越过那条边界的那一段。

  const timeWatchers: ((range: { from: number; to: number; programmatic: boolean }) => void)[] = []
  const retryWatchers: ((side: 'left' | 'right') => void)[] = []

  const band = h('div.tv-band', { hidden: true })
  const retryLeft = h('button.btn', { text: '重试', hidden: true, on: { click: () => { for (const cb of retryWatchers) cb('left') } } })
  const retryRight = h('button.btn', { text: '重试', hidden: true, on: { click: () => { for (const cb of retryWatchers) cb('right') } } })
  const edgeLeft = h('div.tv-edge.left', { hidden: true }, retryLeft)
  const edgeRight = h('div.tv-edge.right', { hidden: true }, retryRight)
  // 「记下判断」是叠在画布上的一块 DOM，不是 series marker：marker 在缩到很密的
  // 时候会被图自己藏掉，这一条必须一直看得见。
  const judgeNode = h('div.tv-judge', { hidden: true }, h('span.tv-judge-mark'))
  canvas.append(band, edgeLeft, edgeRight, judgeNode)

  function paintRest(): void { legendRest.textContent = level }

  function timeAtLogical(logical: number): number {
    // 铺了格子就只做这一道除法的反向：格子是等距的，整条轴上都准。
    if (lat) return timeOfSlot(lat, logical)
    if (!bars.length) return Number.NaN
    const last = bars.length - 1
    const head = startOf(bars[0] as Bar)
    const tail = startOf(bars[last] as Bar)
    const step = barSpanMs(level)
    if (logical <= 0) return head + logical * step
    if (logical >= last) return tail + (logical - last) * step
    const i = Math.floor(logical)
    const a = startOf(bars[i] as Bar)
    const b = startOf(bars[i + 1] as Bar)
    return a + (b - a) * (logical - i)
  }

  function logicalAtTime(ms: number): number {
    if (lat) return slotOf(lat, ms)
    if (!bars.length) return 0
    const last = bars.length - 1
    const head = startOf(bars[0] as Bar)
    const tail = startOf(bars[last] as Bar)
    const step = barSpanMs(level)
    if (ms <= head) return (ms - head) / step
    if (ms >= tail) return last + (ms - tail) / step
    let lo = 0
    let hi = last
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (startOf(bars[mid] as Bar) <= ms) lo = mid
      else hi = mid
    }
    const a = startOf(bars[lo] as Bar)
    const b = startOf(bars[hi] as Bar)
    return b > a ? lo + (ms - a) / (b - a) : lo
  }

  /**
   * 最后一次程序性落位要去的那一段，还没等到图走过去。
   *
   * `setVisibleLogicalRange` 是延迟生效的（图自己的 rAF 里才真正落位），紧接着
   * 读回来的是上一段。连按 `-` 时每一下都拿这个旧值当基准，倍数就忽大忽小、
   * 中心到处跳。所以这段时间里「现在看的是哪儿」一律认它。
   */
  const aim = viewAim()
  /**
   * 「现在看的是哪一段」：目标还没兑现的时候，就是那个目标。
   *
   * 图的 rAF 会把还没有真 bar 的那一跳钳到格子边上，如果这时候照图的说法去取
   * 数，取的就是上市之前那一段空白，取回来还是空——没人再把视野落回去，就卡死
   * 在那儿了。所以只要还有没落到的目标，一律先认目标；人一动手 `settle(false)`
   * 把目标清掉，下一次问就回到图的真实范围，不会把人拉回去。
   */
  function pendingView(): { from: number; to: number } | null {
    return padded ? aim.want() : null
  }

  /** 图此刻真正落在哪一段——被钳过的也照报，不替它遮掩。 */
  function chartRange(): { from: number; to: number } | null {
    const range = chart.timeScale().getVisibleLogicalRange()
    if (!range) return null
    const from = timeAtLogical(range.from)
    const to = timeAtLogical(range.to)
    return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null
  }

  /** 图走到没走到：走到了、或者人自己动了手，这份念想就放下。 */
  function settlePending(self: boolean): void {
    aim.settle(self, chartRange(), lat ? lat.stepMs : barSpanMs(level))
  }

  function visibleTime(): { from: number; to: number } | null {
    const now = chartRange()
    const real = now && now.to > now.from ? now : null
    // 格子在，时间就永远说得出来：图自己还没算出范围（刚挂载、刚换数据）就先认
    // 上一次要去的那一段，实在没有就报整排格子。
    if (!lat) return bars.length ? nowShowing(pendingView(), real, null) : null
    const ends = latticeEnds(lat)
    return nowShowing(pendingView(), real, { from: ends.startMs, to: ends.endMs })
  }

  /** 人把动效关了就别缓动，直接到位。 */
  function calm(): boolean {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
  }

  // 程序自己设视野的时候打个标记：事件照发，但外面知道这一次不是人手在缩放。
  // 同步那一发已经出去了，还要再留一帧给图自己补发的那一次。
  const self = selfMark((run) => { requestAnimationFrame(run) })
  const asProgrammatic = self.as

  /**
   * 左墙：上市之前最多让人看到一屏空白。还不知道上市时刻的时候，就先拿已经拿到
   * 的最早那一根往左退两屏——再往左是没取过的那一段，得让人拖得过去才有人去取。
   */
  function leftWall(wideMs: number): number {
    const wide = Math.max(barSpanMs(level), wideMs)
    if (floorMs !== null) return floorMs - wide
    const head = bars[0]
    return head ? startOf(head) - 2 * wide : Number.NEGATIVE_INFINITY
  }

  /** 视野的两道墙。跨度多宽，墙就退多远——一屏永远是一屏。 */
  function viewBounds(wideMs: number): ViewBounds {
    const step = barSpanMs(level)
    const wall = leftWall(wideMs)
    // 墙比格子的左端再让半格：格子是按整格对齐的，差那一点不该变成一次夹取。
    return {
      minFromMs: Number.isFinite(wall) ? wall - step : Number.NEGATIVE_INFINITY,
      maxToMs: Date.now() + step,
    }
  }

  /** 按时间设视野。下标现算——留白已经把轴撑成线性的了。 */
  function applyTime(fromMs: number, toMs: number): void {
    // 无论谁要往哪儿跳，先夹回「上市前一屏 ~ 现在加一点」这一段里。
    const want = padded
      ? clampSpan({ from: fromMs, to: toMs }, viewBounds(toMs - fromMs))
      : { from: fromMs, to: toMs }
    aim.aim(want)
    asProgrammatic(() => {
      chart.timeScale().setVisibleLogicalRange({ from: logicalAtTime(want.from), to: logicalAtTime(want.to) })
    })
  }

  let regrowing = false
  /**
   * 按这一段视野重铺格子。铺出来和现在这排一样就什么都不做；不一样就换一份数据。
   * 视野由调用方负责按毫秒放回去——格子一换，所有下标的含义都变了。
   */
  function rebuildLattice(cover: { from: number; to: number } | null): boolean {
    if (!padded) {
      if (!lat) return false
      lat = null
      repaint()
      return true
    }
    const view = cover ?? visibleTime()
    if (!view) return false
    const head = bars[0]
    const tail = bars[bars.length - 1]
    const wall = leftWall(view.to - view.from)
    const next = planLattice({
      stepMs: barSpanMs(level),
      viewFromMs: view.from,
      viewToMs: view.to,
      paneWidthPx: chart.timeScale().width(),
      nowMs: Date.now(),
      ...(head ? { anchorMs: startOf(head) } : {}),
      ...(Number.isFinite(wall) ? { minStartMs: wall } : {}),
      // 离视野最近的那一根真 K 线必须圈得进来，理由见 chart-span 的 viewAfterSwap。
      ...(head && tail ? { keepMs: keepInView(view.from, view.to, startOf(head), startOf(tail)) } : {}),
    })
    if (!next || sameLattice(next, lat)) return false
    // 一根真 K 线都圈不住的格子宁可不换：图会把量滚动位置的尺子退回第 0 格，
    // 视野当场被拽到格子左端，下一帧再重铺一次就又往左推一屏，一路推到上市之前。
    if (head && tail && !latticeHolds(next, startOf(head), startOf(tail))) return false
    lat = next
    repaint()
    return true
  }

  /** 视野快走到格子边上了就往那边再铺一排，并把视野按毫秒放回原处。 */
  function maybeRegrow(): void {
    if (!padded || regrowing || !lat) return
    const view = visibleTime()
    if (!view || !nearEdge(lat, view.from, view.to)) return
    regrow(view)
  }

  /** 按这一段重铺，并把视野按毫秒放回去。 */
  function regrow(view: { from: number; to: number }): void {
    regrowing = true
    try {
      if (!rebuildLattice(view)) return
      // 换了一排格子，下标的含义就变了。按毫秒放回去——全屏态下平移是我们自己
      // 按鼠标位移算的（见 onPanMove），没人会再拿旧账把这一次抹掉。
      applyTime(view.from, view.to)
      layout()
    } finally { regrowing = false }
  }

  // 「换数据」和「落位」这两件事的先后写在 view-rules 里，远跳和补数据走同一套。
  /**
   * 价格轴重新按眼前这一段自动定范围。
   *
   * 远跳过去的那几秒里图上一根都没有，价格轴就停在出发那一段的量级上（实测从
   * 8 万跳到上市那一段，轴还写着 78k–86k，K 线画出来也在屏幕外，看着就像没画）。
   * 换一份数据就把 autoScale 重新按一遍，轴和 K 线同一帧一起到位。
   */
  // 价格轴默认对数：同一张图上 3 万到 12 万那一段，常规轴会把早年的波动压成一条
  // 直线。常规和百分比由外面按人的选择切过来。
  let priceMode: PriceScaleMode = PriceScaleMode.Logarithmic
  function applyScale(): void {
    try { chart.priceScale('right').applyOptions({ autoScale: true, mode: priceMode }) } catch { /* 图已经销毁 */ }
  }
  let priceMark = ''
  /** 这一份数据的价格范围签名。范围一个字没变就别重按——重按一次轴会自己跳一下。 */
  function markOf(list: readonly Bar[]): string {
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const bar of list) {
      const l = Number(bar.low)
      const h = Number(bar.high)
      if (Number.isFinite(l) && l < low) low = l
      if (Number.isFinite(h) && h > high) high = h
    }
    return Number.isFinite(low) && Number.isFinite(high) ? `${low}~${high}` : ''
  }
  function renewScale(): void {
    const mark = markOf(bars)
    // 往左并进来一段历史，价格范围常常一点没动：这时候重按 autoScale 只会让轴
    // 无缘无故重算一次刻度，看着就是「刷新了一下」。
    if (mark === priceMark) return
    priceMark = mark
    applyScale()
  }

  const stage: Stage<Bar> = {
    fill: (next) => { bars = next; renewScale() },
    rebuild: (fromMs, toMs) => rebuildLattice({ from: fromMs, to: toMs }),
    repaint,
    applyTime,
  }

  let gliding = 0
  /** 缓动的目标存毫秒。中途左边并进来新数据，下标会整体错位，时间不会。 */
  let glideTo: { from: number; to: number } | null = null
  function setVisibleTime(from: number, to: number, animate: boolean, next?: Bar[]): void {
    if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return
    stopFling()
    if (gliding) { cancelAnimationFrame(gliding); gliding = 0 }
    glideTo = null
    const here = visibleTime()
    const fresh = next && next.length && !sameBars(next) ? next : null
    // 远跳（目标出了格子、换了档、或者离当前视野三屏以上）：先按目标重铺格子再
    // 直接落位。中间那几万根一根都没有，缓动过去只是划过一片空白。
    const far = padded && (!lat || lat.stepMs !== barSpanMs(level) || farJump(here, { from, to }, lat))
    if (far) {
      // 落位之前先把这一档的真 bar 换上去。图算滚动位置用的是「最后一根真数据」
      // 的下标：新格子上一根真 bar 都没有的时候，它把我们要的位置当越界处理，
      // 直接钳到格子边上（实测 rightOffset 被钳成 width / barSpacing − 2，
      // 视野落在格子左端而不是目标那一段）。先填数据，这一步就不会被钳。
      jumpTo(stage, from, to, fresh)
      layout()
      return
    }
    if (fresh) setBars(fresh, 'time')
    if (!animate || calm() || !here) {
      applyTime(from, to)
      layout()
      return
    }
    glideTo = { from, to }
    const began = performance.now()
    const tick = (): void => {
      const step = glideAt(here, { from, to }, performance.now() - began)
      applyTime(step.from, step.to)
      layout()
      if (!step.done) { gliding = requestAnimationFrame(tick); return }
      gliding = 0
      glideTo = null
    }
    gliding = requestAnimationFrame(tick)
  }

  /**
   * 小数下标的横坐标。
   *
   * 图只认整数下标：`indexToCoordinate` 碰上小数直接返回 **0**（不是 null），
   * 于是锚定带和「记下判断」会被摆到画布最左边去。记录的起止时刻不一定卡在格
   * 子上——4h 档上 10:00、02:30 都落在两格中间——所以两头各问一个整数下标，中
   * 间按比例插出来。轴是线性的，插出来就是准的。
   */
  function xAtLogical(logical: number): number | null {
    if (!Number.isFinite(logical)) return null
    const floor = Math.floor(logical)
    const left = chart.timeScale().logicalToCoordinate(floor as Logical)
    if (left === null) return null
    const frac = logical - floor
    if (frac === 0) return left
    const right = chart.timeScale().logicalToCoordinate((floor + 1) as Logical)
    if (right === null) return null
    return left + (right - left) * frac
  }

  /** 这个时刻在画布上的横坐标。铺了格子就是一道除法，没铺才去问图。 */
  function xAt(ms: number): number | null {
    if (lat) return xAtLogical(logicalAtTime(ms))
    const direct = chart.timeScale().timeToCoordinate(stamp(ms))
    if (direct !== null) return direct
    return xAtLogical(logicalAtTime(ms))
  }

  let anchorBand: { startMs: number; endMs: number } | null = null

  let judgeAt: number | null = null

  /** K 线那一格的下沿，也就是量柱窗的上沿，离画布顶多少像素。 */
  function mainBottom(): number {
    const first = chart.panes()[0]
    const height = first ? first.getHeight() : 0
    return height > 0 ? height : canvas.clientHeight
  }

  /** 锚定带跟着视野走：每次视野变化重排一次，整段出了屏就收起来。 */
  function layoutBand(): void {
    if (!anchorBand) { band.hidden = true; return }
    const width = chart.timeScale().width()
    const a = xAt(anchorBand.startMs)
    const b = xAt(anchorBand.endMs)
    if (a === null || b === null || !(width > 0)) { band.hidden = true; return }
    const left = Math.max(0, Math.min(a, b))
    const right = Math.min(width, Math.max(a, b))
    if (!(right > left)) { band.hidden = true; return }
    band.hidden = false
    band.style.left = `${left}px`
    band.style.width = `${right - left}px`
  }

  /** 「记下判断」钉在截止那一根下面、量柱窗上沿；出了屏就收起来。 */
  function layoutJudge(): void {
    if (judgeAt === null) { judgeNode.hidden = true; return }
    const width = chart.timeScale().width()
    const x = xAt(judgeAt)
    if (x === null || !(width > 0) || x < 0 || x > width) { judgeNode.hidden = true; return }
    judgeNode.hidden = false
    judgeNode.style.left = `${x}px`
    judgeNode.style.bottom = `${Math.max(0, canvas.clientHeight - mainBottom() + 4)}px`
  }

  function layout(): void {
    layoutBand()
    layoutJudge()
  }

  // 图被 resize 之后（进出全屏、转屏、拖分隔条）：格子和视野都按新的画布宽重来
  // 一遍，把最后一次程序性落位放回去。人自己拖过、缩过之后 pending 早就清了，
  // 这里不会把他拉回原处。
  onResized = () => {
    const back = padded ? aim.want() : null
    if (!back) return
    rebuildLattice(back)
    applyTime(back.from, back.to)
    layout()
  }

  // 这个回调是**同步**触发的：`setData`、`removeSeries`、`resize` 内部一读可见
  // 范围就 fire。所以回调体里只做「看一眼、摆一下」这种轻活，重铺格子和通知外面
  // 一律推到微任务里——同一帧里来多少次都并成一次，绝不会从中间捅进正在跑的
  // `repaint`/`rebuildPanes`。
  let sweeping = false
  let sweepSelf = true
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
    // `setData` 正在跑：这一发是图自己在换数据的半路上打出来的，图里的下标还是
    // 旧那排格子的意思，按它去读「现在看的是哪一段时间」读到的是一段假账。重画
    // 的那一头自己会把视野按毫秒放回去，这里一个字都不要信。
    if (painting) return
    const mineNow = self.mine()
    settlePending(mineNow)
    layout()
    // 一批里只要有一次是人手动的，这一批就按人手算（该换档、该算速度）。
    sweepSelf = sweeping ? sweepSelf && mineNow : mineNow
    if (sweeping) return
    sweeping = true
    queueMicrotask(() => {
      sweeping = false
      const mine = sweepSelf
      maybeRegrow()
      layout()
      const range = visibleTime()
      if (!range) return
      // 手正拖着的时候，视野确实是我们自己按毫秒设的，但拿主意的是人的手：对外
      // 就得说「这是人动的」，否则取数和换档那一头会把它当自动回位跳过去，人拖
      // 到哪儿都没人去取数据，一路空白。
      const byHand = panning !== null || fling !== null
      for (const cb of timeWatchers) cb({ from: range.from, to: range.to, programmatic: mine && !byHand })
    })
  })

  /** 换一整份数据之后要跟着重画的那几样。 */
  function paintAll(): void {
    recompute()
    candles.setData(candleData())
    pinRuler()
    rebuildPanes()
    if (lastOutline) setOutline(lastOutline)
  }
  // 重入的话记个脏、这一趟跑完再补一趟：`setData` 会同步把范围变化回调打出去，
  // 回调那条线万一又绕回来重画，从中间捅进来的那一次会把 series 删两遍。
  const repaintOnce = guarded(paintAll)
  // 数据到了不是人手势：`setData` 会同步把范围变化回调打出去，不打程序性标记的
  // 话，外面会把它当成人在拖图——pending 被丢掉、换档和速度逻辑跟着乱走。
  function repaint(): void {
    painting = true
    try { asProgrammatic(repaintOnce) } finally { painting = false }
  }

  /** 和现在这一份是同一批 bar 吗：根数、头尾时刻、最后一根的收盘和量都没变。 */
  function sameBars(next: Bar[]): boolean {
    if (!bars.length || next.length !== bars.length) return false
    const last = bars.length - 1
    const a = bars[last] as Bar
    const b = next[last] as Bar
    if (startOf(next[0] as Bar) !== startOf(bars[0] as Bar)) return false
    if (startOf(b) !== startOf(a)) return false
    return b.close === a.close && b.volume === a.volume
  }

  /** 只在右端多了几根？是的话返回多出来几根，不是就返回 -1。 */
  function grownAtTail(next: Bar[]): number {
    if (!bars.length || next.length <= bars.length) return -1
    const last = bars.length - 1
    if (startOf(next[0] as Bar) !== startOf(bars[0] as Bar)) return -1
    if (startOf(next[last] as Bar) !== startOf(bars[last] as Bar)) return -1
    return next.length - bars.length
  }

  /* ------------------------------------------ 手正按着的时候不换数据 */

  /** 松手之后再等这么久：惯性滚动还没停，这会儿换数据照样会被看见。 */
  const GESTURE_TAIL_MS = 300
  /** 攒着的数据最多压这么久——万一 pointerup 丢了，也不能真就不画了。 */
  const HOLD_CAP_MS = 2000

  let downs = 0
  let tailUntil = 0
  let held: { next: Bar[]; keep: 'time' | 'logical'; since: number } | null = null
  let holdTimer = 0
  let settleTimer = 0

  function sliding(): boolean {
    return downs > 0 || Date.now() < tailUntil
  }

  function stash(next: Bar[], keep: 'time' | 'logical'): void {
    held = { next, keep, since: held ? held.since : Date.now() }
    if (holdTimer) return
    holdTimer = window.setTimeout(releaseHeld, GESTURE_TAIL_MS + 20)
  }

  function releaseHeld(): void {
    holdTimer = 0
    const waiting = held
    if (!waiting) return
    if (sliding() && Date.now() - waiting.since < HOLD_CAP_MS) {
      holdTimer = window.setTimeout(releaseHeld, GESTURE_TAIL_MS)
      return
    }
    held = null
    setBars(waiting.next, waiting.keep)
  }

  function onDragDown(): void { downs += 1 }
  function onDragUp(): void {
    if (downs > 0) downs -= 1
    tailUntil = Date.now() + GESTURE_TAIL_MS
    if (held && !holdTimer) holdTimer = window.setTimeout(releaseHeld, GESTURE_TAIL_MS + 20)
    // 拖的过程里格子的右端是钉死的，只往左长，长着长着就偏得离谱。松手落定之后
    // 按眼下这一段重铺一次：这会儿没人跟我们抢方向盘，视野按毫秒放回去是准的。
    planSettle()
  }

  /** 落定之后重铺一次格子。还在滑就先不铺，等滑停了再排一次。 */
  function planSettle(): void {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      settleTimer = 0
      if (sliding() || fling !== null || !padded || !lat) return
      const view = visibleTime()
      if (view) regrow(view)
    }, GESTURE_TAIL_MS + 40)
  }

  function setBars(next: Bar[], keep: 'time' | 'logical'): void {
    if (!next.length) return
    // 一根没变就别重画：拖动的时候这个函数每一帧都来一趟，而格子上的点数是按屏
    // 宽封顶的几千个，白白 setData 一次够慢的，而且 setData 会同步把范围变化
    // 回调打出来，整条链路跟着抖一遍。
    if (sameBars(next)) { layout(); return }
    // 窗口态还是图自己在拖（那套账是「按下时的位置 + 手指位移」，中途换数据会
    // 被算成一次整体位移，人看见的就是跳一下），所以手按着就先攒着。全屏态的平
    // 移是我们自己按鼠标位移算的，换完数据把同一段时间再落一次就行——数据一到
    // 就画出来，不用等松手。
    if (!padded && sliding()) { stash(next, keep); return }
    // 铺了格子的时候，新到的 bar 只是填进对应的格里：格子没变，视野的 logical
    // 范围就没变，一个字都不用碰视野，也就不会抖。
    if (lat) {
      // 换数据之前把眼下这一段记成时间：万一 setData 把视野挪了，就按同一段时
      // 间在新格子上算回 logical，同一个任务里设回去（不等下一帧）。
      // 手按着的时候不设——设了也会被下一次 pointermove 按旧账抹掉，反而把「现在
      // 看的是哪儿」带偏。上面那道关已经保证这一次换数据不会挪动视野。
      const locked = aim.want() ?? chartRange()
      refill(stage, next, locked)
      layout()
      return
    }
    // 纯右端追加、而且没开指标：一根一根 update 过去，视野连碰都不用碰。开着指标
    // 的时候新来的这几根会把 MA、MACD 的尾巴也改掉，那就得整份重算。
    const added = keep === 'time' && !setup ? grownAtTail(next) : -1
    if (added > 0) {
      const from = next.length - added
      bars = next
      recompute()
      for (let i = from; i < next.length; i += 1) {
        const bar = next[i] as Bar
        candles.update({
          time: time(bar), open: Number(bar.open), high: Number(bar.high),
          low: Number(bar.low), close: Number(bar.close),
        })
      }
      layout()
      return
    }
    const logical = chart.timeScale().getVisibleLogicalRange()
    // 换数据之前先把视野记成毫秒：下标会跟着新数据一起挪，时间不会。
    // 正在缓动就按缓动的目标来：那一帧自己会落地，别拿中途的视野当目标。
    const hold = keep === 'time' ? swapCover(glideTo, visibleTime()) : null
    bars = next
    repaint()
    if (keep === 'logical') {
      if (logical) asProgrammatic(() => chart.timeScale().setVisibleLogicalRange(logical))
      else reset()
      layout()
      return
    }
    if (hold) applyTime(hold.from, hold.to)
    else if (logical) asProgrammatic(() => chart.timeScale().setVisibleLogicalRange(logical))
    layout()
  }

  function setEdge(side: 'left' | 'right', state: 'idle' | 'loading' | 'failed'): void {
    const edge = side === 'left' ? edgeLeft : edgeRight
    const button = side === 'left' ? retryLeft : retryRight
    edge.classList.toggle('loading', state === 'loading')
    edge.classList.toggle('failed', state === 'failed')
    edge.hidden = state === 'idle'
    button.hidden = state !== 'failed'
  }


  /* ---------------------------------------------- 活的最新一根 / 跟到最新 */

  /**
   * 只改最后这一根。
   *
   * 走 `series.update` 而不是整份 `setData`：后者会把范围变化回调同步打出来，
   * 一秒四次，全屏那一整套换档、取数、落位逻辑跟着抖一遍。量柱那一条同样只更
   * 新对应的那一格。
   */
  function updateLast(bar: Bar): void {
    const at = Date.parse(bar.start)
    if (!Number.isFinite(at)) return
    const slot = lat ? slotFor(lat, at) : null
    // 铺了格子的时候，这一根必须落在格子上；落不进去（跳到别处去了）就不画。
    if (lat && slot === null) return
    const when = lat && slot !== null ? stamp(timeOfSlot(lat, slot)) : stamp(at)
    const close = Number(bar.close)
    const last = bars[bars.length - 1]
    const same = last && startOf(last) === at
    if (same) bars[bars.length - 1] = bar
    else if (!last || at > startOf(last)) bars = [...bars, bar]
    else return
    candles.update({
      time: when, open: Number(bar.open), high: Number(bar.high),
      low: Number(bar.low), close,
    })
    if (volumeSeries && bar.volume !== null && bar.volume !== undefined) {
      const value = Number(bar.volume)
      if (Number.isFinite(value)) {
        volumeSeries.update({ time: when, value, color: (close >= Number(bar.open) ? up : down) + '99' })
      }
    }
  }

  /* ------------------------------------------------ 量一段 / 钉一条价 */

  const measureLabel = h('span.tv-measure-label')
  const measureBox = h('div.tv-measure', { hidden: true }, measureLabel)
  canvas.appendChild(measureBox)
  const hintWatchers: ((text: string) => void)[] = []
  const tell = (text: string): void => { for (const cb of hintWatchers) cb(text) }

  let gestures = false
  let magnetOn = false
  let pins: number[] = []
  const pinLines = new Map<number, IPriceLine>()
  let measuring: { x: number; y: number; ms: number; price: number } | null = null
  let measureFade = 0
  let measureHide = 0

  /** 松手后的两个定时器一起清：再按一次量尺时，上一段的淡出不能追着新的这一段跑。 */
  function stopMeasureTimers(): void {
    window.clearTimeout(measureFade)
    window.clearTimeout(measureHide)
  }

  const priceAtY = (y: number): number | null => {
    const value = candles.coordinateToPrice(y)
    return value === null ? null : Number(value)
  }
  const yAtPrice = (value: number): number | null => {
    const y = candles.priceToCoordinate(value)
    return y === null ? null : Number(y)
  }
  function msAtX(x: number): number | null {
    const logical = chart.timeScale().coordinateToLogical(x)
    if (logical === null) return null
    const ms = timeAtLogical(logical)
    return Number.isFinite(ms) ? ms : null
  }

  function drawMeasure(x: number, y: number): void {
    const from = measuring
    if (!from) return
    const ms = msAtX(x)
    const value = priceAtY(y)
    if (ms === null || value === null) return
    measureBox.hidden = false
    measureBox.classList.remove('tv-measure-fade')
    measureBox.style.left = `${Math.min(from.x, x)}px`
    measureBox.style.top = `${Math.min(from.y, y)}px`
    measureBox.style.width = `${Math.abs(x - from.x)}px`
    measureBox.style.height = `${Math.abs(y - from.y)}px`
    measureBox.classList.toggle('tv-measure-up', value >= from.price)
    measureLabel.textContent = measureText({
      fromMs: from.ms, toMs: ms, fromPrice: from.price, toPrice: value, interval: level,
    })
  }

  /** 钉一条：线本身归 series 画，标签就是价格。 */
  function applyPins(next: number[]): void {
    for (const [value, line] of [...pinLines]) {
      if (next.includes(value)) continue
      try { candles.removePriceLine(line) } catch { /* 图已经换过数据了 */ }
      pinLines.delete(value)
    }
    for (const value of next) {
      if (pinLines.has(value)) continue
      pinLines.set(value, candles.createPriceLine({
        price: value, color: NIGHT.outline, lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: pinLabel(value, precision),
      }))
    }
    pins = next
  }

  /* ------------------------------------------ 全屏态：平移由我们自己算 */

  /**
   * 一次拖动记下三件事：按下时鼠标在哪儿、当时看的是哪一段时间。往后每一帧都拿
   * 「按下那一刻的那一段 − 鼠标横向位移换算成的毫秒」当目标，一帧一算，和中途来
   * 了什么数据、重铺了几次格子统统无关。
   *
   * 为什么不交给图自己拖：图内部量位置用的是「离最后一根真 K 线多少根」，而窗口
   * 里的真 K 线只是眼下这一段。数据一换那个基准就动，人手里的画面跟着跳；反过来
   * 我们在中途设一次可见范围，也会被它下一次 pointermove 按按下那一刻的账抹掉。
   * 两边抢方向盘的结果就是图自己跑起来。索性全屏态就不让它拖。
   */
  function onPanDown(event: PointerEvent): void {
    // 第二根手指下来就把这一次平移作废：那是要捏合缩放，缩放还是交给图自己做。
    if (panning !== null) { panning = null; return }
    if (!padded || measuring) return
    if (event.button !== 0 || event.altKey || event.shiftKey || event.ctrlKey || event.metaKey) return
    const view = visibleTime()
    if (!view || !(view.to > view.from)) return
    panning = {
      id: event.pointerId,
      x: event.clientX,
      from: view.from,
      to: view.to,
      touch: event.pointerType === 'touch',
      trail: [{ x: event.clientX, at: event.timeStamp }],
    }
    try { canvas.setPointerCapture(event.pointerId) } catch { /* 捕获不到就算了，move 照样来 */ }
  }

  function onPanMove(event: PointerEvent): void {
    const pan = panning
    if (!pan || event.pointerId !== pan.id) return
    const width = chart.timeScale().width()
    if (!(width > 0)) return
    if (pan.touch) {
      pan.trail.push({ x: event.clientX, at: event.timeStamp })
      // 只留最后 200ms：再早的位移和「松手那一下甩得多快」没关系。
      while (pan.trail.length > 2 && event.timeStamp - (pan.trail[0] as FlingSample).at > 200) {
        pan.trail.shift()
      }
    }
    const perPx = (pan.to - pan.from) / width
    const moved = (event.clientX - pan.x) * perPx
    applyTime(pan.from - moved, pan.to - moved)
  }

  function onPanUp(event: PointerEvent): void {
    const pan = panning
    if (!pan || event.pointerId !== pan.id) return
    panning = null
    // 惯性只给手指。鼠标松手就停，和图库原来的 kinetic 设置（mouse: false,
    // touch: true）一样；pointercancel 是被系统打断，也不该滑。
    if (!pan.touch || event.type !== 'pointerup') return
    pan.trail.push({ x: event.clientX, at: event.timeStamp })
    startFling(flingSpeed(pan.trail))
  }

  /** 掐掉正在滑的惯性。人一动手、跳视野、换档、拆组件，都走这儿。 */
  function stopFling(): void {
    if (!fling) return
    cancelAnimationFrame(fling.raf)
    fling = null
  }

  /**
   * 甩出去之后接着滑。速度按 e 指数往下掉（见 chart-span 的 flingSpan），每一帧
   * 都是「松手那一段 − 到这一刻一共滑过的像素」重算一次，和拖动同一套账：中途
   * 到了新数据、重铺了格子，都不会改这条轨迹，也不会打断它。
   * 撞上「上市前一屏」或者「现在」那道墙就地停住——夹取和拖动共用一道。
   */
  function startFling(speedPxPerMs: number): void {
    stopFling()
    if (!padded || measuring || speedPxPerMs === 0) return
    const view = visibleTime()
    if (!view || !(view.to > view.from)) return
    const width = chart.timeScale().width()
    if (!(width > 0)) return
    const start = { from: view.from, to: view.to }
    const msPerPx = (start.to - start.from) / width
    const began = performance.now()
    const tick = (): void => {
      if (!fling) return
      const step = flingSpan(
        start, msPerPx, speedPxPerMs, performance.now() - began, viewBounds(start.to - start.from),
      )
      applyTime(step.from, step.to)
      layout()
      if (step.done) { fling = null; planSettle(); return }
      fling.raf = requestAnimationFrame(tick)
    }
    fling = { raf: requestAnimationFrame(tick) }
  }

  function onGesturePointerDown(event: PointerEvent): void {
    if (!gestures) return
    const box = canvas.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    if (event.altKey) {
      const value = priceAtY(y)
      if (value === null) return
      event.preventDefault()
      event.stopPropagation()
      const change = pinToggle(pins, value, yAtPrice)
      if (change.did === 'full') { tell('最多钉 5 条'); return }
      applyPins(change.prices)
      return
    }
    if (!event.shiftKey) return
    const ms = msAtX(x)
    const value = priceAtY(y)
    if (ms === null || value === null) return
    event.preventDefault()
    event.stopPropagation()
    measuring = { x, y, ms, price: value }
    stopMeasureTimers()
    // 量尺期间别让图跟着手一起拖：两件事同时发生，量出来的那一段就不是人画的那一段。
    chart.applyOptions({ handleScroll: { pressedMouseMove: false, horzTouchDrag: false } })
    canvas.setPointerCapture(event.pointerId)
    drawMeasure(x, y)
  }

  function onGesturePointerMove(event: PointerEvent): void {
    if (!measuring) return
    const box = canvas.getBoundingClientRect()
    drawMeasure(event.clientX - box.left, event.clientY - box.top)
  }

  function onGesturePointerUp(): void {
    if (!measuring) return
    measuring = null
    chart.applyOptions({ handleScroll: { pressedMouseMove: !padded, horzTouchDrag: !padded } })
    // 松手之后留三秒：人要抄下那个数字，别一撒手就没了。整整两秒六保持不透明，最后
    // 320ms 才淡出（和 .tv-measure-fade 的 transition 对齐），第三秒结束时收起来。
    stopMeasureTimers()
    if (calm()) {
      measureHide = window.setTimeout(() => { measureBox.hidden = true }, 3000)
      return
    }
    measureFade = window.setTimeout(() => { measureBox.classList.add('tv-measure-fade') }, 2680)
    measureHide = window.setTimeout(() => { measureBox.hidden = true }, 3000)
  }

  canvas.addEventListener('pointerdown', onGesturePointerDown, { capture: true })
  canvas.addEventListener('pointermove', onGesturePointerMove)
  canvas.addEventListener('pointerup', onGesturePointerUp)
  canvas.addEventListener('pointercancel', onGesturePointerUp)
  canvas.addEventListener('pointerdown', onPanDown)
  window.addEventListener('pointermove', onPanMove)
  window.addEventListener('pointerup', onPanUp)
  window.addEventListener('pointercancel', onPanUp)

  // 手起手落只记一件事：这会儿人是不是正在拖图。松手要听 window 的——手指划出
  // 画布再松开，canvas 上那一发根本不来。
  canvas.addEventListener('pointerdown', onDragDown)
  window.addEventListener('pointerup', onDragUp)
  window.addEventListener('pointercancel', onDragUp)


  reset()

  return {
    node,
    setOutline,
    showOutline: (visible) => comparison.applyOptions({ visible }),
    setIndicators: (next) => { setup = next; rebuildPanes() },
    appendBars,
    setBars,
    visibleTime,
    reassert: () => {
      const back = padded ? aim.want() : null
      if (!back) return
      if (!needsReassert(back, chartRange(), lat ? lat.stepMs : barSpanMs(level))) return
      rebuildLattice(back)
      applyTime(back.from, back.to)
      layout()
    },
    setVisibleTime,
    paneWidth: () => chart.timeScale().width(),
    barSpacing: () => chart.timeScale().options().barSpacing,
    setScaleMode: (mode) => {
      priceMode = mode === 'normal' ? PriceScaleMode.Normal
        : mode === 'percent' ? PriceScaleMode.Percentage
          : PriceScaleMode.Logarithmic
      // 换了坐标就当这一份数据没按过 autoScale：不然轴还停在上一套算法的范围上。
      priceMark = ''
      applyScale()
    },
    legendParts: () => ({ symbol: legendSymbol, period: legendRest, line: legend }),
    setPadding: (on) => {
      if (padded === on) return
      // 进出全屏都要保住「现在看的是哪一段时间」：格子一铺，下标的含义就变了。
      const before = visibleTime()
      padded = on
      aim.drop()
      const changed = rebuildLattice(before)
      // 铺了格子才把左墙交给图自己守：`fixLeftEdge` 不许视野越过第一个点，而第
      // 一个点就是按「上市前一屏」算出来的那一格。人手拖、惯性滑、滚轮，全都得
      // 过它这一关——它在图内部每一次滚动里都算一遍，抹不掉、也不会跟人手打架。
      // 窗口态没有格子，开了会把人钉死在第一根 K 线上，所以只在全屏开。
      chart.applyOptions({ timeScale: { fixLeftEdge: on } })
      // 全屏态的平移归 onPanMove 管，别让图自己也拖一遍。
      chart.applyOptions({ handleScroll: { pressedMouseMove: !on, horzTouchDrag: !on } })
      stopFling()
      if (!on) panning = null
      if (changed && before) applyTime(before.from, before.to)
      layout()
    },
    onVisibleTime: (handler) => { timeWatchers.push(handler) },
    setInterval: (next, view) => {
      // 换档先按新档重铺格子，再把同一段时间放回去：视野的毫秒不变，变的是一根
      // 多宽。先设视野后换档的话，视野会落在按旧档算出来的下标上，越换越偏。
      stopFling()
      const before = padded ? (view ?? visibleTime()) : null
      level = next
      paintRest()
      // 日线以上不必显示到分钟。
      chart.applyOptions({ timeScale: { timeVisible: barSpanMs(next) < 86_400_000 } })
      if (!padded) return
      if (rebuildLattice(before) && before) applyTime(before.from, before.to)
      layout()
    },
    setAnchor: (next) => {
      anchorBand = next
      if (!next) { band.hidden = true; return }
      layout()
    },
    setEdge,
    onEdgeRetry: (handler) => { retryWatchers.push(handler) },
    setJudgment: (atMs) => { judgeAt = atMs; layoutJudge() },
    setFloor: (atMs) => {
      const next = atMs !== null && Number.isFinite(atMs) ? atMs : null
      if (next === floorMs) return
      floorMs = next
    },
    updateLast,
    setFollowLatest: (on) => chart.applyOptions({ timeScale: { shiftVisibleRangeOnNewBar: on } }),
    setMagnet: (on) => {
      magnetOn = on
      chart.applyOptions({ crosshair: { mode: on ? CrosshairMode.Magnet : CrosshairMode.Normal } })
    },
    magnet: () => magnetOn,
    setGestures: (on) => {
      gestures = on
      if (on) return
      measuring = null
      stopMeasureTimers()
      measureBox.hidden = true
      applyPins([])
    },
    onHint: (handler) => { hintWatchers.push(handler) },
    showCutoff: (on) => {
      if (on === cutShown) return
      cutShown = on
      if (on) candles.attachPrimitive(marker)
      else candles.detachPrimitive(marker)
    },
    setCutoff: (next) => {
      const when = Date.parse(next)
      if (!Number.isFinite(when)) return
      cutAt = when
      recompute()
      layout()
    },
    view,
    setView,
    reset,
    zoom: (factor) => {
      const range = chart.timeScale().getVisibleLogicalRange()
      if (!range) return
      touched = true
      const center = (range.from + range.to) / 2
      const half = Math.max(4, ((range.to - range.from) * factor) / 2)
      chart.timeScale().setVisibleLogicalRange({ from: center - half, to: center + half })
    },
    pan: (fraction) => {
      const range = chart.timeScale().getVisibleLogicalRange()
      if (!range) return
      touched = true
      stopFling()
      const shift = (range.to - range.from) * fraction
      chart.timeScale().setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift })
    },
    onRange: (handler) => chart.timeScale().subscribeVisibleLogicalRangeChange(handler),
    destroy: () => {
      if (gliding) cancelAnimationFrame(gliding)
      stopFling()
      stopMeasureTimers()
      watcher.disconnect()
      canvas.removeEventListener('wheel', mark)
      canvas.removeEventListener('pointerdown', mark)
      canvas.removeEventListener('touchstart', mark)
      canvas.removeEventListener('pointerdown', onGesturePointerDown, { capture: true })
      canvas.removeEventListener('pointermove', onGesturePointerMove)
      canvas.removeEventListener('pointerup', onGesturePointerUp)
      canvas.removeEventListener('pointercancel', onGesturePointerUp)
      canvas.removeEventListener('pointerdown', onPanDown)
      window.removeEventListener('pointermove', onPanMove)
      window.removeEventListener('pointerup', onPanUp)
      window.removeEventListener('pointercancel', onPanUp)
      canvas.removeEventListener('pointerdown', onDragDown)
      window.removeEventListener('pointerup', onDragUp)
      window.removeEventListener('pointercancel', onDragUp)
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0 }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0 }
      held = null
      chart.remove()
    },
  }
}

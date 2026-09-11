// 舞台：真实 K 线。纯 SVG，没有第三方库。
//
// 一个念头贯穿整个文件：**画上去的东西不重画**。
// 每根 K 线在数据坐标里画一次（x 用第几根，y 用价格），整幅图的比例只落在
// 一个 <g> 的 transform 上。往后长一根就往后追加一根的 DOM；价格区间变了、
// 窗口宽度变了，改的都只是那一个 transform，两千根 K 线也不用重排一遍。
//
// 副图（成交量、MACD、RSI、ATR）走同一套：每个副图一个自己的缩放组，x 的比例
// 和主图一模一样、共用一条十字线，y 各算各的。所以横轴永远对得齐。
//
// 线宽和虚线都用 non-scaling-stroke，不然纵向压缩会把它们一起压扁。
// 文字不进那个被压缩的坐标系——价格标签、时间刻度、标注气泡、副图名都是叠在
// 上面的 HTML，比例一变只挪位置。

import type { Bar } from '../../api/types'
import type { ChartSetup } from '../../api/replay'
import { dateTime } from '../../data/time'
import { h } from '../../ui/dom'
import { prefersReducedMotion } from '../../ui/motion'
import {
  atr as atrLine,
  boll,
  ema,
  macd as macdLines,
  rsi as rsiLine,
  sma,
  type Line,
} from './indicators'

export interface LevelLine {
  id: string
  price: number
  label: string
  /** 决定颜色：目标、失效、边界、触发、起始价。 */
  kind: 'target' | 'invalidation' | 'boundary' | 'trigger' | 'base'
}

export interface StageMark {
  id: string
  /** 落在第几根上。 */
  index: number
  /** 有价格就钉在那个价位上，没有就钉在这一根的顶上。 */
  price?: number | null
  label: string
  sub?: string | null
  kind:
    | 'judgment'
    | 'trigger'
    | 'invalidation'
    | 'threshold'
    | 'end'
    | 'mfe'
    | 'mae'
    | 'review'
    | 'trade'
    | 'shot'
    | 'other'
  /** 播到这里停一下，毫秒。 */
  hold?: number
  /** 挂在时间轴那一条上，不挂在价位上。 */
  rail?: boolean
  onClick?: () => void
}

/** 时间轴上的一段：观察期、后来那张截图覆盖的范围。 */
export interface StageBand {
  id: string
  from: number
  to: number
  label: string
  kind: 'horizon' | 'shot' | 'threshold'
  onClick?: () => void
}

export interface CandlesOptions {
  bars: Bar[]
  interval: string
  levels?: LevelLine[]
  marks?: StageMark[]
  bands?: StageBand[]
  judgmentAt?: string | null
  setup?: ChartSetup | null
  /** 播放中经过一个标注。 */
  onMark?: (mark: StageMark) => void
  /** 播到窗口末尾。 */
  onEnd?: () => void
  /** 每次显示的根数变化。 */
  onFrame?: (shown: number) => void
  /** 一屏最多铺多少根；超过就跟着播放头往前推。 */
  window?: number
  /** 允许滚轮缩放、拖动平移。默认允许。 */
  interactive?: boolean
}

export interface CandleStage {
  node: HTMLElement
  /** 显示到第 index 根（含）。往回收也走这条路。 */
  showUpTo: (index: number) => void
  play: (speed?: number) => void
  pause: () => void
  playing: () => boolean
  shown: () => number
  setSetup: (setup: ChartSetup | null) => void
  setMarks: (marks: StageMark[], bands?: StageBand[]) => void
  zoom: (range: { from: number; to: number } | null) => void
  /** 把某一根摆到屏幕中间，顺带把缩放定住。span 是这一屏铺多少根。 */
  focus: (index: number, span?: number) => void
  /** 放开手动缩放，回到跟着播放头走。 */
  resetView: () => void
  /** 时间落在第几根上；早于第一根返回 0，晚于最后一根返回最后一根。 */
  indexAt: (iso: string | null | undefined) => number
  destroy: () => void
}

interface Num {
  start: number
  end: number
  open: number
  high: number
  low: number
  close: number
  /** 缺就是 null——这一段没有成交量，不拿 0 顶替。 */
  volume: number | null
  iso: string
}

const NS = 'http://www.w3.org/2000/svg'
let seq = 0

/** 一秒往前走几根：越小的周期走得越快，不然一屏要看半分钟。 */
export function barsPerSecond(interval: string): number {
  if (interval === '1m') return 20
  if (interval === '3m' || interval === '5m' || interval === '15m' || interval === '30m') return 10
  if (interval === '1h' || interval === '2h') return 6
  if (interval === '3d' || interval === '1w' || interval === '1M') return 2
  return 3
}

function svg(tag: string, attrs: Record<string, string | number> = {}): SVGElement {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

function toNumber(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 成交量缺失和成交量为零是两回事，所以认不出来的一律 null。 */
function toVolume(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 价格的小数位按这一段的量级来：BTC 给两位，几毛钱的币给五位。 */
export function priceDigits(span: number, sample: number): number {
  const scale = Math.abs(sample) || Math.abs(span) || 1
  if (scale >= 1000) return 2
  if (scale >= 100) return 2
  if (scale >= 10) return 3
  if (scale >= 1) return 4
  if (scale >= 0.01) return 5
  return 7
}

export function formatPrice(value: number, digits: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** 成交量按量级缩写：读数条上塞不下八位数。 */
export function formatVolume(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

/** 5 个左右的整齐刻度。 */
function ticks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) out.push(v)
  return out
}

export function createCandles(options: CandlesOptions): CandleStage {
  const id = `rlvclip${(seq += 1)}`
  const bars: Num[] = options.bars.map((bar: Bar) => ({
    start: new Date(bar.start).getTime(),
    end: new Date(bar.end).getTime(),
    open: toNumber(bar.open),
    high: toNumber(bar.high),
    low: toNumber(bar.low),
    close: toNumber(bar.close),
    volume: toVolume(bar.volume),
    iso: bar.start,
  }))
  const closes = bars.map((b) => b.close)
  const hasVolume = bars.some((b) => b.volume !== null)
  let levels = options.levels ?? []
  let marks = options.marks ?? []
  let bands = options.bands ?? []
  let setup: ChartSetup | null = options.setup ?? null
  const interactive = options.interactive !== false

  const padR = 58
  const padB = 20
  const padT = 10
  const PANE_GAP = 9

  let width = 720
  let height = 380
  let shown = bars.length ? Math.min(1, bars.length) : 0
  let fixedView: { from: number; to: number } | null = null
  let mainH = 300

  /* ---------------------------------------------------------------- DOM */

  const plate = svg('svg', { class: 'rlv-svg', preserveAspectRatio: 'none' }) as SVGSVGElement
  const defs = svg('defs')
  const clip = svg('clipPath', { id })
  const clipRect = svg('rect', { x: 0, y: 0, width: 10, height: 10 })
  clip.appendChild(clipRect)
  defs.appendChild(clip)
  const grid = svg('g', { class: 'rlv-grid' })
  // 裁剪要挂在没有缩放的外层：挂在 scaled 上的话，裁剪框会跟着一起被放大，
  // 整幅图就全被裁掉了。
  const clipBox = svg('g', { class: 'rlv-clip', 'clip-path': `url(#${id})` })
  const scaled = svg('g', { class: 'rlv-plot' })
  const paneBox = svg('g', { class: 'rlv-panes' })
  clipBox.append(scaled, paneBox)
  const indLayer = svg('g', { class: 'rlv-ind' })
  const candleLayer = svg('g', { class: 'rlv-cds' })
  const levelLayer = svg('g', { class: 'rlv-lv' })
  scaled.append(indLayer, candleLayer, levelLayer)
  const pixel = svg('g', { class: 'rlv-px' })
  const judgeRule = svg('line', { class: 'rlv-judge', opacity: 0, 'vector-effect': 'non-scaling-stroke' }) as SVGLineElement
  pixel.appendChild(judgeRule)
  const cross = svg('g', { class: 'rlv-cross', opacity: 0 })
  const crossX = svg('line', { class: 'cx', y1: 0, y2: 10 })
  const crossY = svg('line', { class: 'cy', x1: 0, x2: 10 })
  cross.append(crossX, crossY)
  plate.append(defs, grid, clipBox, pixel, cross)

  const yAxis = h('div.rlv-y')
  const xAxis = h('div.rlv-x')
  const pins = h('div.rlv-pins')
  const tags = h('div.rlv-ptags')
  const readout = h('div.rlv-read', { hidden: true })
  const node = h(
    'div.rlv-stage',
    {},
    plate as unknown as HTMLElement,
    yAxis,
    xAxis,
    pins,
    tags,
    readout,
  )
  if (interactive) node.classList.add('grabbable')

  /* ------------------------------------------------------------ 指标线 */

  interface Series {
    node: SVGPolylineElement
    values: Line
    /** 读数条上显示的名字，比如 MA30。 */
    name: string
  }

  /**
   * 一个副图。自己一套 y 比例，x 跟主图共用，所以横轴永远对得齐。
   * `cells` 是每根一个的柱子（量、MACD 柱），跟着 shown 一根根追加、往回收。
   */
  interface Pane {
    kind: 'vol' | 'macd' | 'rsi' | 'atr'
    title: string
    layer: SVGGElement
    cellLayer: SVGGElement
    cells: (SVGElement | undefined)[]
    lines: Series[]
    cell: ((i: number) => SVGElement | null) | null
    /** 这一屏的取值范围；给不出就退回 [0,1]。 */
    span: (from: number, to: number) => [number, number]
    read: (i: number) => [string, string][]
    label: HTMLElement
    top: number
    height: number
  }

  let series: Series[] = []
  let panes: Pane[] = []

  function clearPanes(): void {
    for (const pane of panes) {
      pane.layer.remove()
      pane.label.remove()
    }
    panes = []
  }

  function addPane(spec: {
    kind: Pane['kind']
    title: string
    cls: string
    guides?: number[]
    cell?: (i: number) => SVGElement | null
    span: (from: number, to: number) => [number, number]
    read: (i: number) => [string, string][]
    lines: { values: Line; name: string; cls: string }[]
    note?: string | null
  }): Pane {
    const layer = svg('g', { class: `rlv-pane ${spec.cls}` }) as SVGGElement
    const guideLayer = svg('g', { class: 'gd' })
    for (const g of spec.guides ?? []) {
      guideLayer.appendChild(
        svg('line', {
          class: 'gl',
          x1: 0,
          x2: Math.max(1, bars.length),
          y1: g,
          y2: g,
          'vector-effect': 'non-scaling-stroke',
        }),
      )
    }
    const cellLayer = svg('g', { class: 'cl' }) as SVGGElement
    const lineLayer = svg('g', { class: 'ln' })
    layer.append(guideLayer, cellLayer, lineLayer)
    paneBox.appendChild(layer)
    const lines: Series[] = spec.lines.map((line) => {
      const el = svg('polyline', {
        class: `rlv-line ${line.cls}`,
        'vector-effect': 'non-scaling-stroke',
      }) as SVGPolylineElement
      lineLayer.appendChild(el)
      return { node: el, values: line.values, name: line.name }
    })
    const label = h(
      'span.rlv-plab',
      {},
      h('b', { text: spec.title }),
      spec.note ? h('i', { text: spec.note }) : null,
    )
    tags.appendChild(label)
    const pane: Pane = {
      kind: spec.kind,
      title: spec.title,
      layer,
      cellLayer,
      cells: [],
      lines,
      cell: spec.cell ?? null,
      span: spec.span,
      read: spec.read,
      label,
      top: 0,
      height: 40,
    }
    panes.push(pane)
    return pane
  }

  function buildSeries(): void {
    for (const s of series) s.node.remove()
    series = []
    clearPanes()
    if (!setup) {
      redrawSeries()
      layout()
      return
    }
    const add = (values: Line, cls: string, name: string) => {
      const line = svg('polyline', { class: `rlv-line ${cls}`, 'vector-effect': 'non-scaling-stroke' }) as SVGPolylineElement
      indLayer.appendChild(line)
      series.push({ node: line, values, name })
    }
    setup.ma.slice(0, 8).forEach((n, i) => add(sma(closes, n), `ma m${i % 3}`, `MA${n}`))
    setup.ema.slice(0, 8).forEach((n, i) => add(ema(closes, n), `ema m${i % 3}`, `EMA${n}`))
    if (setup.boll) {
      const k = Number(setup.boll.k)
      const width = Number.isFinite(k) ? k : 2
      const b = boll(closes, setup.boll.n, width)
      add(b.upper, 'bb', `BOLL上`)
      add(b.mid, 'bb mid', `BOLL中`)
      add(b.lower, 'bb', `BOLL下`)
    }

    if (setup.volume) {
      const mas = setup.volume.ma.slice(0, 6)
      // 量的 MA 复用 sma：缺量的位置按 0 参与平均会把线拉下去，所以缺量整段就
      // 不画副图，只留一句话。
      const vols = bars.map((b) => b.volume ?? 0)
      addPane({
        kind: 'vol',
        title: mas.length ? `VOL  MA${mas.join('/')}` : 'VOL',
        cls: 'rlv-pvol',
        note: hasVolume ? null : '这一段没有成交量',
        lines: hasVolume
          ? mas.map((n, i) => ({ values: sma(vols, n), name: `MAVOL${n}`, cls: `mavol m${i % 3}` }))
          : [],
        cell: hasVolume
          ? (i) => {
              const bar = bars[i]
              if (!bar || bar.volume === null) return null
              return svg('rect', {
                class: `v ${bar.close >= bar.open ? 'up' : 'down'}`,
                x: i + 0.16,
                width: 0.68,
                y: 0,
                height: Math.max(bar.volume, 0),
              })
            }
          : undefined,
        span: (from, to) => {
          let hi = 0
          for (let i = from; i <= to && i < shown; i += 1) {
            const v = bars[i]?.volume
            if (v !== null && v !== undefined && v > hi) hi = v
          }
          return [0, hi > 0 ? hi * 1.12 : 1]
        },
        read: (i) => {
          const v = bars[i]?.volume
          const rows: [string, string][] = [
            ['量', v === null || v === undefined ? '—' : formatVolume(v)],
          ]
          return rows
        },
      })
    }

    if (setup.macd) {
      const { fast, slow, signal } = setup.macd
      const m = macdLines(closes, fast, slow, signal)
      addPane({
        kind: 'macd',
        title: `MACD(${fast},${slow},${signal})`,
        cls: 'rlv-pmacd',
        guides: [0],
        lines: [
          { values: m.dif, name: 'DIF', cls: 'dif' },
          { values: m.dea, name: 'DEA', cls: 'dea' },
        ],
        cell: (i) => {
          const v = m.hist[i]
          if (v === null || v === undefined) return null
          return svg('rect', {
            class: `hs ${v >= 0 ? 'up' : 'down'}`,
            x: i + 0.2,
            width: 0.6,
            y: Math.min(0, v),
            height: Math.abs(v) || 1e-9,
          })
        },
        span: (from, to) => {
          let lo = 0
          let hi = 0
          for (let i = from; i <= to && i < shown; i += 1) {
            for (const v of [m.dif[i], m.dea[i], m.hist[i]]) {
              if (v === null || v === undefined) continue
              if (v < lo) lo = v
              if (v > hi) hi = v
            }
          }
          if (hi - lo < 1e-12) return [-1, 1]
          const pad = (hi - lo) * 0.1
          return [lo - pad, hi + pad]
        },
        read: (i) => {
          const cell = (v: number | null | undefined) =>
            v === null || v === undefined ? '—' : formatPrice(v, Math.min(6, digits + 1))
          return [
            ['DIF', cell(m.dif[i])],
            ['DEA', cell(m.dea[i])],
            ['柱', cell(m.hist[i])],
          ]
        },
      })
    }

    if (setup.rsi) {
      const n = setup.rsi.n
      const values = rsiLine(closes, n)
      addPane({
        kind: 'rsi',
        title: `RSI(${n})`,
        cls: 'rlv-prsi',
        guides: [30, 50, 70],
        lines: [{ values, name: `RSI${n}`, cls: 'rsi' }],
        span: () => [0, 100],
        read: (i) => {
          const v = values[i]
          return [[`RSI${n}`, v === null || v === undefined ? '—' : v.toFixed(1)]]
        },
      })
    }

    if (setup.atr) {
      const n = setup.atr.n
      const values = atrLine(bars, n)
      addPane({
        kind: 'atr',
        title: `ATR(${n})`,
        cls: 'rlv-patr',
        lines: [{ values, name: `ATR${n}`, cls: 'atr' }],
        span: (from, to) => {
          let lo = Number.POSITIVE_INFINITY
          let hi = Number.NEGATIVE_INFINITY
          for (let i = from; i <= to && i < shown; i += 1) {
            const v = values[i]
            if (v === null || v === undefined) continue
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1]
          if (hi - lo < 1e-12) return [Math.max(0, lo - 1e-6), hi + 1e-6]
          const pad = (hi - lo) * 0.12
          return [lo - pad, hi + pad]
        },
        read: (i) => {
          const v = values[i]
          return [[`ATR${n}`, v === null || v === undefined ? '—' : formatPrice(v, digits)]]
        },
      })
    }

    redrawSeries()
    syncCells()
    layout()
  }

  function redrawSeries(): void {
    const all = [...series, ...panes.flatMap((p) => p.lines)]
    for (const s of all) {
      const points: string[] = []
      for (let i = 0; i < shown; i += 1) {
        const v = s.values[i]
        if (v === null || v === undefined) continue
        points.push(`${i + 0.5},${v}`)
      }
      s.node.setAttribute('points', points.join(' '))
    }
  }

  /** 副图的柱子跟着 shown 走：只补新的那几根，回收时把多的删掉。 */
  function syncCells(): void {
    for (const pane of panes) {
      if (!pane.cell) continue
      for (let i = pane.cells.length; i < shown; i += 1) {
        const el = pane.cell(i)
        pane.cells[i] = el ?? undefined
        if (el) pane.cellLayer.appendChild(el)
      }
      for (let i = shown; i < pane.cells.length; i += 1) {
        pane.cells[i]?.remove()
        pane.cells[i] = undefined
      }
      if (pane.cells.length > shown) pane.cells.length = shown
    }
  }

  /* -------------------------------------------------------------- K 线 */

  const drawn: SVGGElement[] = []

  function drawCandle(i: number, fresh: boolean): void {
    const bar = bars[i] as Num
    const up = bar.close >= bar.open
    const group = svg('g', {
      class: `rlv-c ${up ? 'up' : 'down'}${fresh ? ' fresh' : ''}`,
    }) as SVGGElement
    group.appendChild(
      svg('line', {
        class: 'w',
        x1: i + 0.5,
        x2: i + 0.5,
        y1: bar.low,
        y2: bar.high,
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    group.appendChild(
      svg('rect', {
        class: 'b',
        x: i + 0.16,
        width: 0.68,
        y: Math.min(bar.open, bar.close),
        height: Math.abs(bar.close - bar.open),
        'vector-effect': 'non-scaling-stroke',
      }),
    )
    candleLayer.appendChild(group)
    drawn[i] = group
  }

  /* ------------------------------------------------------------ 水平线 */

  const levelNodes = new Map<string, { line: SVGLineElement; tag: HTMLElement }>()

  function buildLevels(): void {
    for (const { line, tag } of levelNodes.values()) {
      line.remove()
      tag.remove()
    }
    levelNodes.clear()
    levels.forEach((level, i) => {
      const line = svg('line', {
        class: `rlv-level k-${level.kind}`,
        x1: 0,
        x2: Math.max(1, bars.length),
        y1: level.price,
        y2: level.price,
        'vector-effect': 'non-scaling-stroke',
        style: `--i:${i}`,
      }) as SVGLineElement
      levelLayer.appendChild(line)
      const tag = h('span', { class: ['rlv-ltag', `k-${level.kind}`], style: `--i:${i}` }, h('b', { text: level.label }))
      pins.appendChild(tag)
      levelNodes.set(level.id, { line, tag })
    })
  }

  /* -------------------------------------------------------------- 标注 */

  const markNodes = new Map<string, HTMLElement>()
  const bandNodes = new Map<string, HTMLElement>()

  function buildBands(): void {
    for (const el of bandNodes.values()) el.remove()
    bandNodes.clear()
    bands.forEach((band, i) => {
      const el = h(
        band.onClick ? 'button' : 'span',
        {
          class: ['rlv-band', `k-${band.kind}`],
          style: `--i:${i}`,
          ...(band.onClick ? { on: { click: band.onClick } } : {}),
        },
        h('span.bl', { text: band.label }),
      )
      pins.appendChild(el)
      bandNodes.set(band.id, el)
    })
  }

  function placeBands(): void {
    for (const band of bands) {
      const el = bandNodes.get(band.id)
      if (!el) continue
      const from = xOf(band.from) - scaleX / 2
      const to = xOf(band.to) + scaleX / 2
      const left = Math.max(0, Math.round(from))
      const right = Math.min(plotWidth(), Math.round(to))
      const visible = right > 2 && left < plotWidth() - 2
      el.hidden = !visible
      el.style.left = `${left}px`
      el.style.width = `${Math.max(2, right - left)}px`
    }
  }

  function buildMarks(): void {
    for (const el of markNodes.values()) el.remove()
    markNodes.clear()
    for (const mark of marks) {
      const dot = h('i.d')
      const body = h(
        'span.t',
        {},
        h('b', { text: mark.label }),
        mark.sub ? h('span.s', { text: mark.sub }) : null,
      )
      const pin = h(
        mark.onClick ? 'button' : 'span',
        {
          class: ['rlv-pin', `k-${mark.kind}`],
          ...(mark.onClick ? { on: { click: mark.onClick } } : {}),
        },
        dot,
        body,
      )
      pins.appendChild(pin)
      markNodes.set(mark.id, pin)
    }
  }

  /* ------------------------------------------------------------ 布局 */

  let view = { from: 0, to: 0 }
  let scaleX = 1
  let scaleY = 1
  let yMin = 0
  let yMax = 1
  let digits = 2

  function currentView(): { from: number; to: number } {
    if (fixedView) {
      return {
        from: Math.max(0, Math.min(fixedView.from, bars.length - 1)),
        to: Math.max(0, Math.min(fixedView.to, bars.length - 1)),
      }
    }
    const last = Math.max(0, shown - 1)
    const cap = options.window ?? 320
    const from = Math.max(0, last - cap + 1)
    return { from, to: last }
  }

  function plotWidth(): number {
    return Math.max(60, width - padR)
  }

  function plotHeight(): number {
    return mainH
  }

  /** 主图和副图怎么分这块高度：副图各占一条窄的，主图至少还留 42%。 */
  function measurePanes(): void {
    const usable = Math.max(80, height - padB - padT)
    if (!panes.length) {
      mainH = usable
      return
    }
    let paneH = Math.min(80, Math.max(34, usable * 0.19))
    const minMain = usable * 0.42
    if (usable - panes.length * (paneH + PANE_GAP) < minMain) {
      paneH = Math.max(22, (usable - minMain) / panes.length - PANE_GAP)
    }
    mainH = Math.max(60, usable - panes.length * (paneH + PANE_GAP))
    let top = padT + mainH + PANE_GAP
    for (const pane of panes) {
      pane.top = top
      pane.height = paneH
      top += paneH + PANE_GAP
    }
  }

  function layout(): void {
    if (!bars.length) return
    measurePanes()
    view = currentView()
    const span = Math.max(1, view.to - view.from + 1)
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (let i = view.from; i <= view.to && i < shown; i += 1) {
      const bar = bars[i] as Num
      if (bar.low < low) low = bar.low
      if (bar.high > high) high = bar.high
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      const bar = bars[Math.min(view.from, bars.length - 1)] as Num
      low = bar.low
      high = bar.high
    }
    for (const level of levels) {
      if (level.price < low) low = level.price
      if (level.price > high) high = level.price
    }
    if (high - low < 1e-9) {
      const pad = Math.max(Math.abs(high) * 0.005, 1e-6)
      low -= pad
      high += pad
    }
    const margin = (high - low) * 0.07
    yMin = low - margin
    yMax = high + margin
    digits = priceDigits(yMax - yMin, (yMax + yMin) / 2)

    const pw = plotWidth()
    const ph = plotHeight()
    scaleX = pw / span
    scaleY = ph / (yMax - yMin)

    plate.setAttribute('viewBox', `0 0 ${width} ${height}`)
    plate.setAttribute('width', String(width))
    plate.setAttribute('height', String(height))
    clipRect.setAttribute('width', String(pw))
    clipRect.setAttribute('height', String(height))
    const tx = -view.from * scaleX
    const ty = padT + yMax * scaleY
    scaled.setAttribute('style', `transform:translate(${tx}px,${ty}px) scale(${scaleX},${-scaleY})`)

    paintGrid()
    paintPanes()
    placeLevels()
    placeMarks()
    placeBands()
    placeJudge()
    paintXAxis()
  }

  function xOf(index: number): number {
    return (index + 0.5 - view.from) * scaleX
  }

  function yOf(price: number): number {
    return padT + (yMax - price) * scaleY
  }

  function paintGrid(): void {
    while (grid.firstChild) grid.removeChild(grid.firstChild)
    while (yAxis.firstChild) yAxis.removeChild(yAxis.firstChild)
    const pw = plotWidth()
    for (const value of ticks(yMin, yMax, 5)) {
      const y = yOf(value)
      if (y < padT - 2 || y > padT + mainH + 2) continue
      grid.appendChild(svg('line', { class: 'g', x1: 0, x2: pw, y1: y, y2: y }))
      yAxis.appendChild(
        h('span.rlv-yt', { style: `top:${y}px`, text: formatPrice(value, digits) }),
      )
    }
  }

  /** 每个副图自己一套 y：x 的比例和主图共用，所以横轴永远对得齐。 */
  function paintPanes(): void {
    const tx = -view.from * scaleX
    for (const pane of panes) {
      const [lo, hi] = pane.span(view.from, view.to)
      const range = hi - lo > 1e-12 ? hi - lo : 1
      const s = pane.height / range
      const bottom = pane.top + pane.height
      pane.layer.setAttribute(
        'style',
        `transform:translate(${tx}px,${bottom + lo * s}px) scale(${scaleX},${-s})`,
      )
      pane.label.style.top = `${Math.round(pane.top)}px`
      pane.label.style.left = '4px'
    }
  }

  function placeLevels(): void {
    for (const level of levels) {
      const found = levelNodes.get(level.id)
      if (!found) continue
      const y = yOf(level.price)
      const inside = y > padT - 6 && y < padT + mainH + 6
      found.tag.hidden = !inside
      found.tag.style.top = `${Math.round(y)}px`
      // 贴着价格轴左边挂，往图里排：挂在轴上会被右边的价格标签挤掉一截。
      found.tag.style.right = `${Math.round(width - plotWidth()) + 6}px`
    }
  }

  function placeMarks(): void {
    for (const mark of marks) {
      const pin = markNodes.get(mark.id)
      if (!pin) continue
      const visible = mark.index < shown && mark.index >= view.from - 1 && mark.index <= view.to + 1
      pin.classList.toggle('on', visible)
      const bar = bars[Math.min(mark.index, bars.length - 1)]
      const price = mark.price ?? (bar ? (mark.kind === 'mae' ? bar.low : bar.high) : yMax)
      const x = xOf(mark.index)
      const y = mark.rail ? height - padB - 4 : yOf(price)
      pin.classList.toggle('rail', Boolean(mark.rail))
      pin.style.left = `${Math.round(x)}px`
      pin.style.top = `${Math.round(Math.max(padT, Math.min(height - padB, y)))}px`
      pin.classList.toggle('flip', x > plotWidth() * 0.62)
      pin.classList.toggle('low', y < 74)
    }
  }

  function placeJudge(): void {
    if (judgeIndex === null) {
      judgeRule.setAttribute('opacity', '0')
      return
    }
    const x = xOf(judgeIndex)
    if (x < 0 || x > plotWidth()) {
      judgeRule.setAttribute('opacity', '0')
      return
    }
    judgeRule.setAttribute('x1', String(x))
    judgeRule.setAttribute('x2', String(x))
    judgeRule.setAttribute('y1', String(padT))
    judgeRule.setAttribute('y2', String(height - padB))
    judgeRule.setAttribute('opacity', '1')
  }

  function paintXAxis(): void {
    while (xAxis.firstChild) xAxis.removeChild(xAxis.firstChild)
    const span = view.to - view.from + 1
    const count = Math.max(2, Math.min(5, Math.floor(plotWidth() / 130)))
    const step = Math.max(1, Math.floor(span / count))
    for (let i = view.from; i <= view.to; i += step) {
      if (i >= shown) break
      const bar = bars[i]
      if (!bar) continue
      const x = xOf(i)
      if (x < 26 || x > plotWidth() - 20) continue
      xAxis.appendChild(h('span.rlv-xt', { style: `left:${Math.round(x)}px`, text: dateTime(bar.iso) }))
    }
  }

  /* ------------------------------------------------------------ 显示到 */

  function showUpTo(index: number): void {
    const next = Math.max(0, Math.min(index + 1, bars.length))
    if (next === shown) {
      layout()
      return
    }
    if (next > shown) {
      const fresh = next - shown <= 3
      for (let i = shown; i < next; i += 1) drawCandle(i, fresh && !prefersReducedMotion())
    } else {
      for (let i = next; i < shown; i += 1) {
        drawn[i]?.remove()
        delete drawn[i]
      }
    }
    shown = next
    redrawSeries()
    syncCells()
    layout()
    options.onFrame?.(shown)
  }

  /* ------------------------------------------------------------ 播放 */

  let raf = 0
  let running = false
  let last = 0
  let carry = 0
  let holdUntil = 0
  let rate = 1
  const fired = new Set<string>()

  function step(now: number): void {
    if (!running) return
    if (!last) last = now
    const dt = (now - last) / 1000
    last = now
    if (now < holdUntil) {
      raf = requestAnimationFrame(step)
      return
    }
    carry += dt * barsPerSecond(options.interval) * rate
    let advance = Math.floor(carry)
    if (advance > 0) {
      carry -= advance
      advance = Math.min(advance, bars.length - shown)
      for (let n = 0; n < advance; n += 1) {
        showUpTo(shown)
        const at = shown - 1
        for (const mark of marks) {
          if (mark.index !== at || fired.has(mark.id)) continue
          fired.add(mark.id)
          options.onMark?.(mark)
          if (mark.hold && !prefersReducedMotion()) holdUntil = performance.now() + mark.hold
        }
        if (holdUntil > performance.now()) break
      }
    }
    if (shown >= bars.length) {
      pause()
      options.onEnd?.()
      return
    }
    // 回调里可能按了暂停（撞到失效价那一根就停），停了就不再排下一帧。
    if (!running) return
    raf = requestAnimationFrame(step)
  }

  function play(speed = 1): void {
    rate = speed
    if (prefersReducedMotion()) {
      showUpTo(bars.length - 1)
      for (const mark of marks) {
        if (fired.has(mark.id)) continue
        fired.add(mark.id)
        options.onMark?.(mark)
      }
      options.onEnd?.()
      return
    }
    if (running) return
    if (shown >= bars.length) return
    last = 0
    carry = 0
    holdUntil = 0
    running = true
    raf = requestAnimationFrame(step)
    node.classList.add('playing')
  }

  function pause(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    running = false
    last = 0
    node.classList.remove('playing')
  }

  /* ------------------------------------------------------------ 十字线 */

  function indexFromX(px: number): number {
    const i = Math.floor(px / scaleX) + view.from
    return Math.max(view.from, Math.min(i, Math.min(view.to, shown - 1)))
  }

  function cell(label: string, value: string): HTMLElement {
    return h('span.o', {}, h('i', { text: label }), h('b', { text: value }))
  }

  function showCross(clientX: number, clientY: number): void {
    if (!shown) return
    const box = plate.getBoundingClientRect()
    const px = clientX - box.left
    const py = clientY - box.top
    if (px < 0 || px > plotWidth()) {
      hideCross()
      return
    }
    const i = indexFromX(px)
    const bar = bars[i]
    if (!bar) return
    const x = xOf(i)
    crossX.setAttribute('x1', String(x))
    crossX.setAttribute('x2', String(x))
    crossX.setAttribute('y1', String(padT))
    crossX.setAttribute('y2', String(height - padB))
    crossY.setAttribute('x1', '0')
    crossY.setAttribute('x2', String(plotWidth()))
    crossY.setAttribute('y1', String(py))
    crossY.setAttribute('y2', String(py))
    cross.setAttribute('opacity', '1')
    readout.hidden = false
    const rows: HTMLElement[] = [
      h('span.t', { text: dateTime(bar.iso) }),
      cell('开', formatPrice(bar.open, digits)),
      cell('高', formatPrice(bar.high, digits)),
      cell('低', formatPrice(bar.low, digits)),
      cell('收', formatPrice(bar.close, digits)),
    ]
    // 主图上开着的每一条线，都把光标那一根的值报出来——看图的人不用去数颜色。
    for (const s of series) {
      const v = s.values[i]
      rows.push(cell(s.name, v === null || v === undefined ? '—' : formatPrice(v, digits)))
    }
    for (const pane of panes) {
      for (const [label, text] of pane.read(i)) rows.push(cell(label, text))
      for (const line of pane.lines) {
        const v = line.values[i]
        if (pane.kind === 'vol') {
          rows.push(cell(line.name, v === null || v === undefined ? '—' : formatVolume(v)))
        }
      }
    }
    readout.replaceChildren(...rows)
    readout.classList.toggle('right', x > plotWidth() * 0.5)
  }

  function hideCross(): void {
    cross.setAttribute('opacity', '0')
    readout.hidden = true
  }

  /* -------------------------------------------------- 缩放 / 平移 */

  function setView(from: number, span: number): void {
    const size = Math.max(8, Math.min(bars.length, Math.round(span)))
    const start = Math.max(0, Math.min(Math.max(0, bars.length - size), Math.round(from)))
    fixedView = { from: start, to: start + size - 1 }
    layout()
  }

  const onWheel = (e: WheelEvent) => {
    if (!interactive || !bars.length) return
    e.preventDefault()
    const box = plate.getBoundingClientRect()
    const px = e.clientX - box.left
    const v = currentView()
    const span = v.to - v.from + 1
    const anchor = Math.max(
      v.from,
      Math.min(v.to, v.from + Math.floor(px / Math.max(1e-6, scaleX))),
    )
    const next = Math.round(span * (e.deltaY > 0 ? 1.2 : 1 / 1.2))
    const size = Math.max(8, Math.min(bars.length, next))
    if (size === span) return
    // 光标底下那一根不动，围着它缩放。
    const ratio = span > 1 ? (anchor - v.from) / (span - 1) : 0.5
    setView(anchor - ratio * (size - 1), size)
  }

  let drag: { x: number; from: number; span: number; moved: boolean } | null = null

  function panFrom(e: PointerEvent): void {
    if (!drag) return
    const dx = e.clientX - drag.x
    if (Math.abs(dx) > 2) drag.moved = true
    const shift = -dx / Math.max(1e-6, scaleX)
    setView(drag.from + shift, drag.span)
  }

  const onMove = (e: PointerEvent) => {
    if (drag && (e.buttons & 1) === 1) {
      panFrom(e)
      node.classList.add('grabbing')
    }
    showCross(e.clientX, e.clientY)
  }
  const onLeave = () => {
    drag = null
    node.classList.remove('grabbing')
    hideCross()
  }
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') showCross(e.clientX, e.clientY)
    if (!interactive) return
    // 标注气泡上的按钮要能点，别把点击当成拖动。
    if (e.target instanceof Element && e.target.closest('button')) return
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const v = currentView()
    drag = { x: e.clientX, from: v.from, span: v.to - v.from + 1, moved: false }
  }
  const onUp = () => {
    drag = null
    node.classList.remove('grabbing')
  }
  node.addEventListener('pointermove', onMove)
  node.addEventListener('pointerleave', onLeave)
  node.addEventListener('pointerdown', onDown)
  node.addEventListener('pointerup', onUp)
  node.addEventListener('pointercancel', onLeave)
  node.addEventListener('wheel', onWheel, { passive: false })

  /* ------------------------------------------------------------ 尺寸 */

  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect
    if (!box) return
    const w = Math.round(box.width)
    const hgt = Math.round(box.height)
    if (w === width && hgt === height) return
    width = Math.max(200, w)
    height = Math.max(180, hgt)
    layout()
  })
  observer.observe(node)

  /* ------------------------------------------------------------ 起画 */

  function indexAt(iso: string | null | undefined): number {
    if (!iso || !bars.length) return 0
    const at = new Date(iso).getTime()
    if (!Number.isFinite(at)) return 0
    if (at <= (bars[0] as Num).start) return 0
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i] as Num
      if (at >= bar.start && at < bar.end) return i
    }
    return bars.length - 1
  }

  const judgeIndex: number | null = options.judgmentAt ? indexAt(options.judgmentAt) : null

  buildLevels()
  buildMarks()
  buildBands()
  buildSeries()
  showUpTo(0)

  return {
    node,
    showUpTo,
    play,
    pause,
    playing: () => running,
    shown: () => shown,
    setSetup: (next) => {
      setup = next
      buildSeries()
    },
    setMarks: (nextMarks, nextBands) => {
      marks = nextMarks
      if (nextBands) bands = nextBands
      buildMarks()
      buildBands()
      layout()
    },
    zoom: (range) => {
      fixedView = range
      layout()
    },
    focus: (index, span) => {
      const size = Math.max(8, Math.min(bars.length, span ?? options.window ?? 240))
      setView(index - size / 2, size)
    },
    resetView: () => {
      fixedView = null
      layout()
    },
    indexAt,
    destroy: () => {
      pause()
      observer.disconnect()
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerleave', onLeave)
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointerup', onUp)
      node.removeEventListener('pointercancel', onLeave)
      node.removeEventListener('wheel', onWheel)
      node.remove()
    },
  }
}

/**
 * 候选那几段的小图：只要形状，不要坐标轴，也不要交互。
 */
export function miniCandles(source: Bar[], width = 168, height = 62): SVGElement {
  const plate = svg('svg', {
    class: 'rlv-mini',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
  })
  if (!source.length) return plate
  const bars = source.map((bar) => ({
    open: toNumber(bar.open),
    high: toNumber(bar.high),
    low: toNumber(bar.low),
    close: toNumber(bar.close),
  }))
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const bar of bars) {
    if (bar.low < low) low = bar.low
    if (bar.high > high) high = bar.high
  }
  if (!(high > low)) high = low + 1
  const step = width / bars.length
  const y = (p: number) => height - ((p - low) / (high - low)) * (height - 4) - 2
  bars.forEach((bar, i) => {
    const x = i * step
    const up = bar.close >= bar.open
    const group = svg('g', { class: up ? 'up' : 'down' })
    group.appendChild(
      svg('line', { class: 'w', x1: x + step / 2, x2: x + step / 2, y1: y(bar.low), y2: y(bar.high) }),
    )
    const top = y(Math.max(bar.open, bar.close))
    const bottom = y(Math.min(bar.open, bar.close))
    group.appendChild(
      svg('rect', {
        class: 'b',
        x: x + step * 0.15,
        width: Math.max(0.6, step * 0.7),
        y: top,
        height: Math.max(0.8, bottom - top),
      }),
    )
    plate.appendChild(group)
  })
  return plate
}

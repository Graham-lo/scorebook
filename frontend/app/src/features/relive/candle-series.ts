// 蜡烛和量柱自己画。
//
// 图库出厂的 CandlestickSeries 没有「实体多宽」这个选项：实体永远占根宽的八成
// （tradingview/lightweight-charts#792），桌面上正好，手机上就粗得像一堵墙——
// AICoin 那张图一屏九十根、实体两像素、影线细得像头发丝，靠出厂选项做不出来。
//
// 所以这里用 `chart.addCustomSeries()` 自己画。两条硬规矩：
//
// 一，桌面一个像素都不许变。宽度那套公式（`optimalCandlestickWidth` 加奇偶
// 修正）、影线的 `prevEdge` 夹取、先画完所有影线再画所有实体的顺序，全部照抄
// 图库现在这一版，抄到 `Math.round` 的位置都一样。
//
// 二，手机上实体按根宽的 0.55 取，影线只要半个设备像素——两者奇偶对齐，才不会
// 一边多半个像素、看着像毛边。
//
// 量柱走同一个渲染器的「只画柱」模式：桌面照抄图库 Histogram 那套对齐算法，手机
// 上柱宽就等于蜡烛实体宽，一根 K 线一根柱，上下对得齐齐的。

import {
  customSeriesDefaultOptions,
  type CustomData, type CustomSeriesOptions, type CustomSeriesPricePlotValues,
  type CustomSeriesWhitespaceData, type ICustomSeriesPaneRenderer, type ICustomSeriesPaneView,
  type PaneRendererCustomData, type Time,
} from 'lightweight-charts'

type DrawTarget = Parameters<ICustomSeriesPaneRenderer['draw']>[0]
type ToCoordinate = Parameters<ICustomSeriesPaneRenderer['draw']>[1]

/** 位图坐标里画一笔要知道的那几样。 */
interface Scope {
  readonly context: CanvasRenderingContext2D
  readonly horizontalPixelRatio: number
  readonly verticalPixelRatio: number
}

/* ------------------------------------------------------------ 宽度 */

/** 实体和影线各多宽（位图像素）。 */
export interface CandleWidths {
  body: number
  wick: number
}

/**
 * 图库算实体宽的那道公式，一个字没改地抄过来。
 * 见 lightweight-charts 的 `optimalCandlestickWidth`。
 */
function libraryBody(barSpacing: number, ratio: number): number {
  const from = 2.5
  const to = 4
  if (barSpacing >= from && barSpacing <= to) return Math.floor(3 * ratio)
  const coeff = 1 - 0.2 * Math.atan(Math.max(to, barSpacing) - to) / (Math.PI * 0.5)
  const res = Math.floor(barSpacing * coeff * ratio)
  const scaled = Math.floor(barSpacing * ratio)
  return Math.max(Math.floor(ratio), Math.min(res, scaled))
}

/** 手机上实体要么和影线同奇偶，要么就干脆和影线一样细。 */
function evenUp(raw: number, body: number, wick: number): number {
  if ((body % 2) === (wick % 2)) return body
  const down = body - 1
  const up = body + 1
  if (down >= 1 && Math.abs(raw - down) <= Math.abs(raw - up)) return down
  return up
}

/**
 * 这一根多宽：实体、影线各几个位图像素。
 *
 * 桌面按图库那一套算（实体约占根宽八成，影线一个设备像素），手机按 AICoin 的
 * 手感算（实体 0.55 根宽，影线半个设备像素）。奇偶要对齐：十字线自己是
 * `floor(dpr)` 宽，实体和它同奇偶，压上去才左右对称、不糊边。
 *
 * 根宽乘设备像素比再乘 0.55 还不到两个位图像素的时候，实体就退化成一条和影线
 * 一样细的线——再细下去画出来是半明半暗的灰边，不如干脆画成一根。
 */
export function candleWidths(barSpacing: number, dpr: number, mobile: boolean): CandleWidths {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const spacing = Number.isFinite(barSpacing) && barSpacing > 0 ? barSpacing : 0
  if (!mobile) {
    let body = libraryBody(spacing, ratio)
    const line = Math.floor(ratio)
    if (body >= 2 && (line % 2) !== (body % 2)) body -= 1
    let wick = Math.min(Math.floor(ratio), Math.floor(spacing * ratio))
    wick = Math.max(Math.floor(ratio), Math.min(wick, body))
    return { body, wick }
  }
  const wick = Math.max(1, Math.round(ratio / 2))
  const raw = spacing * 0.55 * ratio
  if (raw < 2) return { body: wick, wick }
  return { body: evenUp(raw, Math.max(1, Math.round(raw)), wick), wick }
}

/* ------------------------------------------------------------ 蜡烛 */

/** 一根 K 线。缺 `open` 的那一格是留白，不画。 */
export interface CandlePoint extends CustomData<Time> {
  open: number
  high: number
  low: number
  close: number
}

export interface CandleOptions extends CustomSeriesOptions {
  upColor: string
  downColor: string
  /** 手机布局。切的是宽度那一套，不是颜色。 */
  mobile: boolean
}

const isCandle = (data: unknown): data is CandlePoint =>
  typeof (data as Partial<CandlePoint>)?.open === 'number'

class CandleRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, CandlePoint> | null = null
  private options: CandleOptions | null = null

  update(data: PaneRendererCustomData<Time, CandlePoint>, options: CandleOptions): void {
    this.data = data
    this.options = options
  }

  draw(target: DrawTarget, toCoordinate: ToCoordinate): void {
    target.useBitmapCoordinateSpace((scope: Scope) => this.paint(scope, toCoordinate))
  }

  private paint(scope: Scope, toY: ToCoordinate): void {
    const data = this.data
    const style = this.options
    if (!data || !style || !data.visibleRange || !data.bars.length) return
    const { context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr } = scope
    const { body: bodyWidth, wick: wickWidth } = candleWidths(data.barSpacing, hr, style.mobile)
    const { from, to } = data.visibleRange

    // 影线先画一遍、实体再盖一遍：和图库同一个顺序。反过来的话密集处影线会盖在
    // 实体上，一眼就看得出不是同一张图。
    const offset = Math.floor(wickWidth * 0.5)
    let edge: number | null = null
    let inked = ''
    for (let i = from; i < to; i += 1) {
      const bar = data.bars[i]
      if (!bar || !isCandle(bar.originalData)) continue
      const one = bar.originalData
      const openY = toY(one.open)
      const closeY = toY(one.close)
      const highY = toY(one.high)
      const lowY = toY(one.low)
      if (openY === null || closeY === null || highY === null || lowY === null) continue
      const color = one.open <= one.close ? style.upColor : style.downColor
      if (color !== inked) { ctx.fillStyle = color; inked = color }
      const top = Math.round(Math.min(openY, closeY) * vr)
      const bottom = Math.round(Math.max(openY, closeY) * vr)
      const high = Math.round(highY * vr)
      const low = Math.round(lowY * vr)
      const center = Math.round(hr * bar.x)
      let left = center - offset
      const right = left + wickWidth - 1
      // 上一根的右缘顶着：挤到一起的时候宁可让这一根瘦一像素，也不要两根叠着画。
      if (edge !== null) {
        left = Math.max(edge + 1, left)
        left = Math.min(left, right)
      }
      const width = right - left + 1
      ctx.fillRect(left, high, width, top - high)
      ctx.fillRect(left, bottom + 1, width, low - bottom)
      edge = right
    }

    inked = ''
    for (let i = from; i < to; i += 1) {
      const bar = data.bars[i]
      if (!bar || !isCandle(bar.originalData)) continue
      const one = bar.originalData
      const openY = toY(one.open)
      const closeY = toY(one.close)
      if (openY === null || closeY === null) continue
      const color = one.open <= one.close ? style.upColor : style.downColor
      if (color !== inked) { ctx.fillStyle = color; inked = color }
      const top = Math.round(Math.min(openY, closeY) * vr)
      const bottom = Math.round(Math.max(openY, closeY) * vr)
      if (top > bottom) continue
      const left = Math.round(bar.x * hr) - Math.floor(bodyWidth * 0.5)
      const right = left + bodyWidth - 1
      // 开收同价的十字星：top 和 bottom 相等，这一笔还是有一个位图像素高。
      ctx.fillRect(left, top, right - left + 1, bottom - top + 1)
    }
  }
}

/** 主图那条蜡烛。 */
export function candleView(): ICustomSeriesPaneView<Time, CandlePoint, CandleOptions> {
  const renderer = new CandleRenderer()
  return {
    renderer: () => renderer,
    update: (data, options) => renderer.update(data, options),
    priceValueBuilder: (row: CandlePoint): CustomSeriesPricePlotValues => [row.high, row.low, row.close],
    isWhitespace: (
      data: CandlePoint | CustomSeriesWhitespaceData<Time>,
    ): data is CustomSeriesWhitespaceData<Time> => !isCandle(data),
    defaultOptions: (): CandleOptions => ({
      ...customSeriesDefaultOptions,
      upColor: '#26a69a',
      downColor: '#ef5350',
      mobile: false,
    }),
  }
}

/* ------------------------------------------------------------ 量柱 */

/** 一根量柱。缺 `value` 的那一格是留白，不画。 */
export interface ColumnPoint extends CustomData<Time> {
  value: number
}

export interface ColumnOptions extends CustomSeriesOptions {
  /** 一根柱的底在哪个值上。成交量是 0。 */
  base: number
  /** 手机布局：柱宽跟着蜡烛实体走。 */
  mobile: boolean
}

const isColumn = (data: unknown): data is ColumnPoint =>
  typeof (data as Partial<ColumnPoint>)?.value === 'number'

/** 一根柱在位图上的左右缘。 */
interface Edges {
  left: number
  right: number
  rounded: number
  center: number
  time: number
}

/**
 * 桌面上柱子怎么排：图库 `PaneRendererHistogram` 那套对齐算法照抄。
 *
 * 它做的事是「相邻两根之间永远只留 spacing 个像素的缝」——四舍五入会让某几根
 * 比邻居宽一像素，这两趟修正就是把那一像素还回去，缝才会一样宽。
 */
function columnEdges(
  bars: PaneRendererCustomData<Time, ColumnPoint>['bars'],
  range: { from: number; to: number },
  barSpacing: number,
  hr: number,
): Edges[] {
  const spacing = Math.ceil(barSpacing * hr) <= 1 ? 0 : Math.max(1, Math.floor(hr))
  const width = Math.round(barSpacing * hr) - spacing
  const out: Edges[] = []
  for (let i = range.from; i < range.to; i += 1) {
    const bar = bars[i]
    const x = bar ? Math.round(bar.x * hr) : 0
    let left: number
    let right: number
    if (width % 2) {
      const half = (width - 1) / 2
      left = x - half
      right = x + half
    } else {
      const half = width / 2
      left = x - half
      right = x + half - 1
    }
    out.push({ left, right, rounded: x, center: bar ? bar.x * hr : 0, time: bar ? bar.time : 0 })
  }
  for (let i = 1; i < out.length; i += 1) {
    const now = out[i] as Edges
    const was = out[i - 1] as Edges
    if (now.time !== was.time + 1) continue
    if (now.left - was.right === spacing + 1) continue
    if (was.rounded > was.center) was.right = now.left - spacing - 1
    else now.left = was.right + spacing + 1
  }
  let thinnest = Math.ceil(barSpacing * hr)
  for (const one of out) {
    if (one.right < one.left) one.right = one.left
    thinnest = Math.min(one.right - one.left + 1, thinnest)
  }
  if (spacing > 0 && thinnest < 4) {
    for (const one of out) {
      if (one.right - one.left + 1 <= thinnest) continue
      if (one.rounded > one.center) one.right -= 1
      else one.left += 1
    }
  }
  return out
}

class ColumnRenderer implements ICustomSeriesPaneRenderer {
  private data: PaneRendererCustomData<Time, ColumnPoint> | null = null
  private options: ColumnOptions | null = null

  update(data: PaneRendererCustomData<Time, ColumnPoint>, options: ColumnOptions): void {
    this.data = data
    this.options = options
  }

  draw(target: DrawTarget, toCoordinate: ToCoordinate): void {
    target.useBitmapCoordinateSpace((scope: Scope) => this.paint(scope, toCoordinate))
  }

  private paint(scope: Scope, toY: ToCoordinate): void {
    const data = this.data
    const style = this.options
    if (!data || !style || !data.visibleRange || !data.bars.length) return
    const baseY = toY(style.base)
    if (baseY === null) return
    const { context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr } = scope
    const range = data.visibleRange
    const tick = Math.max(1, Math.floor(vr))
    const base = Math.round(baseY * vr)
    const baseTop = base - Math.floor(tick / 2)
    const baseBottom = baseTop + tick
    const wide = style.mobile ? candleWidths(data.barSpacing, hr, true).body : 0
    const edges = style.mobile ? null : columnEdges(data.bars, range, data.barSpacing, hr)
    let inked = ''
    for (let i = range.from; i < range.to; i += 1) {
      const bar = data.bars[i]
      if (!bar || !isColumn(bar.originalData)) continue
      const valueY = toY(bar.originalData.value)
      if (valueY === null) continue
      const y = Math.round(valueY * vr)
      const color = bar.barColor
      if (color !== inked) { ctx.fillStyle = color; inked = color }
      let top: number
      let bottom: number
      if (y <= baseTop) { top = y; bottom = baseBottom }
      else { top = baseTop; bottom = y - Math.floor(tick / 2) + tick }
      // 手机上柱子和蜡烛实体同宽同心：一根 K 线一根柱，上下一条直线对下来。
      const left = edges ? (edges[i - range.from] as Edges).left : Math.round(bar.x * hr) - Math.floor(wide * 0.5)
      const right = edges ? (edges[i - range.from] as Edges).right : left + wide - 1
      ctx.fillRect(left, top, right - left + 1, bottom - top)
    }
  }
}

/** 成交量那一排柱。 */
export function columnView(): ICustomSeriesPaneView<Time, ColumnPoint, ColumnOptions> {
  const renderer = new ColumnRenderer()
  return {
    renderer: () => renderer,
    update: (data, options) => renderer.update(data, options),
    priceValueBuilder: (row: ColumnPoint): CustomSeriesPricePlotValues => [0, row.value],
    isWhitespace: (
      data: ColumnPoint | CustomSeriesWhitespaceData<Time>,
    ): data is CustomSeriesWhitespaceData<Time> => !isColumn(data),
    defaultOptions: (): ColumnOptions => ({
      ...customSeriesDefaultOptions,
      base: 0,
      mobile: false,
    }),
  }
}

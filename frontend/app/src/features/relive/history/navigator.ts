// 导航条：一整条命的缩略图。
//
// 全屏那张图一次只看得见几百根，可这个品种从上市到现在有五六年。人在里面拖，
// 拖两下就不知道自己在哪儿了——「我现在看的是全程的哪一段」这个问题，图本身回答
// 不了。导航条就是那张全景：整条命压成一条 28 像素高的日线走势，眼前这一段是上
// 面一个可以拖、可以拉宽的框。
//
// 它还兼做「哪些地方取过了」的进度条：取过的那几段亮一点，没取过的暗一点，锚定
// 那一段上立一根丁香色的小竖线——人一眼看得出自己那次判断发生在这条命的哪个位置。
//
// 像素和时间之间的换算、年份刻度怎么稀释、拖到边上算拖还是算拉宽，全是纯函数，
// 写在上半截，Node 里直接测。下半截才是画布和事件。

import type { Bar } from '../../../api/types'
import { h } from '../../../ui/dom'

/* ------------------------------------------------------------ 纯算术 */

export interface NavSpan {
  fromMs: number
  toMs: number
  widthPx: number
}

export function navX(ms: number, span: NavSpan): number {
  const total = span.toMs - span.fromMs
  if (!(total > 0) || !(span.widthPx > 0)) return 0
  return ((ms - span.fromMs) / total) * span.widthPx
}

export function navTime(x: number, span: NavSpan): number {
  const total = span.toMs - span.fromMs
  if (!(total > 0) || !(span.widthPx > 0)) return span.fromMs
  return span.fromMs + (x / span.widthPx) * total
}

/** 眼前这一段在导航条上占哪一块。窄到看不见就撑到 6 像素，不然抓不着。 */
export const MIN_WINDOW_PX = 6
export function windowBox(view: { fromMs: number; toMs: number }, span: NavSpan): { left: number; width: number } {
  const a = navX(view.fromMs, span)
  const b = navX(view.toMs, span)
  const left = Math.min(a, b)
  const width = Math.max(MIN_WINDOW_PX, Math.abs(b - a))
  return { left, width }
}

/** 边上这么宽的一条算「拉宽」，中间算「拖着走」。 */
export const EDGE_PX = 8
export type NavGrab = 'left' | 'right' | 'move' | 'empty'

export function grabAt(x: number, box: { left: number; width: number }, edgePx = EDGE_PX): NavGrab {
  const right = box.left + box.width
  // 窗口比两条边还窄（30m 视野在七年跨度上就只有 6px），分左右边就等于永远拖不动：
  // 手落在哪儿都判成拉边，一拖就把这一段拉没了。这种时候整块都算「拖着走」。
  if (box.width < 3 * edgePx) {
    return x >= box.left - edgePx && x <= right + edgePx ? 'move' : 'empty'
  }
  if (x >= box.left - edgePx && x <= box.left + edgePx) return 'left'
  if (x >= right - edgePx && x <= right + edgePx) return 'right'
  if (x > box.left && x < right) return 'move'
  return 'empty'
}

/**
 * 拖一下之后眼前这一段变成哪一段。
 *
 * 三条路各不相同：拖着走是整段平移（跨度不变）；拉左边只动左端、拉右边只动右
 * 端，而且不许穿过对面——跨度最小留一天，不然一拉到底就成了一个点。
 */
export const MIN_SPAN_MS = 86_400_000
export function dragTo(
  grab: NavGrab,
  view: { fromMs: number; toMs: number },
  deltaMs: number,
  at: number,
): { fromMs: number; toMs: number } {
  if (grab === 'move') return { fromMs: view.fromMs + deltaMs, toMs: view.toMs + deltaMs }
  if (grab === 'left') {
    const from = Math.min(at, view.toMs - MIN_SPAN_MS)
    return { fromMs: from, toMs: view.toMs }
  }
  if (grab === 'right') {
    const to = Math.max(at, view.fromMs + MIN_SPAN_MS)
    return { fromMs: view.fromMs, toMs: to }
  }
  // 点空白：把眼前这一段的中心挪到点的那儿，跨度不变。
  const half = (view.toMs - view.fromMs) / 2
  return { fromMs: at - half, toMs: at + half }
}

/** 一年一根刻度；挤不下就隔一年画一根，再挤不下就隔两年。 */
export const YEAR_GAP_PX = 44
export function yearTicks(span: NavSpan, gapPx = YEAR_GAP_PX): { ms: number; year: number; x: number }[] {
  const total = span.toMs - span.fromMs
  if (!(total > 0) || !(span.widthPx > 0)) return []
  const first = new Date(span.fromMs).getUTCFullYear()
  const last = new Date(span.toMs).getUTCFullYear()
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return []
  const years = last - first + 1
  const perYear = span.widthPx / Math.max(1, years)
  const every = Math.max(1, Math.ceil(gapPx / Math.max(1, perYear)))
  const out: { ms: number; year: number; x: number }[] = []
  for (let year = first; year <= last; year += 1) {
    if ((year - first) % every !== 0) continue
    const ms = Date.UTC(year, 0, 1)
    if (ms < span.fromMs || ms > span.toMs) continue
    out.push({ ms, year, x: navX(ms, span) })
  }
  return out
}

/** 取过的那几段在条上的位置。相邻的并成一条，省得画出一排缝。 */
export function bands(
  ranges: readonly { fromMs: number; toMs: number }[],
  span: NavSpan,
): { left: number; width: number }[] {
  const sorted = [...ranges].filter((r) => r.toMs > r.fromMs).sort((a, b) => a.fromMs - b.fromMs)
  const merged: { fromMs: number; toMs: number }[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, range.toMs)
    else merged.push({ ...range })
  }
  return merged.map((range) => {
    const a = navX(range.fromMs, span)
    const b = navX(range.toMs, span)
    return { left: a, width: Math.max(1, b - a) }
  })
}

/** 收盘价压成一条折线：一列像素只留一个点，几千根也画得起。 */
export function linePoints(
  bars: readonly Bar[],
  span: NavSpan,
  heightPx: number,
): { x: number; y: number }[] {
  if (!bars.length || !(span.widthPx > 0) || !(heightPx > 0)) return []
  let low = Infinity
  let high = -Infinity
  for (const bar of bars) {
    const close = Number(bar.close)
    if (!Number.isFinite(close)) continue
    if (close < low) low = close
    if (close > high) high = close
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return []
  const range = high - low || 1
  const seen = new Set<number>()
  const out: { x: number; y: number }[] = []
  for (const bar of bars) {
    const close = Number(bar.close)
    if (!Number.isFinite(close)) continue
    const x = Math.round(navX(Date.parse(bar.start), span))
    if (seen.has(x)) continue
    seen.add(x)
    out.push({ x, y: heightPx - ((close - low) / range) * heightPx })
  }
  return out
}

/* ------------------------------------------------------------ 那条 DOM */

export const NAV_H = 28
export const NAV_H_SHORT = 20

const INK = {
  loaded: 'rgba(255,255,255,.55)',
  blank: 'rgba(255,255,255,.18)',
  anchor: '#C4B5FD',
  year: 'rgba(255,255,255,.45)',
}

export interface NavigatorDeps {
  /** 眼前这一段。拖的时候每一帧问一次。 */
  view(): { fromMs: number; toMs: number } | null
  /** 拖动过程中：跟手，别发请求。 */
  onDrag(fromMs: number, toMs: number): void
  /** 手放开：这一次才算数，该取数就取数。 */
  onSettle(fromMs: number, toMs: number): void
  /** 双击锚定那根小竖线：回那一段去。 */
  onAnchor(): void
  /** 长按：跳到某一天。 */
  onLongPress?(): void
}

export interface ChartNavigator {
  node: HTMLElement
  /** 整条命的范围。上市到现在。 */
  setSpan(fromMs: number, toMs: number): void
  /** 那条 1d 走势。 */
  setLine(bars: readonly Bar[]): void
  /** 取过的那几段。 */
  setLoaded(ranges: readonly { fromMs: number; toMs: number }[]): void
  /** 锚定段的位置（那根丁香色小竖线）。 */
  setAnchor(atMs: number | null): void
  /** 视野变了，重画那个框。 */
  refresh(): void
  destroy(): void
}

/** 长按多久算长按。 */
const LONG_MS = 500

export function chartNavigator(deps: NavigatorDeps): ChartNavigator {
  const canvas = h('canvas') as HTMLCanvasElement
  const windowNode = h('div.tv-nav-window')
  const empty = h('span.tv-nav-empty', { text: '导航条正在取 1d 走势' })
  const node = h('div.tv-nav', {
    attrs: { tabindex: '0', role: 'slider', 'aria-label': '时间导航' },
  }, canvas, windowNode, empty)

  let span: { fromMs: number; toMs: number } | null = null
  let line: readonly Bar[] = []
  let loaded: { fromMs: number; toMs: number }[] = []
  let anchorMs: number | null = null
  let frame = 0
  let dead = false
  let grab: NavGrab | null = null
  let pressAt = 0
  let held = 0
  let startView: { fromMs: number; toMs: number } | null = null

  const width = (): number => node.clientWidth
  const height = (): number => node.clientHeight

  const spanOf = (): NavSpan | null =>
    span && width() > 0 ? { fromMs: span.fromMs, toMs: span.toMs, widthPx: width() } : null

  function draw(): void {
    frame = 0
    if (dead) return
    const box = spanOf()
    const h0 = height()
    empty.hidden = line.length > 0
    if (!box || !(h0 > 0)) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(box.widthPx * ratio)
    canvas.height = Math.round(h0 * ratio)
    canvas.style.width = `${box.widthPx}px`
    canvas.style.height = `${h0}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, box.widthPx, h0)

    // 底：整条都是「没取过」，取过的那几段盖一层亮的。
    const lineTop = 4
    const lineH = Math.max(4, h0 - 12)
    ctx.fillStyle = INK.blank
    ctx.fillRect(0, lineTop, box.widthPx, lineH)
    ctx.fillStyle = INK.loaded
    for (const band of bands(loaded, box)) ctx.fillRect(band.left, lineTop, band.width, lineH)

    // 走势线。有几根画几根——上市没几天的品种，整条命在这根几年长的导航条上只
    // 占一两像素，按像素列压完只剩一个点；以前 `> 1` 才画，于是什么都看不见，
    // 看起来就像「一直没取到」。只剩一个点就点一个点。
    const points = linePoints(line, box, lineH)
    if (points.length) {
      ctx.save()
      ctx.translate(0, lineTop)
      ctx.strokeStyle = 'rgba(255,255,255,.75)'
      ctx.fillStyle = 'rgba(255,255,255,.75)'
      ctx.lineWidth = 1
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (points.length === 1) {
        const only = points[0]!
        ctx.fillRect(Math.max(0, Math.min(box.widthPx - 2, only.x - 1)), Math.max(0, only.y - 1), 2, 2)
      } else {
        ctx.beginPath()
        points.forEach((point, i) => { if (i) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y) })
        ctx.stroke()
      }
      ctx.restore()
    }

    // 锚定那一根。
    if (anchorMs !== null) {
      const x = navX(anchorMs, box)
      ctx.fillStyle = INK.anchor
      ctx.fillRect(Math.max(0, Math.min(box.widthPx - 2, x - 1)), 0, 2, h0)
    }

    // 年份刻度。
    ctx.fillStyle = INK.year
    ctx.font = '10px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    for (const tick of yearTicks(box)) {
      ctx.fillRect(tick.x, h0 - 8, 1, 4)
      if (tick.x < box.widthPx - 26) ctx.fillText(String(tick.year), tick.x + 2, h0)
    }

    place()
  }

  /** 那个框。用 DOM 而不是画进画布：拖的时候只改两个 style，不重画整条。 */
  function place(): void {
    const box = spanOf()
    const view = deps.view()
    if (!box || !view) { windowNode.hidden = true; return }
    const rect = windowBox(view, box)
    windowNode.hidden = false
    windowNode.style.left = `${rect.left}px`
    windowNode.style.width = `${rect.width}px`
  }

  function schedule(): void {
    if (dead || frame) return
    frame = requestAnimationFrame(draw)
  }

  function xOf(event: PointerEvent): number {
    return event.clientX - node.getBoundingClientRect().left
  }

  function onDown(event: PointerEvent): void {
    const box = spanOf()
    const view = deps.view()
    if (!box || !view) return
    const x = xOf(event)
    const rect = windowBox(view, box)
    grab = grabAt(x, rect)
    pressAt = x
    startView = { ...view }
    node.setPointerCapture(event.pointerId)
    node.focus()
    if (deps.onLongPress) {
      window.clearTimeout(held)
      held = window.setTimeout(() => { if (grab) { grab = null; deps.onLongPress?.() } }, LONG_MS)
    }
    if (grab === 'empty') {
      const next = dragTo('empty', view, 0, navTime(x, box))
      deps.onSettle(next.fromMs, next.toMs)
      grab = null
      window.clearTimeout(held)
    }
    event.preventDefault()
  }

  function onMove(event: PointerEvent): void {
    if (!grab || !startView) return
    const box = spanOf()
    if (!box) return
    const x = xOf(event)
    if (Math.abs(x - pressAt) > 3) window.clearTimeout(held)
    const total = box.toMs - box.fromMs
    const deltaMs = ((x - pressAt) / Math.max(1, box.widthPx)) * total
    const next = dragTo(grab, startView, deltaMs, navTime(x, box))
    deps.onDrag(next.fromMs, next.toMs)
    place()
  }

  function onUp(event: PointerEvent): void {
    window.clearTimeout(held)
    if (!grab || !startView) { grab = null; return }
    const box = spanOf()
    if (box) {
      const x = xOf(event)
      const total = box.toMs - box.fromMs
      const deltaMs = ((x - pressAt) / Math.max(1, box.widthPx)) * total
      const next = dragTo(grab, startView, deltaMs, navTime(x, box))
      deps.onSettle(next.fromMs, next.toMs)
    }
    grab = null
    startView = null
  }

  function onDouble(event: MouseEvent): void {
    const box = spanOf()
    if (!box || anchorMs === null) return
    const x = event.clientX - node.getBoundingClientRect().left
    if (Math.abs(x - navX(anchorMs, box)) > EDGE_PX) return
    deps.onAnchor()
  }

  function onKey(event: KeyboardEvent): void {
    const view = deps.view()
    if (!view) return
    const width0 = view.toMs - view.fromMs
    const step = width0 / 4
    const zoom = (factor: number): void => {
      const middle = (view.fromMs + view.toMs) / 2
      const half = (width0 * factor) / 2
      deps.onSettle(middle - half, middle + half)
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (event.shiftKey) zoom(1.35)
      else deps.onSettle(view.fromMs - step, view.toMs - step)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (event.shiftKey) zoom(1 / 1.35)
      else deps.onSettle(view.fromMs + step, view.toMs + step)
    }
  }

  node.addEventListener('pointerdown', onDown)
  node.addEventListener('pointermove', onMove)
  node.addEventListener('pointerup', onUp)
  node.addEventListener('pointercancel', onUp)
  node.addEventListener('dblclick', onDouble)
  node.addEventListener('keydown', onKey)
  const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
  watcher?.observe(node)

  return {
    node,
    setSpan(fromMs, toMs) {
      if (!(toMs > fromMs)) return
      span = { fromMs, toMs }
      schedule()
    },
    setLine(bars) { line = bars; schedule() },
    setLoaded(ranges) { loaded = ranges.map((range) => ({ ...range })); schedule() },
    setAnchor(atMs) { anchorMs = atMs; schedule() },
    refresh() { place() },
    destroy() {
      dead = true
      if (frame) cancelAnimationFrame(frame)
      window.clearTimeout(held)
      watcher?.disconnect()
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerup', onUp)
      node.removeEventListener('pointercancel', onUp)
      node.removeEventListener('dblclick', onDouble)
      node.removeEventListener('keydown', onKey)
    },
  }
}

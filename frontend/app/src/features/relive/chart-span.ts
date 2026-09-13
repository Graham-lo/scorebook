// 当前这一档的「规则格子」。
//
// lightweight-charts 的横轴是按数据点排的：点与点之间是等距的，点以外只能外推，
// 而且它还会把没有数据的视野钳回来（至少露两个点）。上一版拿留白去贴着已加载的
// 那一段两边铺，结果是「时间↔下标」只在数据连续、留白够长的时候才准——往 2019 年
// 跳要铺十几万根，铺不到，视野就设不过去，轴刻度和 K 线也对不上。
//
// 这一版反过来：先按目标视野划一排等距的格子（originMs / stepMs / count），
// 真实 bar 按 slot 填进对应的格里，其余的格子放 whitespace。于是
//
//     logical = (ms − originMs) / stepMs
//
// 在整条轴上精确成立，不用二分、不用外推，也不必关心 bars 连不连续。格子外的
// bar 不进图（feed 里照旧留着，视野回来再填）。留白不参与指标、不计入「已加载」。

/** 一排等距的格子。第 i 格代表 originMs + i * stepMs 这一刻。 */
export interface Lattice {
  originMs: number
  stepMs: number
  count: number
}

/** 图允许的最密根宽。格子的点数上限按它算。 */
export const MIN_BAR_SPACING = 0.4

/**
 * 一个格子最多几个点：视野 ±2 屏共五屏，每屏最密也就 paneWidth / 0.4 根。
 * 再多的点画不出来也定位不到，只是白白拖慢 setData。
 */
export function latticeCap(paneWidthPx: number): number {
  const width = paneWidthPx > 0 ? paneWidthPx : 1440
  return Math.max(500, Math.ceil((5 * width) / MIN_BAR_SPACING))
}

export interface LatticeInput {
  stepMs: number
  /** 目标视野。远跳的时候给的是要去的地方，不是现在在哪。 */
  viewFromMs: number
  viewToMs: number
  paneWidthPx: number
  /** 有真实 bar 就给一根的开盘时刻：格子跟着它对齐（周线是周一开，不是整周数）。 */
  anchorMs?: number
  /** 铺到「现在」为止，未来那一段不给时间轴。不传就不封顶。 */
  nowMs?: number
  /** 左端不许越过这一刻（上市之前只留一屏空白）。 */
  minStartMs?: number
  /** 这一刻必须圈得进来。给的是离视野最近的那一根真 K 线。 */
  keepMs?: number
}

const num = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value)

/** 按目标视野划一排格子：覆盖视野 ±2 屏，点数封顶。 */
export function planLattice(input: LatticeInput): Lattice | null {
  const { stepMs, viewFromMs, viewToMs, paneWidthPx } = input
  if (!(stepMs > 0) || !Number.isFinite(viewFromMs) || !Number.isFinite(viewToMs)) return null
  if (!(viewToMs > viewFromMs)) return null
  const span = Math.max(stepMs, viewToMs - viewFromMs)
  let startMs = viewFromMs - 2 * span
  let endMs = viewToMs + 2 * span
  if (num(input.nowMs)) endMs = Math.max(viewToMs, Math.min(endMs, input.nowMs + stepMs))
  // 手正按着图的时候右端一格都不能动，理由见 `viewAfterSwap`。
  if (num(input.minStartMs)) startMs = Math.max(startMs, input.minStartMs)
  // 格子里必须留得住一根真 K 线。留不住，图量滚动位置的那把尺子就没了，视野当场
  // 被拽到格子左端，再重铺一次只会把人推得更远——一直推到上市之前。
  if (num(input.keepMs)) {
    if (input.keepMs < startMs) startMs = input.keepMs
    if (input.keepMs > endMs) endMs = input.keepMs
  }
  if (!(endMs > startMs)) endMs = startMs + stepMs
  const phase = num(input.anchorMs) ? ((input.anchorMs % stepMs) + stepMs) % stepMs : 0
  const align = (ms: number): number => Math.floor((ms - phase) / stepMs) * stepMs + phase
  let originMs = align(startMs)
  let count = Math.floor((endMs - originMs) / stepMs) + 1
  const cap = latticeCap(paneWidthPx)
  if (count > cap) {
    // 铺不下就只保「目标视野 + 那根尺子」这一段，居中摆：两边的余量先让出去。
    const keep = num(input.keepMs) ? input.keepMs : null
    const mustFrom = keep === null ? viewFromMs : Math.min(viewFromMs, keep)
    const mustTo = keep === null ? viewToMs : Math.max(viewToMs, keep)
    const middle = (mustFrom + mustTo) / 2
    originMs = align(middle - (cap / 2) * stepMs)
    count = cap
  }
  return { originMs, stepMs, count: Math.max(1, count) }
}

/** 格子里还留得住真 K 线吗：留不住，图量滚动位置的尺子就没了。 */
export function latticeHolds(lattice: Lattice, firstBarMs: number, lastBarMs: number): boolean {
  const { startMs, endMs } = latticeEnds(lattice)
  return lastBarMs >= startMs && firstBarMs <= endMs
}

/** 视野整个落在数据之外的时候，格子至少得把最近的那一根真 K 线圈进来。 */
export function keepInView(
  fromMs: number, toMs: number, firstBarMs: number, lastBarMs: number,
): number {
  if (lastBarMs < fromMs) return lastBarMs
  if (firstBarMs > toMs) return firstBarMs
  return Math.max(firstBarMs, Math.min(lastBarMs, (fromMs + toMs) / 2))
}

/** 这一刻落在第几格。带小数——视野两端本来就不在格子上。 */
export function slotOf(lattice: Lattice, ms: number): number {
  return (ms - lattice.originMs) / lattice.stepMs
}

/** 第几格是哪一刻。 */
export function timeOfSlot(lattice: Lattice, slot: number): number {
  return lattice.originMs + slot * lattice.stepMs
}

/** 真实 bar 该填进哪一格；格子外返回 null。 */
export function slotFor(lattice: Lattice, ms: number): number | null {
  const slot = Math.round(slotOf(lattice, ms))
  if (!Number.isFinite(slot) || slot < 0 || slot >= lattice.count) return null
  return slot
}

/** 格子的头尾两刻。 */
export function latticeEnds(lattice: Lattice): { startMs: number; endMs: number } {
  return { startMs: lattice.originMs, endMs: timeOfSlot(lattice, lattice.count - 1) }
}

/** 这一段视野还在格子里面吗。 */
export function latticeCovers(lattice: Lattice, fromMs: number, toMs: number): boolean {
  const { startMs, endMs } = latticeEnds(lattice)
  return fromMs >= startMs && toMs <= endMs
}

/** 视野离格子边缘还有不到一屏就该重铺了。 */
export function nearEdge(lattice: Lattice, fromMs: number, toMs: number): boolean {
  const span = Math.max(lattice.stepMs, toMs - fromMs)
  const { startMs, endMs } = latticeEnds(lattice)
  return fromMs - span < startMs || toMs + span > endMs
}

/** 两排格子一样吗。 */
export function sameLattice(a: Lattice | null, b: Lattice | null): boolean {
  if (!a || !b) return a === b
  return a.originMs === b.originMs && a.stepMs === b.stepMs && a.count === b.count
}

/** 一段视野，两头都是毫秒。 */
export interface Span {
  from: number
  to: number
}

/** 视野只能待在这一段里。 */
export interface ViewBounds {
  /** 左端最早能到哪一刻（上市之前留一屏空白）。 */
  minFromMs: number
  /** 右端最晚能到哪一刻（现在再加一点留白）。 */
  maxToMs: number
}

/**
 * 把一段视野挪回允许的范围里。跨度一个字不改——夹取只负责平移，不负责缩放，
 * 否则人拖到头的那一下会看见图自己缩了一下。
 */
export function clampSpan(span: Span, bounds: ViewBounds): Span {
  const width = span.to - span.from
  if (!(width > 0)) return span
  const lo = Number.isFinite(bounds.minFromMs) ? bounds.minFromMs : Number.NEGATIVE_INFINITY
  const hi = Number.isFinite(bounds.maxToMs) ? bounds.maxToMs : Number.POSITIVE_INFINITY
  if (!(hi > lo)) return span
  let from = span.from
  if (from < lo) from = lo
  if (from + width > hi) from = Math.max(lo, hi - width)
  if (from === span.from) return span
  return { from, to: from + width }
}

/**
 * 手动换周期：每根 K 线多宽不变，跨度按新周期重算，中心那一刻留在中心。
 *
 * TradingView 就是这么干的——人点 `1d` 是想换一把尺子，不是想把屏幕上那几根
 * 撑成方块。保跨度的话 1h→1d 只剩几根大方块、→5m 挤成一片细线，那是「自动」
 * 按密度换档才该有的行为（那一路是缩放动作的延续，跨度必须守住）。
 *
 * `paneWidthPx` 是时间轴那块画布的宽，`barSpacingPx` 是图现在一根占几个像素，
 * `stepMs` 是新周期一根多少毫秒。算不出来（宽度或根宽是 0）就原样返回。
 */
export function spanForPeriod(
  fromMs: number,
  toMs: number,
  paneWidthPx: number,
  barSpacingPx: number,
  stepMs: number,
): Span {
  const here = { from: fromMs, to: toMs }
  if (![fromMs, toMs, paneWidthPx, barSpacingPx, stepMs].every((n) => Number.isFinite(n))) return here
  if (!(toMs > fromMs) || !(paneWidthPx > 0) || !(barSpacingPx > 0) || !(stepMs > 0)) return here
  const middle = (fromMs + toMs) / 2
  const half = (paneWidthPx / barSpacingPx) * stepMs / 2
  return { from: middle - half, to: middle + half }
}

/**
 * 换档算出来的那一段，挪到「至少看得见一根真 K 线」的地方。
 *
 * 上一档被未来封顶往左推过之后，视野中点可能已经落在上市之前的空白里；照那个
 * 中点换档，新的一段就整段悬在没有行情的时间上，屏上一根 K 线都没有。这里只做
 * 平移，不改跨度（根宽因此不变）：整段在最后一根右边就把右端贴住最后一根，整段
 * 在上市之前就把左端贴住第一根。两头都不知道，或者本来就压着行情，原样不动。
 */
export function spanOnBars(
  span: Span,
  stepMs: number,
  edges: { firstMs?: number | null; lastMs?: number | null },
): Span {
  const width = span.to - span.from
  if (!(width > 0) || !(stepMs > 0)) return span
  if (!Number.isFinite(span.from) || !Number.isFinite(span.to)) return span
  const lo = typeof edges.firstMs === 'number' && Number.isFinite(edges.firstMs) ? edges.firstMs : null
  const hi = typeof edges.lastMs === 'number' && Number.isFinite(edges.lastMs) ? edges.lastMs : null
  if (lo === null && hi === null) return span
  // 最后一根自己占一格，右边界算到它收盘。
  const right = hi === null ? Number.POSITIVE_INFINITY : hi + stepMs
  const left = lo === null ? Number.NEGATIVE_INFINITY : lo
  const overlap = Math.min(span.to, right) - Math.max(span.from, left)
  if (overlap >= stepMs) return span
  if (hi !== null && span.from > hi) return { from: right - width, to: right }
  if (lo !== null) return { from: left, to: left + width }
  return span
}

/** 换一份数据的那一刻，格子和真 K 线的两头。 */
export interface Swap {
  lattice: Lattice
  /** 这一份数据里最后一根真 K 线的时刻；一根都没有就给 null。 */
  lastBarMs: number | null
}

/** 图量滚动位置用的那把尺子指着哪一刻。 */
function rulerMs(swap: Swap): number {
  const slot = swap.lastBarMs === null ? null : slotFor(swap.lattice, swap.lastBarMs)
  return slot === null ? swap.lattice.originMs : timeOfSlot(swap.lattice, slot)
}

/**
 * 换一份数据之后，图会把视野摆到哪一段时间。
 *
 * 图内部记的不是「看的是哪一段时间」，是 `rightOffset`：从「最后一根真 K 线」
 * 那一格往右还差几格。而且手按在图上的那一路，每一次 pointermove 都拿按下那一
 * 刻的 `rightOffset` 加鼠标位移重算一遍——中途我们设过的可见范围会被整个抹掉。
 * 所以换数据、重铺格子这些事想不挪动视野，唯一的办法是让这把尺子指着同一刻：
 * 格子往左铺多长都不要紧，右端一动、或者格子里一根真的都不剩（尺子退回第 0
 * 格），视野当场就跟着走。
 */
export function viewAfterSwap(view: Span, before: Swap, after: Swap): Span {
  const shift = rulerMs(after) - rulerMs(before)
  if (!Number.isFinite(shift) || shift === 0) return view
  return { from: view.from + shift, to: view.to + shift }
}

/**
 * 上一发程序性落位到位了没有。
 *
 * `setVisibleLogicalRange` 不是立刻生效的：它只往图的 InvalidateMask 里塞一笔，
 * 真正落位在图自己的 rAF 里。所以落位之后紧接着去读图的可见范围，读到的还是旧
 * 的那一段——中间这一段时间里「现在看的是哪儿」只能认我们自己要去的地方。两头
 * 都差不到一格，就算图已经走到了，那份 pending 可以撤掉。
 */
export function settled(pending: Span, now: Span, stepMs: number): boolean {
  const slack = stepMs > 0 ? stepMs : 1
  return Math.abs(now.from - pending.from) < slack && Math.abs(now.to - pending.to) < slack
}

/**
 * 还该不该再催图落一次位。
 *
 * 没目标就不用；图那边一片空白（还没算出范围）就得催；已经落到了也不用——不然
 * 每一帧都补一发，就成了死循环。
 */
export function needsReassert(want: Span | null, now: Span | null, stepMs: number): boolean {
  if (!want) return false
  if (!now) return true
  return !settled(want, now, stepMs)
}

/**
 * 「现在看的是哪一段时间」按什么顺序回答。
 *
 * 还没兑现的目标排在最前面。图的 rAF 会把一根真 bar 都没有的那一跳钳到格子边
 * 上，这时候照图的说法去取数，取的是上市之前那一段空白，取回来还是空——没有
 * `setBars` 就没人再落一次位，于是永远卡在那儿。人一动手目标就清了，这里立刻
 * 改口说图的真实范围，不会把人拉回去。
 */
export function nowShowing(want: Span | null, now: Span | null, ends: Span | null): Span | null {
  return want ?? now ?? ends
}

/**
 * 「最后一次程序性落位要去的那一段」这件事本身。
 *
 * 落位延迟生效，所以这段时间里问「现在看的是哪儿」，答的必须是要去的地方，不是
 * 图上还留着的上一段——否则连按 `−` 每一下都拿旧值当基准，倍数忽大忽小、中心
 * 乱跳。人自己动手、图已经走到、或者等太久了，这份念想就该放下。
 */
export interface ViewAim {
  /**
   * 还没落到的那个目标；没有就 null（该去问图）。
   *
   * 不按数据回来的快慢过期。远跳的数据要两三秒才回来，中间这段时间里问「现在
   * 看的是哪儿」，答的必须还是这个目标：图那边已经被钳到格子边上了，照它去取数
   * 只会取到一段空白。人自己动手、图真的走到了、主动放下，这份念想才作废——
   * 再有就是坚持得太久还没走到：那多半是图根本去不了（上市之前那一段一根真
   * bar 都没有，rAF 每帧把视野钳回格子边），这时候还认它就是死锁。
   */
  want(): Span | null
  /** 记下这一次要去哪。 */
  aim(span: Span): void
  /** 来了一次范围变化：`self` 表示这一次是程序自己设的。 */
  settle(self: boolean, now: Span | null, stepMs: number): void
  /** 直接放下（退出全屏之类）。 */
  drop(): void
}

/**
 * 一个目标最多坚持多久。
 *
 * 取一段远处历史，慢的时候两三秒；六秒还没走到，就不是「数据没回来」，是图去
 * 不了那儿。认图的说法，人拖到哪儿就是哪儿——空白允许，死锁不允许。
 */
export const AIM_HOLD_MS = 6000

export function viewAim(clock: () => number = () => Date.now(), holdMs = AIM_HOLD_MS): ViewAim {
  let want: Span | null = null
  let since = 0

  /** 坚持过了头 = 图去不了。认账。 */
  const stale = (): boolean => want !== null && clock() - since >= holdMs

  return {
    want() {
      if (stale()) want = null
      return want ? { ...want } : null
    },
    aim(span) {
      want = { from: span.from, to: span.to }
      since = clock()
    },
    settle(self, now, stepMs) {
      if (!want) return
      // 人自己拖过缩过，这一段就作废：后面的 resize 重放不该把他拉回原处。
      if (!self) { want = null; return }
      if (now && settled(want, now, stepMs)) { want = null; return }
      if (stale()) want = null
    },
    drop() { want = null },
  }
}

/** 缓动走多久。 */
export const GLIDE_MS = 240

/** 远跳的界线：目标离当前视野超过三屏就不缓动，先重铺格子再直接落位。 */
export const FAR_SCREENS = 3

/** 这一跳算不算远跳。远跳要先重铺格子，缓动没有意义（中间全是空的）。 */
export function farJump(here: Span | null, target: Span, lattice: Lattice | null): boolean {
  if (!here) return true
  if (!lattice || lattice.count <= 0) return true
  if (!latticeCovers(lattice, target.from, target.to)) return true
  const span = Math.max(target.to - target.from, here.to - here.from)
  if (!(span > 0)) return true
  const middle = (target.from + target.to) / 2
  const was = (here.from + here.to) / 2
  return Math.abs(middle - was) > FAR_SCREENS * span
}

/**
 * 缓动到第 `elapsedMs` 毫秒时视野该停在哪。起点和目标都是时间：中途左边并进来
 * 新格子，下标会整体错位，时间不会——下标每一帧按时间现算。
 */
export function glideAt(
  here: Span,
  target: Span,
  elapsedMs: number,
  durationMs = GLIDE_MS,
): Span & { done: boolean } {
  const span = durationMs > 0 ? durationMs : GLIDE_MS
  const done = Math.min(1, Math.max(0, elapsedMs) / span)
  const k = 1 - (1 - done) ** 3
  return {
    from: here.from + (target.from - here.from) * k,
    to: here.to + (target.to - here.to) * k,
    done: done >= 1,
  }
}

/**
 * 换数据那一刻留白该照着哪一段铺：缓动还没落地就照它的目标铺，目标本身一个字
 * 都不改——那一帧自己会走到。没在缓动就照换数据前记下的那一段。
 */
export function swapCover(glide: Span | null, hold: Span | null): Span | null {
  return glide ?? hold
}

/* ------------------------------------------------------------ 甩动惯性 */

/**
 * 惯性的手感常数。速度按 e 指数往下掉，每过 FLING_TAU_MS 掉到 1/e。滑行总距离
 * 正好是「松手速度 × TAU」——所以甩得越快滑得越远，是线性的。TAU 取 325ms 时，
 * 1.3 秒后只剩松手速度的 2%，和图库自带的 kinetic 滑停时间（1~1.5 秒）对齐。
 */
export const FLING_TAU_MS = 325
/** 再慢也就滑这么久，到点收手。 */
export const FLING_MAX_MS = 1400
/** 低于这个速度当是「放手」不是「甩」，不起惯性（px/ms）。和图库的门槛同值。 */
export const FLING_MIN_PX_PER_MS = 0.2
/** 快到离谱的一甩（多半是合成事件）也按这个封顶，免得一下滑到天边。 */
export const FLING_MAX_PX_PER_MS = 3
/** 剩下不到半个像素就算停了。 */
const FLING_EPS_PX = 0.5

/** 拖动途中记下的一个指针位置。 */
export interface FlingSample {
  /** 指针的横坐标（px）。 */
  x: number
  /** 这一刻的时间戳（ms）。 */
  at: number
}

/**
 * 松手速度：拿最后这一小段时间（默认 100ms）里的位移除以用时。手在松开之前停住
 * 过，这一段就把那段停顿也算进来，速度自然低于门槛——放手和甩就这么分开。
 */
export function flingSpeed(trail: readonly FlingSample[], windowMs = 100): number {
  const last = trail[trail.length - 1]
  if (!last || trail.length < 2) return 0
  let first = last
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const sample = trail[i]
    if (!sample) continue
    first = sample
    if (last.at - sample.at >= windowMs) break
  }
  const dt = last.at - first.at
  if (!(dt > 0)) return 0
  const speed = (last.x - first.x) / dt
  if (!Number.isFinite(speed)) return 0
  if (Math.abs(speed) < FLING_MIN_PX_PER_MS) return 0
  const capped = Math.min(Math.abs(speed), FLING_MAX_PX_PER_MS)
  return speed < 0 ? -capped : capped
}

/** 惯性走到第 `elapsedMs` 毫秒时，相对松手那一刻一共滑过多少像素。 */
export function flingAt(
  speedPxPerMs: number,
  elapsedMs: number,
  tauMs = FLING_TAU_MS,
): { pastPx: number; done: boolean } {
  const tau = tauMs > 0 ? tauMs : FLING_TAU_MS
  const time = Math.max(0, elapsedMs)
  if (!Number.isFinite(speedPxPerMs) || speedPxPerMs === 0) return { pastPx: 0, done: true }
  const left = Math.exp(-time / tau)
  const total = speedPxPerMs * tau
  const pastPx = total * (1 - left)
  const done = time >= FLING_MAX_MS || Math.abs(total) * left < FLING_EPS_PX
  return { pastPx, done }
}

/**
 * 惯性第 `elapsedMs` 毫秒时视野停在哪。和拖动走的是同一套：位移先换算成毫秒，
 * 再用同一道 `clampSpan` 夹回去。撞上墙就地停住——不回弹，也不抖。
 */
export function flingSpan(
  start: Span,
  msPerPx: number,
  speedPxPerMs: number,
  elapsedMs: number,
  bounds: ViewBounds,
  tauMs = FLING_TAU_MS,
): Span & { done: boolean } {
  const step = flingAt(speedPxPerMs, elapsedMs, tauMs)
  const moved = step.pastPx * msPerPx
  const want = { from: start.from - moved, to: start.to - moved }
  const held = clampSpan(want, bounds)
  const walled = held.from !== want.from
  return { from: held.from, to: held.to, done: step.done || walled }
}

// 当前这一档的规则格子：铺到哪、铺多少、哪一刻落第几格、什么算远跳。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FAR_SCREENS, farJump, glideAt, latticeCap, latticeCovers, latticeEnds, nearEdge,
  needsReassert, nowShowing, planLattice, sameLattice, settled, slotFor, slotOf, swapCover,
  timeOfSlot, viewAim, spanOnBars,
} from '../src/features/relive/chart-span'

const HOUR = 3_600_000
const DAY = 86_400_000
const WEEK = 7 * DAY
const T = Date.UTC(2026, 8, 1)

function lay(over: Partial<Parameters<typeof planLattice>[0]> = {}) {
  const got = planLattice({
    stepMs: HOUR,
    viewFromMs: T,
    viewToMs: T + 10 * HOUR,
    paneWidthPx: 1200,
    ...over,
  })
  assert.ok(got, '这一排格子应该铺得出来')
  return got
}

test('格子覆盖目标视野前后各两屏，两端都在格子里', () => {
  const lat = lay()
  const { startMs, endMs } = latticeEnds(lat)
  assert.ok(startMs <= T - 2 * 10 * HOUR)
  assert.ok(endMs >= T + 10 * HOUR + 2 * 10 * HOUR)
  assert.equal(latticeCovers(lat, T, T + 10 * HOUR), true)
})

test('logical 就是 (ms − origin) / step：整点落整数格，格子外返回 null', () => {
  const lat = lay()
  const at = timeOfSlot(lat, 7)
  assert.equal(slotOf(lat, at), 7)
  assert.equal(slotFor(lat, at), 7)
  // 半根的位置也照算，不四舍五入。
  assert.equal(slotOf(lat, at + HOUR / 2), 7.5)
  assert.equal(slotFor(lat, lat.originMs - HOUR), null)
  assert.equal(slotFor(lat, timeOfSlot(lat, lat.count)), null)
})

test('周线按真实开盘时刻对相位：币安的周一开盘落在整格上', () => {
  // 2019-09-09 是周一；整周数对齐会把它错开成半格。
  const monday = Date.UTC(2019, 8, 9)
  const lat = lay({
    stepMs: WEEK,
    viewFromMs: monday,
    viewToMs: monday + 30 * WEEK,
    anchorMs: monday,
  })
  assert.equal(lat.stepMs, WEEK)
  assert.equal(Number.isInteger(slotOf(lat, monday)), true)
  assert.equal(Number.isInteger(slotOf(lat, monday + 12 * WEEK)), true)
  assert.equal(timeOfSlot(lat, slotFor(lat, monday + 12 * WEEK) as number), monday + 12 * WEEK)
})

test('跨年远跳：2019 年那一屏在 4h 档上照样精确落格', () => {
  const back = Date.UTC(2019, 8, 8)
  const lat = lay({ stepMs: 4 * HOUR, viewFromMs: back, viewToMs: back + 50 * 4 * HOUR, anchorMs: T })
  const slot = slotFor(lat, back + 33 * 4 * HOUR)
  assert.notEqual(slot, null)
  assert.equal(timeOfSlot(lat, slot as number), back + 33 * 4 * HOUR)
  // 七年的跨度不会把点数撑爆。
  assert.ok(lat.count <= latticeCap(1200))
})

test('点数封顶：跨度再大也只铺五屏最密那么多，目标视野居中', () => {
  const cap = latticeCap(800)
  assert.equal(cap, Math.ceil((5 * 800) / 0.4))
  const lat = lay({
    stepMs: 60_000,
    viewFromMs: Date.UTC(2019, 0, 1),
    viewToMs: Date.UTC(2026, 0, 1),
    paneWidthPx: 800,
  })
  assert.equal(lat.count, cap)
  const middle = (Date.UTC(2019, 0, 1) + Date.UTC(2026, 0, 1)) / 2
  const { startMs, endMs } = latticeEnds(lat)
  assert.ok(startMs < middle && endMs > middle)
})

test('右边最多铺到现在，未来那一段连时间轴都不给', () => {
  const lat = lay({ viewFromMs: T, viewToMs: T + 10 * HOUR, nowMs: T + 12 * HOUR })
  assert.ok(latticeEnds(lat).endMs <= T + 12 * HOUR + HOUR)
})

test('跨度不合法、步长为零：一排都不铺', () => {
  assert.equal(planLattice({ stepMs: 0, viewFromMs: T, viewToMs: T + HOUR, paneWidthPx: 1200 }), null)
  assert.equal(planLattice({ stepMs: HOUR, viewFromMs: T, viewToMs: T, paneWidthPx: 1200 }), null)
  assert.equal(planLattice({ stepMs: HOUR, viewFromMs: Number.NaN, viewToMs: T, paneWidthPx: 1200 }), null)
})

test('远跳：出了格子、换了档、或者隔着三屏以上都算，近处不算', () => {
  const lat = lay()
  const here = { from: T, to: T + 10 * HOUR }
  // 还在格子里、只挪了一屏：不算远跳，可以缓动过去。
  assert.equal(farJump(here, { from: T + 10 * HOUR, to: T + 20 * HOUR }, lat), false)
  // 隔着三屏以上。
  const far = { from: T + FAR_SCREENS * 10 * HOUR + 20 * HOUR, to: T + FAR_SCREENS * 10 * HOUR + 30 * HOUR }
  assert.equal(farJump(here, far, lat), true)
  // 目标出了格子（2019 年）。
  assert.equal(farJump(here, { from: Date.UTC(2019, 8, 8), to: Date.UTC(2019, 8, 10) }, lat), true)
  // 还没有格子、或者还不知道现在在哪：一律直接落位。
  assert.equal(farJump(here, { from: T, to: T + HOUR }, null), true)
  assert.equal(farJump(null, { from: T, to: T + HOUR }, lat), true)
})

test('视野走到离边缘不足一屏就该重铺，中间不重铺', () => {
  const lat = lay()
  assert.equal(nearEdge(lat, T, T + 10 * HOUR), false)
  const { startMs, endMs } = latticeEnds(lat)
  assert.equal(nearEdge(lat, startMs + HOUR, startMs + 11 * HOUR), true)
  assert.equal(nearEdge(lat, endMs - 11 * HOUR, endMs - HOUR), true)
})

test('同一排格子重铺出来还是它，就不用换数据', () => {
  const a = lay()
  const b = lay()
  assert.equal(sameLattice(a, b), true)
  assert.equal(sameLattice(a, { ...a, count: a.count + 1 }), false)
  assert.equal(sameLattice(a, null), false)
  assert.equal(sameLattice(null, null), true)
})

test('换档：同一段时间在新一档的格子上还是同一段时间', () => {
  const view = { from: Date.UTC(2026, 7, 20), to: Date.UTC(2026, 7, 28) }
  const half = lay({ stepMs: 30 * 60_000, viewFromMs: view.from, viewToMs: view.to, anchorMs: T })
  const four = lay({ stepMs: 4 * HOUR, viewFromMs: view.from, viewToMs: view.to, anchorMs: T })
  // 视野的两头按毫秒存、按新格子现算下标：换完档，那两个下标指回的还是同一刻。
  for (const lat of [half, four]) {
    assert.ok(latticeCovers(lat, view.from, view.to))
    assert.equal(timeOfSlot(lat, slotOf(lat, view.from)), view.from)
    assert.equal(timeOfSlot(lat, slotOf(lat, view.to)), view.to)
  }
  // 换了档就是另一排格子，数据必须重铺。
  assert.equal(sameLattice(half, four), false)
})

/* ---- 落位是延迟生效的：这段时间里「现在看的是哪儿」得认要去的那一段 ---- */

const HERE = { from: T, to: T + 10 * HOUR }
const WANT = { from: T + 40 * HOUR, to: T + 50 * HOUR }

test('落位还没生效的这会儿，问「看的是哪儿」答的是要去的那一段', () => {
  const held = viewAim()
  assert.equal(held.want(), null)
  held.aim(WANT)
  // 图这会儿还停在原处（setVisibleLogicalRange 要等它自己那一帧），不认它。
  held.settle(true, HERE, HOUR)
  assert.deepEqual(held.want(), WANT)
  assert.deepEqual(nowShowing(held.want(), HERE, null), WANT)
})

test('图走到了就放手：两头差不到一格算走到', () => {
  const held = viewAim()
  held.aim(WANT)
  // 差了三格：还在路上。
  held.settle(true, { from: WANT.from + 3 * HOUR, to: WANT.to + 3 * HOUR }, HOUR)
  assert.notEqual(held.want(), null)
  // 到位了。
  held.settle(true, WANT, HOUR)
  assert.equal(held.want(), null)
  assert.equal(settled(WANT, { from: WANT.from + 2 * HOUR, to: WANT.to }, HOUR), false)
})

test('人自己拖过一下就作废：后面的 resize 不会把他拉回原处', () => {
  const held = viewAim()
  held.aim(WANT)
  // 非程序性的那一次范围变化 = 人手在动。
  const moved = { from: T + 3 * HOUR, to: T + 13 * HOUR }
  held.settle(false, moved, HOUR)
  assert.equal(held.want(), null)
  // 人动过手之后，「现在看的是哪儿」立刻改口认图自己的范围，不会把人拉回去。
  assert.deepEqual(nowShowing(held.want(), moved, null), moved)
})

test('要去哪不按数据快慢过期：数据两三秒才回来，回来了还认这个目标', () => {
  const held = viewAim()
  held.aim(WANT)
  // 远跳的 bar 三秒后才到；这段时间里问几次，答的都还是这个目标。
  assert.deepEqual(held.want(), WANT)
  held.settle(true, { from: WANT.from + 3 * HOUR, to: WANT.to + 3 * HOUR }, HOUR)
  assert.deepEqual(held.want(), WANT)
  // 图真的走到了，或者人自己动了手，才作废。
  held.settle(true, WANT, HOUR)
  assert.equal(held.want(), null)

  const moved = viewAim()
  moved.aim(WANT)
  moved.settle(false, HERE, HOUR)
  assert.equal(moved.want(), null)
  const dropped = viewAim()
  dropped.aim(WANT)
  dropped.drop()
  assert.equal(dropped.want(), null)
})

test('resize 之后重放的就是这一段，退出全屏则直接放下', () => {
  const held = viewAim()
  held.aim(WANT)
  // 画布宽变了、格子要按新宽度重铺，重放用的还是同一段时间。
  assert.deepEqual(held.want(), WANT)
  assert.deepEqual(held.want(), WANT)
  held.drop()
  assert.equal(held.want(), null)
})

/* ---- 还该不该再催图落一次位 ---- */

test('图那边一片空白就得催，落到了就别催——不然每帧补一发成了死循环', () => {
  assert.equal(needsReassert(null, null, HOUR), false)
  assert.equal(needsReassert(WANT, null, HOUR), true)
  assert.equal(needsReassert(WANT, HERE, HOUR), true)
  assert.equal(needsReassert(WANT, WANT, HOUR), false)
})

/* ---- 「现在看的是哪一段」按什么顺序回答 ---- */

test('没目标也没范围的时候，认整排格子；三样都没有就说不出来', () => {
  const ends = { from: T - 5 * HOUR, to: T + 100 * HOUR }
  assert.deepEqual(nowShowing(null, HERE, ends), HERE)
  assert.deepEqual(nowShowing(null, null, ends), ends)
  assert.equal(nowShowing(null, null, null), null)
})

test('缓动：第 0 毫秒在起点，到时间落在目标上', () => {
  const here = { from: T, to: T + 10 * HOUR }
  const target = { from: T + 100 * HOUR, to: T + 110 * HOUR }
  const begun = glideAt(here, target, 0)
  assert.equal(begun.from, here.from)
  assert.equal(begun.done, false)
  const ended = glideAt(here, target, 240)
  assert.deepEqual({ from: ended.from, to: ended.to }, target)
  assert.equal(ended.done, true)
  // 掉帧掉过头也不会冲过目标。
  const late = glideAt(here, target, 5_000)
  assert.deepEqual({ from: late.from, to: late.to }, target)
})

test('缓动中间那一帧在起点和目标之间，跨度不塌', () => {
  const here = { from: T, to: T + 10 * HOUR }
  const target = { from: T + 100 * HOUR, to: T + 110 * HOUR }
  const mid = glideAt(here, target, 120)
  assert.ok(mid.from > here.from && mid.from < target.from)
  assert.ok(mid.to > here.to && mid.to < target.to)
  assert.ok(Math.abs((mid.to - mid.from) - 10 * HOUR) < 1)
})

test('缓动中途换了数据：留白照缓动的目标铺，目标一个字不改', () => {
  const glide = { from: T + 100 * HOUR, to: T + 110 * HOUR }
  const hold = { from: T, to: T + 10 * HOUR }
  assert.equal(swapCover(glide, hold), glide)
  // 没在缓动才照换数据前记下的那一段。
  assert.equal(swapCover(null, hold), hold)
  assert.equal(swapCover(null, null), null)
})

/* ---- D9：拖到上市之前，目标到不了的时候必须认账，不然就是空白死锁 ---- */

test('图连着到不了的目标：坚持够久就认图的说法，不再一帧一帧把人弹回空白处', () => {
  // SKHY 这种上市不久的：Shift+Home 到上市处，再往右拖越过上市前那一片空白。
  // 那一段一根真 bar 都没有，图的 rAF 把视野钳在格子边上，`settled()` 永远不
  // 成立。旧版「不按时间过期」于是让「现在看的是哪儿」永远答那一段空白：取数
  // 按它取（取回来还是空）、视野每帧被弹回去、人手那一拖也被当成程序自己在动。
  let clock = 0
  const held = viewAim(() => clock, 6000)
  held.aim(WANT)
  const CLAMPED = { from: WANT.from - 400 * HOUR, to: WANT.to - 400 * HOUR }
  // 远跳的数据两三秒才回来：这段时间里还得认目标，不然远跳当场就散了。
  clock = 2500
  held.settle(true, CLAMPED, HOUR)
  assert.deepEqual(held.want(), WANT)
  // 坚持过了头还没走到 = 它到不了。认图的说法，人拖到哪儿就是哪儿。
  clock = 6500
  held.settle(true, CLAMPED, HOUR)
  assert.equal(held.want(), null)
  assert.deepEqual(nowShowing(held.want(), CLAMPED, null), CLAMPED)
  assert.equal(needsReassert(held.want(), CLAMPED, HOUR), false)
})

test('认账只看「到不了」：读一次 want 就过期，不用等下一发范围变化', () => {
  let clock = 0
  const held = viewAim(() => clock, 6000)
  held.aim(WANT)
  clock = 6001
  assert.equal(held.want(), null)
  // 重新瞄一次，期限跟着重算。
  held.aim(WANT)
  assert.deepEqual(held.want(), WANT)
})

/* ---- D11：滑动时并进来一段新数据，眼前这一段不许位移 ---- */

test('合并前后同一时间对应的可见 logical 区间不变：换了格子也一根不挪', () => {
  // 往左拖着拖着并进来一块 tile：真 bar 的第一根变了（相位跟着变）、格子按新视
  // 野重铺。合并前把可见区间记成时间，合并后按新格子把同一段时间算回 logical，
  // 这一步必须无损——差一格人就看见图跳了一下。
  const view = { from: T - 30 * HOUR, to: T - 20 * HOUR }
  const before = lay({ viewFromMs: view.from, viewToMs: view.to, anchorMs: T })
  const seen = { from: slotOf(before, view.from), to: slotOf(before, view.to) }
  assert.equal(timeOfSlot(before, seen.from), view.from)
  assert.equal(timeOfSlot(before, seen.to), view.to)

  // 新来的这块 tile 把第一根真 bar 推到更早、相位也错开半小时。
  const after = lay({ viewFromMs: view.from, viewToMs: view.to, anchorMs: T - 500 * HOUR + HOUR / 2 })
  assert.equal(sameLattice(before, after), false, '这一趟确实换了格子，测的才是换格子这件事')
  const back = { from: slotOf(after, view.from), to: slotOf(after, view.to) }
  assert.equal(timeOfSlot(after, back.from), view.from)
  assert.equal(timeOfSlot(after, back.to), view.to)
  // 一根多宽没变，眼前这一段的格数就该原样。
  assert.ok(Math.abs((back.to - back.from) - (seen.to - seen.from)) < 1e-9, '可见跨度不变')
})

test('合并时的时间锁只认时间：直接沿用旧下标才会跳', () => {
  const view = { from: T - 30 * HOUR, to: T - 20 * HOUR }
  const before = lay({ viewFromMs: view.from, viewToMs: view.to, anchorMs: T })
  const after = lay({ viewFromMs: view.from - 400 * HOUR, viewToMs: view.to - 400 * HOUR, anchorMs: T })
  const seen = { from: slotOf(before, view.from), to: slotOf(before, view.to) }
  // 旧下标搬到新格子上是另一段时间——这就是「突然跳一下」的那一下。
  assert.notEqual(timeOfSlot(after, seen.from), view.from)
  // 按时间换算回来才对得上。
  assert.equal(timeOfSlot(after, slotOf(after, view.from)), view.from)
})

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

test('换档算出来的一段压着行情就原样不动', () => {
  const onboard = Date.UTC(2026, 6, 1)
  const last = Date.UTC(2026, 8, 13)
  const span = { from: Date.UTC(2026, 7, 1), to: Date.UTC(2026, 7, 5) }
  assert.deepEqual(spanOnBars(span, HOUR_MS, { firstMs: onboard, lastMs: last }), span)
})

test('整段落在上市之前：左端贴住第一根，跨度一个字不改', () => {
  const onboard = Date.UTC(2026, 6, 1)
  const last = Date.UTC(2026, 8, 13)
  const span = { from: Date.UTC(2026, 2, 15), to: Date.UTC(2026, 5, 10) }
  const out = spanOnBars(span, 4 * HOUR_MS, { firstMs: onboard, lastMs: last })
  assert.equal(out.from, onboard, '左端落在上市那一刻')
  assert.equal(out.to - out.from, span.to - span.from, '跨度不变，根宽就不变')
})

test('整段落在最后一根右边：右端贴住最后一根', () => {
  const onboard = Date.UTC(2026, 6, 1)
  const last = Date.UTC(2026, 8, 13)
  const span = { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 11) }
  const out = spanOnBars(span, DAY_MS, { firstMs: onboard, lastMs: last })
  assert.equal(out.to, last + DAY_MS, '最后一根自己占一格，右端算到它收盘')
  assert.equal(out.to - out.from, span.to - span.from)
})

test('只压着不到一根也算没压着，照样挪回去', () => {
  const onboard = Date.UTC(2026, 6, 1)
  const span = { from: Date.UTC(2026, 5, 1), to: onboard + 10 * MIN_MS }
  const out = spanOnBars(span, HOUR_MS, { firstMs: onboard, lastMs: Date.UTC(2026, 8, 13) })
  assert.equal(out.from, onboard)
})

test('两头都不知道、跨度算不出来，就别动人家的视野', () => {
  const span = { from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 3, 1) }
  assert.deepEqual(spanOnBars(span, HOUR_MS, {}), span)
  assert.deepEqual(spanOnBars(span, HOUR_MS, { firstMs: null, lastMs: null }), span)
  assert.deepEqual(spanOnBars(span, 0, { firstMs: 1, lastMs: 2 }), span)
  assert.deepEqual(spanOnBars({ from: 5, to: 5 }, HOUR_MS, { firstMs: 1, lastMs: 2 }), { from: 5, to: 5 })
})

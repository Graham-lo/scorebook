// 视野的两条硬规矩。
//
// 一、无论往哪边拖多久，视野只能待在「上市前一屏」到「现在再加一点」之间。
// 二、tile 到达、格子重铺、攒着的数据放出来，都不许把视野从这一段时间上挪开。
//
// 第二条靠的是图内部量滚动位置的那把尺子：`rightOffset` 数的是从「最后一根真
// K 线」那一格往右还有几格。尺子指的时刻不变，视野就不动；格子里一根真的都不
// 剩，尺子退回第 0 格，视野当场被拽到格子左端——往过去拖着拖着整张图跑到上市
// 之前、再也拖不回来，就是这么来的。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampSpan, keepInView, latticeEnds, latticeHolds, planLattice, slotOf, timeOfSlot, viewAfterSwap,
} from '../src/features/relive/chart-span'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const STEP = 30 * MIN
const WIDTH = 1250

/** 上市那一刻、和「现在」。 */
const ONBOARD = Date.UTC(2019, 8, 8)
const NOW = Date.UTC(2026, 8, 13)
/** 一屏 = 200 根 30 分钟。 */
const SCREEN = 200 * STEP

/* ------------------------------------------------------------ 一、夹取 */

test('夹取：拖到上市之前，左边最多露一屏空白', () => {
  const bounds = { minFromMs: ONBOARD - SCREEN, maxToMs: NOW + STEP }
  const got = clampSpan({ from: ONBOARD - 40 * SCREEN, to: ONBOARD - 39 * SCREEN }, bounds)
  assert.equal(got.from, ONBOARD - SCREEN)
  assert.equal(got.to - got.from, SCREEN)
})

test('夹取：往未来拖，右边停在现在加一点留白', () => {
  const bounds = { minFromMs: ONBOARD - SCREEN, maxToMs: NOW + STEP }
  const got = clampSpan({ from: NOW + 10 * SCREEN, to: NOW + 11 * SCREEN }, bounds)
  assert.equal(got.to, NOW + STEP)
  assert.equal(got.to - got.from, SCREEN)
})

test('夹取：本来就在范围里的一段一个字都不动', () => {
  const bounds = { minFromMs: ONBOARD - SCREEN, maxToMs: NOW + STEP }
  const span = { from: Date.UTC(2021, 4, 3), to: Date.UTC(2021, 4, 10) }
  assert.deepEqual(clampSpan(span, bounds), span)
})

test('格子的左端不会越过上市前那一屏', () => {
  const lattice = planLattice({
    stepMs: STEP,
    viewFromMs: ONBOARD - 30 * SCREEN,
    viewToMs: ONBOARD - 29 * SCREEN,
    paneWidthPx: WIDTH,
    nowMs: NOW,
    minStartMs: ONBOARD - SCREEN,
  })
  assert.ok(lattice)
  assert.ok(latticeEnds(lattice).startMs >= ONBOARD - SCREEN - STEP)
})

/* ------------------------- 二、数据和格子的动静不许挪动视野 */

test('格子里永远留得住一根真 K 线', () => {
  // 视野拖到上市之前整整三十屏：按视野 ±2 屏铺出来的格子一根真的都圈不住。
  const view = { from: ONBOARD - 30 * SCREEN, to: ONBOARD - 29 * SCREEN }
  const naive = planLattice({
    stepMs: STEP, viewFromMs: view.from, viewToMs: view.to, paneWidthPx: WIDTH, nowMs: NOW,
  })
  assert.ok(naive)
  assert.equal(latticeHolds(naive, ONBOARD, ONBOARD + 2000 * STEP), false)
  const kept = planLattice({
    stepMs: STEP, viewFromMs: view.from, viewToMs: view.to, paneWidthPx: WIDTH, nowMs: NOW,
    keepMs: keepInView(view.from, view.to, ONBOARD, ONBOARD + 2000 * STEP),
  })
  assert.ok(kept)
  assert.equal(latticeHolds(kept, ONBOARD, ONBOARD + 2000 * STEP), true)
})

test('换一排格子：同一刻的下标整排一起挪，挪的还是同一个数', () => {
  // 图量滚动位置用的是下标。只要两排格子相位一样，任意一刻的下标只差一个常数，
  // 整幅画就是整体平移——把那个常数补回去，人看见的一段时间一毫秒都不会变。
  const first = planLattice({
    stepMs: STEP, viewFromMs: Date.UTC(2021, 4, 3), viewToMs: Date.UTC(2021, 4, 3) + SCREEN,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
  })
  const grown = planLattice({
    stepMs: STEP, viewFromMs: Date.UTC(2021, 3, 20), viewToMs: Date.UTC(2021, 3, 20) + SCREEN,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD, keepMs: Date.UTC(2021, 4, 5),
  })
  assert.ok(first)
  assert.ok(grown)
  const at = [Date.UTC(2021, 3, 25), Date.UTC(2021, 4, 3), Date.UTC(2021, 4, 5)]
  const gaps = at.map((ms) => slotOf(grown, ms) - slotOf(first, ms))
  assert.ok(gaps.every((gap) => gap === gaps[0]), `整排没有一起挪：${gaps.join(',')}`)
})

test('左边并进一段历史：同一段时间还在同一段时间上', () => {
  const view = { from: Date.UTC(2021, 4, 3), to: Date.UTC(2021, 4, 3) + SCREEN }
  const before = planLattice({
    stepMs: STEP, viewFromMs: view.from, viewToMs: view.to,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
  })
  assert.ok(before)
  const lastBar = Date.UTC(2021, 4, 5)
  const after = planLattice({
    stepMs: STEP, viewFromMs: view.from - SCREEN, viewToMs: view.to - SCREEN,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
    keepMs: lastBar,
  })
  assert.ok(after)
  const moved = viewAfterSwap(
    view,
    { lattice: before, lastBarMs: lastBar },
    { lattice: after, lastBarMs: lastBar },
  )
  assert.deepEqual(moved, view)
})

test('格子里一根真的都不剩：尺子退回第 0 格，视野被拽到格子左端', () => {
  const view = { from: Date.UTC(2021, 4, 3), to: Date.UTC(2021, 4, 3) + SCREEN }
  const before = planLattice({
    stepMs: STEP, viewFromMs: view.from, viewToMs: view.to,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
  })
  assert.ok(before)
  const lastBar = Date.UTC(2021, 4, 5)
  const runaway = planLattice({
    stepMs: STEP, viewFromMs: Date.UTC(2019, 0, 1), viewToMs: Date.UTC(2019, 0, 1) + SCREEN,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
  })
  assert.ok(runaway)
  const moved = viewAfterSwap(
    view,
    { lattice: before, lastBarMs: lastBar },
    { lattice: runaway, lastBarMs: lastBar },
  )
  assert.notDeepEqual(moved, view)
})

test('换一排格子之后，按时间算回来的下标指的还是同一刻', () => {
  const a = planLattice({
    stepMs: STEP, viewFromMs: Date.UTC(2021, 4, 3), viewToMs: Date.UTC(2021, 4, 3) + SCREEN,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
  })
  const b = planLattice({
    stepMs: STEP, viewFromMs: Date.UTC(2021, 3, 1), viewToMs: Date.UTC(2021, 3, 1) + SCREEN,
    paneWidthPx: WIDTH, nowMs: NOW, anchorMs: ONBOARD,
  })
  assert.ok(a && b)
  const when = Date.UTC(2021, 4, 3) + 7 * HOUR
  assert.equal(Math.round(timeOfSlot(b, slotOf(b, when)) / DAY), Math.round(when / DAY))
  assert.notEqual(slotOf(a, when), slotOf(b, when))
})

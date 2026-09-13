// 导航条的算术：像素和时间怎么换、拖一下之后眼前那一段变成哪一段、年份刻度挤
// 不下的时候隔几年画一根。这一层不碰 DOM。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import {
  EDGE_PX, MIN_SPAN_MS, MIN_WINDOW_PX, bands, dragTo, grabAt, linePoints, navTime, navX,
  windowBox, yearTicks, type NavSpan,
} from '../src/features/relive/history/navigator'

const DAY = 86_400_000
const span: NavSpan = { fromMs: 0, toMs: 1000 * DAY, widthPx: 500 }

test('时间和像素两头都能换回去', () => {
  assert.equal(navX(0, span), 0)
  assert.equal(navX(1000 * DAY, span), 500)
  assert.equal(navX(500 * DAY, span), 250)
  assert.equal(navTime(250, span), 500 * DAY)
  assert.equal(navTime(navX(123 * DAY, span), span), 123 * DAY)
})

test('条还没量出宽度的时候不出 NaN', () => {
  const flat: NavSpan = { fromMs: 0, toMs: 0, widthPx: 0 }
  assert.equal(navX(5, flat), 0)
  assert.equal(navTime(5, flat), 0)
})

test('眼前那一段窄到看不见也留 6 像素，不然抓不着', () => {
  const box = windowBox({ fromMs: 10 * DAY, toMs: 10 * DAY + 1000 }, span)
  assert.equal(box.width, MIN_WINDOW_PX)
  assert.ok(Math.abs(box.left - 5) < 0.01)
})

test('按下的位置决定是拉边还是拖着走', () => {
  const box = { left: 100, width: 60 }
  assert.equal(grabAt(100, box), 'left')
  assert.equal(grabAt(100 + EDGE_PX - 1, box), 'left')
  assert.equal(grabAt(160, box), 'right')
  assert.equal(grabAt(130, box), 'move')
  assert.equal(grabAt(20, box), 'empty')
})

test('窗口窄到 6px 时整块都算拖着走，不再分左右边', () => {
  const box = { left: 100, width: MIN_WINDOW_PX }
  assert.equal(grabAt(100, box), 'move')
  assert.equal(grabAt(103, box), 'move')
  assert.equal(grabAt(106, box), 'move')
  assert.equal(grabAt(100 - EDGE_PX, box), 'move', '边上 8px 的容差还在')
  assert.equal(grabAt(106 + EDGE_PX, box), 'move')
  assert.equal(grabAt(60, box), 'empty')
})

test('窗口够宽还是分左右边', () => {
  const box = { left: 100, width: 60 }
  assert.equal(grabAt(100, box), 'left')
  assert.equal(grabAt(160, box), 'right')
  assert.equal(grabAt(130, box), 'move')
})

test('拖着走是整段平移，跨度不变', () => {
  const next = dragTo('move', { fromMs: 10 * DAY, toMs: 20 * DAY }, 5 * DAY, 0)
  assert.deepEqual(next, { fromMs: 15 * DAY, toMs: 25 * DAY })
})

test('拉边只动一头，而且不许穿过对面，最少留一天', () => {
  const view = { fromMs: 10 * DAY, toMs: 20 * DAY }
  assert.deepEqual(dragTo('left', view, 0, 12 * DAY), { fromMs: 12 * DAY, toMs: 20 * DAY })
  assert.deepEqual(dragTo('right', view, 0, 18 * DAY), { fromMs: 10 * DAY, toMs: 18 * DAY })
  assert.deepEqual(dragTo('left', view, 0, 99 * DAY), { fromMs: 20 * DAY - MIN_SPAN_MS, toMs: 20 * DAY })
  assert.deepEqual(dragTo('right', view, 0, 0), { fromMs: 10 * DAY, toMs: 10 * DAY + MIN_SPAN_MS })
})

test('点空白把眼前这一段的中心挪过去，跨度不变', () => {
  const next = dragTo('empty', { fromMs: 10 * DAY, toMs: 20 * DAY }, 0, 100 * DAY)
  assert.deepEqual(next, { fromMs: 95 * DAY, toMs: 105 * DAY })
})

test('年份刻度：挤得下一年一根，挤不下就隔几年一根', () => {
  const wide: NavSpan = { fromMs: Date.UTC(2018, 0, 1), toMs: Date.UTC(2026, 0, 1), widthPx: 800 }
  const loose = yearTicks(wide)
  assert.deepEqual(loose.map((t) => t.year), [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
  const narrow: NavSpan = { ...wide, widthPx: 120 }
  const thin = yearTicks(narrow)
  assert.ok(thin.length < loose.length, '窄的时候要抽掉一些')
  assert.equal(thin[0]?.year, 2018)
})

test('取过的那几段相邻就并成一条', () => {
  const merged = bands([
    { fromMs: 100 * DAY, toMs: 200 * DAY },
    { fromMs: 150 * DAY, toMs: 260 * DAY },
    { fromMs: 400 * DAY, toMs: 500 * DAY },
  ], span)
  assert.equal(merged.length, 2)
  assert.ok(Math.abs(merged[0]!.left - 50) < 0.01)
  assert.ok(Math.abs(merged[0]!.width - 80) < 0.01)
})

test('一列像素只留一个点：几千根压成几百个点', () => {
  const bars: Bar[] = []
  for (let i = 0; i < 1000; i += 1) {
    const at = i * DAY
    bars.push({
      start: new Date(at).toISOString(), end: new Date(at + DAY).toISOString(),
      open: '1', high: '2', low: '0.5', close: String(100 + i), volume: '1',
    })
  }
  const points = linePoints(bars, span, 20)
  assert.ok(points.length <= 501, `一列一个点，实际 ${points.length}`)
  assert.ok(points.length > 400)
  assert.ok(points[0]!.y > points[points.length - 1]!.y, '价格越高，y 越小')
})

test('上市三天的品种：几年长的条上压成一个点，也得有这个点', () => {
  // SKHY 这种：整条命只有三根 1d。压完只剩一个点，画的那一头不能因为「不足两
  // 个点」就什么都不画——那看起来就是「导航条一直没取到」。
  const life: NavSpan = { fromMs: 0, toMs: 1095 * DAY, widthPx: 500 }
  const bars: Bar[] = [0, 1, 2].map((i) => ({
    start: new Date(1092 * DAY + i * DAY).toISOString(),
    end: new Date(1093 * DAY + i * DAY).toISOString(),
    open: '1', high: '2', low: '0.5', close: String(10 + i), volume: '1',
  }))
  const points = linePoints(bars, life, 20)
  assert.ok(points.length >= 1, `有几根画几根，实际 ${points.length}`)
  assert.ok(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
})

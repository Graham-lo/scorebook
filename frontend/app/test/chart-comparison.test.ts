import test from 'node:test'
import assert from 'node:assert/strict'
import { compareOutline, followingStats, marketOutline } from '../src/data/chart-comparison'
import type { Bar } from '../src/api/types'
const bar = (hour: number, low: number, high: number, close: number): Bar => ({
  start: `2026-09-01T${String(hour).padStart(2, '0')}:00:00Z`, end: `2026-09-01T${String(hour + 1).padStart(2, '0')}:00:00Z`,
  open: String(low), low: String(low), high: String(high), close: String(close),
})
const original = [bar(0, 10, 20, 15), bar(1, 12, 18, 16), bar(2, 14, 19, 18)]
const cutoff = original[2]!.end
test('虚线只线性映射截图轮廓；再多后续行情也不改变拟合或延长虚线', () => {
  const a = compareOutline([0, 1, 0], original, cutoff)
  assert.deepEqual(a.map(p => p.value), [10, 20, 10])
  const b = compareOutline([0, 1, 0], [...original, bar(3, 1, 1000, 500)], cutoff)
  assert.deepEqual(a, b)
  assert.equal(a.at(-1)!.time, Date.parse(original[2]!.start) / 1000)
  assert.deepEqual(compareOutline([1, Number.NaN], original, cutoff), [])
})
test('不同根数保持时间顺序及端点，不做局部时间扭曲', () => {
  assert.deepEqual(compareOutline([0.2, 0.8], original, cutoff).map(p => p.value), [12, 15, 18])
})
test('后续涨跌以匹配截止收盘为基准；图中根不混入后续统计', () => {
  assert.equal(followingStats(original, cutoff), null)
  const actual = followingStats([...original, bar(3, 9, 36, 27)], cutoff)!
  assert.equal(actual.count, 1)
  assert.equal(actual.close, 50)
  assert.equal(actual.high, 100)
  assert.equal(actual.low, -50)
})


test('已定位截图的虚线使用真实收盘，窗口外的行情不会改变归一化', () => {
  const bars = [
    { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z', open: '12', high: '20', low: '10', close: '15' },
    { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z', open: '15', high: '30', low: '15', close: '25' },
    { start: '2026-01-03T00:00:00Z', end: '2026-01-04T00:00:00Z', open: '25', high: '100', low: '1', close: '80' },
  ]
  assert.deepEqual(marketOutline(bars, bars[0]!.start, bars[1]!.end), [0.25, 0.75])
})

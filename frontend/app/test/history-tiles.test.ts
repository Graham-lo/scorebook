// 格子怎么切、覆盖表怎么合、两份 bars 怎么并。
//
// 这一层一根网络都不发，全是算术。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import {
  Coverage, TILE_BARS, barSpanMs, mergeBars, spaceKeyString, tileIndex, tileKeyString,
  tileRange, tileSpanMs, tilesBetween,
} from '../src/features/relive/history/tiles'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

function bar(at: number, close = '100'): Bar {
  return {
    start: new Date(at).toISOString(),
    end: new Date(at + HOUR).toISOString(),
    open: '100', high: '101', low: '99', close, volume: '10',
  }
}

test('一格就是 1000 根那么久', () => {
  assert.equal(tileSpanMs('1m'), TILE_BARS * MIN)
  assert.equal(tileSpanMs('1h'), TILE_BARS * HOUR)
  assert.equal(tileSpanMs('1d'), TILE_BARS * DAY)
})

test('周线一格 1000 周、月线一格 1000 个 30 天', () => {
  assert.equal(tileSpanMs('1w'), TILE_BARS * 7 * DAY)
  assert.equal(tileSpanMs('1M'), TILE_BARS * 30 * DAY)
})

test('认不出来的周期按 1 分钟算，不抛异常', () => {
  assert.equal(tileSpanMs('7s'), TILE_BARS * MIN)
  assert.equal(barSpanMs('7s'), MIN)
})

test('一根有多长：1M 按 30 天估', () => {
  assert.equal(barSpanMs('1h'), HOUR)
  assert.equal(barSpanMs('1M'), 30 * DAY)
})

test('桶起落在这一格，桶止那一刻属于下一格', () => {
  const span = tileSpanMs('1h')
  assert.equal(tileIndex(span * 3, '1h'), 3)
  assert.equal(tileIndex(span * 4 - 1, '1h'), 3)
  assert.equal(tileIndex(span * 4, '1h'), 4)
})

test('tileRange 和 tileIndex 对得上', () => {
  const { startMs, endMs } = tileRange(7, '15m')
  assert.equal(tileIndex(startMs, '15m'), 7)
  assert.equal(tileIndex(endMs - 1, '15m'), 7)
  assert.equal(endMs - startMs, tileSpanMs('15m'))
})

test('一段视野对应一串连续的格子', () => {
  const span = tileSpanMs('1h')
  assert.deepEqual(tilesBetween(span * 2 + 5, span * 4 + 5, '1h'), [2, 3, 4])
  assert.deepEqual(tilesBetween(span * 2, span * 2, '1h'), [2])
})

test('区间反着给就是空的', () => {
  assert.deepEqual(tilesBetween(1000, 0, '1h'), [])
  assert.deepEqual(tilesBetween(Number.NaN, 10, '1h'), [])
})

test('键里有市场、品种、周期、格号', () => {
  const key = { market: 'usd_m' as const, symbol: 'BTCUSDT', interval: '1h', index: 12 }
  assert.equal(tileKeyString(key), 'usd_m/BTCUSDT/1h/12')
  assert.equal(spaceKeyString(key), 'usd_m/BTCUSDT/1h')
})

test('覆盖表：相邻的两段合成一段', () => {
  const cover = new Coverage()
  cover.add(0, 100)
  cover.add(100, 200)
  assert.deepEqual(cover.ranges(), [[0, 200]])
})

test('覆盖表：重叠的合并', () => {
  const cover = new Coverage()
  cover.add(0, 100)
  cover.add(60, 180)
  assert.deepEqual(cover.ranges(), [[0, 180]])
})

test('覆盖表：被包含的不会把大段切小', () => {
  const cover = new Coverage()
  cover.add(0, 400)
  cover.add(100, 200)
  assert.deepEqual(cover.ranges(), [[0, 400]])
})

test('覆盖表：乱序加进来也还是有序不相交', () => {
  const cover = new Coverage()
  cover.add(300, 400)
  cover.add(0, 100)
  cover.add(150, 260)
  assert.deepEqual(cover.ranges(), [[0, 100], [150, 260], [300, 400]])
  cover.add(90, 160)
  assert.deepEqual(cover.ranges(), [[0, 260], [300, 400]])
})

test('覆盖表：空区间不记', () => {
  const cover = new Coverage()
  cover.add(100, 100)
  cover.add(200, 100)
  assert.deepEqual(cover.ranges(), [])
})

test('缺的那几段：中间的洞、两头露出来的', () => {
  const cover = new Coverage()
  cover.add(100, 200)
  cover.add(300, 400)
  assert.deepEqual(cover.missing(0, 500), [[0, 100], [200, 300], [400, 500]])
  assert.deepEqual(cover.missing(120, 180), [])
  assert.deepEqual(cover.missing(150, 350), [[200, 300]])
})

test('covers 就是「一段都不缺」', () => {
  const cover = new Coverage()
  cover.add(0, 1000)
  assert.equal(cover.covers(10, 900), true)
  assert.equal(cover.covers(900, 1100), false)
  assert.equal(cover.covers(2000, 2100), false)
})

test('并 bars：按开盘时间升序、去重', () => {
  const have = [bar(0), bar(HOUR), bar(2 * HOUR)]
  const more = [bar(3 * HOUR), bar(HOUR)]
  const out = mergeBars(have, more)
  assert.equal(out.length, 4)
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(Date.parse(out[i]!.start) > Date.parse(out[i - 1]!.start))
  }
})

test('并 bars：同一根保留已有的那一份', () => {
  const have = [bar(0, '100')]
  const out = mergeBars(have, [bar(0, '999')])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.close, '100')
})

test('并 bars：新的那份没排序也认', () => {
  const out = mergeBars([], [bar(2 * HOUR), bar(0), bar(HOUR)])
  assert.deepEqual(out.map((b) => b.start), [bar(0).start, bar(HOUR).start, bar(2 * HOUR).start])
})

test('并 bars：空的进来就原样出去，且不是同一个数组', () => {
  const have = [bar(0)]
  const out = mergeBars(have, [])
  assert.deepEqual(out, have)
  assert.notEqual(out, have)
})

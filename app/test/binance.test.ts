// 交易所给的那一行，怎么变成项目里的一根。
//
// 两件事必须一直对：`end` 是开区间的那一头（收盘时间 + 1 毫秒，正好是下一根的
// 开盘时间），缺成交量就是 null——不是 0。0 是「这一根没人成交」，null 是
// 「这一段我们不知道有没有成交」，画量柱和算量均线的时候是两回事。

import assert from 'node:assert/strict'
import test from 'node:test'
import { mapKline, mapKlines, tidy } from '../src/api/binance'

const ONE_HOUR = 3_600_000
const T0 = Date.UTC(2025, 0, 1, 0, 0, 0)

/** 交易所那一行：[开盘时间, 开, 高, 低, 收, 量, 收盘时间, …] */
function row(at: number, close = '101.5', volume: unknown = '12.5'): unknown[] {
  return [at, '100.0', '102.0', '99.5', close, volume, at + ONE_HOUR - 1, '1234.5', 88]
}

test('一根映射过来：时间按 UTC，价格原样留字符串，end 是收盘时间加 1 毫秒', () => {
  const bar = mapKline(row(T0))
  assert.ok(bar)
  assert.equal(bar.start, '2025-01-01T00:00:00.000Z')
  assert.equal(bar.end, '2025-01-01T01:00:00.000Z')
  assert.equal(bar.open, '100.0')
  assert.equal(bar.high, '102.0')
  assert.equal(bar.low, '99.5')
  assert.equal(bar.close, '101.5')
  assert.equal(bar.volume, '12.5')
  // 下一根的开盘时间正好接上，中间不留缝也不重叠。
  const next = mapKline(row(T0 + ONE_HOUR))
  assert.equal(next?.start, bar.end)
})

test('没有成交量就是 null，不拿 0 顶替', () => {
  assert.equal(mapKline(row(T0, '101.5', null))?.volume, null)
  assert.equal(mapKline(row(T0, '101.5', ''))?.volume, null)
  assert.equal(mapKline(row(T0, '101.5', 12.5))?.volume, null)
  assert.equal(mapKline(row(T0, '101.5', '0'))?.volume, '0')
})

test('认不出来的行直接扔掉，不猜', () => {
  assert.equal(mapKline(null), null)
  assert.equal(mapKline([]), null)
  assert.equal(mapKline([T0, '1', '2', '3']), null)
  assert.equal(mapKline([T0, 1, 2, 3, 4, '5', T0 + 1]), null)
  assert.equal(mapKline(['x', '1', '2', '3', '4', '5', 'y']), null)
  // 收盘时间比开盘还早：这一行坏了。
  assert.equal(mapKline([T0, '1', '2', '3', '4', '5', T0 - 10]), null)
  assert.equal(mapKlines('nope').length, 0)
  assert.equal(mapKlines([row(T0), null, row(T0 + ONE_HOUR)]).length, 2)
})

test('整理：重复的按开盘时间去掉一份，乱序的排好，窗口外的不要', () => {
  const bars = mapKlines([
    row(T0 + ONE_HOUR * 2),
    row(T0),
    row(T0, '999'), // 同一根又来一次，留先到的那一份
    row(T0 + ONE_HOUR),
    row(T0 - ONE_HOUR), // 窗口之前
    row(T0 + ONE_HOUR * 3), // 窗口之后（end 是不含的）
  ])
  const out = tidy(bars, T0, T0 + ONE_HOUR * 3)
  assert.equal(out.length, 3)
  assert.deepEqual(
    out.map((b) => b.start),
    [
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T01:00:00.000Z',
      '2025-01-01T02:00:00.000Z',
    ],
  )
  assert.equal(out[0]?.close, '101.5')
})

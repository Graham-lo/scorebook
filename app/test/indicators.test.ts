// 指标算得对不对，只能靠手算的那一份来对。
//
// 这里的期望值不是把实现跑一遍抄下来的，是按公式一步一步算出来的：
// EMA 用前 n 根的简单平均起头、之后 α=2/(n+1)；MACD 的 DEA 是 DIF 有值那一段
// 的 EMA，柱子是 (DIF−DEA)×2（国内行情软件的画法）；RSI 用 Wilder 平滑，
// 第 n 根上出第一个值。改实现的时候这些数字不该跟着改。

import assert from 'node:assert/strict'
import test from 'node:test'
import { ema, macd, rsi, sma } from '../src/features/relive/indicators'

/** 浮点比大小：算到小数点后九位一样就算一样。 */
function near(actual: number | null | undefined, expected: number, what: string): void {
  assert.ok(actual !== null && actual !== undefined, `${what} 不该是空的`)
  assert.ok(
    Math.abs((actual as number) - expected) < 1e-9,
    `${what}: 算出来 ${actual}，手算是 ${expected}`,
  )
}

test('SMA 头 n-1 根没有值，之后是这 n 根的平均', () => {
  const out = sma([1, 2, 3, 4], 3)
  assert.deepEqual(out, [null, null, 2, 3])
  assert.deepEqual(sma([1, 2], 3), [null, null])
})

test('EMA 用前 n 根的平均起头，之后按 α=2/(n+1) 递推', () => {
  const out = ema([10, 11, 9, 12, 14, 13], 3)
  assert.equal(out[0], null)
  assert.equal(out[1], null)
  near(out[2], 10, 'EMA3 第 3 根') // (10+11+9)/3
  near(out[3], 11, 'EMA3 第 4 根') // 12*0.5 + 10*0.5
  near(out[4], 12.5, 'EMA3 第 5 根')
  near(out[5], 12.75, 'EMA3 第 6 根')
})

test('MACD(2,3,2)：DIF 从慢线有值那一根起，DEA 再往后一根，柱子是差的两倍', () => {
  const closes = [10, 11, 9, 12, 14, 13]
  const out = macd(closes, 2, 3, 2)

  assert.equal(out.dif[0], null)
  assert.equal(out.dif[1], null)
  near(out.dif[2], -0.5, 'DIF 第 3 根')
  near(out.dif[3], 0.16666666666666785, 'DIF 第 4 根')
  near(out.dif[4], 0.5555555555555554, 'DIF 第 5 根')
  near(out.dif[5], 0.26851851851851904, 'DIF 第 6 根')

  // DEA 是 DIF 那一段（从第 3 根起）的 EMA2，所以它自己要晚一根才有值。
  assert.equal(out.dea[2], null)
  near(out.dea[3], -0.16666666666666607, 'DEA 第 4 根')
  near(out.dea[4], 0.3148148148148149, 'DEA 第 5 根')
  near(out.dea[5], 0.283950617283951, 'DEA 第 6 根')

  assert.equal(out.hist[2], null)
  near(out.hist[3], 0.6666666666666679, '柱子 第 4 根')
  near(out.hist[4], 0.48148148148148096, '柱子 第 5 根')
  near(out.hist[5], -0.03086419753086389, '柱子 第 6 根')
})

test('MACD 的快线周期不小于慢线就整段不画，不去猜人想要什么', () => {
  const out = macd([1, 2, 3, 4, 5], 26, 12, 9)
  assert.deepEqual(out.dif, [null, null, null, null, null])
  assert.deepEqual(out.dea, [null, null, null, null, null])
  assert.deepEqual(out.hist, [null, null, null, null, null])
  assert.deepEqual(macd([1, 2, 3], 0, 3, 2).dif, [null, null, null])
  assert.deepEqual(macd([1, 2, 3], 1.5, 3, 2).dif, [null, null, null])
})

test('RSI(3) 用 Wilder 平滑，第 n 根上出第一个值', () => {
  const out = rsi([10, 11, 10.5, 12, 11, 13], 3)
  assert.equal(out[0], null)
  assert.equal(out[1], null)
  assert.equal(out[2], null)
  // 前三根的涨跌：+1、−0.5、+1.5 → 均涨 5/6、均跌 1/6 → RS=5
  near(out[3], 83.33333333333334, 'RSI 第 4 根')
  near(out[4], 55.55555555555556, 'RSI 第 5 根')
  near(out[5], 77.77777777777777, 'RSI 第 6 根')
})

test('一路涨的时候分母是 0，RSI 给 100 而不是 NaN', () => {
  const out = rsi([1, 2, 3, 4, 5], 2)
  assert.equal(out[2], 100)
  assert.equal(out[4], 100)
})

test('根数不够（<= n）就一个值都不给', () => {
  assert.deepEqual(rsi([1, 2, 3], 3), [null, null, null])
  assert.deepEqual(rsi([1, 2, 3], 0), [null, null, null])
})

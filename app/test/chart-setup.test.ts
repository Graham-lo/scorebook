// 图上画什么：后端回来的那一份怎么整理，存回去之前怎么自己先看一遍。
//
// 整理这一步是给旧记录留的门：老的 chart_setup 里只有 ma/ema/boll/atr，新的
// 还有 volume/macd/rsi。缺的一律当「这一项没开」，脏的直接丢——宁可少画一条线，
// 也不能拿半个设置去算指标。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMPTY,
  MAX_LINES,
  MAX_VOL_LINES,
  SHOT_DEFAULT,
  cloneSetup,
  normalizeSetup,
  sameSetup,
  setupIsEmpty,
  validateSetup,
} from '../src/features/relive/setup'

test('后端从来没存过：整理出来是一份字段齐全的空设置', () => {
  assert.deepEqual(normalizeSetup(null), EMPTY)
  assert.deepEqual(normalizeSetup(undefined), EMPTY)
  assert.deepEqual(normalizeSetup({}), EMPTY)
  assert.ok(setupIsEmpty(normalizeSetup(null)))
})

test('旧记录只有 ma/ema/boll/atr：新的三项当成没开，不报错', () => {
  const out = normalizeSetup({ ma: [7, 25], ema: [12], boll: { n: 20, k: '2' }, atr: { n: 14 } })
  assert.deepEqual(out.ma, [7, 25])
  assert.deepEqual(out.ema, [12])
  assert.deepEqual(out.boll, { n: 20, k: '2' })
  assert.deepEqual(out.atr, { n: 14 })
  assert.equal(out.volume, null)
  assert.equal(out.macd, null)
  assert.equal(out.rsi, null)
  assert.equal(validateSetup(out), null)
})

test('周期列表：去重、排序、扔掉不合法的', () => {
  const out = normalizeSetup({ ma: [30, 30, 0, 501, '120', -5, 7.5, 256] })
  assert.deepEqual(out.ma, [30, 120, 256])
})

test('主图均线一共最多 8 条，MA 先占，EMA 拿剩下的', () => {
  const out = normalizeSetup({
    ma: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ema: [11, 12],
  })
  assert.equal(out.ma.length, MAX_LINES)
  assert.equal(out.ema.length, 0)
  assert.equal(validateSetup(out), null)

  const half = normalizeSetup({ ma: [1, 2, 3], ema: [4, 5, 6, 7, 8, 9, 10] })
  assert.equal(half.ma.length + half.ema.length, MAX_LINES)
})

test('量均线最多 6 条；volume 在但列表是空的，仍然算开着（只看量柱）', () => {
  assert.deepEqual(normalizeSetup({ volume: { ma: [5, 10, 20, 30, 60, 120, 250] } }).volume, {
    ma: [5, 10, 20, 30, 60, 120],
  })
  assert.deepEqual(normalizeSetup({ volume: {} }).volume, { ma: [] })
  assert.equal(normalizeSetup({ volume: null }).volume, null)
  assert.equal(MAX_VOL_LINES, 6)
})

test('MACD 快线不小于慢线、或者哪个周期缺了，整项当没开', () => {
  assert.deepEqual(normalizeSetup({ macd: { fast: 12, slow: 26, signal: 9 } }).macd, {
    fast: 12,
    slow: 26,
    signal: 9,
  })
  assert.equal(normalizeSetup({ macd: { fast: 26, slow: 12, signal: 9 } }).macd, null)
  assert.equal(normalizeSetup({ macd: { fast: 12, slow: 26 } }).macd, null)
  assert.equal(normalizeSetup({ macd: 'yes' }).macd, null)
})

test('布林的倍数原样留字符串，超出范围就当没开', () => {
  assert.deepEqual(normalizeSetup({ boll: { n: 20, k: '2.5' } }).boll, { n: 20, k: '2.5' })
  assert.equal(normalizeSetup({ boll: { n: 20, k: '0' } }).boll, null)
  assert.equal(normalizeSetup({ boll: { n: 20, k: '11' } }).boll, null)
  assert.equal(normalizeSetup({ boll: { n: 0, k: '2' } }).boll, null)
})

test('校验和后端一条线：面板上过得去的，后端一定收得下', () => {
  assert.equal(validateSetup(SHOT_DEFAULT), null)
  assert.equal(validateSetup(EMPTY), null)

  const many = { ...cloneSetup(EMPTY), ma: [1, 2, 3, 4, 5], ema: [6, 7, 8, 9] }
  assert.match(validateSetup(many) ?? '', /最多 8 条/)

  assert.match(validateSetup({ ...cloneSetup(EMPTY), ma: [700] }) ?? '', /1 到 500/)
  assert.match(
    validateSetup({ ...cloneSetup(EMPTY), macd: { fast: 30, slow: 10, signal: 9 } }) ?? '',
    /快线周期要小于慢线/,
  )
  assert.match(
    validateSetup({ ...cloneSetup(EMPTY), volume: { ma: [1, 2, 3, 4, 5, 6, 7] } }) ?? '',
    /最多 6 条/,
  )
  assert.match(validateSetup({ ...cloneSetup(EMPTY), rsi: { n: 0 } }) ?? '', /RSI/)
  assert.match(validateSetup({ ...cloneSetup(EMPTY), atr: { n: 501 } }) ?? '', /ATR/)
  assert.match(validateSetup({ ...cloneSetup(EMPTY), boll: { n: 20, k: '99' } }) ?? '', /布林倍数/)
})

test('复制出来是新的一份，改它不会动到原来那一份', () => {
  const copy = cloneSetup(SHOT_DEFAULT)
  assert.ok(sameSetup(copy, SHOT_DEFAULT))
  copy.ma.push(999)
  copy.volume?.ma.push(999)
  assert.ok(!sameSetup(copy, SHOT_DEFAULT))
  assert.deepEqual(SHOT_DEFAULT.ma, [30, 120, 256])
  assert.deepEqual(SHOT_DEFAULT.volume?.ma, [5, 10, 30, 60, 120])
})

// 图上画哪几条线：默认一条都不画，开着的那几项参数先看记录。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChartSetup } from '../src/api/types'
import { normalizeSetup } from '../src/features/relive/setup'
import {
  blankChoice,
  describeSetup,
  LINE_ORDER,
  maxPeriod,
  menuFooter,
  menuItems,
  readChoice,
  seededNames,
  setupFor,
  type Choice,
} from '../src/features/relive/indicator-choice'

const shot = (): ChartSetup =>
  normalizeSetup({
    ma: [7, 25],
    ema: [],
    boll: { n: 21, k: '2' },
    volume: { ma: [5, 10] },
    macd: { fast: 12, slow: 26, signal: 9 },
    rsi: { n: 6 },
  })

const on = (...names: (keyof Choice)[]): Choice => {
  const choice = blankChoice()
  for (const name of LINE_ORDER) choice[name] = false
  for (const name of names) choice[name] = true
  return choice
}

test('首次进来一条线都不画，只有成交量柱开着', () => {
  const fresh = blankChoice()
  assert.deepEqual(fresh, {
    ma: false,
    ema: false,
    boll: false,
    mavol: false,
    macd: false,
    rsi: false,
    volume: true,
  })
  // 没有 localStorage（比如这里）也照样是这一套，不会莫名其妙开出几条线。
  assert.deepEqual(readChoice(), fresh)
})

test('默认这份选择画出来的图：只有成交量', () => {
  const setup = setupFor(blankChoice(), shot())
  assert.deepEqual(setup.ma, [])
  assert.deepEqual(setup.ema, [])
  assert.equal(setup.boll, null)
  assert.equal(setup.macd, null)
  assert.equal(setup.rsi, null)
  assert.deepEqual(setup.volume, { ma: [] })
  assert.equal(describeSetup(setup), '成交量')
})

test('开着的那几项：记录里存过就用记录的，没存过才用默认', () => {
  const withShot = setupFor(on('ma', 'boll', 'macd', 'rsi', 'volume'), shot())
  assert.deepEqual(withShot.ma, [7, 25])
  assert.deepEqual(withShot.boll, { n: 21, k: '2' })
  assert.deepEqual(withShot.macd, { fast: 12, slow: 26, signal: 9 })
  assert.deepEqual(withShot.rsi, { n: 6 })

  const noShot = setupFor(on('ma', 'boll', 'macd', 'rsi'), null)
  assert.deepEqual(noShot.ma, [30, 120, 256])
  assert.deepEqual(noShot.boll, { n: 20, k: '2' })
  assert.deepEqual(noShot.macd, { fast: 10, slow: 30, signal: 9 })
  assert.deepEqual(noShot.rsi, { n: 14 })
})

test('量均线画在成交量面板上：开了量均线就等于开了成交量', () => {
  assert.deepEqual(setupFor(on('mavol'), shot()).volume, { ma: [5, 10] })
  assert.deepEqual(setupFor(on('mavol'), null).volume, { ma: [5, 10, 30, 60, 120] })
  // 只开成交量柱：柱子有，均线没有。
  assert.deepEqual(setupFor(on('volume'), shot()).volume, { ma: [] })
  // 两个都关：这一层整个没有。
  assert.equal(setupFor(on('ma'), shot()).volume, null)
})

test('菜单：顺序固定、开着的打勾、参数来自截图的标一下', () => {
  const items = menuItems(on('ma', 'volume'), shot())
  assert.equal(items[0]?.header, '画在图上')
  const lines = items.filter((item) => LINE_ORDER.includes(item.value as never))
  assert.deepEqual(
    lines.map((item) => item.value),
    ['ma', 'ema', 'boll', 'volume', 'mavol', 'macd', 'rsi'],
  )
  assert.deepEqual(
    lines.map((item) => item.label),
    ['MA', 'EMA', 'BOLL', '成交量', '量均线', 'MACD', 'RSI'],
  )
  assert.deepEqual(
    lines.filter((item) => item.on).map((item) => item.value),
    ['ma', 'volume'],
  )
  assert.equal(lines.find((item) => item.value === 'ma')?.hint, '7 / 25 · 截图')
  assert.equal(lines.find((item) => item.value === 'ema')?.hint, '12 / 144 / 169')
  assert.equal(lines.find((item) => item.value === 'volume')?.hint, null)
  // 有截图指标才给「按截图全开」。
  assert.ok(items.some((item) => item.value === '__shot'))
  assert.ok(items.some((item) => item.value === '__none'))
  assert.equal(menuFooter(shot()), '按截图 = 这条记录截图上的那几条')
})

test('这条记录没有截图指标：不给「按截图全开」，底下那句换一种说法', () => {
  const items = menuItems(blankChoice(), null)
  assert.equal(
    items.some((item) => item.value === '__shot'),
    false,
  )
  assert.ok(items.some((item) => item.value === '__none'))
  assert.equal(menuFooter(null), '这条记录没有截图指标，用默认参数')
  assert.deepEqual(seededNames(null), [])
  assert.deepEqual(seededNames(shot()), ['ma', 'boll', 'volume', 'mavol', 'macd', 'rsi'])
})

test('预热要往前取多少根：递推的按三倍要，滑动窗口够 n 根就行', () => {
  assert.equal(maxPeriod(setupFor(blankChoice(), null)), 0)
  assert.equal(maxPeriod(setupFor(on('ma'), null)), 256)
  assert.equal(maxPeriod(setupFor(on('ema'), null)), 169 * 3)
  assert.equal(maxPeriod(setupFor(on('rsi'), null)), 14 * 3)
  assert.equal(maxPeriod(setupFor(on('macd'), null)), (30 + 9) * 3)
  assert.equal(maxPeriod(setupFor(on('mavol'), null)), 120)
})

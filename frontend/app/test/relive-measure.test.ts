// Shift 拖出来那把尺子和 Alt 钉上去那几条线：算术部分。画在哪儿是图的事。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PIN_MAX, barsAcross, measureText, pctText, pinLabel, pinToggle, spanText,
} from '../src/features/relive/measure'

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

test('涨跌幅永远两位小数，零也带 +', () => {
  assert.equal(pctText(100, 101.234), '+1.23%')
  assert.equal(pctText(100, 99.6), '-0.40%')
  assert.equal(pctText(100, 100), '+0.00%')
})

test('起点说不通就给 0.00%，不出 NaN', () => {
  assert.equal(pctText(0, 100), '0.00%')
  assert.equal(pctText(Number.NaN, 100), '0.00%')
})

test('时长说人话，零头是 0 的那一截不说', () => {
  assert.equal(spanText(3 * DAY + 4 * HOUR), '3 天 4 小时')
  assert.equal(spanText(3 * DAY), '3 天')
  assert.equal(spanText(5 * HOUR + 30 * MINUTE), '5 小时 30 分')
  assert.equal(spanText(5 * HOUR), '5 小时')
  assert.equal(spanText(45 * MINUTE), '45 分')
  assert.equal(spanText(-5), '0 分')
})

test('跨了几根按这一档一根多宽算，最少算一根', () => {
  assert.equal(barsAcross(0, 10 * HOUR, '1h'), 10)
  assert.equal(barsAcross(10 * HOUR, 0, '1h'), 10, '反着拖也是十根')
  assert.equal(barsAcross(0, 60_000, '1h'), 1)
})

test('尺子上那一行就是三段用 · 拼起来', () => {
  const text = measureText({
    fromMs: 0, toMs: 3 * DAY + 4 * HOUR, fromPrice: 100, toPrice: 112.5, interval: '1h',
  })
  assert.equal(text, '+12.50% · 76 根 · 3 天 4 小时')
})

test('Alt 点一下钉一条，再点这条就拔掉', () => {
  const y = (price: number) => price
  const first = pinToggle([], 100, y)
  assert.deepEqual(first, { prices: [100], did: 'added' })
  const off = pinToggle(first.prices, 102, y)
  assert.equal(off.did, 'removed', '差两像素算点在它身上')
  assert.deepEqual(off.prices, [])
})

test('离得远就是再钉一条，不是拔掉', () => {
  const y = (price: number) => price
  const next = pinToggle([100], 200, y)
  assert.deepEqual(next, { prices: [100, 200], did: 'added' })
})

test('满五条就谁也不动，让外面去说那句话', () => {
  const y = (price: number) => price
  const full = [10, 100, 200, 300, 400]
  assert.equal(full.length, PIN_MAX)
  const blocked = pinToggle(full, 999, y)
  assert.equal(blocked.did, 'full')
  assert.deepEqual(blocked.prices, full)
  assert.equal(pinToggle(full, 101, y).did, 'removed', '满了照样能拔')
})

test('价格轴外面（算不出 y）就当没命中，照常钉一条', () => {
  const next = pinToggle([100], 500, () => null)
  assert.deepEqual(next, { prices: [100, 500], did: 'added' })
})

test('线上那个标签就是价格本身，按这张图的小数位数写', () => {
  assert.equal(pinLabel(64250.5, 2), '64,250.50')
  assert.equal(pinLabel(3.14159, 4), '3.1416')
})

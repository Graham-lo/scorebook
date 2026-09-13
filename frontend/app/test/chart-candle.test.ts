// 蜡烛和量柱的宽度：桌面必须和图库那道公式分毫不差，手机按 0.55 根宽收细。

import assert from 'node:assert/strict'
import test from 'node:test'
import { candleWidths } from '../src/features/relive/candle-series'

/** 图库的 `optimalCandlestickWidth`，照抄一份当基准（别 import 内部实现）。 */
function libraryBody(barSpacing: number, ratio: number): number {
  const from = 2.5
  const to = 4
  if (barSpacing >= from && barSpacing <= to) return Math.floor(3 * ratio)
  const coeff = 1 - 0.2 * Math.atan(Math.max(to, barSpacing) - to) / (Math.PI * 0.5)
  const res = Math.floor(barSpacing * coeff * ratio)
  const scaled = Math.floor(barSpacing * ratio)
  return Math.max(Math.floor(ratio), Math.min(res, scaled))
}

/** 图库画蜡烛前那道奇偶修正。 */
function libraryCandle(barSpacing: number, ratio: number): number {
  let body = libraryBody(barSpacing, ratio)
  if (body >= 2) {
    const wick = Math.floor(ratio)
    if ((wick % 2) !== (body % 2)) body -= 1
  }
  return body
}

test('桌面的实体宽和图库那道公式逐个对得上', () => {
  for (const ratio of [1, 2, 3]) {
    for (const spacing of [0.4, 1, 2, 2.5, 3, 4, 4.5, 6, 8, 12, 20, 40]) {
      assert.equal(
        candleWidths(spacing, ratio, false).body,
        libraryCandle(spacing, ratio),
        `根宽 ${spacing} / dpr ${ratio}`,
      )
    }
  }
})

test('桌面的影线照图库那道夹取：一个设备像素，且不宽过实体', () => {
  assert.deepEqual(candleWidths(6, 1, false), { body: 5, wick: 1 })
  assert.deepEqual(candleWidths(6, 2, false), { body: 10, wick: 2 })
  // 根宽细到半个像素，实体退到 floor(dpr)，影线不许比实体宽。
  const thin = candleWidths(0.4, 2, false)
  assert.ok(thin.wick <= thin.body, '影线不宽过实体')
})

test('手机 4.5 根宽、dpr 3：实体 8 位图像素（≈2.7px），影线 2（≈0.7px）', () => {
  assert.deepEqual(candleWidths(4.5, 3, true), { body: 8, wick: 2 })
})

test('手机上影线永远细于实体，且两者同奇偶', () => {
  for (const ratio of [1, 2, 3]) {
    for (const spacing of [2, 3, 4.5, 6, 10, 20, 40]) {
      const got = candleWidths(spacing, ratio, true)
      assert.equal(got.body % 2, got.wick % 2, `根宽 ${spacing} / dpr ${ratio} 奇偶要对齐`)
      assert.ok(got.wick <= got.body, `根宽 ${spacing} / dpr ${ratio} 影线不该粗过实体`)
    }
  }
})

test('手机上实体大约就是 0.55 根宽（差不超过一个位图像素）', () => {
  for (const spacing of [4.5, 6, 10, 20]) {
    const got = candleWidths(spacing, 3, true)
    assert.ok(Math.abs(got.body - spacing * 0.55 * 3) <= 1, `根宽 ${spacing}`)
  }
})

test('根宽细到 0.55×dpr 不足两个位图像素，实体就退化成一条影线', () => {
  const tiny = candleWidths(1, 3, true)
  assert.deepEqual(tiny, { body: 2, wick: 2 })
  const tinier = candleWidths(0.4, 1, true)
  assert.deepEqual(tinier, { body: 1, wick: 1 })
})

test('根宽或者 dpr 是脏数据也得给出能画的一根', () => {
  for (const mobile of [false, true]) {
    for (const [spacing, ratio] of [[Number.NaN, 2], [6, Number.NaN], [-1, 2], [6, 0]] as const) {
      const got = candleWidths(spacing, ratio, mobile)
      assert.ok(got.body >= 1 && got.wick >= 1, `${spacing}/${ratio}/${mobile}`)
      assert.ok(Number.isInteger(got.body) && Number.isInteger(got.wick))
    }
  }
})

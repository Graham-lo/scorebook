import assert from 'node:assert/strict'
import test from 'node:test'
import { SCORE_CAVEAT, SCORE_MEANING, scoreBand, scorePercent } from '../src/features/search/score'

/** 后端的分数就是这么来的：exp(-6 * cost)，方向对不上再乘 0.25。 */
const rerank = (cost: number, consistent = true): number =>
  Math.exp(-6 * cost) * (consistent ? 1 : 0.25)

test('百分比是照实翻译过来的，不是又缩放了一次', () => {
  assert.equal(scorePercent(1), 100)
  assert.equal(scorePercent(0.347), 35)
  assert.equal(scorePercent(0.5), 50)
  assert.equal(scorePercent(0.004), 0)
})

test('脏数据不该把这一行弄垮', () => {
  assert.equal(scorePercent(Number.NaN), 0)
  assert.equal(scorePercent(-1), 0)
  assert.equal(scorePercent(7), 100)
})

test('四条界上取的是上面那一档', () => {
  assert.equal(scoreBand(85), '几乎是同一段形状')
  assert.equal(scoreBand(84), '很像')
  assert.equal(scoreBand(70), '很像')
  assert.equal(scoreBand(69), '像')
  assert.equal(scoreBand(50), '像')
  assert.equal(scoreBand(49), '有点像')
  // 25 归下面那档：方向反了的硬顶正好落在 0.25，那个数本身属于方向反了的那一侧。
  assert.equal(scoreBand(26), '有点像')
  assert.equal(scoreBand(25), '不太像')
  assert.equal(scoreBand(0), '不太像')
})

test('85 那条界就是后端自动钉图用的那条', () => {
  assert.equal(scoreBand(scorePercent(0.85)), '几乎是同一段形状')
  // 0.8496 显示出来是 85%，那句话就得跟着念 85% 的那一档，不能照原始值念「很像」。
  assert.equal(scorePercent(0.8496), 85)
  assert.equal(scoreBand(scorePercent(0.8496)), '几乎是同一段形状')
})

test('方向对不上的那一乘 0.25 是硬顶，必然掉进最后一档', () => {
  for (const cost of [0, 0.01, 0.05, 0.2]) {
    const percent = scorePercent(rerank(cost, false))
    assert.ok(percent <= 25, `cost ${cost} 方向不一致却给到了 ${percent}%`)
    assert.equal(scoreBand(percent), '不太像')
  }
})

test('但最后一档不全是方向不一致的：方向对、形状差得远一样掉下来', () => {
  // 代价 0.3、方向一致 —— 17%。所以这一档的话只能说形状，不能替方向作结论。
  const percent = scorePercent(rerank(0.3, true))
  assert.equal(percent, 17)
  assert.equal(scoreBand(percent), '不太像')
})

test('文案不许出现概率那一套说法', () => {
  for (const copy of [SCORE_MEANING, SCORE_CAVEAT]) {
    for (const word of ['胜率', '概率', '预测']) {
      if (!copy.includes(word)) continue
      // 出现了只能是在否定它。
      assert.ok(/不是|不说/.test(copy), `「${word}」出现在了一句没有否定它的话里：${copy}`)
    }
  }
  assert.ok(SCORE_MEANING.includes('不是胜率'))
  assert.ok(SCORE_MEANING.includes('不是上涨概率'))
  assert.ok(SCORE_CAVEAT.includes('不是涨跌概率'))
})

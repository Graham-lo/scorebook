import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchScore } from '../src/api/chart'
import { levelFromScore, levelWord } from '../src/features/search/score'

const match = (score: number, level?: string | null): MatchScore => ({
  score,
  alignment_cost: 0,
  direction_consistent: true,
  reverse: false,
  meaning: '',
  ...(level === undefined ? {} : { level }),
})

test('没有 level 的旧后端按分数分档，界限取上面那一档', () => {
  assert.equal(levelFromScore(1), '很像')
  assert.equal(levelFromScore(0.75), '很像')
  assert.equal(levelFromScore(0.749), '像')
  assert.equal(levelFromScore(0.6), '像')
  assert.equal(levelFromScore(0.599), '有点像')
  assert.equal(levelFromScore(0.45), '有点像')
  assert.equal(levelFromScore(0.449), null)
  assert.equal(levelFromScore(0), null)
})

test('脏数据不该让这一行说出一个词来', () => {
  assert.equal(levelFromScore(Number.NaN), null)
  assert.equal(levelWord(null), null)
  assert.equal(levelWord(undefined), null)
})

test('后端给了 level 就照它念', () => {
  assert.equal(levelWord(match(0.99, 'likely')), '像')
  assert.equal(levelWord(match(0.1, 'sure')), '很像')
  assert.equal(levelWord(match(0.1, '很像')), '很像')
  assert.equal(levelWord(match(0.99, '有点像')), '有点像')
})

test('后端用标识符写 level 时翻回那三个词', () => {
  assert.equal(levelWord(match(0.1, 'strong')), '很像')
  assert.equal(levelWord(match(0.1, 'similar')), '像')
  assert.equal(levelWord(match(0.9, 'weak')), '有点像')
})

test('level 是 none 就是不该说成像，这一条不显示', () => {
  assert.equal(levelWord(match(0.99, 'none')), null)
})

test('认不出的 level 退回按分数分档', () => {
  assert.equal(levelWord(match(0.8, 'whatever')), '很像')
  assert.equal(levelWord(match(0.2, 'whatever')), null)
})

test('只有这三个词', () => {
  const words = new Set<string | null>()
  for (let s = 0; s <= 1.0001; s += 0.01) words.add(levelFromScore(s))
  assert.deepEqual([...words].sort(), [null, '像', '很像', '有点像'].sort())
})

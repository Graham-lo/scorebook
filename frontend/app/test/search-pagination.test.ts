import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resultPage } from '../src/features/search/pagination'

test('next and previous preserve the frozen order without duplicates or lost matches', () => {
  const ranking = Array.from({ length: 12 }, (_, i) => ({ id: `match-${i}`, score: 1 - i / 20 }))
  const first = resultPage(ranking, 0, 5)
  const second = resultPage(ranking, 1, 5)
  const last = resultPage(ranking, 2, 5)
  assert.deepEqual([...first.items, ...second.items, ...last.items], ranking)
  assert.deepEqual(resultPage(ranking, 0, 5), first)
  assert.deepEqual(resultPage(ranking, 99, 5), last)
  assert.equal(last.count, 3)
  assert.equal(last.items.length, 2)
  assert.deepEqual(resultPage(ranking, 0, 10).items, ranking.slice(0, 10))
  assert.deepEqual(resultPage([], 4, 5), { items: [], index: 0, count: 1 })
})

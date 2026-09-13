// 取回来的格子放哪儿：淘汰谁、`window()` 在洞处怎么断。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import { tileStore } from '../src/features/relive/history/store'
import { tileRange, type TileKey } from '../src/features/relive/history/tiles'

const space = { market: 'usd_m' as const, symbol: 'BTCUSDT', interval: '1h' }
const key = (index: number): TileKey => ({ ...space, index })

/** 这一格里放一根，落在格子起点。 */
function tile(index: number): { bars: Bar[]; complete: boolean; fetchedAt: number } {
  const { startMs } = tileRange(index, space.interval)
  return {
    bars: [{
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + 3_600_000).toISOString(),
      open: '1', high: '2', low: '0', close: '1', volume: '1',
    }],
    complete: true,
    fetchedAt: 0,
  }
}

test('存了就取得回来', () => {
  const store = tileStore()
  store.set(key(3), tile(3))
  assert.equal(store.get(key(3))?.bars.length, 1)
  assert.equal(store.get(key(4)), null)
  assert.equal(store.size(), 1)
})

test('同一个品种最多留这么多格，淘汰最久没碰过的', () => {
  const store = tileStore(3, 10)
  for (const i of [0, 1, 2]) store.set(key(i), tile(i))
  // 碰一下 0，让它不是最老的那个。
  store.touch(key(0))
  store.set(key(3), tile(3))
  assert.equal(store.size(), 3)
  assert.equal(store.get(key(1)), null)
  assert.ok(store.get(key(0)))
  assert.ok(store.get(key(3)))
})

test('整页也有上限：别的品种也算在内', () => {
  const store = tileStore(10, 2)
  store.set({ ...space, symbol: 'ETHUSDT', index: 0 }, tile(0))
  store.set(key(1), tile(1))
  store.set(key(2), tile(2))
  assert.equal(store.size(), 2)
  assert.equal(store.get({ ...space, symbol: 'ETHUSDT', index: 0 }), null)
})

test('get 也算碰过：刚读过的不会被先淘汰', () => {
  const store = tileStore(2, 10)
  store.set(key(0), tile(0))
  store.set(key(1), tile(1))
  store.get(key(0))
  store.set(key(2), tile(2))
  assert.ok(store.get(key(0)))
  assert.equal(store.get(key(1)), null)
})

test('window：连着的几格接成一条', () => {
  const store = tileStore()
  for (const i of [0, 1, 2]) store.set(key(i), tile(i))
  const from = tileRange(0, space.interval).startMs
  const to = tileRange(2, space.interval).endMs
  assert.equal(store.window(space, from, to).length, 3)
})

test('window：中间缺一格就在洞处断开，只给包含视野的那一段', () => {
  const store = tileStore()
  for (const i of [0, 1, 3, 4]) store.set(key(i), tile(i))
  const from = tileRange(3, space.interval).startMs
  const to = tileRange(4, space.interval).endMs
  const bars = store.window(space, from, to)
  assert.equal(bars.length, 2)
  assert.equal(bars[0]?.start, tile(3).bars[0]?.start)
})

test('window：往两边尽量延伸，不止视野里那几格', () => {
  const store = tileStore()
  for (const i of [0, 1, 2, 3]) store.set(key(i), tile(i))
  const { startMs, endMs } = tileRange(1, space.interval)
  assert.equal(store.window(space, startMs, endMs).length, 4)
})

test('window：视野里一格都没有就是空的', () => {
  const store = tileStore()
  store.set(key(0), tile(0))
  const { startMs, endMs } = tileRange(9, space.interval)
  assert.deepEqual(store.window(space, startMs, endMs), [])
})

test('count 和 earliest 只看这一个品种这一档', () => {
  const store = tileStore()
  store.set(key(2), tile(2))
  store.set(key(0), tile(0))
  store.set({ ...space, interval: '1d', index: 0 }, tile(0))
  assert.equal(store.count(space), 2)
  assert.equal(store.earliest(space)?.start, tile(0).bars[0]?.start)
  assert.equal(store.earliest({ ...space, symbol: 'ETHUSDT' }), null)
})

test('clear 之后一格不剩', () => {
  const store = tileStore()
  store.set(key(0), tile(0))
  store.clear()
  assert.equal(store.size(), 0)
  assert.equal(store.get(key(0)), null)
})

test('window：视野拖到上市之前那一格，给最近的一段而不是一片空白', () => {
  // SKHY 这种上市三天的：上市到现在整段都在同一格里，它左边那一格永远没人取
  // （调度器按 floor 整格跳过）。人把图往右拖越过上市点，视野整个落进那一格空
  // 洞里——这时候要是回空，图上就一根 K 线都没有，再往回拖也回不来了。
  const store = tileStore()
  store.set(key(7), tile(7))
  const before = tileRange(6, space.interval)
  const inside = (r: { startMs: number; endMs: number }, lo: number, hi: number) =>
    store.window(space, r.startMs + (r.endMs - r.startMs) * lo, r.startMs + (r.endMs - r.startMs) * hi)
  assert.equal(inside(before, 0.2, 0.8).length, 1)
  // 隔得太远就还是空的：那是真的没取过，不是刚跨过上市点。
  const far = tileRange(3, space.interval)
  assert.deepEqual(inside(far, 0.2, 0.8), [])
})

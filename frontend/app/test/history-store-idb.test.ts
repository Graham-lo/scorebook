// 24 小时热缓存：什么能存、什么到点该扔、占太多该扔谁，以及存取那一层一抛错就
// 静默退回内存。真的 IndexedDB 在 Node 里没有，换一张 Map 就行。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import {
  CAP_BYTES, TTL_MS, estimateBytes, evictions, fresh, hotCache, keepable,
  type HotBackend, type HotTile,
} from '../src/features/relive/history/store-idb'
import { tileKeyString, tileRange, type TileKey } from '../src/features/relive/history/tiles'

const HOUR = 3_600_000
const key = (index: number, interval = '1h'): TileKey => ({ market: 'usd_m', symbol: 'BTCUSDT', interval, index })

function bar(at: number): Bar {
  return {
    start: new Date(at).toISOString(), end: new Date(at + HOUR).toISOString(),
    open: '1', high: '2', low: '0.5', close: '1.5', volume: '10',
  }
}

function fake(): HotBackend & { rows: Map<string, HotTile>; fail: boolean } {
  const rows = new Map<string, HotTile>()
  const self = {
    rows,
    fail: false,
    async get(id: string) { if (self.fail) throw new Error('idb 挂了'); return rows.get(id) ?? null },
    async put(id: string, tile: HotTile) { if (self.fail) throw new Error('idb 挂了'); rows.set(id, tile) },
    async delete(ids: readonly string[]) { if (self.fail) throw new Error('idb 挂了'); for (const id of ids) rows.delete(id) },
    async all() { if (self.fail) throw new Error('idb 挂了'); return [...rows].map(([k, tile]) => ({ key: k, tile })) },
    async clear() { if (self.fail) throw new Error('idb 挂了'); rows.clear() },
  }
  return self
}

test('只有问干净了、而且整格都已经收盘的才存得下', () => {
  const index = 0
  const end = tileRange(index, '1h').endMs
  assert.equal(keepable(key(index), { complete: true, bars: [bar(0)] }, end + 1), true)
  assert.equal(keepable(key(index), { complete: true, bars: [bar(0)] }, end - 1), false, '桶止还在未来：里面躺着活的那一根')
  assert.equal(keepable(key(index), { complete: false, bars: [bar(0)] }, end + 1), false)
  assert.equal(keepable(key(index), { complete: true, bars: [] }, end + 1), false)
})

test('过没过期只看表上那个时刻', () => {
  assert.equal(fresh({ expiresAt: 100 }, 99), true)
  assert.equal(fresh({ expiresAt: 100 }, 100), false)
})

test('存进去 24 小时后过期，过期那一条读的时候顺手删掉', async () => {
  const backend = fake()
  const cache = hotCache(backend, () => 0)
  const index = 0
  const at = tileRange(index, '1h').endMs + 1
  await cache.write(key(index), { complete: true, bars: [bar(0)] }, at)
  const row = backend.rows.get(tileKeyString(key(index)))!
  assert.equal(row.expiresAt, at + TTL_MS)
  assert.ok(await cache.read(key(index), at + 1))
  assert.equal(await cache.read(key(index), at + TTL_MS), null)
  assert.equal(backend.rows.size, 0, '读到一条过期的就地删掉')
})

test('读一次就把 touchedAt 刷新一遍，淘汰的时候才知道谁最久没碰', async () => {
  const backend = fake()
  const cache = hotCache(backend, () => 0)
  const index = 0
  const at = tileRange(index, '1h').endMs + 1
  await cache.write(key(index), { complete: true, bars: [bar(0)] }, at)
  await cache.read(key(index), at + 5_000)
  assert.equal(backend.rows.get(tileKeyString(key(index)))!.touchedAt, at + 5_000)
})

test('还在走的那一格永远不落盘', async () => {
  const backend = fake()
  const cache = hotCache(backend, () => 0)
  const index = 0
  await cache.write(key(index), { complete: true, bars: [bar(0)] }, tileRange(index, '1h').endMs - 1)
  assert.equal(backend.rows.size, 0)
})

test('总量超了按最久没碰过的往外扔，扔到装得下为止', () => {
  const many = Array.from({ length: 600 }, (_, i) => ({
    key: `t${i}`,
    touchedAt: i,
    bars: Array.from({ length: 1000 }, (_, n) => bar(n * HOUR)),
  }))
  const total = many.reduce((n, tile) => n + estimateBytes(tile), 0)
  assert.ok(total > CAP_BYTES, '这堆确实超了 50MB')
  const drop = evictions(many)
  assert.ok(drop.length > 0)
  assert.equal(drop[0], 't0', '最久没碰的先走')
  assert.equal(drop[1], 't1')
  const left = many.filter((tile) => !drop.includes(tile.key))
  assert.ok(left.reduce((n, tile) => n + estimateBytes(tile), 0) <= CAP_BYTES)
})

test('装得下就一条都不扔', () => {
  assert.deepEqual(evictions([{ key: 'a', touchedAt: 1, bars: [bar(0)] }]), [])
})

test('sweep 先扫过期再看总量，返回还剩几条', async () => {
  const backend = fake()
  const cache = hotCache(backend, () => 0)
  const index = 0
  const at = tileRange(index, '1h').endMs + 1
  await cache.write(key(index), { complete: true, bars: [bar(0)] }, at)
  await cache.write(key(index - 1), { complete: true, bars: [bar(0)] }, at)
  assert.equal(await cache.sweep(at + 1), 2)
  assert.equal(await cache.sweep(at + TTL_MS), 0)
  assert.equal(backend.rows.size, 0)
})

test('存取那一层抛错一律静默：读到 null、写当没发生，图照常', async () => {
  const backend = fake()
  const cache = hotCache(backend, () => 0)
  backend.fail = true
  assert.equal(await cache.read(key(0), 1), null)
  await cache.write(key(0), { complete: true, bars: [bar(0)] }, tileRange(0, '1h').endMs + 1)
  assert.equal(await cache.sweep(1), 0)
  assert.equal(await cache.count(), 0)
  await cache.clear()
})

// 一格行情从哪里取：先直连，走不通就整场改走后端。

import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../src/api/errors'
import type { Bar, ChartRequest, MarketData } from '../src/api/types'
import {
  BACKEND_NAME, DIRECT_NAME, shouldFallBack, sourcePool, type SourceDeps,
} from '../src/features/relive/history/sources'
import { TILE_BARS, tileRange, type TileKey } from '../src/features/relive/history/tiles'

const space = { market: 'usd_m' as const, symbol: 'BTCUSDT', interval: '1h' }
const key: TileKey = { ...space, index: 10 }
const past = tileRange(11, '1h').endMs + 86_400_000
const HOUR = 3_600_000

function bars(count: number): Bar[] {
  const { startMs } = tileRange(10, '1h')
  return Array.from({ length: count }, (_, i) => ({
    start: new Date(startMs + i * HOUR).toISOString(),
    end: new Date(startMs + (i + 1) * HOUR).toISOString(),
    open: '1', high: '2', low: '0', close: '1', volume: '1',
  }))
}

function limited(status: number): ApiError {
  return new ApiError(status, { code: 'search_capacity_reached', retry: { kind: 'after', value: 1 } })
}

function rig(overrides: Partial<SourceDeps> = {}) {
  const directCalls: { start_at: string; end_at: string; limit: number }[] = []
  const backendCalls: ChartRequest[] = []
  const waits: number[] = []
  const deps: Partial<SourceDeps> = {
    direct: async (window) => { directCalls.push(window); return bars(3) },
    backend: async (request): Promise<MarketData> => { backendCalls.push(request); return { bars: bars(3), coverage_complete: true } },
    now: () => past,
    wait: async (ms) => { waits.push(ms) },
    ...overrides,
  }
  return { deps, directCalls, backendCalls, waits }
}

test('直连：一次问一整格，limit 就是一格的根数', async () => {
  const box = rig()
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(box.directCalls.length, 1)
  assert.equal(box.directCalls[0]?.limit, TILE_BARS)
  assert.equal(box.directCalls[0]?.start_at, new Date(tileRange(10, '1h').startMs).toISOString())
  assert.equal(got.bars.length, 3)
  assert.equal(got.complete, true)
  assert.equal(pool.name(), DIRECT_NAME)
  assert.equal(pool.concurrency(), 3)
})

test('直连：满 1000 根说明这一格还没问干净', async () => {
  const box = rig({ direct: async () => bars(TILE_BARS) })
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(got.complete, false)
})

test('直连：过去的一格回来是空的，就是一个缺口', async () => {
  const box = rig({ direct: async () => [] })
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(got.hole, 'gap')
  assert.equal(got.complete, false)
})

test('整格都在未来：一根不问，也不算缺口', async () => {
  const box = rig({ now: () => tileRange(10, '1h').startMs - 1 })
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(box.directCalls.length, 0)
  assert.deepEqual(got.bars, [])
  assert.equal(got.complete, true)
})

test('跨到未来的那一格：问一次就算问干净了', async () => {
  const box = rig({ now: () => tileRange(10, '1h').startMs + 5 * HOUR, direct: async () => bars(5) })
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(got.complete, true)
  assert.equal(got.hole, undefined)
})

test('直连断了就整场改走后端，不再回试', async () => {
  let direct = 0
  const box = rig({ direct: async () => { direct += 1; throw new TypeError('failed to fetch') } })
  const pool = sourcePool(space, box.deps)
  await pool.fetch(key, new AbortController().signal)
  assert.equal(pool.name(), BACKEND_NAME)
  assert.equal(pool.concurrency(), 1)
  await pool.fetch({ ...key, index: 11 }, new AbortController().signal)
  assert.equal(direct, 1)
  assert.equal(box.backendCalls.length, 2)
})

test('别的错不切后端：400 就是 400', async () => {
  const box = rig({ direct: async () => { throw new ApiError(400, { code: 'invalid_request' }) } })
  const pool = sourcePool(space, box.deps)
  await assert.rejects(() => pool.fetch(key, new AbortController().signal))
  assert.equal(pool.name(), DIRECT_NAME)
  assert.equal(box.backendCalls.length, 0)
})

test('该不该改走后端：断网、451、超时算，取消和 400 不算', () => {
  assert.equal(shouldFallBack(new TypeError('failed to fetch')), true)
  const slow = new Error('timeout'); slow.name = 'BinanceTimeout'
  assert.equal(shouldFallBack(slow), true)
  assert.equal(shouldFallBack(new Error('HTTP 451 from binance')), true)
  const stopped = new Error('aborted'); stopped.name = 'AbortError'
  assert.equal(shouldFallBack(stopped), false)
  assert.equal(shouldFallBack(new ApiError(400, { code: 'invalid_request' })), false)
})

test('归档那一类从一开始就只走后端', async () => {
  const box = rig()
  const pool = sourcePool({ ...space, source: 'monthly_archive' }, box.deps)
  await pool.fetch(key, new AbortController().signal)
  assert.equal(box.directCalls.length, 0)
  assert.equal(box.backendCalls.length, 1)
  assert.equal(box.backendCalls[0]?.source, 'monthly_archive')
  assert.equal(pool.name(), BACKEND_NAME)
})

test('走后端的格子请求不带截止线', async () => {
  const box = rig({ direct: async () => { throw new TypeError('blocked') } })
  const pool = sourcePool(space, box.deps)
  await pool.fetch(key, new AbortController().signal)
  assert.equal(box.backendCalls[0]?.match_end_at, undefined)
})

test('后端限流：按它说的等一次，再发一次', async () => {
  let n = 0
  const box = rig({
    direct: async () => { throw new TypeError('blocked') },
    backend: async (): Promise<MarketData> => {
      n += 1
      if (n === 1) throw limited(503)
      return { bars: bars(2), coverage_complete: true }
    },
  })
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(n, 2)
  assert.deepEqual(box.waits, [1000])
  assert.equal(got.bars.length, 2)
})

test('等过一次还失败就把这一格记成缺口，不再自己重试', async () => {
  let n = 0
  const box = rig({
    direct: async () => { throw new TypeError('blocked') },
    backend: async (): Promise<MarketData> => { n += 1; throw limited(503) },
  })
  const pool = sourcePool(space, box.deps)
  const got = await pool.fetch(key, new AbortController().signal)
  assert.equal(n, 2)
  assert.equal(got.hole, 'gap')
})

test('后端一次性失败照样抛出去，交给上层记失败', async () => {
  const box = rig({
    direct: async () => { throw new TypeError('blocked') },
    backend: async (): Promise<MarketData> => { throw new ApiError(500, { code: 'internal' }) },
  })
  const pool = sourcePool(space, box.deps)
  await assert.rejects(() => pool.fetch(key, new AbortController().signal))
})

test('后端的区间止在「现在」那一根上，不要未来', async () => {
  const now = tileRange(10, '1h').startMs + 5 * HOUR + 12 * 60_000
  const box = rig({ direct: async () => { throw new TypeError('blocked') }, now: () => now })
  const pool = sourcePool(space, box.deps)
  await pool.fetch(key, new AbortController().signal)
  const asked = box.backendCalls[0]
  assert.equal(asked?.end_at, new Date(tileRange(10, '1h').startMs + 5 * HOUR).toISOString())
})

// ——— 并发硬闸 ———
// 换档那一下调度器会有两拨请求擦肩而过，真正保证「同时最多几路」的是这一层。

const settle = async (): Promise<void> => { await new Promise((go) => { setImmediate(go) }) }

test('直连同时最多 3 路，第 4 格排队等前面让位', async () => {
  const gates: (() => void)[] = []
  const box = rig({
    direct: async () => new Promise<Bar[]>((go) => { gates.push(() => go(bars(3))) }),
  })
  const pool = sourcePool(space, box.deps)
  assert.equal(pool.concurrency(), 3)
  const signal = new AbortController().signal
  const runs = [6, 7, 8, 9].map((index) => pool.fetch({ ...space, index }, signal))
  await settle()
  assert.equal(gates.length, 3)
  gates[0]?.()
  await runs[0]
  await settle()
  assert.equal(gates.length, 4)
  for (const open of gates) open()
  await Promise.all(runs)
})

test('走后端的时候同时只剩 1 路', async () => {
  const gates: (() => void)[] = []
  const box = rig({
    backend: async () => new Promise<MarketData>((go) => {
      gates.push(() => go({ bars: bars(3), coverage_complete: true }))
    }),
  })
  const pool = sourcePool({ ...space, source: 'monthly_archive' }, box.deps)
  assert.equal(pool.concurrency(), 1)
  const signal = new AbortController().signal
  const runs = [6, 7].map((index) => pool.fetch({ ...space, index }, signal))
  await settle()
  assert.equal(gates.length, 1)
  gates[0]?.()
  await runs[0]
  await settle()
  assert.equal(gates.length, 2)
  for (const open of gates) open()
  await Promise.all(runs)
})

test('排在队里的那一格被 abort：不占名额，也不会再发出去', async () => {
  const gates: (() => void)[] = []
  const box = rig({
    direct: async () => new Promise<Bar[]>((go) => { gates.push(() => go(bars(3))) }),
  })
  const pool = sourcePool(space, box.deps)
  const first = new AbortController()
  const later = new AbortController()
  const runs = [6, 7, 8].map((index) => pool.fetch({ ...space, index }, first.signal))
  const queued = pool.fetch({ ...space, index: 9 }, later.signal)
  await settle()
  assert.equal(gates.length, 3)
  later.abort()
  await assert.rejects(() => queued, (error: Error) => error.name === 'AbortError')
  gates[0]?.()
  await runs[0]
  await settle()
  // 让位之后也没人替它发请求。
  assert.equal(gates.length, 3)
  for (const open of gates) open()
  await Promise.all(runs)
})

test('已经 abort 的信号连名额都不去拿', async () => {
  const box = rig()
  const pool = sourcePool(space, box.deps)
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(() => pool.fetch(key, stop.signal), (error: Error) => error.name === 'AbortError')
  assert.equal(box.directCalls.length, 0)
})

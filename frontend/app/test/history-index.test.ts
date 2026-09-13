// 门面：窗口态那份数据先种进去，图第一帧就不用等网络。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import { historyFeed, type HistoryFeedDeps } from '../src/features/relive/history'
import { TILE_BARS, tileRange } from '../src/features/relive/history/tiles'

const space = { market: 'usd_m' as const, symbol: 'BTCUSDT', interval: '1h' }
const HOUR = 3_600_000
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0))
const now = tileRange(12, '1h').endMs

function run(from: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    start: new Date(from + i * HOUR).toISOString(),
    end: new Date(from + (i + 1) * HOUR).toISOString(),
    open: '1', high: '2', low: '0', close: '1', volume: '1',
  }))
}

/** 正好把第 10 格从头盖到尾。 */
const whole = (): Bar[] => run(tileRange(10, '1h').startMs, TILE_BARS)

function rig(overrides: Partial<HistoryFeedDeps> = {}): { deps: HistoryFeedDeps; direct: number[] } {
  const direct: number[] = []
  return {
    direct,
    deps: {
      bounds: async () => ({ onboardMs: null, deliveryMs: null }),
      now: () => now,
      sources: {
        direct: async (window) => { direct.push(Date.parse(window.start_at)); return [] },
        now: () => now,
        wait: async () => {},
      },
      ...overrides,
    },
  }
}

test('种进去的那一格算取过了：视野落在它身上，一根网络都不发', async () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  feed.seed(whole())
  const { startMs } = tileRange(10, '1h')
  feed.focus('1h', startMs + 10 * HOUR, startMs + 20 * HOUR, 0)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(box.direct.length, 0)
  feed.destroy()
})

test('种进去就能取回来：window 给的是这一段连续行情', () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  feed.seed(whole())
  const { startMs, endMs } = tileRange(10, '1h')
  const view = feed.window('1h', startMs, endMs - 1)
  assert.equal(view.bars.length, TILE_BARS)
  assert.equal(view.loaded, TILE_BARS)
  assert.equal(view.from, startMs)
  feed.destroy()
})

test('没有数据的那一档是空的，不报错', () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  feed.seed(whole())
  const view = feed.window('1d', 0, now)
  assert.deepEqual(view.bars, [])
  assert.equal(view.loaded, 0)
  assert.equal(view.from, 0)
  feed.destroy()
})

test('两端没盖满的那一格不算取过：还会去问', async () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  // 只盖住第 10 格的后半截。
  feed.seed(run(tileRange(10, '1h').startMs + 500 * HOUR, 500))
  const { startMs } = tileRange(10, '1h')
  feed.focus('1h', startMs + 600 * HOUR, startMs + 700 * HOUR, 0)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.ok(box.direct.includes(startMs))
  feed.destroy()
})

test('正在取的那一格落在视野哪一边，就报哪一边在转', async () => {
  const box = rig({
    sources: { direct: () => new Promise(() => {}), now: () => now, wait: async () => {} },
  })
  const feed = historyFeed(space, box.deps)
  feed.seed(whole())
  const { startMs, endMs } = tileRange(10, '1h')
  feed.focus('1h', startMs, endMs - 1, -1)
  for (let i = 0; i < 3; i += 1) await tick()
  const view = feed.window('1h', startMs, endMs - 1)
  assert.equal(view.loadingLeft, true)
  assert.equal(view.failedLeft, false)
  feed.destroy()
})

test('取不到就记在失败那一边，retryFailed 会再发一次', async () => {
  let n = 0
  const box = rig({
    sources: {
      direct: async () => { n += 1; throw new Error('nope') },
      now: () => now,
      wait: async () => {},
    },
  })
  const feed = historyFeed(space, box.deps)
  feed.seed(whole())
  const { startMs, endMs } = tileRange(10, '1h')
  feed.focus('1h', startMs, endMs - 1, -1)
  for (let i = 0; i < 6; i += 1) await tick()
  const view = feed.window('1h', startMs, endMs - 1)
  assert.equal(view.failedLeft || view.failedRight, true)
  const before = n
  feed.retryFailed()
  for (let i = 0; i < 6; i += 1) await tick()
  assert.ok(n > before)
  feed.destroy()
})

test('来一格就叫一声，destroy 之后不再叫', async () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  let calls = 0
  const off = feed.onChange(() => { calls += 1 })
  feed.seed(whole())
  assert.equal(calls, 1)
  off()
  feed.seed(whole())
  assert.equal(calls, 1)
  feed.destroy()
})

test('目录里的上市时间用上了：更早的那一档有地板', async () => {
  const { startMs } = tileRange(10, '1h')
  const box = rig({ bounds: async () => ({ onboardMs: startMs, deliveryMs: null }) })
  const feed = historyFeed(space, box.deps)
  feed.seed(whole())
  feed.focus('1h', startMs + HOUR, startMs + 2 * HOUR, 0)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(feed.window('1h', startMs, startMs + HOUR).floor, startMs)
  feed.destroy()
})

test('来源名字就是图例里那一个', () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  assert.equal(feed.sourceName(), '币安')
  feed.destroy()
})

test('destroy 之后 focus 不再发请求', async () => {
  const box = rig()
  const feed = historyFeed(space, box.deps)
  feed.destroy()
  const { startMs } = tileRange(10, '1h')
  feed.focus('1h', startMs, startMs + HOUR, 0)
  for (let i = 0; i < 3; i += 1) await tick()
  assert.equal(box.direct.length, 0)
})

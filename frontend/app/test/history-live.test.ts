// 活的最新一根：怎么把币安那一帧翻成一根 Bar、什么时候该开流、断了怎么再连。
//
// 这一层一根网络都不发：socket、时钟、定时器全是注进来的。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import {
  BACKOFF_CAP_MS, FIRST_FRAME_MS, THROTTLE_MS, backoffMs, closesIn, liveBar, liveFrame, liveStream,
  nearNow, pinnedToLatest, streamUrl, streamable, throttle,
  type TimerLike, type WebSocketLike,
} from '../src/features/relive/history/live'

const HOUR = 3_600_000
const DAY = 86_400_000

const frame = (k: Record<string, unknown>) => JSON.stringify({ e: 'kline', k })
const kline = (t: number, close = '101', closed = false) => ({
  t, T: t + HOUR - 1, o: '100', h: '102', l: '99', c: close, v: '12', x: closed,
})

test('一帧 kline 翻成一根 Bar，收盘时刻是 T + 1ms，和历史那条路一个口径', () => {
  const at = Date.parse('2024-03-01T00:00:00Z')
  const bar = liveBar(kline(at)) as Bar
  assert.ok(bar)
  assert.equal(bar.start, new Date(at).toISOString())
  assert.equal(bar.end, new Date(at + HOUR).toISOString())
  assert.equal(bar.open, '100')
  assert.equal(bar.close, '101')
  assert.equal(bar.volume, '12')
})

test('看不懂的帧一律给 null，不往图上塞半根', () => {
  assert.equal(liveBar({}), null)
  assert.equal(liveFrame('这不是 JSON'), null)
  assert.equal(liveFrame(JSON.stringify({ e: 'kline' })), null)
})

test('x 为真才算收盘', () => {
  const at = Date.parse('2024-03-01T00:00:00Z')
  assert.equal(liveFrame(frame(kline(at)))?.closed, false)
  assert.equal(liveFrame(frame(kline(at, '105', true)))?.closed, true)
})

test('U 本位和币本位走两个不同的域名，品种小写', () => {
  assert.equal(streamUrl('usd_m', 'BTCUSDT', '1h'), 'wss://fstream.binance.com/ws/btcusdt_kline_1h')
  assert.equal(streamUrl('coin_m', 'BTCUSD_PERP', '15m'), 'wss://dstream.binance.com/ws/btcusd_perp_kline_15m')
})

test('月度归档和已经交割的合约没有「最新一根」，2100 那个占位交割不算数', () => {
  const now = Date.parse('2026-09-13T00:00:00Z')
  assert.equal(streamable({ source: 'monthly_archive', nowMs: now }), false)
  assert.equal(streamable({ deliveryMs: now - DAY, nowMs: now }), false)
  assert.equal(streamable({ deliveryMs: now + 30 * DAY, nowMs: now }), true)
  assert.equal(streamable({ deliveryMs: Date.parse('2100-12-25T08:00:00Z'), nowMs: now }), true)
  assert.equal(streamable({ nowMs: now }), true)
})

test('右边缘还在一屏之内就算贴近现在，拖出整整一屏才算去看历史', () => {
  const now = 10 * DAY
  assert.equal(nearNow({ fromMs: now - DAY, toMs: now }, now), true)
  assert.equal(nearNow({ fromMs: now - 2 * DAY, toMs: now - DAY }, now), true)
  assert.equal(nearNow({ fromMs: now - 3 * DAY, toMs: now - 2 * DAY }, now), false)
  assert.equal(nearNow({ fromMs: now, toMs: now }, now), false)
})

test('钉在最新那一根上只看右边缘差不差一根', () => {
  const now = 10 * DAY
  assert.equal(pinnedToLatest({ toMs: now }, now, '1h'), true)
  assert.equal(pinnedToLatest({ toMs: now - HOUR / 2 }, now, '1h'), true)
  assert.equal(pinnedToLatest({ toMs: now - 3 * HOUR }, now, '1h'), false)
})

test('退避是 1、2、4、8、16、30、30……封顶 30 秒', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
  assert.equal(backoffMs(100), BACKOFF_CAP_MS)
})

test('节流：头一下立刻走，中间那些只留最后一根', () => {
  let now = 0
  const seen: string[] = []
  const beat = throttle<string>(THROTTLE_MS, (value) => seen.push(value), () => now)
  beat.push('a')
  assert.deepEqual(seen, ['a'])
  beat.push('b'); beat.push('c')
  assert.deepEqual(seen, ['a'])
  assert.equal(beat.pending(), true)
  now += THROTTLE_MS
  beat.push('d')
  assert.deepEqual(seen, ['a', 'd'])
})

test('距收盘：一小时以内走秒，1d 以上按小时分，过点了按 0 显示', () => {
  assert.equal(closesIn(95_000, '15m'), '距收盘 01:35')
  assert.equal(closesIn(5_400_000, '1d'), '距收盘 1h30m')
  assert.equal(closesIn(-5_000, '15m'), '距收盘 00:00')
})

/* ---------------------------------------------------------------- 那条流 */

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  closed = false
  close(): void { this.closed = true }
}

function fakeTimer(): TimerLike & { run(): number; waits: number[] } {
  let next = 1
  const jobs = new Map<number, { run: () => void; ms: number }>()
  return {
    waits: [] as number[],
    set(run, ms) { const id = next++; jobs.set(id, { run, ms }); this.waits.push(ms); return id },
    clear(id) { jobs.delete(id) },
    run() {
      const now = [...jobs.entries()]
      jobs.clear()
      for (const [, job] of now) job.run()
      return now.length
    },
  }
}

test('want(true) 才开流，want(false) 把连接关掉', () => {
  const sockets: FakeSocket[] = []
  const timer = fakeTimer()
  const stream = liveStream({
    market: 'usd_m', symbol: 'BTCUSDT', interval: '1h',
    onBar: () => {}, onClosed: () => {},
    timer, now: () => 0,
    open: () => { const s = new FakeSocket(); sockets.push(s); return s },
  })
  assert.equal(sockets.length, 0)
  stream.want(true)
  assert.equal(sockets.length, 1)
  stream.want(true)
  assert.equal(sockets.length, 1, '幂等：叫两次只开一条')
  stream.want(false)
  assert.equal(sockets[0]!.closed, true)
  stream.stop()
})

test('走着的那一根走 onBar，x 一来走 onClosed', () => {
  const sockets: FakeSocket[] = []
  const bars: Bar[] = []
  const done: Bar[] = []
  let now = 0
  const stream = liveStream({
    market: 'usd_m', symbol: 'BTCUSDT', interval: '1h',
    onBar: (bar) => bars.push(bar), onClosed: (bar) => done.push(bar),
    timer: fakeTimer(), now: () => now,
    open: () => { const s = new FakeSocket(); sockets.push(s); return s },
  })
  stream.want(true)
  const socket = sockets[0]!
  socket.onopen?.({})
  const at = Date.parse('2024-03-01T00:00:00Z')
  socket.onmessage?.({ data: frame(kline(at, '101')) })
  assert.equal(bars.length, 1)
  now += THROTTLE_MS
  socket.onmessage?.({ data: frame(kline(at, '109', true)) })
  assert.equal(done.length, 1)
  assert.equal(done[0]!.close, '109')
  stream.stop()
})

test('断了按退避重连，连上之后退避从头数', () => {
  const sockets: FakeSocket[] = []
  const timer = fakeTimer()
  const stream = liveStream({
    market: 'usd_m', symbol: 'BTCUSDT', interval: '1h',
    onBar: () => {}, onClosed: () => {},
    timer, now: () => 0,
    open: () => { const s = new FakeSocket(); sockets.push(s); return s },
  })
  stream.want(true)
  sockets[0]!.onclose?.({})
  assert.ok(timer.waits.includes(1000), '第一次等 1 秒')
  timer.run()
  assert.equal(sockets.length, 2, '重连开了第二条')
  stream.stop()
})

test('开了十秒还没有第一帧就当这条路不通，改成每 15 秒补两根', async () => {
  const sockets: FakeSocket[] = []
  const timer = fakeTimer()
  let polled = 0
  const stream = liveStream({
    market: 'usd_m', symbol: 'BTCUSDT', interval: '1h',
    onBar: () => {}, onClosed: () => {},
    timer, now: () => 0,
    open: () => { const s = new FakeSocket(); sockets.push(s); return s },
    poll: async () => { polled += 1; return [] },
  })
  stream.want(true)
  assert.ok(timer.waits.includes(FIRST_FRAME_MS), '开着就挂上第一帧的看门狗')
  timer.run()
  timer.run()
  await Promise.resolve()
  assert.ok(polled >= 1, '看门狗响了就走退路')
  stream.stop()
})

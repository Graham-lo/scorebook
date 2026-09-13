// 谁先取、谁不必取、什么时候算到头了。
//
// 取数、时钟、先验全是注进来的，这里一根网络都不发。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar } from '../src/api/types'
import { GAP_RETRY_MS, scheduler, type Bounds, type SchedulerDeps } from '../src/features/relive/history/scheduler'
import type { TileResult } from '../src/features/relive/history/sources'
import { tileRange, type TileKey } from '../src/features/relive/history/tiles'

const space = { market: 'usd_m' as const, symbol: 'BTCUSDT' }
const LEVEL = '1h'
const HOUR = 3_600_000
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

function bar(at: number): Bar {
  return {
    start: new Date(at).toISOString(),
    end: new Date(at + HOUR).toISOString(),
    open: '1', high: '2', low: '0', close: '1', volume: '1',
  }
}

/** 记下每一次要哪一格，答什么由脚本说了算。 */
function rig(options: {
  answer?: (key: TileKey) => TileResult | 'pending' | 'fail'
  concurrency?: number
  bounds?: Bounds
  now?: () => number
} = {}) {
  const asked: TileKey[] = []
  const signals: AbortSignal[] = []
  const landed: TileKey[] = []
  const failed: TileKey[] = []
  const deps: SchedulerDeps = {
    fetch: (key, signal) => {
      asked.push(key)
      signals.push(signal)
      const said = options.answer?.(key) ?? { bars: [], complete: true }
      if (said === 'pending') return new Promise<TileResult>(() => {})
      if (said === 'fail') return Promise.reject(new Error('nope'))
      return Promise.resolve(said)
    },
    concurrency: () => options.concurrency ?? 1,
    bounds: () => Promise.resolve(options.bounds ?? { onboardMs: null, deliveryMs: null }),
    now: options.now ?? (() => Date.UTC(2026, 0, 1)),
    onTile: (key) => { landed.push(key) },
    onFail: (key) => { failed.push(key) },
  }
  return { deps, asked, signals, landed, failed }
}

/** 正好一屏 = 一整格。 */
function screen(index: number): { from: number; to: number } {
  const { startMs, endMs } = tileRange(index, LEVEL)
  return { from: startMs, to: endMs - 1 }
}

test('优先级：屏上的先取，再两侧各一屏，行进方向再往前两屏', async () => {
  const box = rig()
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  assert.deepEqual(box.asked.map((key) => key.index), [10, 11, 9, 12, 13])
})

test('往回拖的时候先补左边那一屏', async () => {
  const box = rig()
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, -1)
  await tick()
  assert.deepEqual(box.asked.slice(0, 3).map((key) => key.index), [10, 9, 11])
})

test('同一格只在飞一次', async () => {
  const box = rig({ answer: () => 'pending' })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 0)
  await tick()
  run.focus(LEVEL, view.from, view.to, 0)
  await tick()
  assert.equal(box.asked.length, 1)
  assert.equal(run.loading().length, 1)
})

test('离开兴趣区的在途请求当场取消', async () => {
  const box = rig({ answer: () => 'pending' })
  const run = scheduler(space, box.deps)
  const near = screen(10)
  run.focus(LEVEL, near.from, near.to, 0)
  await tick()
  assert.equal(box.signals[0]?.aborted, false)
  const far = screen(500)
  run.focus(LEVEL, far.from, far.to, 0)
  await tick()
  assert.equal(box.signals[0]?.aborted, true)
})

test('直连并发 3：一次可以有三格在飞', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 3 })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  assert.equal(run.loading().length, 3)
})

test('走后端就只排一路', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 1 })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  assert.equal(run.loading().length, 1)
})

test('地板：连着两格空、右边又有数据，就是上市那一天', async () => {
  const head = tileRange(10, LEVEL).startMs
  const box = rig({
    answer: (key) => (key.index === 10 ? { bars: [bar(head)], complete: true } : { bars: [], complete: true }),
  })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, -1)
  for (let i = 0; i < 8; i += 1) await tick()
  assert.equal(run.floorOf(LEVEL), head)
})

test('地板定了就不再往左发请求', async () => {
  const head = tileRange(10, LEVEL).startMs
  const box = rig({
    answer: (key) => (key.index === 10 ? { bars: [bar(head)], complete: true } : { bars: [], complete: true }),
  })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, -1)
  for (let i = 0; i < 8; i += 1) await tick()
  const before = box.asked.length
  run.focus(LEVEL, view.from, view.to, -1)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(box.asked.filter((key) => key.index < 7).length, 0)
  assert.ok(box.asked.length >= before)
})

test('目录里的上市时间当先验：更早的格子一次都不问', async () => {
  const box = rig({
    answer: () => 'pending',
    bounds: { onboardMs: tileRange(10, LEVEL).startMs, deliveryMs: null },
  })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, -1)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(box.asked.filter((key) => key.index < 10).length, 0)
  assert.equal(run.floorOf(LEVEL), tileRange(10, LEVEL).startMs)
})

test('交割之后的格子也不问', async () => {
  const box = rig({
    answer: () => 'pending',
    bounds: { onboardMs: null, deliveryMs: tileRange(11, LEVEL).startMs },
  })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(box.asked.filter((key) => key.index > 10).length, 0)
})

test('未来那一段不问', async () => {
  const now = tileRange(10, LEVEL).startMs
  const box = rig({ answer: () => 'pending', now: () => now })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(box.asked.filter((key) => key.index > 10).length, 0)
})

test('中段缺口一小时内不重试，过了就再试一次', async () => {
  let clock = Date.UTC(2026, 0, 1)
  const box = rig({ answer: () => ({ bars: [], complete: false, hole: 'gap' }), now: () => clock })
  const run = scheduler(space, box.deps)
  const { startMs } = tileRange(10, LEVEL)
  const from = startMs + HOUR
  const to = from + HOUR
  run.focus(LEVEL, from, to, 0)
  await tick()
  assert.equal(box.asked.length, 1)
  run.focus(LEVEL, from, to, 0)
  await tick()
  assert.equal(box.asked.length, 1)
  clock += GAP_RETRY_MS + 1
  run.focus(LEVEL, from, to, 0)
  await tick()
  assert.equal(box.asked.length, 2)
})

test('失败的格子记下来，retryFailed 才会重发', async () => {
  const box = rig({ answer: () => 'fail' })
  const run = scheduler(space, box.deps)
  const { startMs } = tileRange(10, LEVEL)
  run.focus(LEVEL, startMs + HOUR, startMs + 2 * HOUR, 0)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(run.failed().length, 1)
  assert.equal(box.failed.length, 1)
  const before = box.asked.length
  run.focus(LEVEL, startMs + HOUR, startMs + 2 * HOUR, 0)
  await tick()
  assert.equal(box.asked.length, before)
  run.retryFailed()
  for (let i = 0; i < 4; i += 1) await tick()
  assert.ok(box.asked.length > before)
})

test('重试成功之后就不再算失败', async () => {
  let fail = true
  const box = rig({ answer: () => (fail ? 'fail' : { bars: [], complete: true }) })
  const run = scheduler(space, box.deps)
  const { startMs } = tileRange(10, LEVEL)
  run.focus(LEVEL, startMs + HOUR, startMs + 2 * HOUR, 0)
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(run.failed().length, 1)
  fail = false
  run.retryFailed()
  for (let i = 0; i < 4; i += 1) await tick()
  assert.equal(run.failed().length, 0)
})

test('每取回一格就报一次', async () => {
  const box = rig()
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 0)
  for (let i = 0; i < 6; i += 1) await tick()
  assert.ok(box.landed.length >= 1)
  assert.equal(box.landed[0]?.index, 10)
})

test('空视野就停一停：不再排新的', async () => {
  const box = rig({ answer: () => 'pending' })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  const before = box.asked.length
  run.focus(LEVEL, 0, 0, 0)
  await tick()
  assert.equal(box.asked.length, before)
})

test('预热要的那一段也排进去，只是排在最后', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 12 })
  const run = scheduler(space, box.deps)
  run.warmup(3000)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 0)
  await tick()
  const indexes = box.asked.map((key) => key.index)
  assert.ok(indexes.includes(7), indexes.join(','))
  assert.equal(indexes[0], 10)
})

test('stop 之后在途的全取消，也不再发新的', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 3 })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  run.stop()
  assert.ok(box.signals.every((signal) => signal.aborted))
  const before = box.asked.length
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  assert.equal(box.asked.length, before)
})

test('天花板就是现在', () => {
  const now = Date.UTC(2026, 2, 3)
  const box = rig({ now: () => now })
  const run = scheduler(space, box.deps)
  assert.equal(run.ceiling(), now)
})

test('换档：视野没动，旧档在途的也全部取消，新的请求都问新档', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 3 })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 0)
  await tick()
  assert.ok(box.asked.length > 0)
  assert.ok(box.asked.every((key) => key.interval === LEVEL))
  const before = box.asked.length
  run.focus('4h', view.from, view.to, 0)
  await tick()
  assert.ok(box.signals.slice(0, before).every((signal) => signal.aborted), '旧档没停干净')
  assert.ok(box.asked.slice(before).every((key) => key.interval === '4h'))
  assert.ok(run.loading().every((key) => key.interval === '4h'))
})

test('在飞的格子数不超过并发上限', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 3 })
  const run = scheduler(space, box.deps)
  const view = screen(10)
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  assert.equal(box.asked.length, 3)
  assert.equal(run.loading().length, 3)
  // 再催一遍不会多放一个出去。
  run.focus(LEVEL, view.from, view.to, 1)
  await tick()
  assert.equal(box.asked.length, 3)
})

test('视野拖走之后，拖之前那些还在飞的格子全部作废', async () => {
  const box = rig({ answer: () => 'pending', concurrency: 3 })
  const run = scheduler(space, box.deps)
  const near = screen(10)
  run.focus(LEVEL, near.from, near.to, 1)
  await tick()
  const before = box.asked.length
  assert.ok(before > 0)
  const far = screen(60)
  run.focus(LEVEL, far.from, far.to, 1)
  await tick()
  assert.ok(box.signals.slice(0, before).every((signal) => signal.aborted), '拖走之前的请求没停')
  // 腾出来的名额立刻给了新地方，还是不超上限。
  assert.ok(run.loading().length <= 3)
  assert.ok(run.loading().every((key) => Math.abs(key.index - 60) <= 3))
})

// 窗口态往前预热那条链：区间怎么算、重叠的怎么去重、什么时候停。
//
// 取数那两件事是注进来的，所以这里一根网络都不用真发。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bar, ChartRequest, MarketData } from '../src/api/types'
import { feed, PAGE, type FeedDeps } from '../src/features/relive/history-feed'

const HOUR = 3_600_000
const T0 = Date.UTC(2025, 5, 1, 0, 0, 0)

function bar(at: number): Bar {
  return {
    start: new Date(at).toISOString(),
    end: new Date(at + HOUR).toISOString(),
    open: '100',
    high: '101',
    low: '99',
    close: '100.5',
    volume: '10',
  }
}

/** 从 at 起连着 count 根。 */
function run(at: number, count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => bar(at + i * HOUR))
}

const request: ChartRequest = {
  symbol: 'BTCUSDT',
  market: 'usd_m',
  interval: '1h',
  start_at: new Date(T0).toISOString(),
  end_at: new Date(T0 + 100 * HOUR).toISOString(),
}

const wrap = (bars: Bar[]): MarketData => ({ bars, coverage_complete: true })

/** 记下每一次要的区间，按脚本一页一页回答。 */
function deps(pages: Bar[][], onboard: string | null = null) {
  const asked: { start: string; end: string }[] = []
  let n = 0
  const made: FeedDeps = {
    fetch: async (req) => {
      asked.push({ start: req.start_at, end: req.end_at })
      const page = pages[n] ?? []
      n += 1
      return wrap(page)
    },
    onboard: async () => onboard,
  }
  return { deps: made, asked }
}

test('翻页不带截止线：候选的 match_end_at 在翻页区间之外，带上后端会拒', async () => {
  const seen: (string | undefined)[] = []
  const made: FeedDeps = {
    fetch: async (req) => { seen.push(req.match_end_at); return wrap(run(Date.parse(req.start_at), 5)) },
    onboard: async () => null,
  }
  const stream = feed({ ...request, match_end_at: request.end_at }, wrap(run(T0, 100)), made)
  await stream.ensureBefore(101, new AbortController().signal)
  await stream.ensureBefore(201, new AbortController().signal)
  assert.ok(seen.length >= 2)
  assert.ok(seen.every((v) => v === undefined))
})

test('往前要一页：区间正好是「第一根往回数 1900 根」到「第一根」', async () => {
  const initial = wrap(run(T0, 100))
  const page = deps([run(T0 - 50 * HOUR, 50)])
  const stream = feed(request, initial, page.deps)
  await stream.ensureBefore(40, new AbortController().signal)

  assert.equal(page.asked.length, 1)
  assert.equal(page.asked[0]?.end, new Date(T0).toISOString())
  assert.equal(page.asked[0]?.start, new Date(T0 - PAGE * HOUR).toISOString())
  assert.equal(stream.bars.length, 150)
  assert.equal(stream.earliest, new Date(T0 - 50 * HOUR).toISOString())
  // 拼出来的还是一条连续升序。
  for (let i = 1; i < stream.bars.length; i += 1) {
    assert.ok(Date.parse(stream.bars[i]!.start) > Date.parse(stream.bars[i - 1]!.start))
  }
})

test('重叠的那几根按时间去重，只留一根', async () => {
  const initial = wrap(run(T0, 10))
  // 这一页和已有的前 3 根重了。
  const page = deps([run(T0 - 5 * HOUR, 8)])
  const stream = feed(request, initial, page.deps)
  await stream.ensureBefore(5, new AbortController().signal)
  assert.equal(stream.bars.length, 15)
  const stamps = new Set(stream.bars.map((b) => b.start))
  assert.equal(stamps.size, 15)
})

test('空页就是到头了：不再往前要第二页', async () => {
  const initial = wrap(run(T0, 10))
  const page = deps([[]])
  const stream = feed(request, initial, page.deps)
  await stream.ensureBefore(500, new AbortController().signal)
  assert.equal(page.asked.length, 1)
  assert.equal(stream.exhaustedBefore, true)
  assert.equal(stream.bars.length, 10)
})

test('目录里的上市日到了就停，区间也不会要到上市之前', async () => {
  const onboard = new Date(T0 - 20 * HOUR).toISOString()
  const initial = wrap(run(T0, 10))
  const page = deps([run(T0 - 20 * HOUR, 20)], onboard)
  const stream = feed(request, initial, page.deps)
  await stream.ensureBefore(1000, new AbortController().signal)
  assert.equal(page.asked.length, 1)
  assert.equal(page.asked[0]?.start, onboard)
  assert.equal(stream.exhaustedBefore, true)
  assert.equal(stream.earliest, onboard)
})

test('要够了就不再多要一页', async () => {
  const initial = wrap(run(T0, 10))
  const page = deps([run(T0 - 30 * HOUR, 30), run(T0 - 60 * HOUR, 30)])
  const stream = feed(request, initial, page.deps)
  await stream.ensureBefore(25, new AbortController().signal)
  assert.equal(page.asked.length, 1)
  assert.equal(stream.bars.length, 40)
})

test('两处同时要：排成一条链，不会并发打过去', async () => {
  const initial = wrap(run(T0, 10))
  let inflight = 0
  let most = 0
  const made: FeedDeps = {
    fetch: async (req: ChartRequest) => {
      inflight += 1
      most = Math.max(most, inflight)
      await new Promise((done) => setTimeout(done, 1))
      inflight -= 1
      return wrap(run(Date.parse(req.start_at), 5))
    },
    onboard: async () => null,
  }
  const stream = feed(request, initial, made)
  const signal = new AbortController().signal
  await Promise.all([stream.ensureBefore(5, signal), stream.ensureBefore(5, signal)])
  assert.equal(most, 1)
})

// `/v1/market/bounds` 那份先验：占位交割当作没有、缺口登记成洞、后端不认识这个
// 合约（404）就退回目录，别让调用方满地写 try。

import assert from 'node:assert/strict'
import test from 'node:test'
import type { InstrumentBounds } from '../src/api/types'
import {
  PLACEHOLDER_AHEAD_MS, SKEW_TOLERANCE_MS, boundsPrior, bounds, correctedNow, realDelivery,
} from '../src/api/market'

const NOW = Date.parse('2026-09-13T00:00:00Z')
const DAY = 86_400_000

function found(over: Partial<InstrumentBounds> = {}): InstrumentBounds {
  return {
    market: 'usd_m', symbol: 'BTCUSDT', interval: '1h', status: 'TRADING',
    onboard_at: '2019-09-08T00:00:00Z',
    delivery_at: null,
    first_bar_at: '2019-09-08T17:00:00Z',
    last_bar_at: '2026-09-12T23:00:00Z',
    gaps: [],
    verified_at: null,
    server_now: new Date(NOW).toISOString(),
    ...over,
  }
}

test('2100 那个占位交割当作没有，真的交割日照常认', () => {
  assert.equal(realDelivery('2100-12-25T08:00:00Z', NOW), null)
  assert.equal(realDelivery(null, NOW), null)
  assert.equal(realDelivery('乱写的', NOW), null)
  assert.equal(realDelivery('2026-12-25T08:00:00Z', NOW), Date.parse('2026-12-25T08:00:00Z'))
})

test('占位的界线就是十年开外', () => {
  assert.equal(realDelivery(new Date(NOW + PLACEHOLDER_AHEAD_MS + DAY).toISOString(), NOW), null)
  assert.ok(realDelivery(new Date(NOW + PLACEHOLDER_AHEAD_MS - DAY).toISOString(), NOW) !== null)
})

test('地板取真取到过的第一根，比目录里的上市时间准', () => {
  const prior = boundsPrior(found(), NOW)
  assert.equal(prior.onboardMs, Date.parse('2019-09-08T17:00:00Z'))
  const noFirst = boundsPrior(found({ first_bar_at: null }), NOW)
  assert.equal(noFirst.onboardMs, Date.parse('2019-09-08T00:00:00Z'))
  const nothing = boundsPrior(found({ first_bar_at: null, onboard_at: null }), NOW)
  assert.equal(nothing.onboardMs, null)
})

test('缺口翻成可重试的洞，起止说不通的那几条丢掉', () => {
  const prior = boundsPrior(found({
    gaps: [
      { start: '2020-02-01T00:00:00Z', end: '2020-02-03T00:00:00Z' },
      { start: '2020-05-01T00:00:00Z', end: '2020-04-01T00:00:00Z' },
      { start: '乱写', end: '2020-06-01T00:00:00Z' },
    ],
  }), NOW)
  assert.equal(prior.gaps.length, 1)
  assert.equal(prior.gaps[0]!.startMs, Date.parse('2020-02-01T00:00:00Z'))
  assert.equal(prior.gaps[0]!.endMs, Date.parse('2020-02-03T00:00:00Z'))
})

test('本机时钟和后端差了多少，一并算出来', () => {
  const prior = boundsPrior(found(), NOW + 90_000)
  assert.equal(prior.serverNowMs, NOW)
  assert.equal(prior.skewMs, 90_000)
})

test('偏得不多就照常信本机，偏过头了才认服务器的表', () => {
  assert.equal(correctedNow(NOW, 5_000), NOW)
  assert.equal(correctedNow(NOW, SKEW_TOLERANCE_MS), NOW)
  assert.equal(correctedNow(NOW, 90_000), NOW - 90_000)
  assert.equal(correctedNow(NOW, -90_000), NOW + 90_000)
})

/* -------------------------------------------------- 那一趟请求 */

function stubFetch(status: number, body: unknown): () => void {
  const before = { fetch: globalThis.fetch, location: (globalThis as { location?: unknown }).location }
  ;(globalThis as { location?: unknown }).location = { origin: 'http://localhost' }
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
  return () => {
    globalThis.fetch = before.fetch
    ;(globalThis as { location?: unknown }).location = before.location
  }
}

test('取到了就原样给出来', async () => {
  const undo = stubFetch(200, { data: found() })
  try {
    const got = await bounds({ market: 'usd_m', symbol: 'BTCUSDT', interval: '1h' })
    assert.equal(got?.symbol, 'BTCUSDT')
    assert.equal(got?.first_bar_at, '2019-09-08T17:00:00Z')
  } finally { undo() }
})

test('后端不认识这个合约（404）不是错误，翻成 null 让调用方退回目录', async () => {
  const undo = stubFetch(404, { error: { code: 'instrument_unknown' } })
  try {
    assert.equal(await bounds({ market: 'usd_m', symbol: 'NOPEUSDT', interval: '1h' }), null)
  } finally { undo() }
})

test('别的错照样抛出来，不许悄悄当成「没有边界」', async () => {
  const undo = stubFetch(500, { error: { code: 'internal' } })
  try {
    await assert.rejects(() => bounds({ market: 'usd_m', symbol: 'BTCUSDT', interval: '1h' }))
  } finally { undo() }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Attachment, AttachmentLocation } from '../src/api/types'
import { followupChart, locatedShots, sameInstrumentHref } from '../src/features/call/facts'

const at: AttachmentLocation = {
  symbol: 'MUUSDT', market: 'usd_m', interval: '1h', source: 'monthly_archive',
  start_at: '2025-06-01T00:00:00Z', end_at: '2025-06-03T00:00:00Z',
}

test('后续走势使用截图确认的品种、市场、周期、原时间窗和数据来源', () => {
  const chart = followupChart(at, Date.parse('2026-09-12T00:00:00Z'))
  assert.deepEqual(chart, {
    symbol: 'MUUSDT', market: 'usd_m', interval: '1h', source: 'monthly_archive',
    start_at: at.start_at, end_at: '2025-06-08T00:00:00.000Z', match_end_at: at.end_at,
  })
})

test('后续结束不超过当前时间；月线按日历增加而不是固定30天', () => {
  assert.equal(followupChart(at, Date.parse('2025-06-03T01:00:00Z'))?.end_at, '2025-06-03T01:00:00.000Z')
  assert.equal(followupChart({ ...at, interval: '1M', start_at: '2025-01-01T00:00:00Z', end_at: '2025-02-01T00:00:00Z' }, Date.parse('2026-01-01'), 2)?.end_at, '2025-04-01T00:00:00.000Z')
  assert.equal(followupChart({ ...at, interval: 'bad' }), null)
  assert.equal(followupChart({ ...at, end_at: 'bad' }), null)
})

test('多张已定位图全部保留选择，已换下来的当时图不能成为默认走势', () => {
  const shot = (id: string, more: Partial<Attachment>) => ({ id, kind: 'scene', location: at, ...more } as Attachment)
  const selected = locatedShots({ attachments: [
    shot('old', { superseded_at: '2026-09-10T00:00:00Z' }),
    shot('current', {}),
    shot('reference', { kind: 'reference' }),
    shot('unmatched', { location: null }),
  ] })
  assert.deepEqual(selected.map(v => v.id), ['current', 'reference'])
})

test('同品种入口携带准确品种及市场，没有品种时不给虚假关联', () => {
  const target = sameInstrumentHref({ instrument: 'BTC/USD', market: 'coin_m' })
  assert.equal(target, '#/find?by=symbol&instrument=BTC%2FUSD&market=coin_m')
  assert.equal(sameInstrumentHref({ instrument: null, market: null }), null)
})

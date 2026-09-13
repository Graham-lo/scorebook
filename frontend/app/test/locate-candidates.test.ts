import test from 'node:test'
import assert from 'node:assert/strict'
import { locateCandidates } from '../src/data/locate-candidates'

test('锚定定位候选没有公共索引 ID，仍可展示、比对与人工确认', () => {
  const candidate = { symbol: 'SKHYUSDT', market: 'usd_m', interval: '1h', start_at: '2026-09-05T00:00:00Z', end_at: '2026-09-09T13:00:00Z', bars_count: 109, match: { score: 0.6356, level: 'likely' } }
  const parsed = locateCandidates([candidate])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]!.id, undefined)
  assert.equal(parsed[0]!.market_source, 'rest')
  assert.equal(parsed[0]!.bars_count, 109)
  assert.equal(locateCandidates([{ ...candidate, end_at: 'bad' }, null, { ...candidate, market: 'invented' }]).length, 0)
  assert.equal(locateCandidates([{ ...candidate, chart_request: { source: 'monthly_archive' } }])[0]!.market_source, 'monthly_archive')
})

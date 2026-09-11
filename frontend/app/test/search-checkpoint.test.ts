import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCheckpoint } from '../src/features/search/checkpoint'
const saved = { queryId: '50773d78-84a7-43ef-8240-cec3b9f03383', queryName: 'query', runId: '50773d78-84a7-43ef-8240-cec3b9f03384', scope: 'binance_history', region: { x: 1, y: 2, width: 100, height: 80 }, interval: '4h', symbol: null, market: 'usd_m', redUp: false, reverse: false, limit: 3 }
test('refresh restores the same task, period, source and ROI without market bytes', () => {
  assert.deepEqual(readCheckpoint(JSON.stringify({ ...saved, rawCandles: [1], svg: '<svg/>' })), saved)
})
test('unscoped, malformed or unsupported saved tasks are not resumed', () => {
  for (const value of [null, { ...saved, interval: null }, { ...saved, interval: '7h' }, { ...saved, region: { x: -1, y: 0, width: 10, height: 10 } }]) assert.equal(readCheckpoint(JSON.stringify(value)), null)
})
test('an explicit any-interval choice survives the refresh too', () => {
  const any = { ...saved, interval: 'any' }
  assert.deepEqual(readCheckpoint(JSON.stringify(any)), any)
})

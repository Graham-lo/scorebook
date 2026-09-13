import assert from 'node:assert/strict'
import test from 'node:test'
import { historyEnd } from '../src/data/chart-window'
test('延看行情按周期根数推进，月线使用自然月，原匹配窗口不变', () => {
 const request = { end_at: '2026-01-01T00:00:00Z', interval: '1M' }
 assert.equal(historyEnd(request.end_at, request.interval, 2), '2026-03-01T00:00:00.000Z')
 assert.equal(request.end_at, '2026-01-01T00:00:00Z')
 assert.equal(historyEnd('2026-09-09T13:00:00Z', '1h', 32), '2026-09-10T21:00:00.000Z')
})

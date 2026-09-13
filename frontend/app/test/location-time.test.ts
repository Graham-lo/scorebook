import { test } from 'node:test'
import assert from 'node:assert/strict'
import { locationEndAt } from '../src/data/location-time'

test('最后一根按开盘时间填写，结束边界包含这一根', () => {
  assert.equal(locationEndAt(new Date('2026-09-09T20:00:00+08:00'), '1h'), '2026-09-09T13:00:00.000Z')
})

test('周线从星期一开始，月线按日历而非固定 30 天', () => {
  assert.equal(locationEndAt(new Date('2026-09-09T12:00Z'), '1w'), '2026-09-14T00:00:00.000Z')
  assert.equal(locationEndAt(new Date('2026-02-01T00:00Z'), '1M'), '2026-03-01T00:00:00.000Z')
  assert.equal(locationEndAt(new Date('2026-12-01T00:00Z'), '1M'), '2027-01-01T00:00:00.000Z')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { QueryPeriod } from '../src/features/search/query-period'

test('unknown and OCR-suggested periods both wait for a declared selection', () => {
  const period = new QueryPeriod()
  assert.equal(period.value, null)
  assert.equal(period.suggestion(null), null)
  assert.equal(period.suggestion('4h'), '4h')
  assert.equal(period.value, null)
  period.select('4h')
  assert.equal(period.value, '4h')
})

test('new screenshot or region cannot inherit the prior screenshot period', () => {
  const period = new QueryPeriod()
  period.select('1h')
  period.reset()
  assert.equal(period.value, null)
  assert.throws(() => period.select(''), /周期/)
  assert.throws(() => period.select('7h'), /周期/)
  assert.equal(period.value, null)
})

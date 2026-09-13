import assert from 'node:assert/strict'
import test from 'node:test'
import { applyInstrumentQuery, serverFilterKey, type FindState } from '../src/features/find/state'

function state(): FindState {
  return { instrument: 'BTCUSDT', market: 'usd_m', timeframe: null, tag: null, stance: null, path: null, result: null, days: null }
}

test('服务端筛选绑定品种、市场、周期和标签；本地筛选复用同批记录', () => {
  const initial = state()
  const key = serverFilterKey(initial)
  for (const update of [{ instrument: 'ETHUSDT' }, { market: 'coin_m' as const }, { timeframe: '15m' }, { tag: '回踩' }]) {
    assert.notEqual(serverFilterKey({ ...initial, ...update }), key)
  }
  assert.equal(serverFilterKey({ ...initial, stance: 'L', result: 'realized', path: 'chart_first', days: 7 }), key)
})

test('详情里的同品种链接恢复准确市场，不能沿用上个品种的市场', () => {
  const current = state()
  applyInstrumentQuery(new URLSearchParams('instrument=BTCUSD_PERP&market=coin_m'), current)
  assert.equal(current.instrument, 'BTCUSD_PERP')
  assert.equal(current.market, 'coin_m')
  applyInstrumentQuery(new URLSearchParams('instrument=ETHUSDT'), current)
  assert.equal(current.instrument, 'ETHUSDT')
  assert.equal(current.market, null)
  applyInstrumentQuery(new URLSearchParams('market=coin_m'), current)
  assert.equal(current.instrument, null)
  assert.equal(current.market, 'coin_m')
})

test('未传品种参数保留列表上下文，显式空值和无效市场可安全清除', () => {
  const current = state()
  applyInstrumentQuery(new URLSearchParams('by=symbol'), current)
  assert.deepEqual(current, state())
  applyInstrumentQuery(new URLSearchParams('instrument=&market=future_market'), current)
  assert.equal(current.instrument, null)
  assert.equal(current.market, null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { excludeId, type HistoryCandidate, type PrivateCandidate } from '../src/api/chart'
import { searchBody } from '../src/features/search/run'
import { MAX_EXCLUDE, forgetRejected, period, rejectAll, rejectedCount, rejectionFull, state } from '../src/features/search/state'

const QUERY = '50773d78-84a7-43ef-8240-cec3b9f03383'
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** 每个用例都从同一个问题开始问：否决集合是跟着问题走的，问题得先定下来。 */
function ask(): void {
  forgetRejected()
  state.queryId = QUERY
  state.scope = 'binance_history'
  state.symbol = null
  state.market = null
  state.region = null
  state.reverse = false
  state.redUp = false
  state.limit = 3
  period.select('4h')
}

test('一条都没否过的时候，请求体里根本没有 exclude 这一格', () => {
  ask()
  const body = searchBody(QUERY)
  assert.equal('exclude' in body, false)
  assert.equal(rejectedCount(), 0)
})

test('「都不是」是累加的：第三轮报的是前两轮一共六条', () => {
  ask()
  rejectAll([id(1), id(2), id(3)])
  assert.deepEqual(searchBody(QUERY).exclude, [id(1), id(2), id(3)])
  rejectAll([id(4), id(5), id(6)])
  assert.deepEqual(searchBody(QUERY).exclude, [id(1), id(2), id(3), id(4), id(5), id(6)])
  // 同一条报两次不该把它变成两条：集合，不是列表。
  rejectAll([id(1)])
  assert.equal(rejectedCount(), 6)
})

test('连着两次「都不是」是两份不同的请求体，不会被当成同一次重发', () => {
  ask()
  rejectAll([id(1), id(2), id(3)])
  const first = JSON.stringify(searchBody(QUERY))
  rejectAll([id(4), id(5), id(6)])
  assert.notEqual(JSON.stringify(searchBody(QUERY)), first)
})

test('问题一变，之前的否决就不跟过来了', () => {
  for (const change of [
    () => { state.symbol = 'BTCUSDT' },
    () => { state.scope = 'private' },
    () => { state.market = 'usd_m' },
    () => { period.select('1h') },
    () => { state.queryId = '50773d78-84a7-43ef-8240-cec3b9f03384' },
  ]) {
    ask()
    rejectAll([id(1), id(2), id(3)])
    assert.equal(rejectedCount(), 3)
    change()
    assert.equal(rejectedCount(), 0)
    assert.equal('exclude' in searchBody(state.queryId ?? QUERY), false)
  }
})

test('到了后端收得下的上限就不能再报了', () => {
  ask()
  rejectAll(Array.from({ length: MAX_EXCLUDE - 3 }, (_, n) => id(n)))
  // 还差三条到上限：这一屏正好报得下。
  assert.equal(rejectionFull(3), false)
  assert.equal(rejectionFull(4), true)
  rejectAll([id(MAX_EXCLUDE - 3), id(MAX_EXCLUDE - 2), id(MAX_EXCLUDE - 1)])
  assert.equal(rejectedCount(), MAX_EXCLUDE)
  assert.equal(rejectionFull(1), true)
  assert.equal(searchBody(QUERY).exclude?.length, MAX_EXCLUDE)
  forgetRejected()
})

test('要报上去的 id 两条路上不是同一样东西', () => {
  const history = { id: id(7), symbol: 'BTCUSDT' } as HistoryCandidate
  const mine = { attachment_id: id(8), call_id: id(9) } as PrivateCandidate
  assert.equal(excludeId(history), id(7))
  assert.equal(excludeId(mine), id(8))
})

test('多要几条答案不算换了问题：否掉的那几条不会因此回来', () => {
  ask()
  rejectAll([id(1), id(2), id(3)])
  // 「最多 3 条」改成 5 条，问的还是同一件事，只是想多看几个。否决要是跟着一起
  // 清空，人再按一次「都不是」，刚否掉的那三条就又回到眼前了。
  state.limit = 5
  assert.equal(rejectedCount(), 3)
  assert.deepEqual(searchBody(QUERY).exclude, [id(1), id(2), id(3)])
})

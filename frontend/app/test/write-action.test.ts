import assert from 'node:assert/strict'
import test from 'node:test'
import { WriteAction } from '../src/api/http'

test('LAN HTTP writes use valid UUIDs and preserve retry identity without randomUUID', t => {
  t.mock.method(crypto, 'randomUUID', () => { throw new Error('Unavailable on LAN HTTP') })
  const action = new WriteAction()
  const first = action.keyFor({ note: 'one' })
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(action.keyFor({ note: 'one' }), first)
  const changed = action.keyFor({ note: 'two' })
  assert.notEqual(changed, first)
  action.reset()
  assert.notEqual(action.keyFor({ note: 'two' }), changed)
})

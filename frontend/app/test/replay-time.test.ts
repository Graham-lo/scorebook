import test from 'node:test'
import assert from 'node:assert/strict'
import type { Bar } from '../src/api/types'
import { closedIndex, closedWindow } from '../src/data/replay-time'
const bars = [0,1,4,5].map(hour => ({start: `2026-09-09T${String(hour).padStart(2,'0')}:00:00Z`, end:`2026-09-09T${String(hour+1).padStart(2,'0')}:00:00Z`,open:'1',high:'2',low:'1',close:'2'} as Bar))
test('判断所在的未收盘根不泄露最终OHLC，缺口不跳到未来',()=>{
 assert.equal(closedIndex(bars,'2026-09-09T01:36:00Z'),0)
 assert.equal(closedIndex(bars,'2026-09-09T03:00:00Z'),1)
 assert.equal(closedIndex(bars,'2026-09-08T23:00:00Z'),-1)
 assert.deepEqual(closedWindow(bars,'2026-09-09T05:00:00Z','2026-09-09T01:00:00Z'),[bars[1],bars[2]])
})

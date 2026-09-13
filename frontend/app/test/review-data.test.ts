import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'
import type { CallDetail, Outcome, QueueItem } from '../src/api/types'
import { cachedDetail, detail, invalidate } from '../src/data/store'
import { forgetScorecard, scorecard } from '../src/data/scorecard'
import { classifyReviewTask } from '../src/data/review-task'
import { reviewQueue } from '../src/features/review/queue'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://localhost' } })
const json = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } })
const full = (id: string, revision = 1) => ({
  id, revision, voided: false, body: { criteria: [], tags: ['original-tag'] },
  outcomes: [], current_outcomes: [], tags: [{ id: 'later-tag', name: '后来加的标签' }],
} as unknown as CallDetail)
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => { invalidate(); forgetScorecard() })

test('详情并发请求共用一次读取，失效前的迟到响应不能覆盖或返回旧版本', async (t) => {
  const old = deferred<Response>()
  const fresh = deferred<Response>()
  let reads = 0
  t.mock.method(globalThis, 'fetch', () => (++reads === 1 ? old.promise : fresh.promise))
  const a = detail('one')
  const b = detail('one')
  assert.equal(reads, 1)
  invalidate('one')
  const c = detail('one')
  assert.equal(reads, 2)
  fresh.resolve(json(full('one', 2)))
  assert.equal((await c).revision, 2)
  old.resolve(json(full('one', 1)))
  assert.deepEqual((await Promise.all([a, b])).map(v => v.revision), [2, 2])
  assert.equal(cachedDetail('one')?.revision, 2)
  assert.equal(reads, 2)
})

test('refresh 更新缓存，旧请求失败不能删掉较新的详情请求', async (t) => {
  const old = deferred<Response>()
  const fresh = deferred<Response>()
  let reads = 0
  t.mock.method(globalThis, 'fetch', () => (++reads === 1 ? old.promise : fresh.promise))
  const a = detail('one')
  const b = detail('one', { refresh: true })
  old.reject(new Error('old request failed'))
  const c = detail('one')
  fresh.resolve(json(full('one', 2)))
  assert.deepEqual((await Promise.all([a, b, c])).map(v => v.revision), [2, 2, 2])
  assert.equal(reads, 2)
})

test('战绩读完整个 601 条库，标签取详情当前关联而不是原始 body', async (t) => {
  let pages = 0
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/v1/calls') {
      pages += 1
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const end = Math.min(start + 100, 601)
      return json({ items: Array.from({ length: end - start }, (_, i) => full(String(start + i))), next_cursor: end < 601 ? String(end) : null })
    }
    return json(full(url.pathname.split('/').at(-1)!))
  })
  const result = await scorecard()
  assert.equal(result.length, 601)
  assert.equal(pages, 7)
  assert.deepEqual(result[600]?.tags.map(v => v.id), ['later-tag'])
})

test('详情读取失败使战绩失败，不能伪造成未判记录，重试可恢复', async (t) => {
  let fail = true
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    if (new URL(input, 'http://localhost').pathname === '/api/v1/calls') return json({ items: [full('one')], next_cursor: null })
    if (fail) throw new Error('offline')
    return json(full('one'))
  })
  await assert.rejects(scorecard())
  fail = false
  assert.equal((await scorecard()).length, 1)
})

test('取消一个战绩调用者不会取消共享请求或污染下一页调用者', async (t) => {
  const pending = deferred<Response>()
  let reads = 0
  t.mock.method(globalThis, 'fetch', (_input: string, opts: RequestInit) => {
    reads += 1
    assert.equal(opts.signal, undefined)
    return pending.promise
  })
  const controller = new AbortController()
  const first = scorecard({ signal: controller.signal })
  const rejected = assert.rejects(first, { name: 'AbortError' })
  const second = scorecard()
  controller.abort()
  await rejected
  pending.resolve(json({ items: [], next_cursor: null }))
  assert.deepEqual(await second, [])
  assert.deepEqual(await scorecard(), [])
  assert.equal(reads, 1)
})

test('旧战绩请求失败不会清掉失效后重新建立的缓存', async (t) => {
  const old = deferred<Response>()
  const fresh = deferred<Response>()
  let reads = 0
  t.mock.method(globalThis, 'fetch', () => (++reads === 1 ? old.promise : fresh.promise))
  const first = scorecard()
  const rejected = assert.rejects(first)
  forgetScorecard()
  const second = scorecard()
  fresh.resolve(json({ items: [], next_cursor: null }))
  await second
  old.reject(new Error('old request failed'))
  await rejected
  await scorecard()
  assert.equal(reads, 2)
})

test('重复的服务端游标明确报错，不把未读全的记录作为战绩', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ items: [], next_cursor: 'same' }))
  await assert.rejects(scorecard(), /没有读全/)
})

test('复盘两个桶都读到末尾，重叠记录保留草稿身份', async (t) => {
  const pages: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost')
    const bucket = url.searchParams.get('bucket')!
    const start = Number(url.searchParams.get('cursor') ?? 0)
    pages.push(`${bucket}:${start}`)
    const end = Math.min(start + 100, 150)
    return json({ items: Array.from({ length: end - start }, (_, i) => ({ id: String(start + i), bucket })), next_cursor: end < 150 ? String(end) : null })
  })
  const result = await reviewQueue(new AbortController().signal)
  assert.equal(result.length, 150)
  assert.ok(result.every(v => v.bucket === 'in_progress'))
  assert.equal(pages.length, 4)
})

test('稍后队列也完整分页且只请求 snoozed 桶', async (t) => {
  let reads = 0
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost')
    assert.equal(url.searchParams.get('bucket'), 'snoozed')
    return json({ items: [{ id: String(++reads), bucket: 'snoozed' }], next_cursor: reads < 3 ? String(reads) : null })
  })
  assert.equal((await reviewQueue(new AbortController().signal, true)).length, 3)
})

test('复盘分类：随手记直接写；草稿优先；只有未到期的真实 pending 才等市场', () => {
  const item = { bucket: 'needs_review', draft_saved_at: null } as QueueItem
  const record = full('one')
  assert.equal(classifyReviewTask(item, record).box, 'write')
  record.body.criteria = [{ template: 'T0' }] as CallDetail['body']['criteria']
  assert.equal(classifyReviewTask(item, record).box, 'write')
  record.body.criteria = [{}] as CallDetail['body']['criteria']
  const outcome = (end_at: string | null) => ({ result: { state: 'pending', end_at } } as Outcome)
  record.current_outcomes = [outcome('2026-09-12T04:00:00Z')]
  const now = Date.parse('2026-09-12T03:00:00Z')
  assert.equal(classifyReviewTask(item, record, now).box, 'waiting')
  assert.equal(classifyReviewTask(item, record, now).note, '还差 1 小时')
  assert.equal(classifyReviewTask({ ...item, bucket: 'in_progress' }, record, now).box, 'write')
  assert.equal(classifyReviewTask(item, record, now + 3_600_000).box, 'verdict')
})

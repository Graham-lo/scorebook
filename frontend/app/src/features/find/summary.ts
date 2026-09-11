// The strip above the ledger. Both numbers are counted from real reads, not
// estimated: this week's records are paged until the walk passes seven days
// back, and the review count is the backend's own queue.

import * as calls from '../../api/calls'
import * as reviews from '../../api/reviews'
import type { ReviewBucket } from '../../api/types'
import { h } from '../../ui/dom'
import { countUp } from '../../ui/motion'

const WEEK_MS = 7 * 24 * 3_600_000

/**
 * 这四格要打四五个请求才数得出来。在账本和一条记录之间来回走是常事，每来一次
 * 就全部重数一遍，在手机上是白白唤醒一次网络。所以数完先记一分钟；记下新判断
 * 或者写完复盘会把它作废（见 forgetSummary），下一次一定是新数的。
 */
const FRESH_MS = 60_000
const memo = new Map<string, { at: number; value: Promise<unknown> }>()

/** 写过东西之后叫一声，四格下次重新数。 */
export function forgetSummary(): void {
  memo.clear()
}

function recent<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.value as Promise<T>
  const value = read()
  value.catch(() => { if (memo.get(key)?.value === value) memo.delete(key) })
  memo.set(key, { at: Date.now(), value })
  return value
}

export function weekstrip(alive: () => boolean): HTMLElement {
  const week = tile('本周记下的判断', '#/find')
  const due = tile('还没有复盘的判断', '#/review')
  const half = tile('写到一半的复盘', '#/review')
  const done = tile('已经复盘过的判断', '#/review')
  const strip = h('div.weekstrip', {}, week.node, due.node, half.node, done.node)

  void recent('week', countThisWeek)
    .then((n) => {
      if (alive()) week.set(n.count, n.atLeast)
    })
    .catch(() => week.fail())

  // 后三格都是后端队列自己分的篮子，前端不另算分母，也不把当前这一页的条数
  // 说成全库的总数——读不满一页就是准数，还有下一页就写「条以上」。
  count('needs_review', due, alive, true)
  count('in_progress', half, alive, false)
  count('completed', done, alive, false)

  return strip
}

function count(
  bucket: ReviewBucket,
  target: ReturnType<typeof tile>,
  alive: () => boolean,
  hot: boolean,
): void {
  void recent(`queue:${bucket}`, () => reviews.queue({ bucket, limit: 20 }))
    .then((page) => {
      if (!alive()) return
      target.set(page.items.length, Boolean(page.next_cursor))
      if (hot && page.items.length) target.node.classList.add('hot')
    })
    .catch(() => target.fail())
}

function tile(label: string, href: string) {
  const value = h('span.v', { text: '—' })
  const node = h('a', { href }, value, h('span.k', { text: label }))
  return {
    node,
    set(n: number, atLeast: boolean) {
      value.replaceChildren()
      const number = h('span', { text: '0' })
      value.append(number, h('small', { text: atLeast ? '条以上' : '条' }))
      countUp(number, n)
    },
    fail() {
      value.replaceChildren(h('small', { text: '读取失败' }))
    },
  }
}

/**
 * Walks the cursor until the first record older than seven days, so the number
 * is exact rather than "the first page of the library".
 */
async function countThisWeek(): Promise<{ count: number; atLeast: boolean }> {
  const since = Date.now() - WEEK_MS
  let cursor: string | undefined
  let count = 0
  for (let page = 0; page < 6; page += 1) {
    const result = await calls.list({ cursor, limit: 100 })
    for (const item of result.items) {
      if (new Date(item.submitted_at).getTime() < since) return { count, atLeast: false }
      count += 1
    }
    if (!result.next_cursor) return { count, atLeast: false }
    cursor = result.next_cursor
  }
  return { count, atLeast: true }
}

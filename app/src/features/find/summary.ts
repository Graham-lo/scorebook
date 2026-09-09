// The strip above the ledger. Both numbers are counted from real reads, not
// estimated: this week's records are paged until the walk passes seven days
// back, and the review count is the backend's own queue.

import * as calls from '../../api/calls'
import * as reviews from '../../api/reviews'
import { h } from '../../ui/dom'
import { countUp } from '../../ui/motion'

const WEEK_MS = 7 * 24 * 3_600_000

export function weekstrip(alive: () => boolean): HTMLElement {
  const week = tile('本周记下的判断', '#/find')
  const due = tile('还没有复盘的判断', '#/review')
  const strip = h('div.weekstrip', {}, week.node, due.node)

  void countThisWeek()
    .then((n) => {
      if (alive()) week.set(n.count, n.atLeast)
    })
    .catch(() => week.fail())

  void reviews
    .queue({ bucket: 'needs_review', limit: 20 })
    .then((page) => {
      if (!alive()) return
      due.set(page.items.length, Boolean(page.next_cursor))
      if (page.items.length) due.node.classList.add('hot')
    })
    .catch(() => due.fail())

  return strip
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

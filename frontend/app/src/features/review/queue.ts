import * as reviews from '../../api/reviews'
import type { QueueItem } from '../../api/types'

/** 两个队列都读到游标末尾；草稿优先，并按记录去重。 */
export async function reviewQueue(signal: AbortSignal, snoozed = false): Promise<QueueItem[]> {
  async function bucket(name: 'needs_review' | 'in_progress' | 'snoozed'): Promise<QueueItem[]> {
    const items: QueueItem[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (;;) {
      signal.throwIfAborted()
      const page = await reviews.queue({ bucket: name, cursor, limit: 100 }, { signal })
      signal.throwIfAborted()
      items.push(...page.items)
      if (!page.next_cursor) return items
      if (seen.has(page.next_cursor)) throw new Error('复盘清单没有读全，请重试')
      seen.add(page.next_cursor)
      cursor = page.next_cursor
    }
  }
  if (snoozed) return bucket('snoozed')
  const [drafts, todo] = await Promise.all([bucket('in_progress'), bucket('needs_review')])
  const unique = new Map<string, QueueItem>()
  for (const item of [...drafts, ...todo]) if (!unique.has(item.id)) unique.set(item.id, item)
  return [...unique.values()]
}

import type { CallDetail, QueueItem } from '../api/types'

export type ReviewBox = 'waiting' | 'verdict' | 'write'

export interface ReviewTask {
  item: QueueItem
  record: CallDetail
  box: ReviewBox
  note: string | null
  draft: boolean
}

/** 首页和复盘清单共用：草稿优先；没写标准的记录直接写复盘。 */
export function classifyReviewTask(item: QueueItem, record: CallDetail, now = Date.now()): ReviewTask {
  const outcomes = record.current_outcomes ?? []
  const pending = outcomes.filter((o) => o.result.state === 'pending' &&
    (!o.result.end_at || Date.parse(o.result.end_at) > now))
  const judged = outcomes.some((o) => ['realized', 'unrealized', 'not_triggered'].includes(o.result.state))
  const draft = item.bucket === 'in_progress' || Boolean(item.draft_saved_at)
  let box: ReviewBox
  if (draft || judged || !record.body.criteria?.some((claim) => claim.template !== 'T0')) box = 'write'
  else if (pending.length) box = 'waiting'
  else box = 'verdict'
  const endAt = pending[0]?.result.end_at
  const note = box === 'waiting'
    ? endAt ? `还差 ${Math.max(1, Math.ceil((Date.parse(endAt) - now) / 3_600_000))} 小时` : '没写时限'
    : null
  return { item, record, box, note, draft }
}

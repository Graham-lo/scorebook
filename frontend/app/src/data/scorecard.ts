// 给直觉记分要用的那一份底稿：全部还在的记录，每条配上它现在的结果。
//
// 战绩和局面两屏都靠它。记录列表本身不带结果，所以每条记录还要读一次详情——
// 详情走的是 store 里那份缓存，所以第二次进来基本不再发请求。整份结果也在这里
// 记一次，写过东西之后叫一声 forget 就重新数。

import * as calls from '../api/calls'
import type { CallListItem, TagRecord } from '../api/types'
import { head } from './outcome'
import { Gate, detail } from './store'

/** 对 / 错 / 不算；还没判、没写标准、数据不足一律 null。 */
export type Verdict = 'right' | 'wrong' | 'void' | null

export interface Scored {
  item: CallListItem
  verdict: Verdict
  /** 当前标签以详情中的关联为准，不从不可变原文 body.tags 反推。 */
  tags: TagRecord[]
}

const gate = new Gate(4)
let cached: Promise<Scored[]> | null = null

export function scorecard(options: { signal?: AbortSignal } = {}): Promise<Scored[]> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason)
  if (!cached) {
    const request = build().catch((error: unknown) => {
      // 旧请求失败不能清掉 forget 之后开始的新一轮。
      if (cached === request) cached = null
      throw error
    })
    cached = request
  }
  // 底稿由多个页面共享；一个页面退出只取消自己的等待。
  const request = cached
  const signal = options.signal
  if (!signal) return request
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** 写过记录、判过对错之后叫一声，下次重新数。 */
export function forgetScorecard(): void {
  cached = null
}

async function build(): Promise<Scored[]> {
  const all = new Map<string, CallListItem>()
  const cursors = new Set<string>()
  let next: string | undefined
  for (;;) {
    const result = await calls.list({ cursor: next, limit: 100 })
    for (const item of result.items) all.set(item.id, item)
    if (!result.next_cursor) break
    if (cursors.has(result.next_cursor)) throw new Error('记录没有读全，请重试')
    cursors.add(result.next_cursor)
    next = result.next_cursor
  }
  const live = [...all.values()].filter((item) => !item.voided)
  return Promise.all(
    live.map((item) =>
      gate
        .run(() => detail(item.id))
        .then((full): Scored => ({ item, verdict: verdictOf(head(full)?.result.state), tags: full.tags })),
    ),
  )
}

function verdictOf(state: string | null | undefined): Verdict {
  if (state === 'realized') return 'right'
  if (state === 'unrealized') return 'wrong'
  if (state === 'not_triggered') return 'void'
  return null
}

/** 判过对错的那部分里，对的占多少。没有分母就是 null。 */
export function hitRate(group: Scored[]): number | null {
  const right = group.filter((s) => s.verdict === 'right').length
  const wrong = group.filter((s) => s.verdict === 'wrong').length
  return right + wrong ? Math.round((right * 100) / (right + wrong)) : null
}

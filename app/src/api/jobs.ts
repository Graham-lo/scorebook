// Background work: reading where it stands, waiting for it, and asking for
// another go after it stopped.
//
// A job does not simply succeed or fail. It can also stop and wait for a
// person: `needs_attention` after the backend gave up retrying,
// `blocked_capability` when something it needs is not running, `awaiting_input`
// when it was paused. Waiting has to end on all of those, otherwise the page
// sits on a spinner for a job nobody is working on any more.

import { getJson, postJson, type RequestOptions } from './http'
import type { JobRecord, JobRetried, JobStatus, Uuid } from './types'

export function get(id: Uuid, opts: RequestOptions = {}): Promise<JobRecord> {
  return getJson<JobRecord>(`/v1/jobs/${id}`, opts)
}

/** Still moving on its own: worth waiting for, nothing for a person to do. */
const RUNNING: JobStatus[] = ['queued', 'running', 'retry_wait']

export function isRunning(job: JobRecord): boolean {
  return RUNNING.includes(job.status)
}

/** Stopped, and only a person can start it again. */
export function needsPerson(job: JobRecord): boolean {
  return (
    job.status === 'failed' ||
    job.status === 'needs_attention' ||
    job.status === 'blocked_capability'
  )
}

/** Only these two states let the backend accept a retry. */
export function canRetry(job: { status: JobStatus }): boolean {
  return job.status === 'failed' || job.status === 'needs_attention'
}

/**
 * Asks for another go. `expected_generation` is the version of the job the
 * trader was looking at, so two tabs cannot both restart it.
 */
export function retry(
  id: Uuid,
  expectedGeneration: number,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<JobRetried> {
  return postJson(`/v1/jobs/${id}/retry`, { expected_generation: expectedGeneration }, {
    ...opts,
    idempotencyKey,
  })
}

/** Polls a background job until it settles. Progress is reported in business terms. */
export async function waitFor(
  id: Uuid,
  onTick: (job: JobRecord) => void,
  opts: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {},
): Promise<JobRecord> {
  const interval = opts.intervalMs ?? 1500
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000)
  for (;;) {
    const job = await get(id, { signal: opts.signal })
    onTick(job)
    if (!isRunning(job)) return job
    if (Date.now() > deadline) return job
    await new Promise((resolve) => setTimeout(resolve, interval))
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
  }
}

/** The one line a trader reads while it is working. */
export function jobLine(status: JobStatus): { text: string; progress: number } {
  switch (status) {
    case 'queued':
      return { text: '排上队了，马上开始', progress: 0.1 }
    case 'running':
      return { text: '正在做，可以先去做别的', progress: 0.6 }
    case 'retry_wait':
      return { text: '中间断了一次，正在自己重试', progress: 0.5 }
    case 'succeeded':
      return { text: '做完了', progress: 1 }
    case 'failed':
      return { text: '没有做完', progress: 1 }
    case 'needs_attention':
      return { text: '停下来了，要你决定接下来怎么办', progress: 1 }
    case 'blocked_capability':
      return { text: '它要用的服务现在没开着', progress: 1 }
    case 'awaiting_input':
      return { text: '已暂停', progress: 1 }
    case 'cancelled':
      return { text: '已取消', progress: 1 }
    default:
      return { text: '正在做', progress: 0.5 }
  }
}

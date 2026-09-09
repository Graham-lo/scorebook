// Preparing a long stretch of history.
//
// One `/v1/history/indexes` request is capped: 50 000 source bars and 1000
// windows. A plan is the way past that — the backend walks the range one chunk
// at a time, keeps its place, and can be paused, resumed or cancelled without
// losing the chunks already done. Nothing about the raw bars is kept: only the
// features that make a window searchable.

import { getJson, postJson, type RequestOptions } from './http'
import type { HistoryPlan, HistoryPlanStarted, Instant, Market, Uuid } from './types'

export interface PlanRequest {
  symbols: string[]
  market: Market
  intervals: string[]
  start_at: Instant
  end_at: Instant
  window_bars: number
  stride_bars: number
  models: string[]
}

export function create(
  input: PlanRequest,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<HistoryPlanStarted> {
  return postJson('/v1/history/plans', input, { ...opts, idempotencyKey })
}

/** The receipt from a pause/resume/cancel; the plan itself is re-read after. */
export interface PlanControlled {
  plan_id: Uuid
  status: HistoryPlan['status']
  revision: number
}

export function get(id: Uuid, opts: RequestOptions = {}): Promise<HistoryPlan> {
  return getJson(`/v1/history/plans/${id}`, opts)
}

/**
 * Pause, resume or cancel. `expected_revision` is the version the trader had
 * on screen; the backend refuses the change if the plan moved on meanwhile.
 * Cancelling cannot be undone — a new plan has to be started instead.
 */
export function control(
  id: Uuid,
  input: { expected_revision: number; action: 'pause' | 'resume' | 'cancel' },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<PlanControlled> {
  return postJson(`/v1/history/plans/${id}/control`, input, { ...opts, idempotencyKey })
}

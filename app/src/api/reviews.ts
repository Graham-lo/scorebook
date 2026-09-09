// The durable review workflow: the queue, the resumable draft, publishing it
// into an immutable review, discarding it, and the "remind me later" flag.
//
// Three separate version numbers travel through here and they are not
// interchangeable:
//   · `call_revision`       — the record itself, bumped by publishing a review
//   · `draft_revision`      — the draft clock, which keeps counting up across
//                             publish and discard so a late save from an old
//                             tab can never resurrect a draft
//   · `preference_revision` — the reminder, versioned on its own
// Every write states the version it expects, so the server refuses a stale
// write instead of silently overwriting someone else's newer one.

import { getJson, postJson, type RequestOptions } from './http'
import type {
  DraftDiscarded,
  DraftSaved,
  HistoryKind,
  HistoryPage,
  Instant,
  ReminderSaved,
  ReviewAction,
  ReviewBucket,
  ReviewDraftState,
  ReviewPublished,
  ReviewQueue,
  ReviewRecord,
  Uuid,
} from './types'

export function queue(
  input: { bucket?: ReviewBucket | 'all'; cursor?: string | null; limit?: number } = {},
  opts: RequestOptions = {},
): Promise<ReviewQueue> {
  return getJson('/v1/review-queue', {
    ...opts,
    query: {
      bucket: input.bucket ?? 'needs_review',
      cursor: input.cursor ?? undefined,
      limit: input.limit ?? 20,
    },
  })
}

export function draft(id: Uuid, opts: RequestOptions = {}): Promise<ReviewDraftState> {
  return getJson(`/v1/calls/${id}/review-draft`, opts)
}

/**
 * Saves the editor's current text. This never touches the original judgement
 * and never produces a review: it is only the resumable copy of what is being
 * typed. `vs_last` may still be null while the trader is writing.
 */
export function saveDraft(
  id: Uuid,
  input: {
    expected_draft_revision: number
    note: string
    better_play: string | null
    vs_last: ReviewAction | null
  },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<DraftSaved> {
  return postJson(`/v1/calls/${id}/review-draft`, input, { ...opts, idempotencyKey })
}

/**
 * Turns the draft into a review that can never be edited again.
 *
 * `expected_outcome_ids` must be the evaluations the trader actually had on
 * screen. If the settlement job published a new one meanwhile the backend
 * answers `review_outcomes_changed` and the text stays untouched, so the
 * trader can look at the new result before confirming again.
 */
export function publishDraft(
  id: Uuid,
  input: {
    expected_draft_revision: number
    expected_call_revision: number
    expected_outcome_ids: Uuid[]
  },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ReviewPublished> {
  return postJson(`/v1/calls/${id}/review-draft/publish`, input, { ...opts, idempotencyKey })
}

export function discardDraft(
  id: Uuid,
  input: { expected_draft_revision: number },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<DraftDiscarded> {
  return postJson(`/v1/calls/${id}/review-draft/discard`, input, { ...opts, idempotencyKey })
}

/**
 * Pushes a record out of the queue until `until` (UTC, within a year). `null`
 * clears it. Publishing a review clears it too and advances its version, so an
 * old tab cannot bring the reminder back.
 */
export function remind(
  id: Uuid,
  input: { expected_revision: number; until: Instant | null },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ReminderSaved> {
  return postJson(`/v1/calls/${id}/review-reminder`, input, { ...opts, idempotencyKey })
}

/**
 * Older history for one record. Pages come back newest→oldest, while the
 * arrays inlined in the detail response run oldest→newest; the caller decides
 * which way round to show them.
 */
export function history<T = ReviewRecord>(
  id: Uuid,
  input: { kind: HistoryKind; cursor?: string | null; limit?: number },
  opts: RequestOptions = {},
): Promise<HistoryPage<T>> {
  return getJson(`/v1/calls/${id}/history`, {
    ...opts,
    query: {
      kind: input.kind,
      cursor: input.cursor ?? undefined,
      limit: input.limit ?? 20,
    },
  })
}

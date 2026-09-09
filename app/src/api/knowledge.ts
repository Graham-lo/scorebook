import { getJson, postJson, type RequestOptions } from './http'
import type {
  Episode,
  EpisodeLinkRecord,
  Page,
  PlaybookRecord,
  ReviewAction,
  TagRecord,
  Uuid,
} from './types'

/**
 * Publishes a review in one shot, without a draft behind it. The normal route
 * is the draft editor in `./reviews`; this one exists for a review written
 * somewhere that never held a draft.
 *
 * `expected_outcome_ids` is the list of results the trader actually had on
 * screen, so a review can never be silently attached to a result nobody read.
 */
export function review(
  input: {
    call_id: Uuid
    note: string
    better_play?: string | null
    vs_last: ReviewAction
    expected_revision: number
    expected_outcome_ids: Uuid[]
  },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ id: Uuid; revision: number }> {
  return postJson('/v1/reviews', input, { ...opts, idempotencyKey })
}

export function tags(cursor: string | null, opts: RequestOptions = {}): Promise<Page<TagRecord>> {
  return getJson('/v1/tags', { ...opts, query: { cursor: cursor ?? undefined } })
}

export function createTag(
  input: { name: string; definition: string; aliases: string[] },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ id: Uuid; version: number }> {
  return postJson('/v1/tags', input, { ...opts, idempotencyKey })
}

export function linkTag(
  input: { call_id: Uuid; tag_id: Uuid; expected_revision: number },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ revision: number }> {
  return postJson('/v1/tags/links', input, { ...opts, idempotencyKey })
}

export function playbooks(
  cursor: string | null,
  opts: RequestOptions = {},
): Promise<Page<PlaybookRecord>> {
  return getJson('/v1/playbooks', { ...opts, query: { cursor: cursor ?? undefined } })
}

/**
 * Every playbook the backend stores is created as a candidate. There is no
 * adoption or withdrawal endpoint, so the UI must not offer one.
 */
export function createPlaybook(
  input: {
    parent_id?: Uuid | null
    name: string
    applies_to: string
    excludes: string
    old_play: string
    change: string
    evidence_call_ids: Uuid[]
    expected_improvement: string
    cost: string
  },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ id: Uuid; status: 'candidate' }> {
  return postJson('/v1/playbooks', input, { ...opts, idempotencyKey })
}

export function episodes(
  cursor: string | null,
  opts: RequestOptions = {},
): Promise<Page<Episode>> {
  return getJson('/v1/episodes', { ...opts, query: { cursor: cursor ?? undefined } })
}

export function episode(
  id: Uuid,
  opts: RequestOptions = {},
): Promise<{ episode: Episode; links: EpisodeLinkRecord[] }> {
  return getJson(`/v1/episodes/${id}`, opts)
}

export function linkEpisode(
  input: {
    call_id: Uuid
    episode_id: Uuid
    status: 'confirmed' | 'explicit' | 'rejected'
    expected_revision: number
  },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ revision: number }> {
  return postJson('/v1/episode-links', input, { ...opts, idempotencyKey })
}

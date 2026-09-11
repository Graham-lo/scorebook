import { getJson, postJson, type RequestOptions } from './http'
import type {
  CallBody,
  CallDetail,
  CallList,
  CallPreview,
  CreatedCall,
  Market,
  Uuid,
} from './types'

/** Only the filters GET /v1/calls actually implements. */
export interface CallQuery {
  q?: string
  instrument?: string
  market?: Market
  timeframe?: string
  tag?: string
  before?: string
  cursor?: string
  limit?: number
}

export function list(query: CallQuery, opts: RequestOptions = {}): Promise<CallList> {
  return getJson<CallList>('/v1/calls', { ...opts, query: { ...query } })
}

export function get(id: Uuid, opts: RequestOptions = {}): Promise<CallDetail> {
  return getJson<CallDetail>(`/v1/calls/${id}`, opts)
}

export type NewCall = Partial<CallBody> & Pick<CallBody, 'original_text'>

export function create(
  body: NewCall,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<CreatedCall> {
  return postJson<CreatedCall>('/v1/calls', body, { ...opts, idempotencyKey })
}

/**
 * Parses the explicit slash protocol only. Plain Chinese is never read for
 * sentiment, so a note without the protocol stays unknown / T0.
 */
export function preview(text: string, opts: RequestOptions = {}): Promise<CallPreview> {
  return postJson<CallPreview>('/v1/calls/preview', { text }, opts)
}

/** A changed view is a new record that points back at the original. */
export function revise(
  id: Uuid,
  body: NewCall,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<CreatedCall> {
  return postJson<CreatedCall>(`/v1/calls/${id}/revisions`, body, { ...opts, idempotencyKey })
}

/**
 * Hangs a later picture on an existing record. The backend refuses anything
 * uploaded as a scene shot, so the file must go up as `supplement` or
 * `reference`: the original evidence is never rewritten.
 */
export function supplement(
  id: Uuid,
  input: { attachment_id: Uuid; expected_revision: number },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{
  revision: number
  identity: 'later_supplement'
  original_evidence_unchanged: boolean
}> {
  return postJson(`/v1/calls/${id}/attachments`, input, { ...opts, idempotencyKey })
}

/**
 * Records a factual correction against a call. Only metadata, a parsing slip
 * or an annotation can be corrected; a changed view has to be a new record,
 * and nothing here re-scores the original.
 */
export function correct(
  id: Uuid,
  input: {
    expected_revision: number
    category: 'metadata_evidence' | 'parser_error' | 'annotation'
    explanation: string
    evidence_attachment?: Uuid | null
  },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ revision: number; status: string; automatic_rescore: boolean }> {
  return postJson(`/v1/calls/${id}/corrections`, input, { ...opts, idempotencyKey })
}

export function voidCall(
  id: Uuid,
  input: { reason: string; expected_revision: number },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ revision: number; voided: boolean }> {
  return postJson(`/v1/calls/${id}/void`, input, { ...opts, idempotencyKey })
}

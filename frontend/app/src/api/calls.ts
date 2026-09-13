import { getJson, postJson, putJson, type RequestOptions } from './http'
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

/** PUT /v1/calls/{id}/scene 的回执。 */
export interface SceneSwap {
  call_id: Uuid
  /** 换完之后生效的那一张。 */
  attachment_id: Uuid
  revision: number
  /** 这一次被换下来的那几张。第一次换图通常只有一张。 */
  superseded: Uuid[]
  /** 换上来的这一张是记录提交之后才传的。 */
  scene_replaced_after_submission: boolean
  /** 后端恒为 true：证据本身一个字节都没动。 */
  original_evidence_unchanged: boolean
}

/**
 * 换这条记录的现场图。
 *
 * 换得动的是判断，换不动的是证据：截图的字节、sha256、size、uploaded_at 永远
 * 不改，附件一行都不删。这里改的只是「这条记录此刻拿哪一张当现场图」——贴错了
 * 图是可以改正的。换下来的那一张留在 `superseded_scenes` 里，把它的 id 再送一
 * 次就换回来了，已经被接替过的那一张同样认。
 *
 * `attachment_id` 必须是 kind='scene' 的附件，否则后端 400
 * `scene_attachment_required`。还没挂到这条记录上的会顺手挂上。
 *
 * 有一条后果要在界面上说人话：记录提交之后才上传的替换图，重温、自动钉图、界面
 * 显示都会用它，但 similarity 和 chart_search 的证据池闸门一个字都没放松——记录
 * 成立那一刻还不存在的图不进证据池。所以换过这种图的记录，在别人的「按图找」里
 * 就不出现了。记录、旧图、blob 一个没少，只是不拿一张自己都不认的图去作证。
 * 回执里的 `scene_replaced_after_submission` 就是这件事，为 true 时要告诉人。
 */
export function setScene(
  id: Uuid,
  input: { attachment_id: Uuid; expected_revision: number },
  idempotencyKey?: string,
  opts: RequestOptions = {},
): Promise<SceneSwap> {
  return putJson(`/v1/calls/${id}/scene`, input, { ...opts, idempotencyKey })
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

/**
 * 人自己判的对错。
 *
 * 「怎么算对」写全了的记录由后端按标准算；没写标准、或者标准算不下去的那些，
 * 对错只有人自己知道。这条路由是 §2.3「结果」那三颗按钮的去处：后端还没上这一
 * 版时会 404，调用方照实说一句，不静默当成判好了。
 */
export function judge(
  id: Uuid,
  input: { state: 'realized' | 'unrealized' | 'not_triggered'; expected_revision: number },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ revision: number }> {
  return postJson(`/v1/calls/${id}/verdict`, input, { ...opts, idempotencyKey })
}

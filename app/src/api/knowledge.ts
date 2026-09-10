import { getJson, postJson, type RequestOptions } from './http'
import type {
  Episode,
  EpisodeLinkRecord,
  Instant,
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

// ——— v4：在所有记下来的东西里找 ———
//
// 三件事要先说清楚，界面上不能含糊：
//
//   一、返回的是「检索顺序」，后端自己写明 `retrieval_order_not_probability`。
//       它不是相关度百分比，更不是「有多准」，所以不显示分数、不排名次。
//   二、片段不是全文。命中的是原文里的一段，起止字节都在里面；要看全文得用
//       `/v1/knowledge/source/slice`，并且带着同一个 `source_version` 往下翻。
//   三、改过还没重新收进来的来源，这一次搜不到。后端把它们算在 `coverage`
//       的 `pending_sources` 里，界面要照实说，不能让人以为「没有这回事」。
//
// 来源本身是用户自己的记录：当时说的话、后来的复盘、系统给的结论、标签、做法、
// 一段行情、实盘小结、统计与裁决。没有外部资料，也没有凭证和作业日志。

export const SOURCE_KINDS = [
  'call',
  'review',
  'outcome',
  'tag',
  'tag_lineage',
  'playbook',
  'playbook_event',
  'episode',
  'episode_link',
  'episode_review',
  'execution_link',
  'execution_summary',
  'import_receipt',
  'position_seed',
  'reconciliation',
  'submission_feedback',
  'attachment',
  'statistics',
  'verdict',
  'baseline',
] as const

export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface KnowledgeQuery {
  query: string
  /** 只在这一类记录里找。不写就是全部。 */
  source_kind?: SourceKind | string | null
  /** 只看这个时刻之前发生的。 */
  before?: Instant | null
  /** 后端夹在 1 到 30 之间，不写按 10 条。 */
  limit?: number | null
}

/** 索引进度。`pending_sources` 是改过、还没重新收进来的条数——它们这次搜不到。 */
export interface KnowledgeCoverage {
  pending_sources: number
  indexed_sources: number
  oldest_pending_at: Instant | null
  watermark: {
    model_id?: string
    indexed_documents?: number
    last_success_at?: Instant | null
    last_indexed_revision?: number | null
    updated_at?: Instant
  } | null
}

/**
 * 一条命中。`excerpt` 是原文里从 `start_byte` 到 `end_byte` 的一段，按 UTF-8
 * 字节数；`source_version` 是当时那一版的指纹，取全文要拿它去对。
 */
export interface KnowledgeHit {
  chunk_id: Uuid
  document_id: Uuid
  source_kind: string
  source_id: Uuid
  source_version: string
  source_uri: string
  occurred_at: Instant
  excerpt: string
  start_byte: number
  end_byte: number
  /** 融合排序用的中间值。只决定先后，不是相关度，不显示给人看。 */
  rrf_score: number
}

export interface KnowledgeResult {
  items: KnowledgeHit[]
  /** `lexical-dense-rrf-v1`：字面命中和语义命中各排一遍，再合成一个顺序。 */
  protocol: string
  model_id: string
  coverage: KnowledgeCoverage
  /** `retrieval_order_not_probability` —— 后端自己写的，别改写成相关度。 */
  score_interpretation: string
}

export function search(
  input: KnowledgeQuery,
  opts: RequestOptions = {},
): Promise<KnowledgeResult> {
  return postJson<KnowledgeResult>('/v1/knowledge/search', input, opts)
}

/** 索引到哪儿了。搜索结果里也带一份，这个是单独问的。 */
export function indexStatus(opts: RequestOptions = {}): Promise<KnowledgeCoverage> {
  return getJson<KnowledgeCoverage>('/v1/knowledge/index', opts)
}

/** 让后端把改过的来源重新收一遍。这是后台作业，回来的是任务编号。 */
export function reindex(
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ job_id: Uuid; status: string }> {
  return postJson('/v1/knowledge/index', {}, { ...opts, idempotencyKey })
}

export interface SourceRef {
  source_kind: string
  source_id: Uuid
  /** 带上就是「我要的是这一版」。后端读到别的版本会拒绝，不会悄悄给新的。 */
  source_version?: string | null
}

/**
 * 全文的一段。后端把来源整条记录序列化成 JSON 文本再切，`serialization` 说的就
 * 是这件事。`offset_byte` / `next_offset_byte` 都是 UTF-8 字节游标，只能拿后端
 * 给的那个数往下翻，不能自己按字符数算。
 */
export interface SourceSlice {
  source_kind: string
  source_id: Uuid
  source_version: string
  source_uri: string
  occurred_at: Instant
  text: string
  offset_byte: number
  next_offset_byte: number | null
  total_bytes: number
  serialization: string
}

export function sourceSlice(
  input: SourceRef & { offset_byte?: number | null; limit_bytes?: number | null },
  opts: RequestOptions = {},
): Promise<SourceSlice> {
  return postJson<SourceSlice>('/v1/knowledge/source/slice', input, opts)
}

/** 整条来源。长的用 `sourceSlice` 一段一段读，这个一次全给。 */
export function source(
  input: SourceRef,
  opts: RequestOptions = {},
): Promise<{
  source_kind: string
  source_id: Uuid
  source_version: string
  source_uri: string
  occurred_at: Instant
  body: Record<string, unknown>
}> {
  return postJson('/v1/knowledge/source', input, opts)
}

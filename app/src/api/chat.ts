// ——— v4：问过去的自己 ———
//
// 四件事写在这里，界面照着做，不能自己变通：
//
//   一、一次提问就是一次 run。断线之后要带着 `Last-Event-ID` 接着读同一个
//       run，绝对不能因为断线就再发起一次——那是让模型把整件事重跑一遍。
//   二、模型要写东西（发布复盘、下裁决、订阅历史），后端不会替你做。它退回
//       一个提案：具体是哪个操作、参数长什么样、参数的哈希是多少。要真的执
//       行，得你自己看过、自己确认，再带着原样的哈希和你自己写下的意图重新
//       问一次。模型的建议永远不会自己变成动作。
//   三、答案是一段一段的，每一段自带引用，还标明这一段是不是推断。前端不合
//       并、不改写、不给没有引用的段落补上出处。
//   四、后端没接模型的时候会明说 `chat_model_not_configured`。那不是网络问
//       题，界面照实讲，不给一个编出来的答案。

import { getJson, postJson, readEventStream, type RequestOptions } from './http'
import { md5Uuid } from './md5'
import { source } from './knowledge'
import type { Instant, Uuid } from './types'

/** 一次提问就是一次独立的问答，模型不会记得你上一句问过什么。 */
export interface ChatAsk {
  message: string
  /** 最多四张。带上的是你自己传的截图。 */
  attachment_ids?: Uuid[]
  /** 你已经确认过的写入动作。空着就表示这次谁也不许写。 */
  approved_actions?: ApprovedAction[]
}

/**
 * 一次明确的批准。`arguments_sha256` 必须是后端在提案里给的那一个，原样带回；
 * `user_intent` 是你自己写下的话，不能替你填。
 */
export interface ApprovedAction {
  tool: string
  arguments_sha256: string
  user_intent: string
}

export interface ChatCreated {
  chat_run_id: Uuid
  job_id: Uuid
  status: string
  model_id: string
  events_url: string
  /** 后端给这次问答划的上限：轮数、并行读取数、秒数。 */
  budgets: { turns: number; parallel_reads: number; seconds: number }
}

export interface Citation {
  source_kind: string
  source_id: Uuid
  source_version: string
}

/** 答案的一段。`inference` 为真表示这一段是推断出来的，不是记录里写着的。 */
export interface AnswerBlock {
  text: string
  citations: Citation[]
  inference: boolean
}

export type ChatStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'budget_exhausted'
  | 'source_removed'

export interface ChatRun {
  chat_run_id: Uuid
  status: ChatStatus | string
  turn_no: number
  model_id: string
  answer: AnswerBlock[] | null
  error_code: string | null
  /** 取消要带上它。带错了后端会拒绝，不会盲改。 */
  generation: number
  job_status: string
  created_at: Instant
}

export interface ChatEventRow {
  sequence: number
  type: string
  data: Record<string, unknown>
}

export interface ChatEventPage {
  items: ChatEventRow[]
  state: ChatRun
}

export function ask(
  input: ChatAsk,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ChatCreated> {
  return postJson<ChatCreated>(
    '/v1/chat/runs',
    {
      message: input.message,
      attachment_ids: input.attachment_ids ?? [],
      approved_actions: input.approved_actions ?? [],
    },
    { ...opts, idempotencyKey },
  )
}

export function run(id: Uuid, opts: RequestOptions = {}): Promise<ChatRun> {
  return getJson<ChatRun>(`/v1/chat/runs/${id}`, opts)
}

/** 取消要报出你看到的那一版 `generation`；对不上后端回 `chat_run_changed`。 */
export function cancel(
  id: Uuid,
  expectedGeneration: number,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ chat_run_id: Uuid; status: string; generation: number }> {
  return postJson(
    `/v1/chat/runs/${id}/cancel`,
    { expected_generation: expectedGeneration },
    { ...opts, idempotencyKey },
  )
}

/** 不用流的那条路：一次要一页，最多 101 条，顺便把当前状态带回来。 */
export function eventPage(
  id: Uuid,
  after: number,
  opts: RequestOptions = {},
): Promise<ChatEventPage> {
  return getJson<ChatEventPage>(`/v1/chat/runs/${id}/events/page`, {
    ...opts,
    query: { after },
  })
}

/**
 * 读这次问答的事件流。`after` 是上次读到的序号，断线重连时原样带回去——它走的
 * 是 `Last-Event-ID`，后端从它之后接着发，不会新起一次问答。
 */
export function stream(
  id: Uuid,
  after: number | null,
  onEvent: (event: ChatEventRow) => void,
  signal?: AbortSignal,
): Promise<void> {
  return readEventStream(
    `/v1/chat/runs/${id}/events`,
    (frame) => {
      let data: Record<string, unknown> = {}
      try {
        data = frame.data ? (JSON.parse(frame.data) as Record<string, unknown>) : {}
      } catch {
        // 读不出来的一帧不能当成没发生，按原样交上去。
        data = { raw: frame.data }
      }
      onEvent({ sequence: frame.id ?? -1, type: frame.event, data })
    },
    { lastEventId: after, signal },
  )
}

/** 会写东西的三个工具。它们永远要你先确认。 */
export const MUTATION_TOOLS = ['publish_review', 'decide_verdict', 'create_history_subscription']

export interface ToolProposal {
  tool: string
  arguments: Record<string, unknown>
  arguments_sha256: string
  confirmation_required: boolean
}

/**
 * 一次工具调用的证据编号。这是契约写死的算式：`md5(run_id + ':' + tool_call_id)`
 * 当成 UUID。事件流里只说「这一步做完了」，正文要按这个编号去读。
 */
export function evidenceId(runId: Uuid, toolCallId: string): Uuid {
  return md5Uuid(`${runId}:${toolCallId}`)
}

export interface ToolEvidence {
  identity: string
  tool: string
  arguments_sha256: string
  result: Record<string, unknown>
}

/** 读回这一步到底做了什么。它和别的来源一样，是可以被引用的证据。 */
export async function evidence(
  runId: Uuid,
  toolCallId: string,
  opts: RequestOptions = {},
): Promise<ToolEvidence> {
  const record = await source(
    { source_kind: 'tool_result', source_id: evidenceId(runId, toolCallId) },
    opts,
  )
  return record.body as unknown as ToolEvidence
}

/**
 * 这一步是不是一个「等你确认」的提案。是提案就把它原样返回——包括后端算好的
 * 参数哈希；确认的时候要把这个哈希带回去，不能前端自己再算一遍。
 */
export async function proposalOf(
  runId: Uuid,
  toolCallId: string,
  opts: RequestOptions = {},
): Promise<ToolProposal | null> {
  const body = await evidence(runId, toolCallId, opts)
  const result = body.result as { proposal?: ToolProposal; executed?: boolean } | undefined
  if (!result?.proposal || result.executed === true) return null
  return result.proposal
}

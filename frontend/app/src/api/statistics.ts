// 正式统计 —— 一次数清楚：在固定的一套规则、固定的一段历史里，各类判断分别是
// 什么下场。
//
// 三件事必须钉死，否则数出来的东西没有意义：
//
//   口径  `comparison_policy` / `grouping` / `calendar` / `outcome_policy` 在建
//         这次统计的时候就定下来，之后不会跟着心情变。同一条规则、同一个品种
//         算作一组，价位不同就是不同的组——后端不会替你把 3.5 万和 3.6 万归成
//         「差不多」。
//   快照  一次统计对应一份冻结的成员表（`set_snapshot_id`）。翻到第二页、去看
//         某一组的成员、去算参照基准，都要带着同一个 run，不能中途换一份。
//   来源  比例是从成员表里数出来的，不是模型估的。没算完之前 `/members` 和
//         `/groups` 会直接回 `statistics_snapshot_not_ready`，而不是先给个大概。
//
// `realization_rate` 是「这一组里，按同一条规则判定为已实现的占多少」。它是对
// 已经发生过的事的计数，不是胜率，也不是下一次会涨的概率，页面上不要改名。

import { getJson, postJson, type RequestOptions } from './http'
import type { Criteria, Evaluation, Instant, JobStatus, OutcomeState, Uuid } from './types'

/** 六种下场。和后端的 `result_states` 一字不差。 */
export const RESULT_STATES: readonly OutcomeState[] = [
  'realized',
  'unrealized',
  'not_triggered',
  'pending',
  'no_criteria',
  'insufficient_data',
]

/** 一条判断是不是照着做了。 */
export type Adoption = 'planned' | 'executed' | 'not_executed' | 'unknown'

/** 挑哪些记录进这次统计。全空就是「全部」。 */
export interface SampleFilter {
  start_at?: Instant
  end_at?: Instant
  instrument?: string
  market?: string
  timeframe?: string
  path?: string
  stance?: string
  source_entry?: string
  tag_id?: Uuid
  /** 只有同时给了 `tag_id` 才有意义。 */
  tag_phase?: 'hot' | 'cold'
  playbook_id?: Uuid
  adoption?: Adoption
  /**
   * 只留这几种下场。一旦填了，这次统计就是「挑过结果的」——后端会把 `selection`
   * 标成 `result_conditioned`，也不会再为它安排人工裁决。
   */
  result_states?: OutcomeState[]
}

/**
 * 口径。后端只认这四个取值里的组合，别的直接拒绝：
 *
 *   `comparison_policy: exact_frozen_rule` 绝对价位各算各的，不做等价推断。
 *   `grouping: episode_rule`               同一段行情里的重复判断只取第一条；
 *   `grouping: call_rule`                  每条判断各算一次。
 *   `calendar: natural_hours`              按自然小时数，和记录里写的时限一致。
 *   `outcome_policy: current_formal_head`  只认当前正式结论，试算不算数。
 */
export interface StatisticsInput {
  name: string
  filters: SampleFilter
  comparison_policy: 'exact_frozen_rule'
  grouping: 'episode_rule' | 'call_rule'
  calendar: 'natural_hours'
  outcome_policy: 'current_formal_head'
}

export interface StatisticsStarted {
  statistics_run_id: Uuid
  set_snapshot_id: Uuid
  definition_id: Uuid
  status: string
}

export function createStatistics(
  input: StatisticsInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<StatisticsStarted> {
  return postJson('/v1/statistics/runs', input, { ...opts, idempotencyKey })
}

export interface RunCounts {
  call_count: number
  claim_count: number
  episode_count: number
  representative_count: number
  /** 进了成员表但不算数的：作废、历史补录、待确认等等。 */
  excluded_count: number
  /** 因为「只看某几种下场」被筛掉的。 */
  result_filter_excluded_count: number
  voided_count: number
  deleted_count: number
}

export interface RunStats {
  set_snapshot_id: Uuid
  counts: RunCounts
  states: Record<string, number>
  /** 还在处理中的那些停在哪一步，`absent` 是没有处理记录。 */
  processing_states: Record<string, number>
  /** 头 100 组直接给在这里；更多的要翻 `/groups`。 */
  groups: GroupMetric[]
  group_count: number
  groups_complete: boolean
  groups_url: string
  result_policy: string
  comparison_policy: string
  calendar: string
  /** `unconditioned` 没有按结果挑过；`result_conditioned` 挑过。 */
  selection: 'unconditioned' | 'result_conditioned'
  members_url: string
  /**
   * 后端一律给 null，理由是 `independence_not_established`：同一段行情里的多条
   * 判断彼此不独立，套区间公式会给出一个假的精度。页面上照实说，不要自己算。
   */
  wilson_interval: null
  wilson_reason: string
}

export interface GroupMetric {
  /** 规则 + 品种 + 市场 + 日历 + 取价口径的哈希。不是人读的名字。 */
  signature: string
  representative_count: number
  /** 已实现的条数。 */
  numerator: number
  /** 有结论（已实现或未实现）的条数。 */
  denominator: number
  /** 十进制字符串，`numerator / denominator`。分母为零时是 null。 */
  realization_rate: string | null
  mfe_median: string | null
  mae_median: string | null
  recent_explicit_count: number
  recent_rate: string | null
  /** 最近十条比整体低 20 个百分点以上。是「再看一眼」的提示，不是结论。 */
  recheck: boolean
  trigger_day_distribution: { day: Instant; count: number }[]
}

export interface StatisticsRun {
  id: Uuid
  set_snapshot_id: Uuid
  definition_id: Uuid
  /** `queued` → `frozen` → `ready`。 */
  status: string
  source_snapshot_at: Instant | null
  stats: RunStats | null
  created_at: Instant
  completed_at: Instant | null
  definition: StatisticsInput
  job: { status: JobStatus; error_code: string | null; generation: number }
}

export function statisticsRun(id: Uuid, opts: RequestOptions = {}): Promise<StatisticsRun> {
  return getJson<StatisticsRun>(`/v1/statistics/runs/${id}`, opts)
}

// ——— 这次统计到底数了哪些记录 ———

/** 不算数的原因。这些是后端定的，翻译放在页面那一侧。 */
export type ExclusionReason =
  | 'voided'
  | 'historical_unverified'
  | 'episode_unconfirmed'
  | 'formation_not_subsequent_validation'
  | 'no_criteria'
  | 'criteria_unconfirmed'

export interface MemberBody {
  /** 冻结在这次统计里的那一条规则，原样存着，之后改了记录也不会动它。 */
  criteria: Criteria
  instrument: string | null
  market: string | null
  timeframe: string | null
  outcome_id: Uuid | null
  /** 当前正式结论。还没算出来就是空。 */
  result: Evaluation | null
  processing_reason: string | null
  voided: boolean
  /** 补录的原始时间。有值就说明这条是事后补的，不进统计。 */
  historical: string | null
  classification: { path: string; stance: string; source_entry: string }
}

export interface Member {
  run_id: Uuid
  ordinal: number
  call_id: Uuid
  claim_no: number
  episode_id: Uuid | null
  submitted_at: Instant
  signature: string
  state: OutcomeState | string
  processing_state: string | null
  /** 口径上算不算数。false 时 `exclusion_reason` 说明为什么。 */
  eligible: boolean
  /** 同一段行情、同一条规则里被选中代表的那一条。 */
  representative: boolean
  /** 有没有通过「只看某几种下场」这一层筛选。 */
  selected: boolean
  exclusion_reason: ExclusionReason | string | null
  body: MemberBody
}

export interface MemberFilter {
  /** 上一页最后一条的 `ordinal`。 */
  cursor?: number
  group_signature?: string
  state?: string
  representative?: boolean
}

export interface MemberPage {
  set_snapshot_id: Uuid
  items: Member[]
  next_cursor: number | null
}

export function members(
  id: Uuid,
  filter: MemberFilter = {},
  opts: RequestOptions = {},
): Promise<MemberPage> {
  return getJson<MemberPage>(`/v1/statistics/runs/${id}/members`, {
    ...opts,
    query: { ...filter },
  })
}

export interface GroupPage {
  set_snapshot_id: Uuid
  items: GroupMetric[]
  next_cursor: string | null
}

export function groups(
  id: Uuid,
  cursor: string | null = null,
  opts: RequestOptions = {},
): Promise<GroupPage> {
  return getJson<GroupPage>(`/v1/statistics/runs/${id}/groups`, {
    ...opts,
    query: { cursor: cursor ?? undefined },
  })
}

// ——— 参照基准 B1 ———

/**
 * B1 回答的是一件很窄的事：同一条规则，如果把提交时刻往前挪，挪到过去 250 天里
 * 每一天的同一分钟，各自跑一遍，会是什么结果。
 *
 * 它是这条规则在这段历史上的参照，不是对未来的预测，也不是「大盘平均水平」。
 * 只对 T1 这类标准成立（`baseline_only_t1`），取的每一根 K 线都在提交时刻之前
 * （`future_data_allowed: false`）。
 */
export interface BaselineInput {
  statistics_run_id: Uuid
  source_plan: 'rest_closed_minute_endpoints_v1'
  calendar: 'natural_hours'
}

export interface BaselineStarted {
  baseline_run_id: Uuid
  status: string
  protocol: string
  source_plan: string
  lookback_days: number
  sample_clock: string
  price_policy: string
  weighting: string
}

export function createBaseline(
  input: BaselineInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<BaselineStarted> {
  return postJson('/v1/baseline-runs', input, { ...opts, idempotencyKey })
}

export interface BaselineGroup {
  signature: string
  /** 至少取到一份可用样本的判断条数。 */
  valid_calls: number
  /** 一份都没取到的判断条数——这一组的参照就是缺这么多。 */
  missing_calls: number
  valid_samples: number
  attempted_samples: number
  /** 每条判断先各自算一个比例，再等权平均。十进制字符串。 */
  equal_call_realization_rate: string | null
}

export interface BaselineResult {
  protocol: string
  groups: BaselineGroup[]
  other_templates: string
  future_data_allowed: boolean
  calendar: string
  source_plan: string
  rate_without_samples: null
}

export interface BaselineRun {
  id: Uuid
  statistics_run_id: Uuid
  body: BaselineInput
  status: string
  next_ordinal: number
  next_day: number
  result: BaselineResult | null
  created_at: Instant
  job_status: JobStatus
  error_code: string | null
}

export function baselineRun(id: Uuid, opts: RequestOptions = {}): Promise<BaselineRun> {
  return getJson<BaselineRun>(`/v1/baseline-runs/${id}`, opts)
}

export interface BaselineSample {
  ordinal: number
  sample: {
    run_id: Uuid
    call_id: Uuid
    claim_no: number
    at: Instant
    end_at: Instant
    /** 和正式结论同一套判定；取不到样本时是 `excluded` 或 `insufficient_data`。 */
    result: Partial<Evaluation> & { state: string; reason?: string }
    input_sha256: string
  }
}

export interface BaselineSamplePage {
  baseline_run_id: Uuid
  items: BaselineSample[]
  next_cursor: number | null
}

export function baselineSamples(
  id: Uuid,
  cursor: number | null = null,
  opts: RequestOptions = {},
): Promise<BaselineSamplePage> {
  return getJson<BaselineSamplePage>(`/v1/baseline-runs/${id}/samples`, {
    ...opts,
    query: { cursor: cursor ?? undefined },
  })
}

// ——— 人工裁决 ———

/**
 * 某一组攒够 20 条新的明确结论之后，后端会开一条待裁决——只是提醒该看一眼了，
 * 不带任何倾向，也不会自己决定。裁决必须是人按下去的：`authority` 回的是
 * `explicit_user_decision`。
 *
 * 只有没按结果挑过的统计（`selection: unconditioned`）才会排待裁决。挑过结果的
 * 那种，本来就不该拿来下结论。
 */
export interface VerdictRequest {
  id: Uuid
  definition_id: Uuid
  run_id: Uuid
  signature: string
  /** 攒到多少条就提醒：上一次裁决时的条数 + 20。 */
  threshold: number
  /** 提醒时这一组有多少条明确结论。 */
  explicit_count: number
  status: 'pending' | 'decided' | string
  revision: number
  created_at: Instant
}

export function verdictRequests(
  filter: { cursor?: Uuid; status?: string } = {},
  opts: RequestOptions = {},
): Promise<{ items: VerdictRequest[]; next_cursor: Uuid | null }> {
  return getJson('/v1/verdict-requests', { ...opts, query: { ...filter } })
}

/**
 * `evidence` 认它是有证据的一条，`observe` 继续观察，`drop` 不再当回事。
 *
 * `expected_revision` 是你屏幕上看到的那一版；别处已经裁过了后端会回
 * `verdict_request_changed`，这时候要把这条重新读回来再决定，不能盲重试盖过去。
 * 理由是必填的：一次裁决没有写下当时怎么想的，过几个月就没法复查了。
 */
export interface VerdictInput {
  request_id: Uuid
  expected_revision: number
  decision: 'evidence' | 'observe' | 'drop'
  evidence: string
}

export function decideVerdict(
  input: VerdictInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{
  verdict_event_id: Uuid
  request_id: Uuid
  decision: string
  revision: number
  authority: string
}> {
  return postJson('/v1/verdicts', input, { ...opts, idempotencyKey })
}

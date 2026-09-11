// Turns an evaluation into the words and the stamp class the sheet uses.
// The backend states and reasons are internal identifiers; nothing here
// invents a number the backend did not compute.

import type { Evaluation, Outcome, OutcomeState } from '../api/types'
import { DASH, dateTime } from './time'
import { percent } from './decimal'

interface StateLook {
  label: string
  /** Suffix of the .stamp class already defined in the stylesheet. */
  stamp: string
  tone: 'good' | 'bad' | 'wait' | 'none'
}

const STATES: Record<OutcomeState, StateLook> = {
  realized: { label: '兑现', stamp: 'st-realized', tone: 'good' },
  unrealized: { label: '未兑现', stamp: 'st-unrealized', tone: 'bad' },
  not_triggered: { label: '未触发', stamp: 'st-not_triggered', tone: 'none' },
  pending: { label: '观察中', stamp: 'st-pending', tone: 'wait' },
  no_criteria: { label: '没写标准', stamp: 'st-no_criteria', tone: 'none' },
  insufficient_data: { label: '数据不足', stamp: 'st-insufficient_data', tone: 'none' },
}

export function stateLook(state: OutcomeState): StateLook {
  return STATES[state] ?? { label: state, stamp: 'st-no_criteria', tone: 'none' }
}

// Reasons a trader may see. Anything unmapped falls back to a sentence that
// says what it means for them, never to the identifier itself.
const REASONS: Record<string, string> = {
  no_explicit_criteria: '记录时没写算对的标准，所以不判对错。',
  waiting_for_trigger: '还没到触发条件，等条件成立才开始计时。',
  observing: '还在观察期内，到期以后才算对错。',
  boundary_or_invalidation_touched: '价格碰到了你写下的失效价或边界，按当时的约定算没走成。',
  path_coverage_unproven: '这段行情的数据还没补齐，暂时不下结论。',
  window_completed: '观察期已经走完。',
  market_evidence_not_acquired: '行情数据还没取到，取到以后会自动算一次。',
  // 标准本身写得不完整，等于没写标准
  criteria_not_selected: '没有明确选一种标准，按没写标准保存。',
  invalid_horizon: '期限不合法，按没写标准保存。',
  direction_missing: '没有写明看涨还是看跌，按没写标准保存。',
  ambiguous_threshold: '阈值同时写了百分比和 ATR 倍数，只能留一个。',
  invalid_threshold: '阈值不合法。',
  invalid_atr_multiple: 'ATR 倍数不合法。',
  invalidation_missing: '这个模板需要一个失效价。',
  invalid_invalidation: '失效价不合法。',
  boundary_missing: '这个模板需要一条边界和它的方向。',
  trigger_missing: '这个模板需要一个触发条件。',
  invalid_trigger: '触发条件不合法。',
  unknown_rule_version: '标准版本和后端不一致。',
  // 数据不够，暂时算不出来
  base_missing: '缺少起始价，暂时算不出来。',
  invalid_base: '起始价不合法。',
  endpoint_unproven: '期末那一刻的成交还没证实，先不算。',
  end_price_missing: '缺少期末价格。',
  invalid_endpoint: '期末价格不合法。',
  atr_missing: '这段时间的波动幅度还算不出来。',
  atr_history_missing: '历史不足 15 根 K 线，算不出波动幅度。',
  invalid_atr: '波动幅度不合法。',
  trigger_sequence_unproven: '触发前的行情还没补齐，不能确认哪一次是第一次。',
  invalid_ohlc: '拿到的 K 线本身有问题。',
  overlapping_bars: '拿到的 K 线互相重叠。',
  invalid_evaluation_time: '算对错的时间点不合法。',
  invalid_trade_price: '成交价不合法。',
  decimal_too_long: '数字太长了。',
  decimal_exponent_out_of_range: '数字超出可计算范围。',
}

export function reasonText(reason: string | null | undefined): string {
  if (!reason) return ''
  return REASONS[reason] ?? '算对错时遇到一个暂时说不清的情况，稍后会重试。'
}

/** The one-line explanation under the stamp on a call card. */
export function whyLine(evaluation: Evaluation | null): string {
  if (!evaluation) return '还没有算过对错。'
  const { state, reason, signed_return, end_at } = evaluation
  const move = percent(signed_return)
  if (state === 'realized' && move) return `到期 ${move}，达到了你写下的阈值。`
  if (state === 'unrealized' && move) return `到期 ${move}，没有达到你写下的阈值。`
  if (state === 'pending' && end_at) return `${reasonText(reason)}预计 ${dateTime(end_at)} 出结果。`
  return reasonText(reason)
}

/** The four figures on a call card; missing values stay as an em dash. */
export function figures(evaluation: Evaluation | null): { key: string; value: string }[] {
  if (!evaluation) return []
  const rows = [
    { key: '到期涨跌', value: percent(evaluation.signed_return) ?? DASH },
    { key: '最有利', value: percent(evaluation.mfe) ?? DASH },
    { key: '最不利', value: percent(evaluation.mae) ?? DASH },
    {
      key: '首次达标',
      value: evaluation.first_threshold_interval
        ? dateTime(evaluation.first_threshold_interval[0])
        : DASH,
    },
  ]
  return rows.every((r) => r.value === DASH) ? [] : rows
}

/**
 * The evaluation a trader should be looking at now: the newest row for each
 * claim. An `original` row is never deleted, so it stays available beside it.
 */
export function current(outcomes: Outcome[], claimNo = 0): Outcome | null {
  const mine = outcomes.filter((o) => o.claim_no === claimNo)
  if (!mine.length) return null
  return mine.reduce((a, b) => (a.created_at >= b.created_at ? a : b))
}

/**
 * The current evaluation of a record, taken from the server's own head list.
 *
 * `outcomes` holds the history: earlier versions, data corrections and rule
 * replays all live in there, and the newest row in the array is not always the
 * one in force. The detail response says which row is current, so ask it, and
 * only fall back to picking by time for a response that does not carry the
 * head list.
 */
export function head(
  record: { current_outcomes?: Outcome[]; outcomes: Outcome[] },
  claimNo = 0,
): Outcome | null {
  const heads = record.current_outcomes
  if (heads && heads.length) return heads.find((o) => o.claim_no === claimNo) ?? null
  return current(record.outcomes, claimNo)
}

export function original(outcomes: Outcome[], claimNo = 0): Outcome | null {
  return outcomes.find((o) => o.claim_no === claimNo && o.kind === 'original') ?? null
}

/**
 * A list row has no outcome collection, only the criteria that were saved.
 * Until the settlement job runs there is genuinely nothing to show, so the row
 * says so rather than borrowing a state from somewhere else.
 */
export function pendingState(hasCriteria: boolean): OutcomeState {
  return hasCriteria ? 'pending' : 'no_criteria'
}

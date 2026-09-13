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

// 结果只有三个词：对 / 错 / 不算。剩下三种不是判决，是「还判不了」的原因，
// 各用一个不超过四个字的状态词说清楚。
const STATES: Record<OutcomeState, StateLook> = {
  realized: { label: '对', stamp: 'st-realized', tone: 'good' },
  unrealized: { label: '错', stamp: 'st-unrealized', tone: 'bad' },
  not_triggered: { label: '不算', stamp: 'st-not_triggered', tone: 'none' },
  pending: { label: '还没判', stamp: 'st-pending', tone: 'wait' },
  no_criteria: { label: '没写', stamp: 'st-no_criteria', tone: 'none' },
  insufficient_data: { label: '数据不足', stamp: 'st-insufficient_data', tone: 'none' },
}

/** 三个判决词本身，行内三颗按钮和统计表头都用它。 */
export const VERDICTS = { realized: '对', unrealized: '错', not_triggered: '不算' } as const

export function stateLook(state: OutcomeState): StateLook {
  return STATES[state] ?? { label: state, stamp: 'st-no_criteria', tone: 'none' }
}

/**
 * 判决旁边那一行事实：什么时候判的，到期走了多少。不解释口径。
 */
export function whyLine(evaluation: Evaluation | null): string {
  if (!evaluation) return ''
  const { state, signed_return, end_at } = evaluation
  const move = percent(signed_return)
  if ((state === 'realized' || state === 'unrealized') && move) return `到期 ${move}`
  if (state === 'pending' && end_at) return `${dateTime(end_at)} 到期`
  return ''
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

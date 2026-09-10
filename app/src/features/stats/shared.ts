// 统计这一页上，几件到处都要用的小事。

import { explain, known } from '../../api/errors'
import { round, shift } from '../../data/decimal'
import type { JobStatus, OutcomeState } from '../../api/types'
import { h } from '../../ui/dom'

/** 页面还在不在。翻页、轮询都要问一句，人走了就别再往上画。 */
export interface Live {
  alive(): boolean
  sleep(ms: number): Promise<void>
}

/** 后台任务停在这些状态上，就是在等人，不会自己往下走。 */
export const STALLED = new Set<JobStatus>([
  'needs_attention',
  'blocked_capability',
  'awaiting_input',
  'failed',
])

/** 认得的码翻成人话；认不得的把后端的原话摆出来，不用一句通用的话盖过去。 */
export function whyStopped(code: string | null, fallback: string): string {
  if (!code) return fallback
  return known(code) ? explain(code) : `后端停在这里，它给的说法是「${code}」。`
}

/**
 * 比例是十进制字符串，挪两位小数点就是百分数——不乘 100，不进浮点。没有分母的
 * 时候后端给的是 null，这里也就不编一个数出来。
 */
export function share(value: string | null | undefined, places = 1): string | null {
  if (value === null || value === undefined) return null
  const shifted = shift(value, 2)
  if (shifted === null) return null
  const rounded = round(shifted, places)
  return rounded === null ? null : `${rounded}%`
}

/** 哈希不是给人读的，但同一组前后要认得出是同一个，所以留前八位。 */
export function shortSignature(signature: string): string {
  return signature.slice(0, 8)
}

export const STATE_LABELS: Record<OutcomeState, string> = {
  realized: '兑现',
  unrealized: '未兑现',
  not_triggered: '未触发',
  pending: '观察中',
  no_criteria: '没写标准',
  insufficient_data: '数据不足',
}

/** 六态条上的颜色。前三种有语义色，后三种一律走中性色，不暗示好坏。 */
export const STATE_COLORS: Record<OutcomeState, string> = {
  realized: 'var(--realized)',
  unrealized: 'var(--unrealized)',
  not_triggered: 'var(--grey)',
  pending: 'var(--pending)',
  no_criteria: 'var(--ink4)',
  insufficient_data: 'var(--rule3)',
}

/** 一条记录为什么不算数。这些原因是后端定的，这里只负责说人话。 */
export const EXCLUSIONS: Record<string, string> = {
  voided: '这条已经作废。',
  historical_unverified: '这是事后补录的判断，当时没有留下时间戳，没法当证据。',
  episode_unconfirmed: '这条还没确认属于哪一段行情，按「同一段只算一次」的分法就先不算。',
  formation_not_subsequent_validation: '这条是当初总结出这个做法时用到的例子，不能再拿它来验证这个做法。',
  no_criteria: '这条记录时没写算对的标准。',
  criteria_unconfirmed: '这条的标准还等着你确认。',
}

export function exclusionText(reason: string | null): string {
  if (!reason) return ''
  return EXCLUSIONS[reason] ?? `后端把它排除在外，给的说法是「${reason}」。`
}

/** 一个小键值行，样式和别处的 .kv 一致。 */
export function kv(rows: (readonly [string, string])[]): HTMLElement {
  const box = h('div.kv')
  for (const [k, v] of rows) {
    box.appendChild(h('div.kvrow', {}, h('span.k', { text: k }), h('span.v', { text: v })))
  }
  return box
}

// The criteria a record is saved with are built from explicit controls, never
// guessed from the note the trader wrote.
//
// Every rule below mirrors domain::criteria::validate in the backend. That
// matters: POST /v1/calls accepts a criteria object that fails validation and
// silently records it as "no_criteria" with the reason attached, so a draft
// that cannot pass is refused here — in front of the trader, while the fields
// are still on screen — instead of looking saved and scoring nothing.

import type { Criteria, Template } from '../../api/types'
import { shift } from '../../data/decimal'

export const MAX_HORIZON = 87_600

export interface CriteriaDraft {
  template: Template
  horizonHours: number
  /** False while the pre-selected horizon is only the visible default. */
  horizonTouched: boolean
  direction: 'L' | 'S' | null
  thresholdKind: 'default' | 'percent' | 'atr'
  thresholdPercent: string
  atrMultiple: string
  invalidation: string
  boundary: string
  boundaryKind: 'lower_floor' | 'upper_ceiling'
  triggerPrice: string
  triggerComparator: 'gte' | 'lte'
  triggerKind: 'bar_close' | 'trade_touch'
  triggerWindowHours: number
}

export function emptyCriteriaDraft(): CriteriaDraft {
  return {
    template: 'T0',
    horizonHours: 72,
    horizonTouched: false,
    direction: null,
    thresholdKind: 'default',
    thresholdPercent: '',
    atrMultiple: '',
    invalidation: '',
    boundary: '',
    boundaryKind: 'lower_floor',
    triggerPrice: '',
    triggerComparator: 'gte',
    triggerKind: 'bar_close',
    triggerWindowHours: 24,
  }
}

export const TEMPLATE_HELP: Record<Template, string> = {
  T0: '只留下这句话和这张图，不判对错。',
  T1: '在期限内朝一个方向走满阈值就算兑现。',
  T2: '在 T1 之上加一条失效价：期间触及就算没走成。',
  T3: '先等一个价格条件成立，成立之后再开始计时。',
  T4: '一个边界，期限内没被打破就算守住。',
  T5: '只看波动幅度，不分方向。',
}

/** Templates that need a direction, and that read a threshold. */
const DIRECTIONAL: Template[] = ['T1', 'T2', 'T3']

function decimal(value: string): string | null {
  const text = value.trim().replace(/,/g, '')
  if (!/^\d*(?:\.\d*)?$/.test(text) || !/[1-9]/.test(text)) return null
  return text
}

/** A percentage as typed becomes the ratio the backend stores. */
export function ratioFromPercent(value: string): string | null {
  const text = decimal(value)
  return text ? shift(text, -2) : null
}

/**
 * Everything wrong with the draft, said the way a trader would say it. An
 * empty array means the backend's validate() will accept it.
 */
export function problems(d: CriteriaDraft): string[] {
  const out: string[] = []
  if (d.template === 'T0') return out
  if (!(d.horizonHours > 0 && d.horizonHours <= MAX_HORIZON)) {
    out.push('期限要在 1 小时到 10 年之间。')
  }
  if (DIRECTIONAL.includes(d.template) && d.direction === null) {
    out.push('这个标准要有方向：先选看涨还是看跌。')
  }
  if (d.thresholdKind === 'percent' && !decimal(d.thresholdPercent)) {
    out.push('阈值百分比要填一个大于 0 的数。')
  }
  if (d.thresholdKind === 'atr' && !decimal(d.atrMultiple)) {
    out.push('ATR 倍数要填一个大于 0 的数。')
  }
  if (d.template === 'T2' && !decimal(d.invalidation)) {
    out.push('这个标准必须写失效价。')
  }
  if (d.template !== 'T2' && d.invalidation.trim() && !decimal(d.invalidation)) {
    out.push('失效价填得不对，留空表示不设失效价。')
  }
  if (d.template === 'T4' && !decimal(d.boundary)) {
    out.push('守边界要写出那条边界的价格。')
  }
  if (d.template === 'T3') {
    if (!decimal(d.triggerPrice)) out.push('触发条件要写出价格。')
    if (!(d.triggerWindowHours > 0 && d.triggerWindowHours <= MAX_HORIZON)) {
      out.push('等待条件成立的窗口要在 1 小时到 10 年之间。')
    }
  }
  return out
}

/**
 * The object that goes on the wire. Returns null for T0: an empty criteria
 * list already means "not judged", and an explicit T0 row adds nothing.
 */
export function build(d: CriteriaDraft): Criteria | null {
  if (d.template === 'T0') return null
  const c: Criteria = {
    template: d.template,
    version: 'criteria-v1',
    selected_by: d.horizonTouched ? 'explicit' : 'default_visible',
    horizon_hours: d.horizonHours,
  }
  if (DIRECTIONAL.includes(d.template) && d.direction) c.direction = d.direction
  // threshold_ratio and atr_multiple are mutually exclusive; leaving both out
  // lets the backend apply the documented 1×ATR14 (T5: 1.5×ATR14) default.
  if (d.thresholdKind === 'percent') {
    const ratio = ratioFromPercent(d.thresholdPercent)
    if (ratio) c.threshold_ratio = ratio
  } else if (d.thresholdKind === 'atr') {
    const multiple = decimal(d.atrMultiple)
    if (multiple) c.atr_multiple = multiple
  }
  if (d.template === 'T5') {
    // T5 reads the amplitude off atr_multiple only.
    delete c.threshold_ratio
    const multiple = decimal(d.atrMultiple)
    if (multiple) c.atr_multiple = multiple
  }
  const invalidation = decimal(d.invalidation)
  if (invalidation && (d.template === 'T1' || d.template === 'T2' || d.template === 'T3')) {
    c.invalidation = invalidation
  }
  if (d.template === 'T4') {
    const boundary = decimal(d.boundary)
    if (boundary) c.boundary = boundary
    c.boundary_kind = d.boundaryKind
  }
  if (d.template === 'T3') {
    const price = decimal(d.triggerPrice)
    if (price) {
      c.trigger = {
        kind: d.triggerKind,
        comparator: d.triggerComparator,
        price,
        window_hours: d.triggerWindowHours,
        interval_seconds: d.triggerKind === 'bar_close' ? 60 : null,
      }
    }
  }
  return c
}

// The saved criteria, said out loud. Every field comes from the stored
// Criteria struct; nothing is inferred from the note the trader wrote.

import type { Criteria, Stance, Template } from '../api/types'
import { DASH, horizon } from './time'
import { percent, price } from './decimal'

export const TEMPLATES: Record<Template, string> = {
  T0: '只记不判',
  T1: '方向 + 期限',
  T2: '加失效价',
  T3: '先等触发',
  T4: '守住边界',
  T5: '振幅',
}

/** 挑模板的时候那一句，每条不超过 20 字。 */
export const TEMPLATE_NOTES: Record<Template, string> = {
  T0: '只记下来，不判对错',
  T1: '期限内朝这个方向走满阈值',
  T2: '再加一条失效价，碰到算错',
  T3: '先等触发成立，再开始计时',
  T4: '期限内不破这条边界就算对',
  T5: '期限内振幅够大，不分方向',
}

/** 写全了的模板名：`T1 方向 + 期限`。 */
export function templateName(template: Template | string): string {
  const named = TEMPLATES[template as Template]
  return named ?? String(template)
}

export const STANCES: Record<Stance, string> = {
  unknown: '没写',
  L: '看多',
  S: '看空',
  '?': '观望',
  C: '有条件',
}

/** 记一笔时能选的三个方向。 */
export const STANCE_CHOICES: Stance[] = ['L', 'S', '?']

export const PATHS: Record<string, string> = {
  unknown: '没写',
  chart_first: '图在先',
  thought_first: '想法在先',
  interwoven: '边看边想',
}

const DIRECTIONS: Record<string, string> = { L: '看多', S: '看空' }

function threshold(c: Criteria): string | null {
  if (c.threshold_ratio) return percent(c.threshold_ratio, 2)
  if (c.atr_multiple) return `${c.atr_multiple}×ATR14`
  if (c.template === 'T1' || c.template === 'T2' || c.template === 'T3') return '1×ATR14'
  return null
}

/** The short chip that rides along the record in lists and headers. */
export function summary(c: Criteria | null): { main: string; sub: string | null; soft: boolean } {
  if (!c || c.template === 'T0') return { main: '没写', sub: null, soft: true }
  const t = threshold(c)
  const hz = horizon(c.horizon_hours)
  switch (c.template) {
    case 'T1':
      return { main: `${DIRECTIONS[c.direction ?? ''] ?? '没写'} ${t}`, sub: hz, soft: false }
    case 'T2':
      return {
        main: `${DIRECTIONS[c.direction ?? ''] ?? '没写'} ${t}`,
        sub: `${hz} · 失效 ${price(c.invalidation) ?? DASH}`,
        soft: false,
      }
    case 'T3':
      return { main: '先等触发', sub: hz, soft: false }
    case 'T4':
      return {
        main: c.boundary_kind === 'upper_ceiling' ? '不过上边界' : '不破下边界',
        sub: `${price(c.boundary) ?? DASH} · ${hz}`,
        soft: false,
      }
    case 'T5':
      return { main: `振幅 ≥ ${c.atr_multiple ?? '1.5'}×ATR14`, sub: hz, soft: false }
    default:
      return { main: '没写', sub: null, soft: true }
  }
}

/**
 * 「怎么算对」那一格里的值，一句话说完，不解释。
 *
 * 展示页上不写引导语，所以这里只把存下来的标准读出来：期限、方向、阈值、
 * 失效价，一样不多一样不少。
 */
export function sentence(c: Criteria | null): string {
  if (!c || c.template === 'T0') return '没写'
  const hz = horizon(c.horizon_hours)
  const t = threshold(c)
  const up = (c.direction ?? 'L') === 'L'
  switch (c.template) {
    case 'T1':
      return `${hz}内${up ? '涨' : '跌'} ${t}`
    case 'T2':
      return `${hz}内${up ? '涨' : '跌'} ${t} · 失效 ${price(c.invalidation) ?? DASH}`
    case 'T3': {
      const trig = c.trigger
      const cond = trig
        ? `${price(trig.price) ?? DASH}${trig.comparator === 'gte' ? '以上' : '以下'}`
        : '触发'
      return `${cond}成立后 ${hz}内${up ? '涨' : '跌'} ${t}`
    }
    case 'T4':
      return `${hz}内不${c.boundary_kind === 'upper_ceiling' ? '过' : '破'} ${price(c.boundary) ?? DASH}`
    case 'T5':
      return `${hz}内振幅 ≥ ${c.atr_multiple ?? '1.5'}×ATR14`
    default:
      return '没写'
  }
}

/** The key/value rows under the sentence. */
export function ruleRows(c: Criteria | null): { key: string; value: string }[] {
  if (!c) return []
  const rows: { key: string; value: string }[] = [['模板', templateName(c.template)]].map(
    ([key, value]) => ({ key: key as string, value: value as string }),
  )
  if (c.template === 'T0') return rows
  rows.push({ key: '期限', value: horizon(c.horizon_hours) })
  const t = threshold(c)
  if (t) rows.push({ key: '阈值', value: t })
  if (c.direction) rows.push({ key: '方向', value: DIRECTIONS[c.direction] ?? c.direction })
  if (c.invalidation) rows.push({ key: '失效价', value: price(c.invalidation) ?? DASH })
  if (c.boundary) {
    rows.push({
      key: '边界',
      value: `${c.boundary_kind === 'upper_ceiling' ? '上边界' : '下边界'} ${price(c.boundary) ?? DASH}`,
    })
  }
  if (c.trigger) {
    rows.push({
      key: '触发',
      value: `${price(c.trigger.price) ?? DASH} ${c.trigger.comparator === 'gte' ? '以上' : '以下'}${c.trigger.kind === 'bar_close' ? '收盘' : '成交'} · ${horizon(c.trigger.window_hours)}内`,
    })
  }
  return rows
}

/** The criteria a record was saved with, or null when it has none. */
export function primary(list: Criteria[] | null | undefined): Criteria | null {
  return list && list.length ? (list[0] as Criteria) : null
}

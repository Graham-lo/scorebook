// The saved criteria, said out loud. Every field comes from the stored
// Criteria struct; nothing is inferred from the note the trader wrote.

import type { Criteria, Stance, Template } from '../api/types'
import { DASH, horizon } from './time'
import { percent, price } from './decimal'

export const TEMPLATES: Record<Template, string> = {
  T0: '不设标准',
  T1: '方向 + 期限 + 阈值',
  T2: '方向 + 期限 + 阈值 + 失效价',
  T3: '条件触发后再计时',
  T4: '边界守住',
  T5: '只看波动幅度',
}

export const STANCES: Record<Stance, string> = {
  unknown: '没写方向',
  L: '看多',
  S: '看空',
  '?': '不确定',
  C: '有条件',
}

export const PATHS: Record<string, string> = {
  unknown: '顺序未记录',
  chart_first: '先看图再说话',
  thought_first: '先有想法再找图',
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
  if (!c || c.template === 'T0') return { main: '不判对错', sub: null, soft: true }
  const t = threshold(c)
  const hz = horizon(c.horizon_hours)
  switch (c.template) {
    case 'T1':
      return { main: `${DIRECTIONS[c.direction ?? ''] ?? '方向未定'} ${t}`, sub: hz, soft: false }
    case 'T2':
      return {
        main: `${DIRECTIONS[c.direction ?? ''] ?? '方向未定'} ${t}`,
        sub: `${hz} · 失效 ${price(c.invalidation) ?? DASH}`,
        soft: false,
      }
    case 'T3':
      return { main: '条件成立后再看', sub: hz, soft: false }
    case 'T4':
      return {
        main: c.boundary_kind === 'upper_ceiling' ? '不过上边界' : '不破下边界',
        sub: `${price(c.boundary) ?? DASH} · ${hz}`,
        soft: false,
      }
    case 'T5':
      return { main: `振幅 ≥ ${c.atr_multiple ?? '1.5'}×ATR14`, sub: hz, soft: false }
    default:
      return { main: '不判对错', sub: null, soft: true }
  }
}

/** A full sentence for the criteria section and the capture preview. */
export function sentence(c: Criteria | null): string {
  if (!c || c.template === 'T0') {
    return '这条只记录，不判对错。之后可以再记一条写清楚标准的。'
  }
  const hz = horizon(c.horizon_hours)
  const t = threshold(c)
  const dir = DIRECTIONS[c.direction ?? ''] ?? '方向未定'
  switch (c.template) {
    case 'T1':
      return `从记录那一刻起 ${hz} 内，价格朝${dir === '看多' ? '上' : '下'}走满 ${t} 就算兑现。`
    case 'T2':
      return `从记录那一刻起 ${hz} 内，价格朝${dir === '看多' ? '上' : '下'}走满 ${t} 算兑现；期间只要触及 ${price(c.invalidation) ?? DASH} 就算没走成。`
    case 'T3': {
      const trig = c.trigger
      const cond = trig
        ? `${price(trig.price) ?? DASH} ${trig.comparator === 'gte' ? '之上' : '之下'}${trig.kind === 'bar_close' ? '收盘' : '成交'}`
        : '条件'
      return `先等 ${cond} 成立，成立后再看 ${hz}，朝${dir === '看多' ? '上' : '下'}走满 ${t} 算兑现；${trig ? `${horizon(trig.window_hours)}` : '窗口'}内没成立就算未触发。`
    }
    case 'T4':
      return `${hz} 内价格${c.boundary_kind === 'upper_ceiling' ? '没有站上' : '没有跌破'} ${price(c.boundary) ?? DASH} 就算守住。`
    case 'T5':
      return `${hz} 内最高与最低之间拉开 ${c.atr_multiple ?? '1.5'}×ATR14 以上就算兑现，不分方向。`
    default:
      return '这条只记录，不判对错。'
  }
}

/** The key/value rows under the sentence. */
export function ruleRows(c: Criteria | null): { key: string; value: string }[] {
  if (!c) return []
  const rows: { key: string; value: string }[] = [['模板', TEMPLATES[c.template] ?? c.template]].map(
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
      value: `${price(c.trigger.price) ?? DASH} ${c.trigger.comparator === 'gte' ? '以上' : '以下'}${c.trigger.kind === 'bar_close' ? '收盘确认' : '成交触及'} · ${horizon(c.trigger.window_hours)}内有效`,
    })
  }
  rows.push({ key: '标准版本', value: c.version })
  return rows
}

/** The criteria a record was saved with, or null when it has none. */
export function primary(list: Criteria[] | null | undefined): Criteria | null {
  return list && list.length ? (list[0] as Criteria) : null
}

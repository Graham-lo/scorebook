// 实盘账本里反复出现的那几样东西：一笔钱、一个方向、一轮持仓的状态。
//
// 这里只有排版，没有算术。金额、盈亏、手续费都是后端按十进制算好的字符串，
// 前端把它们放进 JS 的数字里再算一遍，只会得到第二个答案；两个答案对不上的时候
// 交易员没有办法判断该信哪一个。
//
// 还有一条：不知道的东西不写成 0。期初持仓不明、还没算完的一轮、缺少已实现盈亏
// 的成交，都要在界面上说出来是“不知道”，因为 0 是一个具体的说法——它是“空仓”。

import type { Decimal } from '../../api/types'
import { group, isNegative, isZero } from '../../data/decimal'
import { h } from '../../ui/dom'
import type { Child } from '../../ui/dom'

/** 一个金额。带上币种，因为多币种的手续费不能加在一起。 */
export function money(value: Decimal | null | undefined, asset?: string | null): HTMLElement {
  if (value === null || value === undefined) return unknown('这一项后端没有给出数字')
  const shown = group(value)
  const tone = isZero(value) ? '' : isNegative(value) ? 'neg' : 'pos'
  return h(
    'span',
    { class: ['mono', tone] },
    shown,
    asset ? h('span.faint', { text: ` ${asset}` }) : null,
  )
}

/** 一个价格或数量：不带正负色，只做千分位。 */
export function figure(value: Decimal | null | undefined, unit?: string | null): HTMLElement {
  if (value === null || value === undefined) return unknown('这一项后端没有给出数字')
  return h('span.mono', {}, group(value), unit ? h('span.faint', { text: ` ${unit}` }) : null)
}

/**
 * “不知道”这三个字要出现在它该出现的地方。写 0 会让人以为账是平的。
 */
export function unknown(why: string): HTMLElement {
  return h('span.faint', { title: why, text: '不知道' })
}

/** 多个币种的手续费并排列出来，不做任何折算。 */
export function commissionList(commissions: Record<string, Decimal> | null | undefined): Child {
  const entries = Object.entries(commissions ?? {})
  if (!entries.length) return h('span.faint', { text: '没有手续费记录' })
  const row = h('span', { style: 'display:inline-flex;gap:10px;flex-wrap:wrap' })
  for (const [asset, value] of entries) row.appendChild(money(value, asset))
  return row
}

export function directionBadge(direction: 'long' | 'short' | string): HTMLElement {
  const long = direction === 'long'
  return h('span', {
    class: ['stance', long ? 'L' : ''],
    title: long ? '多头' : '空头',
    text: long ? 'L' : 'S',
  })
}

const POSITION_SIDE: Record<string, string> = {
  BOTH: '单向持仓',
  LONG: '双向持仓 · 多',
  SHORT: '双向持仓 · 空',
}

export function positionSideLabel(side: string): string {
  return POSITION_SIDE[side] ?? side
}

const SIDE_LABEL: Record<string, string> = { BUY: '买入', SELL: '卖出' }

export function sideLabel(side: string): string {
  return SIDE_LABEL[side] ?? side
}

/** 一轮持仓的状态。期初不明是一种状态，不是一次失败。 */
export function cycleStamp(status: string): HTMLElement {
  if (status === 'closed') return h('span.stamp.st-realized', { text: '已了结' })
  if (status === 'open') return h('span.stamp.st-unrealized', { text: '持仓中' })
  if (status === 'opening_unknown') {
    return h('span.stamp.st-insufficient_data', {
      title: '这一轮开始之前手里有多少不知道，所以这一轮的盈亏也算不出来。',
      text: '期初不明',
    })
  }
  return h('span.stamp.flat', { text: status })
}

/** 资金流水的类别。交易所怎么叫就怎么显示，认识的翻译过来。 */
const LEDGER_KIND: Record<string, string> = {
  FUNDING_FEE: '资金费',
  COMMISSION: '手续费',
  REALIZED_PNL: '已实现盈亏',
  TRANSFER: '划转',
  INSURANCE_CLEAR: '强平清算',
  REFERRAL_KICKBACK: '返佣',
  COMMISSION_REBATE: '手续费返还',
  WELCOME_BONUS: '赠金',
  API_REBATE: 'API 返佣',
  CONTEST_REWARD: '活动奖励',
  CROSS_COLLATERAL_TRANSFER: '跨币种抵押划转',
  OPTIONS_PREMIUM_FEE: '期权权利金',
  OPTIONS_SETTLE_PROFIT: '期权结算',
  AUTO_EXCHANGE: '自动兑换',
  DELIVERED_SETTELMENT: '交割结算',
}

export function ledgerKindLabel(kind: string): string {
  return LEDGER_KIND[kind] ?? kind
}

/** 后端自报的口径，原样摆出来，不替它改写成更好听的说法。 */
export function policyLine(text: string): HTMLElement {
  return h('div.tip', { style: 'margin-top:10px', text })
}

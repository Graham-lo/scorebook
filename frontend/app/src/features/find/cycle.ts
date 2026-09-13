// 一轮持仓的明细 —— 这一轮是由哪几笔成交拼出来的。
//
// 后端把一笔成交拆给一轮或几轮，每一份带着自己的数量和手续费；这一页把这些份额
// 原样列出来，同时把那一笔成交本来的样子也放在旁边，好让人看出“这一轮用掉了这笔
// 成交的多少”。份额是后端拆的，这一页不重拆，也不把份额加起来去印证摘要——摘要
// 是后端算的，两处各算一遍只会得到两个答案。
//
// 资金费不在这里。它按发生时间记在资金流水上，不属于任何一轮的成交盈亏，所以这
// 一页把它单独列在下面，标明是同一段时间里同一个合约的资金流水，而不是把它并进
// 这一轮的盈亏。

import { Latest } from '../../api/http'
import * as trades from '../../api/trades'
import type { Allocation, CycleDetail, LedgerRow } from '../../api/types'
import { DASH, dateTime } from '../../data/time'
import { append, clear, h } from '../../ui/dom'
import type { Child } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { empty, ledgerSkeleton, note } from '../../ui/states'
import { problem } from '../../ui/toast'
import {
  commissionList,
  cycleStamp,
  directionBadge,
  figure,
  ledgerKindLabel,
  money,
  positionSideLabel,
  sideLabel,
  unknown,
} from './fills-bits'

const lane = new Latest()

const PORTION: Record<string, { text: string; why: string }> = {
  open: { text: '建仓', why: '这一份是往这一轮里加仓位的' },
  close: { text: '平仓', why: '这一份是从这一轮里减仓位的' },
  opening_unknown: {
    text: '期初之外',
    why: '这一份平掉的是这一轮开始之前就有的仓位，成本不知道，所以它的盈亏也算不出来',
  },
}

export function cyclePage(host: HTMLElement, arg: string): () => void {
  let alive = true
  const id = arg.split('/')[0] ?? ''

  const crumb = h('div.crumb', {}, h('a', { href: '#/find', text: '记录' }))
  const head = h('div.sheet.pad')
  const body = h('div', { style: 'margin-top:16px' })
  const foot = h('div', { style: 'margin-top:14px' })
  const funding = h('div', { style: 'margin-top:22px' })
  host.append(crumb, head, body, foot, funding)
  body.appendChild(ledgerSkeleton(5))

  const allocations: Allocation[] = []
  let cursor: string | null = null
  let more = false

  if (!id) {
    clear(body)
    body.appendChild(empty({ title: '没有指明是哪一轮' }))
  } else {
    void load()
  }

  async function load(): Promise<void> {
    const signal = lane.begin()
    try {
      const page = await trades.cycle(id, cursor ?? undefined, { signal })
      if (!alive) return
      allocations.push(...page.items)
      cursor = page.next_cursor ?? null
      more = !!page.next_cursor
      paintHead(page)
      paintAllocations()
      if (!funding.childElementCount) void loadFunding(page)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(body)
      body.appendChild(
        empty({
          title: '这一段读不出来',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void load() } }),
        }),
      )
    }
  }

  function paintHead(page: CycleDetail): void {
    clear(head)
    const c = page.cycle.cycle
    const opened = c.opened_at ? dateTime(c.opened_at) : '期初就有'
    const closed = c.closed_at ? dateTime(c.closed_at) : c.status === 'open' ? '还拿着' : DASH

    const numbers = h('div.kv.stats', { style: 'margin-top:14px' })
    numbers.append(
      kv('开仓均价', c.entry_price ? figure(c.entry_price) : unknown('期初持仓不明，均价算不出来')),
      kv(
        '账本算出的已实现',
        c.status === 'opening_unknown'
          ? unknown('期初不明，这一轮的已实现盈亏不能算')
          : money(c.computed_realized_pnl, c.settlement_asset),
      ),
      kv(
        '交易所给的已实现',
        c.exchange_realized_pnl === null || c.exchange_realized_pnl === undefined
          ? unknown('这一轮里有成交没带已实现盈亏')
          : money(c.exchange_realized_pnl, c.settlement_asset),
      ),
      kv('手续费', commissionList(c.commissions)),
      kv(
        '还剩',
        c.remaining_quantity === null || c.remaining_quantity === undefined
          ? unknown('期初不明，剩多少算不出来')
          : figure(c.remaining_quantity),
      ),
      kv('成交笔数', h('span.mono', { text: String(c.fills) })),
    )

    clear(crumb)
    append(crumb, [
      h('a', { href: '#/find', text: '记录' }),
      h('span.sep', { text: '/' }),
      h('a', { href: '#/find?by=fills', text: '成交' }),
      h('span.sep', { text: '/' }),
      h('span', { text: `${c.symbol} 第 ${c.ordinal} 轮` }),
    ])

    head.append(
      h(
        'div.row',
        { style: 'gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px' },
        directionBadge(c.direction),
        h('h1.h1', { text: c.symbol }),
        h('span.faint', { text: `第 ${c.ordinal} 轮` }),
        cycleStamp(c.status),
        h('span.faint', { text: positionSideLabel(c.position_side) }),
      ),
      h('div.faint', { style: 'margin-top:6px', text: `${opened} → ${closed}` }),
      numbers,
    )

    if (c.status === 'opening_unknown') {
      head.appendChild(note('warn', '期初持仓没写，这一轮的盈亏算不出来'))
    }
    if (c.opening_evidence) head.appendChild(evidenceLine(c.opening_evidence))
  }

  function paintAllocations(): void {
    clear(body)
    clear(foot)
    if (!allocations.length) {
      body.appendChild(
        empty({ title: '这一轮还没有成交份额' }),
      )
      return
    }

    body.appendChild(
      h('div.h3', { text: `这一轮用到的成交（${allocations.length}${more ? '+' : ''} 份）` }),
    )
    const list = h('div.ledger', { style: 'margin-top:10px' })
    for (const item of allocations) list.appendChild(allocationRow(item))
    body.appendChild(list)
    stagger(list.children)

    if (more) {
      foot.appendChild(
        h('button.btn.ghost', {
          text: '再读 20 条',
          on: {
            click: (e: Event) => {
              const button = e.currentTarget as HTMLButtonElement
              button.disabled = true
              void load().catch((error) => {
                button.disabled = false
                if (!Latest.aborted(error)) {
                  problem(error instanceof Error ? error.message : '没读出来')
                }
              })
            },
          },
        }),
      )
    }
  }

  function allocationRow(item: Allocation): HTMLElement {
    const f = item.actual_fill
    const portion = PORTION[item.portion] ?? { text: item.portion, why: '' }
    const numbers = h('div.kv', { style: 'margin-top:8px' })
    numbers.append(
      kv('这一轮用掉', figure(item.allocation_quantity)),
      kv('这一份的手续费', money(item.allocation_commission, f.commission_asset)),
      kv('这一笔成交的全部数量', figure(f.quantity)),
      kv('成交价', figure(f.price)),
      kv(
        '这一笔的已实现',
        f.realized_pnl === null || f.realized_pnl === undefined
          ? unknown('交易所这条记录里没带已实现盈亏')
          : money(f.realized_pnl, f.settlement_asset),
      ),
    )
    return h(
      'div.lrow',
      {},
      h(
        'div.body',
        {},
        h(
          'div.row',
          { style: 'gap:8px;align-items:center;flex-wrap:wrap' },
          h('span.tag', { title: portion.why, text: portion.text }),
          h('span.h3', { text: sideLabel(f.side) }),
          h('span.faint', { text: positionSideLabel(f.position_side) }),
          f.liquidation ? h('span.tag.warn', { text: '强平' }) : null,
        ),
        h('div.faint', {
          style: 'margin-top:4px',
          text: `${dateTime(f.traded_at)} · 成交号 ${f.trade_id}`,
        }),
        numbers,
      ),
    )
  }

  // ——— 同一段时间的资金流水 ———

  async function loadFunding(page: CycleDetail): Promise<void> {
    const c = page.cycle.cycle
    clear(funding)
    funding.append(
      h('div.h3', { text: '资金' }),
    )
    if (!c.opened_at) {
      funding.appendChild(h('div.faint', { text: '不知道是什么时候开始的' }))
      return
    }
    const slot = h('div', { style: 'margin-top:12px' }, ledgerSkeleton(3))
    funding.appendChild(slot)
    try {
      const result = await trades.accountLedger({
        connection_id: page.cycle.connection_id,
        symbol: c.symbol,
        start_at: c.opened_at,
        end_at: c.closed_at ?? undefined,
      })
      if (!alive) return
      clear(slot)
      if (!result.items.length) {
        slot.appendChild(
          h('div.faint', { text: '没有符合的记录' }),
        )
        return
      }
      const list = h('div.ledger')
      for (const row of result.items) list.appendChild(fundingRow(row))
      slot.append(list)
      stagger(list.children)
      if (result.next_cursor) {
        slot.appendChild(
          h('a.linkbtn', {
            style: 'margin-top:8px',
            href: '#/find?by=fills&tab=funds',
            text: '看全部资金',
          }),
        )
      }
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(slot)
      slot.appendChild(h('div.faint', { text: '这一段读不出来' }))
    }
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

function fundingRow(row: LedgerRow): HTMLElement {
  const e = row.entry
  return h(
    'div.lrow',
    {},
    h(
      'div.body',
      {},
      h(
        'div.row',
        { style: 'gap:8px;align-items:center;flex-wrap:wrap' },
        h('span.h3', { text: ledgerKindLabel(e.kind) }),
        e.symbol ? h('span.faint', { text: e.symbol }) : null,
      ),
      h('div.faint', { style: 'margin-top:4px', text: dateTime(e.occurred_at) }),
      h('div', { style: 'margin-top:6px' }, money(e.amount, e.asset)),
    ),
  )
}

/**
 * 期初的依据是你自己写下的一句话，所以原样显示，不替你改写。只有一种情况例外：
 * 从来没人填过期初，后端记的是它自己那句占位的英文，那句不是你的话，翻过来说。
 */
const NO_SEED = 'No verified opening position was supplied'

function evidenceLine(evidence: string): HTMLElement {
  if (evidence.trim() === NO_SEED) {
    return h('div.tip', { style: 'margin-top:10px', text: '期初没写' })
  }
  return h(
    'div.tip',
    { style: 'margin-top:10px' },
    h('span.dlabel', { text: '期初依据' }),
    h('span', { text: evidence }),
  )
}

function kv(label: string, value: Child): HTMLElement {
  return h(
    'div.kvrow',
    {},
    h('span.k', { text: label }),
    h('span.v', {}, value),
  )
}

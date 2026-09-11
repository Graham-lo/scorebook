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
import { go } from '../../router'
import { clear, h } from '../../ui/dom'
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
  policyLine,
  positionSideLabel,
  sideLabel,
  unknown,
} from '../trades/bits'

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

  const head = h('div.sheet.pad')
  const body = h('div', { style: 'margin-top:16px' })
  const foot = h('div', { style: 'margin-top:14px' })
  const funding = h('div', { style: 'margin-top:22px' })
  host.append(head, body, foot, funding)

  head.appendChild(
    h('button.btn.sm.ghost', { text: '← 回到实盘', on: { click: () => go('trades') } }),
  )
  body.appendChild(ledgerSkeleton(5))

  const allocations: Allocation[] = []
  let cursor: string | null = null
  let more = false
  let detail: CycleDetail | null = null

  if (!id) {
    clear(body)
    body.appendChild(empty({ title: '没有指明是哪一轮', tip: '从实盘的持仓轮次里点进来。' }))
  } else {
    void load()
  }

  async function load(): Promise<void> {
    const signal = lane.begin()
    try {
      const page = await trades.cycle(id, cursor ?? undefined, { signal })
      if (!alive) return
      detail = page
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
          title: '这一轮没有读出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load() } }),
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

    head.append(
      h('button.btn.sm.ghost', { text: '← 回到实盘', on: { click: () => go('trades') } }),
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
      head.appendChild(
        note(
          'warn',
          '这一轮开始之前手里有多少不知道，所以这一轮的盈亏算不出来——界面上写的是「不知道」，不是 0。到实盘的「账本维护 · 期初持仓」把当时的持仓补上；如果确实不知道，就让它保持不知道，别填一个凑出来的数。',
        ),
      )
    }
    if (c.opening_evidence) head.appendChild(evidenceLine(c.opening_evidence))
    head.appendChild(
      policyLine('这些数字是后端账本算的，这一页只排版，不重算，也不用下面的份额去倒推它们。'),
    )
  }

  function paintAllocations(): void {
    clear(body)
    clear(foot)
    if (!allocations.length) {
      body.appendChild(
        empty({
          title: '这一轮还没有成交份额',
          tip: '导入之后账要重新算一遍，算完这里才有内容。',
        }),
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
    body.appendChild(
      policyLine(
        detail?.allocation_scope === 'complete_immutable_ancestry'
          ? '这里列的是这一轮从头到尾的全部份额，包括早先几次增量重算留下的那些——没有被后来的重算抹掉。'
          : '份额由后端拆分，这一页原样列出。',
      ),
    )

    if (more) {
      foot.appendChild(
        h('button.btn.ghost', {
          text: '再读一批',
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
    } else {
      foot.appendChild(h('div.faint', { text: '这一轮的份额都在这儿了。' }))
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
      h('div.h3', { text: '这一段时间里这个合约的资金流水' }),
      h('div.tip', {
        style: 'margin-top:6px;max-width:60ch',
        text: '资金费、划转这些按发生时间单独记，不算在上面那一轮的成交盈亏里。它们在这儿列出来只是为了让你看到同一段时间里还有哪些钱进出，不要把两边的数字加在一起当成这一轮的结果。',
      }),
    )
    if (!c.opened_at) {
      funding.appendChild(
        note(
          'info',
          '这一轮不知道是什么时候开始的，所以框不出该看哪一段资金流水。到实盘的「资金流水」里按你自己定的时间范围看。',
        ),
      )
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
          h('div.faint', {
            text: c.closed_at
              ? '这一段时间里这个合约没有资金流水。'
              : '从开仓到现在，这个合约还没有资金流水。',
          }),
        )
        return
      }
      const list = h('div.ledger')
      for (const row of result.items) list.appendChild(fundingRow(row))
      slot.append(list)
      stagger(list.children)
      slot.appendChild(
        policyLine(
          result.amount_policy === 'original_asset_decimal_no_fx'
            ? '按发生时的币种原样记，不折算成一个统一的计价货币，所以不同币种的几笔不能相加。'
            : '金额按后端的口径原样显示。',
        ),
      )
      if (result.next_cursor) {
        slot.appendChild(
          h('div.tip', {
            style: 'margin-top:8px',
            text: '这一段的流水还没列完。完整的一份在实盘的「资金流水」里，可以接着往下翻。',
          }),
        )
      }
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(slot)
      slot.appendChild(
        note('warn', error instanceof Error ? error.message : '这一段的资金流水没有读出来。'),
      )
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
    return h('div.tip', {
      style: 'margin-top:10px',
      text: '期初没人填过：这个合约在这段成交开始之前手里有多少，账本里没有依据。',
    })
  }
  return h(
    'div.tip',
    { style: 'margin-top:10px' },
    h('span.dlabel', { text: '你填期初时写的依据：' }),
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

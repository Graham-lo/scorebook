// 记录 / 成交 —— 交易所真正成交过的那些单子。
//
// 四段：持仓 · 成交 · 资金 · 账户。段名写在地址上（`#/find?by=fills&tab=…`），
// 刷新和后退都回得到同一段。金额、盈亏、手续费都是后端按十进制算好的字符串，
// 这一页只排版，不再算一遍；算不出来的地方写「不知道」，不写 0。

import { Latest, Pager } from '../../api/http'
import * as trades from '../../api/trades'
import type { CycleRow, ExchangeConnection, FillRow, LedgerRow, Uuid } from '../../api/types'
import { dateTime, DASH } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { go } from '../../router'
import type { Child } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { empty, ledgerSkeleton } from '../../ui/states'
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
import { bookPanel } from './fills-book'

type Tab = 'positions' | 'fills' | 'funds' | 'accounts'

const TABS: { id: Tab; label: string }[] = [
  { id: 'positions', label: '持仓' },
  { id: 'fills', label: '成交' },
  { id: 'funds', label: '资金' },
  { id: 'accounts', label: '账户' },
]

const lane = new Latest()

const view = {
  connections: [] as ExchangeConnection[],
  loaded: false,
  current: null as Uuid | null,
  symbol: '',
  from: '',
  to: '',
}

export function fillsPage(host: HTMLElement, query: URLSearchParams): () => void {
  let alive = true
  let renderVersion = 0
  resetPagers()
  view.loaded = false
  const asked = (query.get('tab') ?? 'positions') as Tab
  const tab: Tab = TABS.some((t) => t.id === asked) ? asked : 'positions'

  const strip = h('div.acctstrip')
  const tabs = h('div.segs')
  const filters = h('div.filters')
  const body = h('div', { style: 'margin-top:16px' })
  const foot = h('div', { style: 'margin-top:14px' })
  host.append(strip, tabs, filters, body, foot)

  if (view.loaded) paintAll()
  else {
    body.appendChild(ledgerSkeleton(4))
    void loadConnections()
  }

  async function loadConnections(): Promise<void> {
    const signal = lane.begin()
    try {
      const items: ExchangeConnection[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await trades.connections({ cursor }, { signal })
        if (!alive || signal.aborted) return
        items.push(...page.items)
        cursor = page.next_cursor ?? undefined
        if (cursor && seen.has(cursor)) throw new Error('账户列表没有读完整，请重试')
        if (cursor) seen.add(cursor)
      } while (cursor)
      view.connections = items
      view.loaded = true
      if (!view.current || !items.some((c) => c.id === view.current)) {
        view.current = items.find((c) => !c.disabled_at)?.id ?? items[0]?.id ?? null
      }
      paintAll()
    } catch (error) {
      if (Latest.aborted(error) || !alive || signal.aborted) return
      clear(body)
      body.appendChild(
        empty({
          title: '没读出来，请重试',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void loadConnections() } }),
        }),
      )
    }
  }

  function paintAll(): void {
    paintStrip()
    paintTabs()
    paintTab()
  }

  function paintStrip(): void {
    clear(strip)
    if (view.connections.length < 2) return
    for (const connection of view.connections) {
      strip.appendChild(
        h(
          'button',
          {
            class: ['chip', connection.id === view.current ? 'on' : ''],
            on: {
              click: () => {
                if (view.current === connection.id) return
                view.current = connection.id
                resetPagers()
                paintAll()
              },
            },
          },
          `${connection.name} · ${connection.account_label}`,
        ),
      )
    }
  }

  function paintTabs(): void {
    clear(tabs)
    for (const item of TABS) {
      tabs.appendChild(
        h('a', {
          class: ['seg', tab === item.id ? 'on' : ''],
          href: `#/find?by=fills&tab=${item.id}`,
          text: item.label,
        }),
      )
    }
  }

  function paintTab(): void {
    renderVersion += 1
    clear(filters)
    clear(body)
    clear(foot)
    const connection = view.connections.find((c) => c.id === view.current) ?? null
    if (tab === 'accounts') {
      body.appendChild(bookPanel(connection, view.connections, () => {
        resetPagers()
        void loadConnections()
      }, resetPagers))
      return
    }
    if (!connection) {
      body.appendChild(empty({
        title: '还没接交易所账户',
        action: h('a.btn.sm.primary', { href: '#/find?by=fills&tab=accounts', text: '接一个账户' }),
      }))
      return
    }

    paintFilters()
    if (tab === 'positions') void run(cyclesPager(connection.id), paintCycles)
    else if (tab === 'fills') void run(fillsPager(connection.id), paintFills)
    else void run(ledgerPager(connection.id), paintLedger)
  }

  function paintFilters(): void {
    const symbol = h('input.input', {
      value: view.symbol,
      placeholder: '品种，如 BTCUSDT',
      attrs: { 'aria-label': '品种' },
      style: 'width:180px',
    }) as HTMLInputElement
    const from = h('input.input', { type: 'date', value: view.from, attrs: { 'aria-label': '开始日期' } }) as HTMLInputElement
    const to = h('input.input', { type: 'date', value: view.to, attrs: { 'aria-label': '结束日期' } }) as HTMLInputElement
    filters.append(
      h('button.btn.sm.ghost', { text: '刷新', on: { click: () => { resetPagers(); void loadConnections() } } }),
      symbol,
      from,
      to,
      h('button.btn.sm', {
        text: '筛选',
        on: {
          click: () => {
            if (from.value && to.value && from.value > to.value) { problem('结束日期要在开始日期之后'); return }
            view.symbol = symbol.value.trim().toUpperCase()
            view.from = from.value
            view.to = to.value
            resetPagers()
            paintTab()
          },
        },
      }),
      h('button.btn.sm.ghost', {
        text: '清除筛选',
        on: {
          click: () => {
            view.symbol = ''
            view.from = ''
            view.to = ''
            resetPagers()
            paintTab()
          },
        },
      }),
    )
  }

  async function run<T>(pager: Pager<T>, paint: (pager: Pager<T>) => void): Promise<void> {
    const version = renderVersion
    if (!pager.loaded) body.appendChild(ledgerSkeleton(5))
    try {
      if (!pager.loaded) await pager.next()
      if (!alive || version !== renderVersion) return
      paint(pager)
    } catch (error) {
      if (Latest.aborted(error) || !alive || version !== renderVersion) return
      clear(body)
      body.appendChild(
        empty({
          title: '没读出来，请重试',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void run(pager, paint) } }),
        }),
      )
    }
  }

  function moreButton<T>(pager: Pager<T>, paint: (pager: Pager<T>) => void): void {
    const version = renderVersion
    clear(foot)
    if (!pager.more) return
    foot.appendChild(
      h('button.btn.ghost.sm', {
        text: '再读 20 条',
        on: {
          click: (e: Event) => {
            const button = e.currentTarget as HTMLButtonElement
            button.disabled = true
            void pager
              .next()
              .then(() => {
                if (alive && version === renderVersion) paint(pager)
              })
              .catch((error) => {
                if (!alive || version !== renderVersion) return
                button.disabled = false
                if (!Latest.aborted(error)) problem('没读出来，请重试')
              })
          },
        },
      }),
    )
  }

  /* ——— 持仓 ——— */

  function paintCycles(pager: Pager<CycleRow>): void {
    clear(body)
    if (!pager.items.length) {
      body.appendChild(h('div.rtable', {}, empty({ title: '没有符合的记录' })))
      moreButton(pager, paintCycles)
      return
    }
    const list = h('div.rtable')
    for (const row of pager.items) list.appendChild(cycleRow(row))
    body.appendChild(list)
    stagger(list.children)
    moreButton(pager, paintCycles)
  }

  function cycleRow(row: CycleRow): HTMLElement {
    const c = row.cycle
    const opened = c.opened_at ? dateTime(c.opened_at) : DASH
    const closed = c.closed_at ? dateTime(c.closed_at) : DASH

    const numbers = h('div.kv', { style: 'margin-top:8px' })
    numbers.append(
      kv('价格', c.entry_price ? figure(c.entry_price) : unknown()),
      kv(
        '结果',
        c.status === 'opening_unknown'
          ? unknown()
          : money(c.computed_realized_pnl, c.settlement_asset),
      ),
      kv('手续费', commissionList(c.commissions)),
      kv(
        '数量',
        c.remaining_quantity === null || c.remaining_quantity === undefined
          ? unknown()
          : figure(c.remaining_quantity),
      ),
    )

    return h(
      'div.lrow',
      {
        tabIndex: 0,
        on: {
          click: () => go(`cycle/${row.id}`),
          keydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') go(`cycle/${row.id}`)
          },
        },
      },
      h(
        'div.body',
        {},
        h(
          'div.row',
          { style: 'gap:8px;align-items:center;flex-wrap:wrap' },
          directionBadge(c.direction),
          h('span.h3', { text: c.symbol }),
          h('span.faint', { text: `第 ${c.ordinal} 轮` }),
          cycleStamp(c.status),
          h('span.faint', { text: positionSideLabel(c.position_side) }),
        ),
        h('div.faint', { style: 'margin-top:4px', text: `${opened} – ${closed}` }),
        numbers,
      ),
    )
  }

  /* ——— 成交 ——— */

  function paintFills(pager: Pager<FillRow>): void {
    clear(body)
    if (!pager.items.length) {
      body.appendChild(h('div.rtable', {}, empty({ title: '没有符合的记录' })))
      moreButton(pager, paintFills)
      return
    }
    const list = h(
      'div.rtable',
      {},
      h(
        'div.frow.fhead',
        {},
        h('span', { text: '时间' }),
        h('span', { text: '品种' }),
        h('span', { text: '方向' }),
        h('span', { text: '价格' }),
        h('span', { text: '数量' }),
        h('span', { text: '手续费' }),
      ),
    )
    for (const row of pager.items) {
      const f = row.fill
      list.appendChild(
        h(
          'div.frow',
          {},
          h('span.c-time', { text: dateTime(f.traded_at) }),
          h('span', { text: f.symbol }),
          h('span', { text: sideLabel(f.side) }),
          h('span', {}, figure(f.price)),
          h('span', {}, figure(f.quantity)),
          h('span', {}, money(f.commission, f.commission_asset)),
        ),
      )
    }
    body.appendChild(list)
    stagger(list.children)
    moreButton(pager, paintFills)
  }

  /* ——— 资金 ——— */

  function paintLedger(pager: Pager<LedgerRow>): void {
    clear(body)
    if (!pager.items.length) {
      body.appendChild(h('div.rtable', {}, empty({ title: '没有符合的记录' })))
      moreButton(pager, paintLedger)
      return
    }
    const list = h('div.rtable')
    for (const row of pager.items) {
      const e = row.entry
      list.appendChild(
        h(
          'div.frow.f3',
          {},
          h('span.c-time', { text: dateTime(e.occurred_at) }),
          h('span', { text: `${ledgerKindLabel(e.kind)}${e.symbol ? ` · ${e.symbol}` : ''}` }),
          h('span', {}, money(e.amount, e.asset)),
        ),
      )
    }
    body.appendChild(list)
    stagger(list.children)
    moreButton(pager, paintLedger)
  }

  return () => {
    alive = false
    lane.cancel()
    resetPagers()
  }
}

function kv(label: string, value: Child): HTMLElement {
  return h('div.kvrow', {}, h('span.k', { text: label }), h('span.v', {}, value))
}

/* ——— 分页器：一组筛选条件配一个，条件一变就整个换掉 ——— */

let pagers: {
  key: string
  cycles?: Pager<CycleRow>
  fills?: Pager<FillRow>
  ledger?: Pager<LedgerRow>
} = { key: '' }

function filterOf(connectionId: Uuid): trades.TradeFilter {
  return {
    connection_id: connectionId,
    symbol: view.symbol || undefined,
    start_at: dayStart(view.from),
    end_at: dayEnd(view.to),
  }
}

function keyOf(connectionId: Uuid): string {
  return JSON.stringify([connectionId, view.symbol, view.from, view.to])
}

function fresh(connectionId: Uuid): void {
  const key = keyOf(connectionId)
  if (pagers.key !== key) {
    resetPagers()
    pagers = { key }
  }
}

function cyclesPager(connectionId: Uuid): Pager<CycleRow> {
  fresh(connectionId)
  const filter = filterOf(connectionId)
  pagers.cycles ??= new Pager<CycleRow>((cursor, signal) =>
    trades.cycles({ ...filter, cursor: cursor ?? undefined }, { signal }),
  )
  return pagers.cycles
}

function fillsPager(connectionId: Uuid): Pager<FillRow> {
  fresh(connectionId)
  const filter = filterOf(connectionId)
  pagers.fills ??= new Pager<FillRow>((cursor, signal) =>
    trades.fills({ ...filter, cursor: cursor ?? undefined }, { signal }),
  )
  return pagers.fills
}

function ledgerPager(connectionId: Uuid): Pager<LedgerRow> {
  fresh(connectionId)
  const filter = filterOf(connectionId)
  pagers.ledger ??= new Pager<LedgerRow>((cursor, signal) =>
    trades.accountLedger({ ...filter, cursor: cursor ?? undefined }, { signal }),
  )
  return pagers.ledger
}

function resetPagers(): void {
  pagers.cycles?.reset()
  pagers.fills?.reset()
  pagers.ledger?.reset()
  pagers = { key: '' }
}

/** date 输入框给的是一天，按本地时区的这一天开始/结束换成 UTC 传给后端。 */
function dayStart(value: string): string | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

function dayEnd(value: string): string | undefined {
  if (!value) return undefined
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return undefined
  d.setDate(d.getDate() + 1)
  return d.toISOString()
}

// 实盘 —— 真正成交过的那些单子。
//
// 这一页和「我的记录」是两件事：记录是你当时怎么想的，实盘是钱实际怎么进出的。
// 两边都留着，复盘的时候才能看出想法和执行之间差在哪里。关联是事后补的，界面上
// 也这么说——不能让一条事后补的关联看起来像是入场之前就有的依据。
//
// 三条规矩写死在这一页里：
//   · 价格是真实成交价，不是行情图上的价；
//   · 手续费和资金费按币种分开列，不折算成一个数；
//   · 不知道的地方写“不知道”，不写 0。

import { Latest, Pager } from '../../api/http'
import * as trades from '../../api/trades'
import type {
  CycleRow,
  ExchangeConnection,
  FillRow,
  LedgerRow,
  Uuid,
} from '../../api/types'
import { dateTime, DASH } from '../../data/time'
import { clear, h } from '../../ui/dom'
import type { Child } from '../../ui/dom'
import { go } from '../../router'
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
} from './bits'
import { bookPanel } from './maintain'

type Tab = 'cycles' | 'fills' | 'ledger' | 'book'

const TABS: { id: Tab; label: string }[] = [
  { id: 'cycles', label: '持仓轮次' },
  { id: 'fills', label: '成交明细' },
  { id: 'ledger', label: '资金流水' },
  { id: 'book', label: '账本维护' },
]

const lane = new Latest()

/** 页面之间保留的选择，回到这一页时还是刚才那个账户、那个筛选。 */
const view = {
  connections: [] as ExchangeConnection[],
  loaded: false,
  current: null as Uuid | null,
  tab: 'cycles' as Tab,
  symbol: '',
  from: '',
  to: '',
}

export function tradesPage(host: HTMLElement): () => void {
  let alive = true

  const head = h(
    'div.sheet.pad',
    {},
    h('h1.h1', { text: '实盘' }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:60ch',
      text: '这里是钱实际怎么走的：每一笔成交按交易所给的成交价记，手续费和资金费按币种分开列。想法记在「我的记录」里，两边对照才看得出执行和判断差在哪。',
    }),
  )
  const strip = h('div', { style: 'margin-top:14px' })
  head.appendChild(strip)

  const tabs = h('div.rvtabs')
  const filters = h('div.filters', { style: 'margin-top:14px' })
  const body = h('div', { style: 'margin-top:16px' })
  const foot = h('div', { style: 'margin-top:14px' })
  host.append(head, tabs, filters, body, foot)

  if (view.loaded) paintAll()
  else {
    body.appendChild(ledgerSkeleton(4))
    void loadConnections()
  }

  async function loadConnections(): Promise<void> {
    const signal = lane.begin()
    try {
      const page = await trades.connections({}, { signal })
      if (!alive) return
      view.connections = page.items
      view.loaded = true
      if (!view.current || !page.items.some((c) => c.id === view.current)) {
        view.current = page.items.find((c) => !c.disabled_at)?.id ?? page.items[0]?.id ?? null
      }
      paintAll()
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(body)
      body.appendChild(
        empty({
          title: '账户列表没有读出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', {
            text: '重试',
            on: { click: () => void loadConnections() },
          }),
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
    if (!view.connections.length) return
    const row = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' })
    for (const connection of view.connections) {
      const off = !!connection.disabled_at
      row.appendChild(
        h(
          'button',
          {
            class: ['chip', connection.id === view.current ? 'on' : ''],
            title: off ? '这个账户已经断开，账还留着，只是不会再同步' : connection.account_label,
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
          off ? h('span.faint', { text: ' 已断开' }) : null,
        ),
      )
    }
    strip.appendChild(row)
  }

  function paintTabs(): void {
    clear(tabs)
    if (!view.connections.length) return
    for (const tab of TABS) {
      tabs.appendChild(
        h('button', {
          class: ['rvtab', view.tab === tab.id ? 'on' : ''],
          text: tab.label,
          on: {
            click: () => {
              if (view.tab === tab.id) return
              view.tab = tab.id
              paintTabs()
              paintTab()
            },
          },
        }),
      )
    }
  }

  function paintTab(): void {
    clear(filters)
    clear(body)
    clear(foot)
    if (!view.connections.length) {
      body.appendChild(
        empty({
          title: '还没有登记过账户',
          tip: '先登记一个账户，再把成交导进来。凭证不经过这个页面——密钥放在这台机器的钥匙串里，页面只用得到它的名字。',
          action: h('button.btn.sm.primary', {
            text: '登记账户',
            on: {
              click: () => {
                view.tab = 'book'
                paintTabs()
                paintTab()
              },
            },
          }),
        }),
      )
      return
    }
    const connection = view.connections.find((c) => c.id === view.current) ?? null
    if (!connection) return

    if (view.tab === 'book') {
      body.appendChild(
        bookPanel(connection, view.connections, () => {
          resetPagers()
          void loadConnections()
        }),
      )
      return
    }

    paintFilters()
    if (view.tab === 'cycles') void run(cyclesPager(connection.id), paintCycles)
    else if (view.tab === 'fills') void run(fillsPager(connection.id), paintFills)
    else void run(ledgerPager(connection.id), paintLedger)
  }

  function paintFilters(): void {
    const symbol = h('input.input', {
      value: view.symbol,
      placeholder: '合约，例如 BTCUSDT',
      style: 'width:200px',
    }) as HTMLInputElement
    const from = h('input.input', { type: 'date', value: view.from }) as HTMLInputElement
    const to = h('input.input', { type: 'date', value: view.to }) as HTMLInputElement
    const apply = h('button.btn.sm', {
      text: '看这一段',
      on: {
        click: () => {
          view.symbol = symbol.value.trim().toUpperCase()
          view.from = from.value
          view.to = to.value
          resetPagers()
          paintTab()
        },
      },
    })
    const clearFilters = h('button.btn.sm.ghost', {
      text: '全部',
      on: {
        click: () => {
          view.symbol = ''
          view.from = ''
          view.to = ''
          resetPagers()
          paintTab()
        },
      },
    })
    filters.append(symbol, from, to, apply, clearFilters)
  }

  /** 取第一页并交给对应的画法；之后的每一页追加在同一个列表里。 */
  async function run<T>(pager: Pager<T>, paint: (pager: Pager<T>) => void): Promise<void> {
    if (!pager.loaded) body.appendChild(ledgerSkeleton(5))
    try {
      if (!pager.loaded) await pager.next()
      if (!alive) return
      paint(pager)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(body)
      body.appendChild(
        empty({
          title: '这一段账没有读出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void run(pager, paint) } }),
        }),
      )
    }
  }

  function moreButton<T>(pager: Pager<T>, paint: (pager: Pager<T>) => void): void {
    clear(foot)
    if (!pager.more) {
      foot.appendChild(h('div.faint', { text: '到这一段的尽头了。' }))
      return
    }
    foot.appendChild(
      h('button.btn.ghost', {
        text: '再读一批',
        on: {
          click: (e: Event) => {
            const button = e.currentTarget as HTMLButtonElement
            button.disabled = true
            void pager
              .next()
              .then(() => {
                if (alive) paint(pager)
              })
              .catch((error) => {
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

  // ——— 持仓轮次 ———

  function paintCycles(pager: Pager<CycleRow>): void {
    clear(body)
    if (!pager.items.length) {
      body.appendChild(
        empty({
          title: '这一段没有算出持仓轮次',
          tip: '要么这段时间没有成交，要么导入之后账还没有重新算完。到「账本维护」看一眼导入记录。',
        }),
      )
      moreButton(pager, paintCycles)
      return
    }

    if (pager.items.some((row) => row.stale)) {
      body.appendChild(
        note(
          'warn',
          '下面有几轮标着「旧账」：它们是上一次算的结果，之后又导入过东西。等重算完再拿它们做结论。',
        ),
      )
    }
    if (pager.items.some((row) => row.cycle.status === 'opening_unknown')) {
      body.appendChild(
        note(
          'info',
          '有几轮开始之前手里有多少不知道，所以这几轮的盈亏算不出来，界面上写的是「不知道」而不是 0。到「账本维护 · 期初持仓」把当时的持仓补上，或者说明确实不知道。',
        ),
      )
    }

    const list = h('div.ledger')
    for (const row of pager.items) list.appendChild(cycleRow(row))
    body.appendChild(list)
    stagger(list.children)
    body.appendChild(policyLine('盈亏、手续费都按后端账本的十进制结果显示，这一页不会再算一遍。'))
    moreButton(pager, paintCycles)
  }

  function cycleRow(row: CycleRow): HTMLElement {
    const c = row.cycle
    const opened = c.opened_at ? dateTime(c.opened_at) : '期初就有'
    const closed = c.closed_at ? dateTime(c.closed_at) : c.status === 'open' ? '还拿着' : DASH

    const numbers = h('div.kv', { style: 'margin-top:8px' })
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
          row.stale
            ? h('span.tag.warn', {
                title: '这一轮是上一次算的结果，之后又导入过内容',
                text: '旧账',
              })
            : null,
          h('span.faint', { text: positionSideLabel(c.position_side) }),
        ),
        h('div.faint', { style: 'margin-top:4px', text: `${opened} → ${closed}` }),
        numbers,
      ),
    )
  }

  // ——— 成交明细 ———

  function paintFills(pager: Pager<FillRow>): void {
    clear(body)
    if (!pager.items.length) {
      body.appendChild(
        empty({ title: '这一段没有成交', tip: '换个时间范围，或者先把账单导进来。' }),
      )
      moreButton(pager, paintFills)
      return
    }
    const list = h('div.ledger')
    for (const row of pager.items) list.appendChild(fillRow(row))
    body.appendChild(list)
    stagger(list.children)
    body.appendChild(policyLine('价格是交易所记的真实成交价，不是行情图上的价。'))
    moreButton(pager, paintFills)
  }

  function fillRow(row: FillRow): HTMLElement {
    const f = row.fill
    const numbers = h('div.kv', { style: 'margin-top:8px' })
    numbers.append(
      kv('成交价', figure(f.price)),
      kv('数量', figure(f.quantity)),
      kv('手续费', money(f.commission, f.commission_asset)),
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
          h('span.h3', { text: f.symbol }),
          h('span.tag', { text: sideLabel(f.side) }),
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

  // ——— 资金流水 ———

  function paintLedger(pager: Pager<LedgerRow>): void {
    clear(body)
    if (!pager.items.length) {
      body.appendChild(
        empty({
          title: '这一段没有资金流水',
          tip: '资金费、划转、返佣走这里，和成交盈亏分开记。',
        }),
      )
      moreButton(pager, paintLedger)
      return
    }
    const list = h('div.ledger')
    for (const row of pager.items) {
      const e = row.entry
      list.appendChild(
        h(
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
        ),
      )
    }
    body.appendChild(list)
    stagger(list.children)
    body.appendChild(policyLine('按发生时的币种原样记，不折算成一个统一的计价货币。'))
    moreButton(pager, paintLedger)
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

function kv(label: string, value: Child): HTMLElement {
  return h(
    'div.kvrow',
    {},
    h('span.k', { text: label }),
    h('span.v', {}, value),
  )
}

// ——— 分页器 ———
//
// 一组筛选条件配一个分页器。条件一变就整个换掉：后端的游标只在同一组条件里有效，
// 拿旧游标去翻新条件的列表会被直接拒绝。

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
  if (pagers.key !== key) pagers = { key }
}

function cyclesPager(connectionId: Uuid): Pager<CycleRow> {
  fresh(connectionId)
  pagers.cycles ??= new Pager<CycleRow>((cursor, signal) =>
    trades.cycles({ ...filterOf(connectionId), cursor: cursor ?? undefined }, { signal }),
  )
  return pagers.cycles
}

function fillsPager(connectionId: Uuid): Pager<FillRow> {
  fresh(connectionId)
  pagers.fills ??= new Pager<FillRow>((cursor, signal) =>
    trades.fills({ ...filterOf(connectionId), cursor: cursor ?? undefined }, { signal }),
  )
  return pagers.fills
}

function ledgerPager(connectionId: Uuid): Pager<LedgerRow> {
  fresh(connectionId)
  pagers.ledger ??= new Pager<LedgerRow>((cursor, signal) =>
    trades.accountLedger({ ...filterOf(connectionId), cursor: cursor ?? undefined }, { signal }),
  )
  return pagers.ledger
}

function resetPagers(): void {
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

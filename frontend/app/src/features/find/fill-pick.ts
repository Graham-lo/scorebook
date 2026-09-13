// 挑成交 / 挑一轮持仓 —— 全站只有这一份。
//
// 以前这件事写了三遍：实盘页一遍、复盘里「这次实际做了没有」一遍、详情页「实际
// 成交」再一遍。三份筛选项不一样、错误话术不一样、空态也不一样，于是同一件事在
// 三个地方看起来像三件事。这里把它收成一个组件：账户 + 品种 + 起止，列出来，选中。
//
// 只负责挑，不负责写。选中之后拿这些 id 去做什么（关联到一条记录、放进一次复盘），
// 由调用的那一页决定。

import { Latest } from '../../api/http'
import * as trades from '../../api/trades'
import type { CycleRow, ExchangeConnection, FillRow, Uuid } from '../../api/types'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { empty } from '../../ui/states'
import { commissionList, cycleStamp, directionBadge, figure, money, sideLabel } from './fills-bits'

export interface FillPickOptions {
  /** `fills` 挑一笔笔成交（可多选）；`positions` 挑一轮持仓（点一下加一轮）。 */
  mode: 'fills' | 'positions'
  symbol?: string | null
  /** 起始那一天，`yyyy-mm-dd`。 */
  from?: string | null
  to?: string | null
  /** 这一页此刻还让不让选。 */
  enabled?: () => boolean
  /** `positions`：点中了一轮。`fills`：勾选变了，给的是当前全部选中的 id。 */
  onPick?: (row: CycleRow, accountName: string | null) => void
  onChange?: (ids: Uuid[]) => void
  /** `positions`：这一轮是不是已经加过了。 */
  isPicked?: (id: Uuid) => boolean
}

export interface FillPicker {
  node: HTMLElement
  /** 现在选的是哪个账户。没有账户时是 null。 */
  connectionId(): Uuid | null
  /** `fills`：勾了哪几笔。 */
  picked(): Uuid[]
  /** 重画列表（`positions` 加过一轮之后，按钮要变成「已选中」）。 */
  refresh(): void
  dispose(): void
}

export function fillPicker(options: FillPickOptions): FillPicker {
  const lane = new Latest()
  const picked = new Set<Uuid>()
  let alive = true
  let connections: ExchangeConnection[] = []
  let cursor: string | undefined
  let fills: FillRow[] = []
  let cycles: CycleRow[] = []

  const account = h('select.input', { style: 'max-width:280px', attrs: { 'aria-label': '账户' } }) as HTMLSelectElement
  const symbol = h('input.input', {
    style: 'width:160px',
    value: options.symbol ?? '',
    placeholder: '品种，如 BTCUSDT', attrs: { 'aria-label': '品种' },
  }) as HTMLInputElement
  const from = h('input.input', { type: 'date', value: options.from ?? '', attrs: { 'aria-label': '开始日期' } }) as HTMLInputElement
  const to = h('input.input', { type: 'date', value: options.to ?? '', attrs: { 'aria-label': '结束日期' } }) as HTMLInputElement
  const filters = h('div.filters')
  const list = h('div', { style: 'margin-top:12px' })
  const foot = h('div', { style: 'margin-top:8px' })
  const node = h('div.fpicker', {}, filters, list, foot)

  const enabled = (): boolean => (options.enabled ? options.enabled() : true)

  function again(): void {
    lane.cancel()
    clear(foot)
    cursor = undefined
    fills = []
    cycles = []
    picked.clear()
    options.onChange?.([])
    void load()
  }

  filters.append(
    account,
    symbol,
    from,
    to,
    h('button.btn.sm.ghost', {
      text: '清除筛选',
      on: {
        click: () => {
          symbol.value = ''
          from.value = ''
          to.value = ''
          again()
        },
      },
    }),
  )
  account.addEventListener('change', again)
  for (const field of [symbol, from, to]) {
    field.addEventListener('change', again)
    field.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') again()
    })
  }

  function filter(): trades.TradeFilter {
    return {
      connection_id: account.value || undefined,
      symbol: symbol.value.trim().toUpperCase() || undefined,
      start_at: dayStart(from.value),
      end_at: dayEnd(to.value),
      cursor,
    }
  }

  async function loadAccounts(): Promise<void> {
    list.replaceChildren(h('div.faint', { text: '正在加载' }))
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
      connections = items
      clear(account)
      for (const one of connections) {
        const option = document.createElement('option')
        option.value = one.id
        option.textContent = one.name
        account.appendChild(option)
      }
      if (!connections.length) {
        filters.hidden = true
        list.replaceChildren(
          empty({
            title: '还没接交易所账户',
            action: h('a.btn.sm', { href: '#/find?by=fills&tab=accounts', text: '接一个账户' }),
          }),
        )
        return
      }
      await load()
    } catch (error) {
      if (Latest.aborted(error) || !alive || signal.aborted) return
      failed(loadAccounts)
    }
  }

  async function load(): Promise<void> {
    if (!connections.length) return
    if (from.value && to.value && from.value > to.value) {
      list.replaceChildren(empty({ title: '结束日期要在开始日期之后' }))
      return
    }
    if (!cursor) list.replaceChildren(h('div.faint', { text: '正在加载' }))
    const signal = lane.begin()
    const pageCursor = cursor
    try {
      if (options.mode === 'fills') {
        const page = await trades.fills(filter(), { signal })
        if (!alive || signal.aborted) return
        fills = pageCursor ? [...fills, ...page.items] : page.items
        cursor = page.next_cursor ?? undefined
      } else {
        const page = await trades.cycles(filter(), { signal })
        if (!alive || signal.aborted) return
        cycles = pageCursor ? [...cycles, ...page.items] : page.items
        cursor = page.next_cursor ?? undefined
      }
      paint()
    } catch (error) {
      if (Latest.aborted(error) || !alive || signal.aborted) return
      failed()
    }
  }

  function failed(retry: () => Promise<void> = load): void {
    clear(foot)
    list.replaceChildren(
      empty({
        title: '这一段读不出来',
        action: h('button.btn.sm', { text: '再试一次', on: { click: () => void retry() } }),
      }),
    )
  }

  function nameOf(id: Uuid): string | null {
    return connections.find((one) => one.id === id)?.name ?? null
  }

  function paint(): void {
    const rows = options.mode === 'fills' ? fills.length : cycles.length
    if (!rows) {
      clear(foot)
      list.replaceChildren(empty({ title: '没有符合的记录' }))
      return
    }
    const table = h('div.rtable')
    if (options.mode === 'fills') {
      table.appendChild(
        h(
          'div.frow.fpick.fhead',
          {},
          h('span'),
          h('span', { text: '时间' }),
          h('span', { text: '品种' }),
          h('span', { text: '方向' }),
          h('span', { text: '价格' }),
          h('span', { text: '数量' }),
          h('span', { text: '手续费' }),
        ),
      )
      for (const row of fills) table.appendChild(fillRow(row))
    } else {
      for (const row of cycles) table.appendChild(cycleCard(row))
    }
    list.replaceChildren(table)
    clear(foot)
    if (cursor) {
      foot.appendChild(
        h('button.btn.ghost.sm', {
          text: '再读 20 条',
          on: {
            click: (e: Event) => {
              ;(e.currentTarget as HTMLButtonElement).disabled = true
              void load()
            },
          },
        }),
      )
    }
  }

  function fillRow(row: FillRow): HTMLElement {
    const f = row.fill
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement
    box.checked = picked.has(row.id)
    box.disabled = !enabled()
    box.addEventListener('change', () => {
      if (box.checked) picked.add(row.id)
      else picked.delete(row.id)
      options.onChange?.([...picked])
    })
    return h(
      'label.frow.fpick',
      {},
      h('span', {}, box),
      h('span.c-time', { text: dateTime(f.traded_at) }),
      h('span', { text: f.symbol }),
      h('span', { text: sideLabel(f.side) }),
      h('span', {}, figure(f.price)),
      h('span', {}, figure(f.quantity)),
      h('span', {}, money(f.commission, f.commission_asset)),
    )
  }

  function cycleCard(row: CycleRow): HTMLElement {
    const c = row.cycle
    const already = options.isPicked?.(row.id) ?? false
    const take = h('button.btn.sm', {
      text: already ? '已选中' : '选中',
      on: {
        click: () => {
          if (!enabled() || (options.isPicked?.(row.id) ?? false)) return
          options.onPick?.(row, nameOf(row.connection_id))
          refresh()
        },
      },
    }) as HTMLButtonElement
    take.disabled = already || !enabled()
    return h(
      'div.lrow',
      {},
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
        ),
        h('div.faint', {
          style: 'margin-top:4px',
          text: `${c.opened_at ? dateTime(c.opened_at) : '不知道'} – ${
            c.closed_at ? dateTime(c.closed_at) : '不知道'
          }`,
        }),
        h(
          'div.kv',
          { style: 'margin-top:8px' },
          h('div.kvrow', {}, h('span.k', { text: '价格' }), h('span.v', {}, figure(c.entry_price))),
          h(
            'div.kvrow',
            {},
            h('span.k', { text: '手续费' }),
            h('span.v', {}, commissionList(c.commissions)),
          ),
        ),
      ),
      h('div.side', {}, take),
    )
  }

  function refresh(): void {
    if (connections.length) paint()
  }

  void loadAccounts()

  return {
    node,
    connectionId: () => (account.value || null) as Uuid | null,
    picked: () => [...picked],
    refresh,
    dispose: () => {
      alive = false
      lane.cancel()
    },
  }
}

/** `<input type=date>` 给的是本地的一天，换成 UTC 的起止时刻再送出去。 */
function dayStart(value: string): string | undefined {
  if (!value) return undefined
  const at = new Date(`${value}T00:00`)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

function dayEnd(value: string): string | undefined {
  if (!value) return undefined
  const at = new Date(`${value}T00:00`)
  if (Number.isNaN(at.getTime())) return undefined
  at.setDate(at.getDate() + 1)
  return at.toISOString()
}

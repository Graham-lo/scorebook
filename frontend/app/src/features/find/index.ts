// 记录 —— 三个子页：全部 / 按品种 / 成交。子页写在地址的 `?by=` 上。
//
// 「全部」是一张表：时间 品种 周期 方向 把握 触发 结果 标签。品种和周期按后端
// 的 CallFilter 真的筛一遍全库；方向、触发、结果、时间这四样后端没有对应的筛选
// 字段，就在读回来的这几页上筛——筛掉什么、还剩多少，页脚照实写。

import * as calls from '../../api/calls'
import { Latest } from '../../api/http'
import type { CallListItem, Market, OutcomeState, Stance } from '../../api/types'
import { STANCES, PATHS } from '../../data/criteria'
import { INTERVALS, MARKET_LABELS } from '../../data/session'
import { head } from '../../data/outcome'
import { Gate, cachedDetail, detail, knownTags, tagIndex } from '../../data/store'
import { shortDate } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { popChip, type PopItem } from '../../ui/pop'
import { recordHead, recordRow } from '../../ui/record-row'
import { empty, ledgerSkeleton } from '../../ui/states'
import { problem } from '../../ui/toast'
import { openCapture } from '../capture'
import { anyFilter, clearFilters, find, serverFilterKey, applyInstrumentQuery } from './state'
import { fillsPage } from './fills'

const PAGE = 20
const lane = new Latest()
const gate = new Gate(3)

let rows: CallListItem[] = []
let cursor: string | null = null
let loaded = false
let loadedKey = ''

/** 记下新的一条之后叫一声，列表下次重读。 */
export function invalidateLedger(): void {
  loaded = false
  rows = []
  cursor = null
}

export function findPage(host: HTMLElement, arg: string, query: URLSearchParams): () => void {
  const by = query.get('by')
  if (by === 'fills') return fillsPage(host, query)
  applyInstrumentQuery(query)
  syncInstrumentQuery()
  if (arg.startsWith('tag/')) {
    try { find.tag = decodeURIComponent(arg.slice(4)) } catch { find.tag = arg.slice(4) }
    loaded = false
  }
  return by === 'symbol' ? bySymbol(host) : allRecords(host)
}

/** Keep symbol links shareable and refreshable without remounting the current page. */
function syncInstrumentQuery(): void {
  const [path, search = ''] = window.location.hash.split('?')
  const query = new URLSearchParams(search)
  if (find.instrument) query.set('instrument', find.instrument)
  else query.delete('instrument')
  if (find.market) query.set('market', find.market)
  else query.delete('market')
  const suffix = query.toString()
  window.history.replaceState(window.history.state, '', `${path}${suffix ? `?${suffix}` : ''}`)
}

/* ================================ 全部 ================================ */

function allRecords(host: HTMLElement): () => void {
  let alive = true
  const isAlive = () => alive
  let resolving = false
  let outcomePass = 0
  let failedOutcomes = 0

  const filters = h('div.filters')
  const wrap = h('div#ledgerWrap')
  const counts = h('div.counts')
  host.append(
    h('div.spread', {},
      h('div.lead', {}, ornament(), filters, counts),
      h('div.bulk', {}, wrap),
    ),
  )

  paintFilters()
  if (loaded && loadedKey === serverFilterKey()) {
    paint()
    if (find.result) void resolveOutcomes()
  } else {
    wrap.replaceChildren(ledgerSkeleton())
    void reload()
  }

  function paintFilters(): void {
    clear(filters)
    filters.append(
      popChip({
        label: () => find.instrument ?? '品种',
        active: () => Boolean(find.instrument),
        search: '品种',
        items: async (q) => {
          const list = await import('../../data/session').then((m) =>
            m.findInstruments(q, { market: find.market ?? undefined }),
          )
          const items: PopItem[] = [{ label: '品种', value: '', on: !find.instrument }]
          for (const item of list) {
            items.push({ label: item.symbol, value: `${item.market}:${item.symbol}`, hint: MARKET_LABELS[item.market], on: find.instrument === item.symbol && find.market === item.market })
          }
          return items
        },
        onPick: (value) => set(() => {
          const [market, symbol] = value.split(':')
          find.instrument = symbol || null
          find.market = symbol ? market as Market : null
        }),
        onClear: () => set(() => { find.instrument = null }),
      }).node,
      popChip({
        label: () => find.market ? MARKET_LABELS[find.market] : '市场',
        active: () => Boolean(find.market),
        items: () => [
          { label: '全部市场', value: '', on: !find.market },
          ...(['usd_m', 'coin_m'] as const).map(value => ({ label: MARKET_LABELS[value], value, on: find.market === value })),
        ],
        onPick: value => set(() => { find.market = (value || null) as Market | null; find.instrument = null }),
        onClear: () => set(() => { find.market = null }),
      }).node,
      popChip({
        label: () => (find.stance ? STANCES[find.stance] : '方向'),
        active: () => Boolean(find.stance),
        items: () => [
          { label: '方向', value: '', on: !find.stance },
          { label: STANCES.L, value: 'L', on: find.stance === 'L' },
          { label: STANCES.S, value: 'S', on: find.stance === 'S' },
          { label: STANCES['?'], value: '?', on: find.stance === '?' },
        ],
        onPick: (value) => set(() => { find.stance = (value || null) as Stance | null }, false),
        onClear: () => set(() => { find.stance = null }, false),
      }).node,
      popChip({
        label: () => (find.result ? RESULT_WORDS[find.result] ?? '结果' : '结果'),
        active: () => Boolean(find.result),
        items: () => [
          { label: '结果', value: '', on: !find.result },
          { label: '对', value: 'realized', on: find.result === 'realized' },
          { label: '错', value: 'unrealized', on: find.result === 'unrealized' },
          { label: '不算', value: 'not_triggered', on: find.result === 'not_triggered' },
          { label: '还没判', value: 'pending', on: find.result === 'pending' },
          { label: '没写', value: 'no_criteria', on: find.result === 'no_criteria' },
        ],
        onPick: (value) => set(() => { find.result = (value || null) as OutcomeState | null }, false),
        onClear: () => set(() => { find.result = null }, false),
      }).node,
      popChip({
        label: () => (find.path ? PATHS[find.path] ?? '触发' : '触发'),
        active: () => Boolean(find.path),
        items: () => [
          { label: '触发', value: '', on: !find.path },
          { label: PATHS.chart_first as string, value: 'chart_first', on: find.path === 'chart_first' },
          { label: PATHS.thought_first as string, value: 'thought_first', on: find.path === 'thought_first' },
        ],
        onPick: (value) => set(() => { find.path = value || null }, false),
        onClear: () => set(() => { find.path = null }, false),
      }).node,
      popChip({
        label: () => (find.days ? DAY_WORDS[find.days] ?? '时间' : '时间'),
        active: () => Boolean(find.days),
        items: () => [
          { label: '时间', value: '', on: !find.days },
          { label: DAY_WORDS[7] as string, value: '7', on: find.days === 7 },
          { label: DAY_WORDS[30] as string, value: '30', on: find.days === 30 },
          { label: DAY_WORDS[90] as string, value: '90', on: find.days === 90 },
        ],
        onPick: (value) => set(() => { find.days = value ? Number(value) : null }, false),
        onClear: () => set(() => { find.days = null }, false),
      }).node,
      popChip({
        label: () => (find.timeframe ?? '周期'),
        active: () => Boolean(find.timeframe),
        items: () => [
          { label: '周期', value: '', on: !find.timeframe },
          ...INTERVALS.map((i) => ({ label: i, value: i, on: find.timeframe === i })),
        ],
        onPick: (value) => set(() => { find.timeframe = value || null }),
        onClear: () => set(() => { find.timeframe = null }),
      }).node,
      popChip({
        label: () => (find.tag ? `#${find.tag}` : '标签'),
        active: () => Boolean(find.tag),
        items: async () => {
          await tagIndex()
          return [
            { label: '标签', value: '', on: !find.tag },
            ...knownTags().map((t) => ({ label: `#${t.name}`, value: t.name, on: find.tag === t.name })),
          ]
        },
        onPick: (value) => set(() => { find.tag = value || null }),
        onClear: () => set(() => { find.tag = null }),
      }).node,
    )
    if (anyFilter()) {
      filters.appendChild(
        h('button.btn.ghost.sm', {
          text: '清除筛选',
          on: { click: () => set(() => clearFilters()) },
        }),
      )
    }
  }

  /** `server` 为真时要重新问一次后端，否则只是把已经读到的几页再筛一遍。 */
  function set(change: () => void, server = true): void {
    change()
    syncInstrumentQuery()
    paintFilters()
    if (server) void reload()
    else {
      outcomePass += 1
      resolving = false
      failedOutcomes = 0
      if (find.result) void resolveOutcomes()
      else paint()
    }
  }

  async function reload(): Promise<void> {
    loaded = false
    outcomePass += 1
    resolving = false
    failedOutcomes = 0
    cursor = null
    rows = []
    wrap.replaceChildren(ledgerSkeleton())
    await fetchMore(true)
  }

  async function fetchMore(reset: boolean): Promise<void> {
    const signal = lane.begin()
    const key = serverFilterKey()
    try {
      const page = await calls.list(
        {
          instrument: find.instrument ?? undefined,
          market: find.market ?? undefined,
          timeframe: find.timeframe ?? undefined,
          tag: find.tag ?? undefined,
          cursor: reset ? undefined : cursor ?? undefined,
          limit: PAGE,
        },
        { signal },
      )
      if (!alive || signal.aborted || key !== serverFilterKey()) return
      const seen = new Set(rows.map((r) => r.id))
      for (const item of page.items) if (!seen.has(item.id)) rows.push(item)
      cursor = page.next_cursor
      loaded = true
      loadedKey = key
      paint()
      if (find.result) void resolveOutcomes()
    } catch (error) {
      if (Latest.aborted(error) || !alive || signal.aborted) return
      wrap.replaceChildren(
        empty({
          title: '没读出来，请重试',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void fetchMore(reset) } }),
        }),
      )
      problem(message(error), () => void fetchMore(reset))
    }
  }

  /** 「结果」这一筛要知道每条的判决，读回来之后再画一次。 */
  async function resolveOutcomes(): Promise<void> {
    const pass = ++outcomePass
    const missing = rows.filter((r) => !cachedDetail(r.id))
    resolving = missing.length > 0
    failedOutcomes = 0
    paint()
    const results = await Promise.allSettled(missing.map((r) => gate.run(() => detail(r.id))))
    if (!alive || pass !== outcomePass) return
    resolving = false
    failedOutcomes = results.filter(result => result.status === 'rejected').length
    paint()
  }

  function paint(): void {
    const shown = rows.filter(keep)
    const table = h('div.rtable', {}, shown.length ? recordHead() : null)
    if (!shown.length) {
      const title = resolving ? '正在读取判断结果' : failedOutcomes ? '部分结果没读出来' :
        cursor ? '已读记录里还没有符合的' : anyFilter() ? '没有符合的记录' : '还没有记录'
      table.appendChild(empty({
        title,
        action: !anyFilter() && !cursor ? h('button.btn.sm.primary', { text: '记一笔', on: { click: () => openCapture() } }) :
          h('button.btn.sm', { text: '清除筛选', on: { click: () => set(() => clearFilters()) } }),
      }))
    }
    const made: HTMLElement[] = []
    for (const item of shown) {
      const row = recordRow(item, {
        density: 'full',
        alive: isAlive,
        onTag: (name) => set(() => { find.tag = name }),
      })
      made.push(row)
      table.appendChild(row)
    }
    if (find.stance || find.path || find.days || find.result) {
      table.appendChild(h('div.ledger-foot', { attrs: { role: 'status' }, text:
        `已读 ${rows.length} 条 · 符合 ${shown.length} 条${cursor ? ' · 后面还有记录' : ''}${resolving ? ' · 正在读取结果' : ''}`,
      }))
    }
    if (failedOutcomes && find.result) {
      table.appendChild(h('div.ledger-foot', {}, `${failedOutcomes} 条结果没读出来`,
        h('button.btn.sm.ghost', { text: '重试', on: { click: () => void resolveOutcomes() } }),
      ))
    }
    if (cursor) {
      table.appendChild(
        h(
          'div.ledger-foot',
          {},
          h('button.btn.sm.ghost', {
            text: shown.length ? '再读 20 条' : '继续查找',
            on: {
              click: (e: Event) => {
                const button = e.currentTarget as HTMLButtonElement
                button.disabled = true
                void fetchMore(false)
              },
            },
          }),
        ),
      )
    }
    wrap.replaceChildren(table)
    paintCounts(shown)
    stagger(made)
  }

  /** 左柱那几个数：只写已经读到手的事实。 */
  function paintCounts(shown: CallListItem[]): void {
    const cells: HTMLElement[] = [count(String(shown.length), '条记录')]
    const full = shown.map((item) => cachedDetail(item.id))
    if (shown.length && full.every(Boolean)) {
      let judged = 0
      let waiting = 0
      for (const one of full) {
        if (!one) continue
        const now = head(one)
        const state = now ? now.result.state : 'pending'
        if (state === 'realized' || state === 'unrealized' || state === 'not_triggered') judged += 1
        else if (state === 'pending') waiting += 1
      }
      cells.push(count(String(judged), '已判'), count(String(waiting), '等答案'))
    }
    counts.replaceChildren(...cells)
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

function count(value: string, word: string): HTMLElement {
  return h('div', {}, h('b', { text: value }), h('span', { text: word }))
}

/** 左柱顶上那一小笔金线。只是装饰，窄屏和关掉动效时样式里不画。 */
function ornament(): HTMLElement {
  const box = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  box.setAttribute('class', 'ornament')
  box.setAttribute('viewBox', '0 0 180 44')
  box.setAttribute('aria-hidden', 'true')
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  line.setAttribute('d', 'M2 34 C 34 30 52 14 78 18 S 120 36 148 10 L 178 6')
  box.appendChild(line)
  return box as unknown as HTMLElement
}

const RESULT_WORDS: Record<string, string> = {
  realized: '对',
  unrealized: '错',
  not_triggered: '不算',
  pending: '还没判',
  no_criteria: '没写',
}

const DAY_WORDS: Record<number, string> = { 7: '最近 7 天', 30: '最近 30 天', 90: '最近 90 天' }

/** 后端筛不到的那几样，在已经读回来的几页上筛。 */
function keep(item: CallListItem): boolean {
  if (find.stance && item.body.stance !== find.stance) return false
  if (find.path && item.body.path !== find.path) return false
  if (find.days) {
    const since = Date.now() - find.days * 86_400_000
    if (new Date(item.submitted_at).getTime() < since) return false
  }
  if (find.result) {
    const full = cachedDetail(item.id)
    if (!full) return false
    const now = head(full)
    const state = now ? now.result.state : item.body.criteria.length ? 'pending' : 'no_criteria'
    if (state !== find.result) return false
  }
  return true
}

/* =============================== 按品种 =============================== */

interface Group {
  symbol: string
  items: CallListItem[]
}

function bySymbol(host: HTMLElement): () => void {
  let alive = true
  const isAlive = () => alive
  const scope = h('div.filters')
  const wrap = h('div')
  const all: CallListItem[] = []
  let next: string | undefined
  host.append(scope, wrap)
  paintScope()
  wrap.appendChild(ledgerSkeleton())

  void load()

  function paintScope(): void {
    clear(scope)
    if (!find.instrument && !find.market) return
    scope.append(
      h('span.chip.on', { text: [find.instrument, find.market ? MARKET_LABELS[find.market] : null].filter(Boolean).join(' · ') }),
      h('button.btn.sm.ghost', { text: '全部品种', on: { click: () => {
        find.instrument = null
        find.market = null
        syncInstrumentQuery()
        all.length = 0
        next = undefined
        paintScope()
        wrap.replaceChildren(ledgerSkeleton())
        void load()
      } } }),
    )
  }

  async function load(): Promise<void> {
    const signal = lane.begin()
    try {
      const result = await calls.list({
        instrument: find.instrument ?? undefined, market: find.market ?? undefined,
        cursor: next, limit: 100,
      }, { signal })
      if (!alive || signal.aborted) return
      const seen = new Set(all.map(item => item.id))
      all.push(...result.items.filter(item => !seen.has(item.id)))
      next = result.next_cursor ?? undefined
      paint(all)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      wrap.replaceChildren(
        empty({
          title: '没读出来，请重试',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void load() } }),
        }),
      )
    }
  }

  function paint(all: CallListItem[]): void {
    const byName = new Map<string, CallListItem[]>()
    for (const item of all) {
      const key = `${item.body.instrument ?? '未标品种'}${item.body.market ? ` · ${MARKET_LABELS[item.body.market]}` : ''}`
      const list = byName.get(key)
      if (list) list.push(item)
      else byName.set(key, [item])
    }
    const groups: Group[] = [...byName.entries()]
      .map(([symbol, items]) => ({ symbol, items }))
      .sort((a, b) => (b.items[0]?.submitted_at ?? '').localeCompare(a.items[0]?.submitted_at ?? ''))

    if (!groups.length) {
      wrap.replaceChildren(
        h(
          'div.rtable',
          {},
          empty({
            title: '还没有记录',
            action: h('button.btn.sm.primary', { text: '记一笔', on: { click: () => openCapture() } }),
          }),
        ),
      )
      return
    }

    const out = h('div.groups')
    const made: HTMLElement[] = []
    for (const group of groups) {
      const items = group.items.slice().sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
      const last = items[0]
      const first = items[items.length - 1]
      const headLine = h('div.ghead')
      const retry = h('button.btn.sm.ghost', { text: '重试结果', hidden: true, on: { click: () => paint(all) } })
      const counts = { right: 0, wrong: 0, read: 0, failed: 0 }
      const write = () => {
        headLine.textContent =
          `${group.symbol} · ${shortDate(first?.submitted_at)}–${shortDate(last?.submitted_at)}` +
          ` · ${items.length} 条记录 · 对 ${counts.right} 错 ${counts.wrong}` +
          (counts.read < items.length ? ' · 结果读取中' : counts.failed ? ` · ${counts.failed} 条结果未读出` : '')
        retry.hidden = counts.read < items.length || !counts.failed
      }
      write()
      const table = h('div.rtable', {}, headLine, retry)
      for (const item of items) {
        table.appendChild(recordRow(item, { density: 'full', alive: isAlive }))
        void gate
          .run(() => detail(item.id))
          .then((full) => {
            if (!alive) return
            counts.read += 1
            const state = full.voided ? null : head(full)?.result.state
            if (state === 'realized') counts.right += 1
            else if (state === 'unrealized') counts.wrong += 1
            write()
          })
          .catch(() => {
            if (!alive) return
            counts.read += 1
            counts.failed += 1
            write()
          })
      }
      made.push(table)
      out.appendChild(table)
    }
    out.appendChild(h('div.ledger-foot', {},
      h('span.faint', { text: `已读 ${all.length} 条${next ? ' · 后面还有记录' : ''}` }),
      next ? h('button.btn.sm.ghost', { text: '继续读取', on: { click: (event: Event) => {
        (event.currentTarget as HTMLButtonElement).disabled = true
        void load()
      } } }) : null,
    ))
    wrap.replaceChildren(out)
    stagger(made)
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '没读出来，请重试'
}

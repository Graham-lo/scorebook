// 我的记录 —— the ledger.
//
// Every filter here is one the backend's CallFilter actually implements
// (`q`, `instrument`, `market`, `timeframe`, `tag`), so what the page shows is
// a real server-side selection over the whole library rather than a filter
// applied to whatever happened to be loaded. Paging follows the cursor the
// server hands back, and rows are de-duplicated by id so a repeated cursor can
// never make the list skip or double a record.

import * as calls from '../../api/calls'
import { Latest } from '../../api/http'
import type { CallListItem, Market } from '../../api/types'
import { INTERVALS, MARKET_LABELS, contractLabel, underlyingLabel } from '../../data/session'
import { knownTags, tagIndex } from '../../data/store'
import { go } from '../../router'
import { clear, debounce, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { stagger } from '../../ui/motion'
import { popChip, type PopItem } from '../../ui/pop'
import { empty, ledgerSkeleton } from '../../ui/states'
import { problem } from '../../ui/toast'
import { ledgerRow } from './row'
import { anyFilter, clearFilters, find } from './state'
import { forgetSummary, weekstrip } from './summary'

const PAGE = 20
const lane = new Latest()

let rows: CallListItem[] = []
let cursor: string | null = null
let loaded = false

/** Called after a new record is written so the ledger shows it. */
export function invalidateLedger(): void {
  loaded = false
  rows = []
  cursor = null
  forgetSummary()
}

export function findPage(host: HTMLElement, arg: string): () => void {
  let alive = true
  const isAlive = () => alive

  if (arg.startsWith('tag/')) {
    find.tag = decodeURIComponent(arg.slice(4))
    loaded = false
  }

  const search = h('input#q', {
    type: 'search',
    placeholder: '搜你当时说过的话，比如「缩量」「63k」',
    value: find.q,
    attrs: { autocomplete: 'off', 'aria-label': '搜索原话' },
  }) as HTMLInputElement

  const bar = h(
    'div',
    { class: ['searchbar', find.q ? 'has' : ''] },
    icon('search'),
    search,
    h('button.iconbtn.clr', {
      title: '清除',
      on: {
        click: () => {
          search.value = ''
          find.q = ''
          bar.classList.remove('has')
          void reload()
          search.focus()
        },
      },
    }, icon('close')),
    h('span.kbd', { text: '/' }),
  )

  const filters = h('div.filters')
  const wrap = h('div#ledgerWrap')
  const strip = weekstrip(isAlive)

  host.append(
    h(
      'div.phead',
      {},
      h(
        'div',
        {},
        h('h1.h1', {}, '我的记录', h('span.lat', { text: 'Records' })),
        h('div.sub', {
          text: '每一行都是市场揭晓之前的一次判断：当时的画面、当时说出口的话、后来市场给的答案。原话不会被改，想不起来就搜其中一句。',
        }),
      ),
      h('button.btn.sm.ghost', {
        type: 'button',
        text: '按意思找',
        style: 'margin-left:auto',
        title: '记不清原话的时候，用大概的意思在所有记下来的东西里找：复盘、结论、做法、实盘小结都算在内。',
        on: { click: () => go('recall') },
      }),
    ),
    strip,
    bar,
    filters,
    wrap,
  )

  // 中文输入法组字期间不检索：只在 compositionend 之后才发请求。
  let composing = false
  const run = debounce(() => {
    if (composing) return
    find.q = search.value
    bar.classList.toggle('has', Boolean(find.q))
    void reload()
  }, 280)
  search.addEventListener('compositionstart', () => {
    composing = true
  })
  search.addEventListener('compositionend', () => {
    composing = false
    run()
  })
  search.addEventListener('input', run)
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = ''
      find.q = ''
      void reload()
    }
  })

  paintFilters()
  if (loaded && rows.length) paint()
  else {
    wrap.replaceChildren(ledgerSkeleton())
    void reload()
  }

  function paintFilters(): void {
    clear(filters)

    const instrument = popChip({
      label: () => find.instrument ?? '品种',
      active: () => Boolean(find.instrument),
      search: '搜合约，比如 BTC',
      items: async (q) => {
        const list = await import('../../data/session').then((m) => m.findInstruments(q, { market: find.market ?? undefined }))
        const items: PopItem[] = [
          { label: '全部品种', value: '', on: !find.instrument },
          { sep: true, label: '', value: '' },
        ]
        for (const item of list) {
          items.push({
            label: item.symbol,
            value: item.symbol,
            hint: describeContract(item.body),
            on: find.instrument === item.symbol,
          })
        }
        return items
      },
      onPick: (value) => {
        find.instrument = value || null
        paintFilters()
        void reload()
      },
      onClear: () => {
        find.instrument = null
        paintFilters()
        void reload()
      },
      footer: () => '品种身份来自交易所合约目录，不按代码名称推断。',
    })

    const market = popChip({
      label: () => (find.market ? MARKET_LABELS[find.market] : '合约类型'),
      active: () => Boolean(find.market),
      items: () => [
        { label: '全部', value: '', on: !find.market },
        { label: MARKET_LABELS.usd_m, value: 'usd_m', on: find.market === 'usd_m' },
        { label: MARKET_LABELS.coin_m, value: 'coin_m', on: find.market === 'coin_m' },
      ],
      onPick: (value) => {
        find.market = (value || null) as Market | null
        paintFilters()
        void reload()
      },
      onClear: () => {
        find.market = null
        paintFilters()
        void reload()
      },
    })

    const timeframe = popChip({
      label: () => find.timeframe ?? '周期',
      active: () => Boolean(find.timeframe),
      items: () => [
        { label: '全部周期', value: '', on: !find.timeframe },
        { sep: true, label: '', value: '' },
        ...INTERVALS.map((i) => ({ label: i, value: i, on: find.timeframe === i })),
      ],
      onPick: (value) => {
        find.timeframe = value || null
        paintFilters()
        void reload()
      },
      onClear: () => {
        find.timeframe = null
        paintFilters()
        void reload()
      },
    })

    const tag = popChip({
      label: () => (find.tag ? `#${find.tag}` : '标签'),
      active: () => Boolean(find.tag),
      items: async () => {
        await tagIndex()
        const list = knownTags()
        return [
          { label: '全部标签', value: '', on: !find.tag },
          { sep: true, label: '', value: '' },
          ...list.map((t) => ({
            label: `#${t.name}`,
            value: t.name,
            hint: t.definition || null,
            on: find.tag === t.name,
          })),
        ]
      },
      onPick: (value) => {
        find.tag = value || null
        paintFilters()
        void reload()
      },
      onClear: () => {
        find.tag = null
        paintFilters()
        void reload()
      },
    })

    filters.append(instrument.node, market.node, timeframe.node, tag.node)
    if (anyFilter()) {
      filters.appendChild(
        h('button.btn.ghost.sm', {
          text: '清除',
          on: {
            click: () => {
              clearFilters()
              paintFilters()
              void reload()
            },
          },
        }),
      )
    }
    filters.appendChild(
      h(
        'span.meta',
        {},
        h('span.faint', { text: '按判断发生的时间倒序 · 不排名、不加权' }),
      ),
    )
  }

  async function reload(): Promise<void> {
    cursor = null
    rows = []
    wrap.replaceChildren(ledgerSkeleton())
    await fetchMore(true)
  }

  async function fetchMore(reset: boolean): Promise<void> {
    const signal = lane.begin()
    try {
      const page = await calls.list(
        {
          q: find.q.trim() || undefined,
          instrument: find.instrument ?? undefined,
          market: find.market ?? undefined,
          timeframe: find.timeframe ?? undefined,
          tag: find.tag ?? undefined,
          cursor: reset ? undefined : cursor ?? undefined,
          limit: PAGE,
        },
        { signal },
      )
      if (!alive) return
      const seen = new Set(rows.map((r) => r.id))
      for (const item of page.items) if (!seen.has(item.id)) rows.push(item)
      cursor = page.next_cursor
      loaded = true
      paint()
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      wrap.replaceChildren(
        empty({
          title: '这一页没读出来',
          tip: message(error),
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void fetchMore(reset) } }),
        }),
      )
      problem(message(error), () => void fetchMore(reset))
    }
  }

  function paint(): void {
    const ledger = h('div.ledger')
    if (!rows.length) {
      const filtered = Boolean(find.q.trim()) || anyFilter()
      wrap.replaceChildren(
        h(
          'div.ledger',
          {},
          empty({
            title: filtered ? '没有符合的判断' : '还没有第一条判断',
            tip: filtered ? '换个词，或者放宽筛选。搜的是你当时的原话，不是事后写的结论。' : '按 ⌃⇧S 记下第一条判断。',
            action: filtered
              ? h('button.btn.sm', {
                  text: '清除全部筛选',
                  on: {
                    click: () => {
                      clearFilters()
                      find.q = ''
                      search.value = ''
                      paintFilters()
                      void reload()
                    },
                  },
                })
              : null,
          }),
        ),
      )
      return
    }

    ledger.appendChild(
      h(
        'div.lh',
        {},
        h('span', { text: '日期' }),
        h('span', { text: '现场' }),
        h('span', { text: '当时的判断' }),
        h('span', { style: 'text-align:right', text: '市场的答案' }),
      ),
    )
    const ctx = {
      query: find.q.trim(),
      alive: isAlive,
      onTag: (name: string) => {
        find.tag = name
        paintFilters()
        void reload()
      },
    }
    const made: HTMLElement[] = []
    for (const item of rows) {
      const row = ledgerRow(item, ctx)
      made.push(row)
      ledger.appendChild(row)
    }

    const foot = h(
      'div.ledger-foot',
      {},
      h('span', { text: `已读取 ${rows.length} 条${cursor ? '，还有更早的' : '，到底了'}` }),
      cursor
        ? h('button.btn.sm.ghost', {
            text: '再读 20 条',
            on: {
              click: (e: Event) => {
                const button = e.currentTarget as HTMLButtonElement
                button.disabled = true
                button.textContent = '读取中…'
                void fetchMore(false)
              },
            },
          })
        : h('span.faint', { text: '按记录时间排列' }),
    )
    ledger.appendChild(foot)
    wrap.replaceChildren(ledger)
    stagger(made)
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

function describeContract(body: Record<string, unknown>): string {
  // 交易所的枚举翻成人话再显示，翻译在 data/session.ts。
  return [contractLabel(body.contractType), underlyingLabel(body.underlyingType, body.underlyingSubType)]
    .filter(Boolean)
    .join(' · ')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : '读取失败，请稍后重试。'
}

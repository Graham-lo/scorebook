// 一条记录在列表里的样子。全站只有这一份实现，三种密度：
//
//   full    记录页的表格行（时间 品种 周期 方向 把握 触发 结果 标签）
//   compact 今天「最近」、局面详情、找页命中：品种 方向 结果 时间
//   task    今天「等答案 / 该复盘」和复盘页三个筐：左边事实，右边一个动作
//
// GET /v1/calls 只回记录本身，不回结果也不回标签名（标签存的是 id）。这两样
// 通过一道窄闸按需补，所以列表先画出来，再自己填上。

import type { CallListItem, Outcome, Uuid } from '../api/types'
import { PATHS, primary, sentence } from '../data/criteria'
import { head, pendingState, whyLine } from '../data/outcome'
import { Gate, cachedDetail, detail } from '../data/store'
import { MARKET_SHORT } from '../data/session'
import { dateTime } from '../data/time'
import { stamp, stampPlaceholder, stanceBadge, tagChip } from './bits'
import { clear, h, highlight } from '../ui/dom'
import { go } from '../router'

const gate = new Gate(3)

export type Density = 'full' | 'compact' | 'task'

export interface RowOptions {
  density: Density
  /** 高亮用的检索词。 */
  query?: string
  /** 页面拆掉之后翻成 false，迟到的补充就不再往 DOM 上写。 */
  alive?: () => boolean
  onTag?: (name: string) => void
  /** task 密度右边那一格；返回 null 就不放。 */
  action?: (item: CallListItem) => Node | null
  /** 已经读到的结果，省掉一次详情请求。 */
  outcome?: Outcome | null
  /** task 密度下额外的一行事实，比如「还差 3 小时」。 */
  note?: string | null
}

/** 记录表的列头，只有 full 密度用得上。 */
export function recordHead(): HTMLElement {
  return h(
    'div.rrow.rhead',
    {},
    h('span.c-time', { text: '时间' }),
    h('span.c-sym', { text: '品种' }),
    h('span.c-tf', { text: '周期' }),
    h('span.c-stance', { text: '方向' }),
    h('span.c-conf', { text: '把握' }),
    h('span.c-path', { text: '触发' }),
    h('span.c-res', { text: '结果' }),
    h('span.c-tags', { text: '标签' }),
    h('span.c-act'),
  )
}

export function recordRow(item: CallListItem, opts: RowOptions): HTMLElement {
  const row =
    opts.density === 'full'
      ? full(item, opts)
      : opts.density === 'compact'
        ? compact(item, opts)
        : task(item, opts)
  if (item.voided) row.classList.add('muted')
  row.tabIndex = 0
  row.setAttribute('role', 'link')
  row.title = displayId(item)
  row.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a,button')) return
    go(`call/${item.id}`)
  })
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === row) {
      e.preventDefault()
      go(`call/${item.id}`)
    }
  })
  return row
}

/* ---------------- full ---------------- */

function full(item: CallListItem, opts: RowOptions): HTMLElement {
  const body = item.body
  const res = h('span.c-res')
  const tags = h('span.c-tags')
  const row = h(
    'div.rrow',
    {},
    h('span.c-time', { text: dateTime(item.submitted_at) }),
    h(
      'span.c-sym',
      {},
      h('b', {}, highlight(body.instrument ?? '', opts.query ?? '')),
      body.market ? h('i', { text: MARKET_SHORT[body.market] ?? '' }) : null,
    ),
    h('span.c-tf', { text: body.timeframe ?? '' }),
    h('span.c-stance', {}, stanceBadge(body.stance, true)),
    h('span.c-conf', { text: body.confidence === null || body.confidence === undefined ? '' : `${body.confidence}%` }),
    h('span.c-path', { text: PATHS[body.path] ?? '' }),
    res,
    tags,
    h(
      'span.c-act',
      {},
      h('a.ra', { href: `#/relive/${item.id}`, text: '重温' }),
      h('a.ra', { href: `#/review/${item.id}`, text: '复盘' }),
    ),
  )
  paintResult(res, item, opts.outcome ?? null, true)
  const load = () => enrich(item, opts, (outcome, names, failed) => {
    if (failed) paintReadError(res, load)
    else paintResult(res, item, outcome)
    paintTags(tags, names, opts)
  })
  load()
  return row
}

/* ---------------- compact ---------------- */

function compact(item: CallListItem, opts: RowOptions): HTMLElement {
  const body = item.body
  const res = h('span.c-res')
  const row = h(
    'div.crow',
    {},
    h('span.c-sym', {}, highlight(body.instrument ?? '', opts.query ?? '')),
    stanceBadge(body.stance, true),
    res,
    h('span.c-time', { text: dateTime(item.submitted_at) }),
  )
  paintResult(res, item, opts.outcome ?? null, true)
  const load = () => enrich(item, opts, (outcome, _names, failed) => {
    if (failed) paintReadError(res, load)
    else paintResult(res, item, outcome)
  })
  load()
  return row
}

/* ---------------- task ---------------- */

function task(item: CallListItem, opts: RowOptions): HTMLElement {
  const body = item.body
  const facts = [
    body.instrument ?? '',
    body.stance && body.stance !== 'unknown' ? stanceWord(body.stance) : '',
    body.confidence === null || body.confidence === undefined ? '' : `把握 ${body.confidence}%`,
    dateTime(item.submitted_at),
  ].filter(Boolean)
  const slot = h('div.tk-act')
  const row = h(
    'div.tkrow',
    {},
    h(
      'div.tk-body',
      {},
      h('div.tk-top', { text: facts.join(' · ') }),
      body.original_text?.trim() ? h('div.tk-quote', {
        text: body.original_text,
        title: body.original_text,
        style: 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:normal;margin:4px 0',
      }) : null,
      h('div.tk-crit', { text: opts.note ?? sentence(primary(body.criteria)) }),
    ),
    slot,
  )
  const node = opts.action?.(item)
  if (node) slot.appendChild(node)
  return row
}

function stanceWord(stance: string): string {
  return { L: '看多', S: '看空', '?': '观望', C: '有条件' }[stance] ?? ''
}

/* ---------------- 补充 ---------------- */

function enrich(
  item: CallListItem,
  opts: RowOptions,
  paint: (outcome: Outcome | null, names: string[], failed?: boolean) => void,
): void {
  const alive = opts.alive ?? (() => true)
  if (!alive()) return
  const cached = cachedDetail(item.id)
  if (cached) {
    paint(head(cached), cached.tags.map((t) => t.name))
    return
  }
  if (opts.outcome !== undefined) {
    paint(opts.outcome, [])
    return
  }
  void gate.run(async () => {
    if (!alive()) return
    try {
      const full_ = await detail(item.id)
      if (!alive()) return
      paint(head(full_), full_.tags.map((t) => t.name))
    } catch {
      if (alive()) paint(null, [], true)
    }
  })
}

function paintReadError(node: HTMLElement, retry: () => void): void {
  clear(node)
  node.appendChild(h('button.linkbtn', {
    text: '结果没读出来 · 重试',
    on: { click: (event) => {
      const button = event.currentTarget as HTMLButtonElement
      button.disabled = true
      button.textContent = '正在加载'
      retry()
    } },
  }))
}

function paintResult(
  node: HTMLElement,
  item: CallListItem,
  outcome: Outcome | null,
  loading = false,
): void {
  clear(node)
  const hasCriteria = (item.body.criteria?.length ?? 0) > 0
  if (loading && !outcome) {
    node.appendChild(stampPlaceholder())
    return
  }
  if (item.voided) {
    node.appendChild(h('span.stamp.flat', { text: '不算' }))
    return
  }
  node.appendChild(stamp(outcome ? outcome.result.state : pendingState(hasCriteria)))
  const why = whyLine(outcome ? outcome.result : null)
  if (why) node.appendChild(h('i.why', { text: why }))
}

function paintTags(node: HTMLElement, names: string[], opts: RowOptions): void {
  clear(node)
  for (const name of names) {
    const chip = tagChip(name, opts.query ?? '')
    if (opts.onTag) {
      chip.classList.add('link')
      chip.setAttribute('role', 'button')
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        opts.onTag?.(name)
      })
    }
    node.appendChild(chip)
  }
}

/** 后端也是这样拼编号的：C-YYYYMMDD-<uuid 前 8 位>。 */
export function displayId(item: { id: Uuid; submitted_at: string }): string {
  const d = new Date(item.submitted_at)
  if (Number.isNaN(d.getTime())) return item.id.slice(0, 8)
  const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
  return `C-${day}-${item.id.replace(/-/g, '').slice(0, 8)}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

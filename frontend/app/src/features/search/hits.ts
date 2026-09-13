// 一条结果长什么样：小 K 线图 · 品种 · 周期 · 起止日期 · 像到什么程度。
//
// 两种来源两种读法。币安历史给的是一段行情，那张图是后端现画的，只在内存里活到
// 这次查看结束，不落盘。自己的记录给的是当时那条判断，主角是当时图，点进去就是
// 那条记录。
//
// 排的是形状上的接近程度。它只说像不像，不说后面会怎么走。

import { chartSvg } from '../../api/market'
import { isHistoryCandidate, type HistoryCandidate, type PrivateCandidate, type SearchCandidate } from '../../api/chart'
import type { CallDetail, Uuid } from '../../api/types'
import { Gate, cachedDetail, detail } from '../../data/store'
import { shortDate } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { type ChartView } from '../../ui/media'
import { stile } from '../../ui/stile'
import { stagger } from '../../ui/motion'
import { go } from '../../router'
import { levelWord } from './score'
import { openMarketChart } from '../relive/market-view'
import { sourceButton } from './sources'

const gate = new Gate(3)

export interface HitCtx {
  alive(): boolean
  queryAttachmentId(): string | null
  /** 要一张登记过的行情图；离开这一页时统一取消。 */
  chart(): ChartView
}

/** 一条结果的身份：自己的记录认那条记录，历史匹配认「品种 + 周期 + 起点」。 */
export function hitKey(item: SearchCandidate): string {
  return isHistoryCandidate(item)
    ? `h:${item.symbol}|${item.interval}|${item.start_at}`
    : `p:${item.call_id}|${item.attachment_id}`
}

function relatedOf(items: SearchCandidate[]): NonNullable<HistoryCandidate['chart_request']>[] {
  return items.filter(isHistoryCandidate).flatMap(item => item.chart_request ? [item.chart_request] : [])
}

function buildHit(
  ctx: HitCtx,
  item: SearchCandidate,
  index: number,
  related: NonNullable<HistoryCandidate['chart_request']>[],
): HTMLElement {
  const node = isHistoryCandidate(item) ? historyHit(ctx, item, index, related) : privateHit(ctx, item, index)
  node.setAttribute('data-key', hitKey(item))
  return node
}

export function hitList(ctx: HitCtx, items: SearchCandidate[], key?: string): HTMLElement {
  const list = h('div.fhits')
  if (key) list.setAttribute('data-key', key)
  const related = relatedOf(items)
  items.forEach((item, index) => { list.appendChild(buildHit(ctx, item, index, related)) })
  stagger(list.children)
  return list
}

/**
 * 轮询回来的一批：同一条结果留着原来那个节点，只改变了的那几个字。
 *
 * 小 K 线是这里最怕重来的一样东西——它要发一次网络请求才画得出来。卡片节点在
 * 就不重建，图一根线都不重画；新冒出来的那几条自己进场一次，不跟着整组抖。
 */
export function syncHits(ctx: HitCtx, list: HTMLElement, items: SearchCandidate[]): void {
  const related = relatedOf(items)
  const live = new Map<string, HTMLElement>()
  for (const node of Array.from(list.children)) {
    const key = node.getAttribute('data-key')
    if (key) live.set(key, node as HTMLElement)
  }
  const seen = new Set<string>()
  let cursor: Element | null = list.firstElementChild
  items.forEach((item, index) => {
    const key = hitKey(item)
    seen.add(key)
    const had = live.get(key)
    let node: HTMLElement
    if (had) { patchHit(had, item); node = had }
    else {
      node = buildHit(ctx, item, index, related)
      // 单独进场一次：整组的错峰只属于新查询那一趟。
      node.style.setProperty('--i', '0')
    }
    if (node === cursor) cursor = cursor.nextElementSibling
    else list.insertBefore(node, cursor)
  })
  for (const [key, node] of live) if (!seen.has(key)) node.remove()
}

/** 同一条结果两次之间会变的就那几样：像不像、历史那条的起止。 */
function patchHit(node: HTMLElement, item: SearchCandidate): void {
  const word = levelWord(item.match)
  const tag = node.querySelector('.fband')
  if (word) {
    if (tag) { if (tag.textContent !== word) tag.textContent = word }
    else node.appendChild(h('span.fband', { text: word }))
  } else tag?.remove()
  if (!isHistoryCandidate(item)) return
  const line = node.querySelector('.fb > .fm')
  const text = `${item.interval} · ${shortDate(item.start_at)} – ${shortDate(item.end_at)}`
  if (line && line.textContent !== text) line.textContent = text
}

/* ------------------------------------------------ 币安历史里的一段 */

function historyHit(ctx: HitCtx, item: HistoryCandidate, index: number, related: NonNullable<HistoryCandidate['chart_request']>[]): HTMLElement {
  const view = ctx.chart()
  const request = item.chart_request
  if (request) void view.show((signal) => chartSvg(request, { signal }))
  return h(
    'div.fhit.fhit-history',
    { style: `--i:${index}` },
    h('div.fshot', {}, view.node),
    h(
      'div.fb',
      {},
      request ? h('button.fh.fhit-open', {
        type: 'button', text: item.symbol,
        attrs: { 'aria-haspopup': 'dialog', 'aria-label': `${item.symbol} · 查看 K 线` },
        on: { click: () => openMarketChart(request, '匹配这段', { related }) },
      }) : h('div.fh', { text: item.symbol }),
      h('div.fm', { text: `${item.interval} · ${shortDate(item.start_at)} – ${shortDate(item.end_at)}` }),
      request ? h('span.fhit-action', { text: '放大对比 K 线 ↗' }) : null,
    ),
    band(item),
  )
}

/* -------------------------------------------------- 我的记录里的一条 */

function privateHit(ctx: HitCtx, item: PrivateCandidate, index: number): HTMLElement {
  const shot = stile({ id: item.attachment_id as Uuid, compact: true, label: '当时图', alt: '当时图' })
  const head = h('div.fh')
  const mine = h('div.fm')
  const row = h(
    'div.fhit.link',
    { style: `--i:${index}`, attrs: { role: 'link', tabindex: '0' } },
    shot,
    h('div.fb', {}, head, mine, item.text_match ? h('div', {}, h('p', { text: item.text_match.excerpt }), sourceButton(item.text_match)) : null),
    band(item),
  )
  row.addEventListener('click', e => { if (!(e.target instanceof Element && e.target.closest('button, a'))) go(`call/${item.call_id}`) })
  row.addEventListener('keydown', (e) => {
    if (e.target === row && (e as KeyboardEvent).key === 'Enter') go(`call/${item.call_id}`)
  })
  paintRecord(head, mine, item, null)
  const cached = cachedDetail(item.call_id)
  if (cached) paintRecord(head, mine, item, cached)
  else {
    void gate.run(async () => {
      if (!ctx.alive()) return
      try {
        const full = await detail(item.call_id)
        if (ctx.alive()) paintRecord(head, mine, item, full)
      } catch { /* 读不到就只写这一条自己带的那几样 */ }
    })
  }
  return row
}

function paintRecord(head: HTMLElement, mine: HTMLElement, item: PrivateCandidate, full: CallDetail | null): void {
  clear(head)
  clear(mine)
  const facts = [full?.instrument ?? '', item.interval ?? full?.timeframe ?? ''].filter(Boolean)
  head.textContent = facts.join(' · ')
  mine.textContent = full ? `我的记录 · ${shortDate(full.submitted_at)}` : '我的记录'
}

/* ------------------------------------------------------------ 像不像 */

function band(item: SearchCandidate): HTMLElement | null {
  const word = levelWord(item.match)
  return word ? h('span.fband', { text: word }) : null
}

/** 后端还没精排完的那一批，这里一条都不显示——候选不是结论。 */
export function ranked(items: SearchCandidate[]): SearchCandidate[] {
  return items.filter((item) => levelWord(item.match) !== null)
}

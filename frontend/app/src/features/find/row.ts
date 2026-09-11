// One ledger row: when it was written, what was on screen, what was said, and
// how it turned out.
//
// GET /v1/calls returns the record itself but no outcome and no tag names —
// tags are stored on the row as ids. Those two pieces are read per record
// through a narrow gate, so the ledger paints immediately and fills in.

import type { CallDetail, CallListItem, Outcome, Uuid } from '../../api/types'
import { percent } from '../../data/decimal'
import { primary } from '../../data/criteria'
import { head, pendingState, reasonText, stateLook } from '../../data/outcome'
import { Gate, cachedDetail, detail } from '../../data/store'
import { flowOf, fromCallDetail } from '../../data/flow'
import { flowMini } from '../../ui/flow'
import { dateTime, DASH } from '../../data/time'
import { MARKET_LABELS } from '../../data/session'
import { critHL, dateColumn, stamp, stampPlaceholder, stanceBadge, tagChip, thumb } from '../../ui/bits'
import { clear, h, highlight } from '../../ui/dom'
import { consumeFresh } from './state'
import { go } from '../../router'

const gate = new Gate(3)

export interface RowContext {
  query: string
  /** Flipped when the page is torn down so late enrichment stops writing. */
  alive: () => boolean
  onTag?: (name: string) => void
}

export function ledgerRow(item: CallListItem, ctx: RowContext): HTMLElement {
  const body = item.body
  const sceneId: Uuid | null = body.attachments?.[0] ?? null
  const side = h('div.side')
  const tags = h('div.tags')
  const track = h('div.track')

  const row = h(
    'div.lrow',
    {
      tabIndex: 0,
      role: 'link',
      // 编号对扫读没有帮助，平时不占位置；真要引用某一条时鼠标停一下就能看到。
      title: displayId(item),
      on: {
        click: () => go(`call/${item.id}`),
        keydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') go(`call/${item.id}`)
        },
      },
    },
    dateColumn(item.submitted_at),
    thumb(sceneId, `${body.instrument ?? '未标品种'} 现场图`),
    h(
      'div.body',
      {},
      h(
        'div.top',
        {},
        stanceBadge(body.stance),
        h('span.sym', {}, highlight(body.instrument ?? '品种待确认', ctx.query)),
        h('span.mkt', { text: body.market ? MARKET_LABELS[body.market] : '' }),
        // 没写标准的记录，右边那枚戳已经说了；这里不再重复一遍。
        (body.criteria?.length ?? 0) > 0 ? critHL(primary(body.criteria)) : null,
      ),
      h('div.q', {}, highlight(body.original_text, ctx.query)),
      tags,
      track,
    ),
    side,
  )

  paintSide(side, item, null, true)
  if (item.voided) row.classList.add('muted')

  const cached = cachedDetail(item.id)
  if (cached) {
    paintSide(side, item, head(cached), false)
    paintTags(tags, cached.tags.map((t) => t.name), ctx)
    paintTrack(track, side, cached)
  } else {
    void gate.run(async () => {
      if (!ctx.alive()) return
      try {
        const full = await detail(item.id)
        if (!ctx.alive()) return
        paintSide(side, item, head(full), false)
        paintTags(tags, full.tags.map((t) => t.name), ctx)
        paintTrack(track, side, full)
      } catch {
        if (ctx.alive()) paintSide(side, item, null, false)
      }
    })
  }

  // A record saved a moment ago is marked once, on the first ledger that shows
  // it, so the trader can see where it landed.
  if (consumeFresh(item.id)) row.classList.add('flash')

  return row
}

/**
 * 这一条走到哪儿了，以及还欠着的那一件事。进度用统一的五段小图，判断全部来自
 * data/flow.ts，行里不自己解释状态。
 *
 * 这里不去问有没有草稿——那要为每一行再发一次请求。所以只有确实要动笔的几种
 * 下一步才在行上给入口；「去看看行情」这种点开整行就是了，不再重复一个按钮。
 */
const WRITING = new Set(['write', 'recheck', 'distill'])

function paintTrack(node: HTMLElement, side: HTMLElement, full: CallDetail): void {
  const flow = flowOf(fromCallDetail(full, undefined))
  clear(node)
  node.appendChild(flowMini(flow))
  const next = flow.next
  if (next.href && WRITING.has(next.kind)) {
    side.appendChild(
      h('a.nx', {
        href: next.href,
        text: next.label,
        // 行本身是个链接，点按钮时不要连着把整行的跳转也触发一次。
        on: { click: (e: MouseEvent) => e.stopPropagation() },
      }),
    )
  }
}

function paintTags(node: HTMLElement, names: string[], ctx: RowContext): void {
  clear(node)
  for (const name of names) {
    const chip = tagChip(name, ctx.query)
    if (ctx.onTag) {
      chip.classList.add('link')
      chip.setAttribute('role', 'button')
      chip.addEventListener('click', (e) => {
        e.stopPropagation()
        ctx.onTag?.(name)
      })
    }
    node.appendChild(chip)
  }
}

function paintSide(
  node: HTMLElement,
  item: CallListItem,
  outcome: Outcome | null,
  loading: boolean,
): void {
  clear(node)
  const hasCriteria = (item.body.criteria?.length ?? 0) > 0
  if (loading) {
    node.appendChild(stampPlaceholder())
  } else if (item.voided) {
    node.appendChild(h('span.stamp.flat', { text: '已作废' }))
  } else {
    node.appendChild(stamp(outcome ? outcome.result.state : pendingState(hasCriteria)))
  }
  // 没写标准的那一句，每行都一样，说一遍就够——戳上已经写着「没写标准」。
  const line = loading ? '' : shortResult(outcome, hasCriteria)
  if (line) node.appendChild(h('div.res', { text: line }))
}

/** A single line, short enough for the ledger's right column. */
function shortResult(outcome: Outcome | null, hasCriteria: boolean): string {
  if (!outcome) return hasCriteria ? '等市场给答案' : ''
  const r = outcome.result
  // 「没写标准」在戳上写着了，行里不再复述一遍同样的话。
  if (r.state === 'no_criteria') return ''
  const look = stateLook(r.state)
  if (r.state === 'realized' || r.state === 'unrealized') {
    const move = percent(r.signed_return)
    return move ? `到期 ${move}` : look.label
  }
  if (r.state === 'pending' && r.end_at) return `${dateTime(r.end_at)} 出结果`
  const reason = reasonText(r.reason)
  return reason || DASH
}

/** The backend builds display ids the same way: C-YYYYMMDD-<first 8 of uuid>. */
export function displayId(item: { id: Uuid; submitted_at: string }): string {
  const d = new Date(item.submitted_at)
  if (Number.isNaN(d.getTime())) return item.id.slice(0, 8)
  const stampText = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
  return `C-${stampText}-${item.id.replace(/-/g, '').slice(0, 8)}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

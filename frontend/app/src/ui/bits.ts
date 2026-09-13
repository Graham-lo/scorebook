// Small pieces of the ledger vocabulary, shared by every page that shows a
// record: the stance badge, the result stamp, the criteria highlight and the
// scene thumbnail. They exist once so a record looks the same everywhere.

import type { Attachment, Criteria, OutcomeState, Stance, Uuid } from '../api/types'
import { STANCES, summary } from '../data/criteria'
import { stateLook } from '../data/outcome'
import { columnParts } from '../data/time'
import { h, highlight } from './dom'
import { icon } from './icons'
import { attachmentImage } from './media'

/** 方向就写成字：看多 / 看空 / 观望。L 和 S 是后端的写法，不给人看。 */
export function stanceBadge(stance: Stance | null | undefined, soft = false): HTMLElement {
  if (!stance || stance === 'unknown') {
    return h('span.stance.soft', { text: STANCES.unknown })
  }
  return h('span', {
    class: ['stance', stance === 'L' ? 'L' : '', stance === 'S' ? 'S' : '', soft ? 'soft' : ''],
    text: STANCES[stance] ?? stance,
  })
}

export function stamp(state: OutcomeState, large = false): HTMLElement {
  const look = stateLook(state)
  return h('span', { class: ['stamp', look.stamp, large ? 'lg' : ''], text: look.label })
}

/** Shown while the record's outcome is still being read from the server. */
export function stampPlaceholder(): HTMLElement {
  return h('span.stamp.flat', { text: '正在加载' })
}

export function critHL(criteria: Criteria | null): HTMLElement {
  const s = summary(criteria)
  if (s.soft) return h('span.hl.soft', { text: s.main })
  return h('span.hl', {}, document.createTextNode(s.main), s.sub ? h('span.sub', { text: s.sub }) : null)
}

export function dateColumn(iso: string): HTMLElement {
  const parts = columnParts(iso)
  return h(
    'div.date',
    {},
    h('span.d', { text: parts.day }),
    h('span.m', { text: parts.month }),
    h('span.t', { text: parts.time }),
  )
}

/**
 * The first scene shot of a record. Attachment bytes sit behind Bearer auth,
 * so they are fetched and shown as an object URL, never as a bare src.
 */
export function thumb(id: Uuid | null, alt: string, extra = ''): HTMLElement {
  if (!id) {
    // 没图就是一格空位，不写字——列表里一行没有图是常事，不需要解释。
    return h('div', { class: ['thumb', 'none', extra] })
  }
  // 92×64 的一格，按显示尺寸解一张小的就够；完整的那张在记录详情里看。
  return attachmentImage(id, { alt, className: `thumb ${extra}`.trim(), maxWidth: 200 })
}

export function tagChip(name: string, query = ''): HTMLElement {
  const node = h('span.tag')
  node.appendChild(document.createTextNode('#'))
  node.appendChild(highlight(name, query))
  return node
}

export function sectionHead(title: string, right?: Node | string | null): HTMLElement {
  return h(
    'div.sh',
    {},
    h('span.eyebrow.noline', { text: title }),
    typeof right === 'string' ? h('span.faint', { text: right }) : right ?? null,
  )
}

export function section(...children: (Node | string | null)[]): HTMLElement {
  return h('div.sec', {}, ...children)
}

export function button(
  label: string,
  onClick: () => void,
  options: { kind?: 'primary' | 'ghost' | 'danger' | ''; small?: boolean; iconName?: string; disabled?: boolean } = {},
): HTMLButtonElement {
  const node = h(
    'button',
    {
      class: ['btn', options.kind ?? '', options.small ? 'sm' : ''],
      disabled: options.disabled,
      on: { click: onClick },
    },
    options.iconName ? icon(options.iconName) : null,
    label,
  ) as HTMLButtonElement
  return node
}

/**
 * 一张图的身份，就是截图卡角上那个词。
 *
 * 「当时 / 之后 / 参考」说的是这张图拍的是哪个时间点——这是看图的人唯一需要
 * 知道的事，不再配一段解释。
 */
export const ATTACHMENT_IDENTITY: Record<string, string> = {
  scene: '当时',
  supplement: '之后',
  reference: '参考',
  query: '这张图',
}

export function identityLabel(attachment: Attachment): string {
  return ATTACHMENT_IDENTITY[attachment.kind] ?? '图'
}

// The shapes a screen takes when it has nothing, is waiting, or has something
// to say. Every one of them keeps the layout it will have when full, so a
// page never jumps as data arrives.

import { append, h, type Child } from './dom'
import { icon } from './icons'

export function empty(options: {
  art?: string
  title: string
  tip?: string
  action?: HTMLElement | null
}): HTMLElement {
  return h(
    'div.empty',
    {},
    options.art ? h('div.art', {}, icon(options.art)) : null,
    h('div.h3', { text: options.title }),
    options.tip ? h('div.tip', { text: options.tip }) : null,
    options.action ? h('div', { style: 'margin-top:14px' }, options.action) : null,
  )
}

/** Placeholder rows shaped like the ledger, so the page does not reflow. */
export function ledgerSkeleton(rows = 5): HTMLElement {
  const list = h('div.ledger.loading')
  for (let i = 0; i < rows; i += 1) {
    list.appendChild(
      h(
        'div.lrow.skeleton',
        {},
        h('div.date', {}, h('span.sk', { style: 'width:22px;height:22px' })),
        h('div.thumb.sk'),
        h(
          'div.body',
          {},
          h('div.sk.line', { style: 'width:32%' }),
          h('div.sk.line', { style: 'width:76%' }),
        ),
        h('div.side', {}, h('div.sk.line', { style: 'width:54px' })),
      ),
    )
  }
  return list
}

export function note(kind: 'info' | 'warn', ...children: Child[]): HTMLElement {
  const body = h('div')
  append(body, children)
  return h('div', { class: ['note', kind === 'warn' ? 'warn' : ''] }, icon(kind === 'warn' ? 'info' : 'info'), body)
}

export function actions(...children: Child[]): HTMLElement {
  const row = h('div.acts')
  append(row, children)
  return row
}

/** A labelled bar, used for queue progress and index preparation. */
export function progressLine(label: string, ratio: number): HTMLElement {
  const width = Math.max(0, Math.min(1, ratio)) * 100
  return h(
    'div.progress-line',
    {},
    h('span', { text: label }),
    h('span.bar', {}, h('i', { style: `width:${width}%` })),
  )
}

export function spinner(label: string): HTMLElement {
  return h('div.sync', {}, h('i'), h('span', { text: label }))
}

/** Used wherever the backend has the data but the feature is not open yet. */
export function unavailable(title: string, why: string): HTMLElement {
  return h(
    'div.sheet.pad',
    {},
    empty({ art: 'info', title, tip: why }),
  )
}

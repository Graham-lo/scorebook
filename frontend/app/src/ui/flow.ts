// 把 data/flow.ts 算出来的状态画出来。这里只有画法，没有判断。

import { STAGES, type Flow } from '../data/flow'
import { h } from './dom'
import { icon } from './icons'

/** 详情页顶上那条路：五段，走过的是青蓝实线。段名见术语表。 */
export function flowBar(flow: Flow): HTMLElement {
  return h(
    'div.flow',
    { style: `--fp:${flow.percent}%` },
    ...STAGES.map((stage) =>
      h(
        'div',
        { class: ['fstep', flow.marks[stage.id]] },
        h('i'),
        h('span.t', { text: stage.title }),
      ),
    ),
  )
}

/** 列表行里的迷你版：五个点，不占地方。 */
export function flowMini(flow: Flow): HTMLElement {
  return h(
    'div.flow.mini',
    {},
    ...STAGES.map((stage) =>
      h(
        'div',
        { class: ['fstep', flow.marks[stage.id]], title: stage.title },
        h('i'),
        flow.marks[stage.id] === 'now' ? h('span.t', { text: stage.title }) : null,
      ),
    ),
  )
}

/**
 * 当前最该做的那一件事：一行事实 + 一个动作。展示页不解释为什么。
 */
export function nextUp(flow: Flow, onGo?: (href: string) => void): HTMLElement {
  const next = flow.next
  const act =
    next.label && next.href
      ? h(
          'a.btn.primary.sm',
          {
            href: next.href,
            on: {
              click: (e: MouseEvent) => {
                if (!onGo) return
                e.preventDefault()
                onGo(next.href as string)
              },
            },
          },
          next.label,
          icon('go'),
        )
      : null
  return h(
    'div.nextup',
    { class: next.kind === 'rest' ? 'done' : undefined },
    h('span.ic', {}, icon(next.iconName)),
    h('div.b', {}, h('b', { text: flow.summary })),
    act ? h('div.acts', {}, act) : null,
  )
}

// 把 data/flow.ts 算出来的状态画出来。这里只有画法，没有判断。

import { STAGES, type Flow } from '../data/flow'
import { h } from './dom'
import { icon } from './icons'

/**
 * 详情页顶上的那条路：五个环节，走过的是青蓝实线。
 * 每一格下面那行小字是给填写流程看的（这一步要做什么）；展示页只要环节名，
 * 传 lines:false 就不画那一行。
 */
export function flowBar(flow: Flow, opts: { lines?: boolean } = {}): HTMLElement {
  const lines = opts.lines ?? true
  return h(
    'div.flow',
    { style: `--fp:${flow.percent}%` },
    ...STAGES.map((stage) =>
      h(
        'div',
        { class: ['fstep', flow.marks[stage.id]] },
        h('i'),
        h('span.t', { text: stage.title }),
        lines
          ? h('span.l', {
              text: flow.marks[stage.id] === 'skipped' ? '这条跳过了这一步' : stage.line,
            })
          : null,
      ),
    ),
  )
}

/** 列表行里的迷你版：五个点加一行小字，不占地方。 */
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
 * 当前最该做的那一件事。一条记录同时只给一个主要动作——五个同样大小的表单框
 * 是上一版被否掉的做法。
 *
 * 上面一行说现在是什么情况，下面一行说为什么该做这一步，按钮上才是动作本身。
 * 三处说三件事，不重复同一句话。展示页传 why:false，只留情况和动作。
 */
export function nextUp(
  flow: Flow,
  opts: { why?: boolean } = {},
  onGo?: (href: string) => void,
): HTMLElement {
  const next = flow.next
  const body = h(
    'div.b',
    {},
    h('b', { text: flow.summary }),
    opts.why === false ? null : h('span', { text: next.why }),
  )
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
    body,
    act ? h('div.acts', {}, act) : null,
  )
}

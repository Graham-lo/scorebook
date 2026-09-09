// Chat 的模块边界。
//
// The backend reports `chat_generation: "planned"` and exposes no route that
// answers a question, so there is nothing here to call. This file exists so
// that when such a route lands, one module changes and the rest of the app
// does not: the panel below is the seam.
//
// Deliberately absent: any canned answer, any client-side "assistant" that
// pretends to reason over the records, and any call to an outside model. A
// fake answer about someone's own trading history would be worse than no
// answer at all.

import { capability } from '../../data/session'
import { h } from '../../ui/dom'
import { icon } from '../../ui/icons'

export interface ChatPanel {
  node: HTMLElement
  /** True once the backend actually serves generation. */
  live: boolean
}

export function chatPanel(): ChatPanel {
  const state = capability('chat_generation')
  const live = state === 'available' || state === 'configured'

  if (live) {
    // No route exists yet; when one does, it is wired here and nowhere else.
    return {
      live: false,
      node: panel('问答还没有接上', '后端说这个能力已经就绪，但前端还没有对应的接口实现。'),
    }
  }

  return {
    live: false,
    node: panel(
      '还不能对着记录提问',
      '「帮我看看我在这种行情上一般怎么说」这类问题，等后端把问答接上之后才能回答。现在不给你一个编出来的答案。',
    ),
  }
}

function panel(title: string, why: string): HTMLElement {
  return h(
    'div.sheet.pad.futurebox',
    {},
    h('div.art', {}, icon('q')),
    h('div.h3', { text: title }),
    h('div.tip', { style: 'max-width:48ch', text: why }),
  )
}

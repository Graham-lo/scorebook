// 一层弹出层。定位面板（对上行情）和几处需要把人从页面里拎出来的表单都用它。
//
// Esc 关掉，点背景关掉，关掉之后焦点回到刚才那颗按钮。里面画什么由调用方决定，
// 这里只管这一层本身：标题、关闭、滚动和焦点。

import { h } from './dom'
import { lockScroll, topModal } from './modal'

export interface Sheet {
  node: HTMLElement
  close: () => void
}

export function sheet(title: string, body: Node, onClose?: () => void, options: { onEscape?: () => boolean } = {}): Sheet {
  const previous = document.activeElement as HTMLElement | null
  const unlock = lockScroll()
  let done = false
  const close = () => {
    if (done) return
    done = true
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('hashchange', close)
    box.remove()
    unlock()
    if (previous?.isConnected) previous.focus()
    onClose?.()
  }
  const onKey = (e: KeyboardEvent) => {
    if (!topModal(card)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (!options.onEscape?.()) close()
    } else if (e.key === 'Tab') {
      const items = Array.from(card.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))
        .filter(node => node.getClientRects().length)
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) { e.preventDefault(); card.focus() }
      else if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === card)) {
        e.preventDefault(); first.focus()
      }
    }
  }
  const shut = h('button.sheet-x', { type: 'button', title: '关掉' }, '×')
  shut.addEventListener('click', close)
  const card = h(
    'div.sheet-card',
    { role: 'dialog', attrs: { 'aria-modal': 'true', 'aria-label': title } },
    h('div.sheet-h', {}, h('span.sheet-t', { text: title }), shut),
    h('div.sheet-b', {}, body),
  )
  const box = h('div.sheet-box', {}, card)
  box.addEventListener('click', (e) => {
    if (e.target === box) close()
  })
  document.addEventListener('keydown', onKey, true)
  document.body.appendChild(box)
  window.addEventListener('hashchange', close)
  card.tabIndex = -1
  card.focus()
  return { node: card, close }
}

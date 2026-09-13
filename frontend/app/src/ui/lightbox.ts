import { clear, h } from './dom'
import { lockScroll, topModal } from './modal'

let closeCurrent: (() => void) | null = null

/**
 * Full-bleed view of one already-loaded image. It takes an object URL the
 * caller owns; closing the lightbox never revokes it, because the thumbnail
 * behind it is still using the same bytes.
 */
export function lightbox(src: string, caption: string): void {
  closeCurrent?.()
  const previous = document.activeElement as HTMLElement | null
  const scroll = { x: window.scrollX, y: window.scrollY }
  const unlock = lockScroll()
  const image = h('img', { attrs: { src, alt: caption } })
  const button = h('button.btn.sm', {
    text: '关闭大图',
    attrs: { 'aria-label': '关闭大图' },
    style: 'position:absolute;top:calc(16px + env(safe-area-inset-top));right:calc(16px + env(safe-area-inset-right));min-height:44px;z-index:1',
  })
  const box = h('div.lightbox', {
    role: 'dialog',
    attrs: { 'aria-modal': 'true', 'aria-label': caption || '查看大图' },
  }, button, image, h('div.cap', { text: caption }))
  let closed = false
  const close = (restore = true) => {
    if (closed) return
    closed = true
    box.remove()
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('focusin', onFocus, true)
    window.removeEventListener('hashchange', onNavigate)
    unlock()
    if (restore) {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
      window.scrollTo(scroll.x, scroll.y)
    }
    if (closeCurrent === close) closeCurrent = null
  }
  const onNavigate = () => close(false)
  const onKey = (e: KeyboardEvent) => {
    if (!topModal(box)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopImmediatePropagation()
      button.focus()
    } else {
      // 大图打开时，底下重温页的方向键等快捷键也不应触发。
      e.stopPropagation()
    }
  }
  const onFocus = (e: FocusEvent) => {
    if (topModal(box) && !box.contains(e.target as Node)) button.focus()
  }
  button.addEventListener('click', () => close())
  box.addEventListener('click', (e) => { if (e.target === box || e.target === image) close() })
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('focusin', onFocus, true)
  window.addEventListener('hashchange', onNavigate)
  ;(document.fullscreenElement ?? document.body).appendChild(box)
  closeCurrent = close
  button.focus()
}

export function replaceChildren(node: Element, child: Node): void {
  clear(node)
  node.appendChild(child)
}

import { clear, h } from './dom'

/**
 * Full-bleed view of one already-loaded image. It takes an object URL the
 * caller owns; closing the lightbox never revokes it, because the thumbnail
 * behind it is still using the same bytes.
 */
export function lightbox(src: string, caption: string): void {
  const image = h('img', { attrs: { src, alt: caption } })
  const box = h('div.lightbox', { role: 'dialog' }, image, h('div.cap', { text: caption }))
  const close = () => {
    box.remove()
    document.removeEventListener('keydown', onKey)
    previous?.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  const previous = document.activeElement as HTMLElement | null
  box.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.appendChild(box)
  box.tabIndex = -1
  box.focus()
}

export function replaceChildren(node: Element, child: Node): void {
  clear(node)
  node.appendChild(child)
}

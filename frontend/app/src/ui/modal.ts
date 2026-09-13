let locks = 0
let original = ''

/** Nested sheets/lightboxes share one body scroll lock. */
export function lockScroll(): () => void {
  if (locks++ === 0) { original = document.body.style.overflow; document.body.style.overflow = 'hidden' }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--locks === 0) document.body.style.overflow = original
  }
}

export function topModal(node: HTMLElement): boolean {
  const dialogs = document.querySelectorAll('[aria-modal="true"]')
  return dialogs[dialogs.length - 1] === node
}

// Entrances are staggered with the same rhythm as the stylesheet's own
// keyframes. Everything here is skipped outright when the reader has asked
// for reduced motion.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

export function prefersReducedMotion(): boolean {
  return reduced.matches
}

/**
 * Numbers the items and lets the stylesheet delay each one by `--i`, which is
 * the same rhythm the rest of the sheet is written against. The cap keeps a
 * long page from ending on a row that arrives a second late.
 */
export function stagger(items: Iterable<Element>, max = 16): void {
  const list = Array.from(items)
  list.forEach((item, index) => {
    if (!prefersReducedMotion()) {
      ;(item as HTMLElement).style.setProperty('--i', String(Math.min(index, max)))
    }
    item.classList.add('in')
  })
}

/** The page's own blocks rise in order, top to bottom. */
export function orderPage(host: HTMLElement, max = 14): void {
  if (prefersReducedMotion()) return
  Array.from(host.children).forEach((child, index) => {
    ;(child as HTMLElement).style.setProperty('--i', String(Math.min(index, max)))
  })
}

/** Pressing a card gives way slightly under the finger. */
export function pressFeedback(): void {
  document.addEventListener('pointerdown', (e) => {
    if (prefersReducedMotion()) return
    const target = (e.target as HTMLElement | null)?.closest(
      '.lrow,.qitem,.tagrow,.opt,.big,.weekstrip a,.vcard,.pbrow,.hcard,.hrec,.hnum',
    ) as HTMLElement | null
    if (!target) return
    target.style.transition = 'transform .09s var(--e)'
    target.style.transform = 'scale(.994)'
    const up = () => {
      target.style.transform = ''
      window.setTimeout(() => (target.style.transition = ''), 120)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
}

/** Counts a number up when it first appears. Decimals are preserved. */
export function countUp(node: HTMLElement, to: number, ms = 620): void {
  if (prefersReducedMotion() || to === 0) {
    node.textContent = String(to)
    return
  }
  const began = performance.now()
  const tick = (now: number) => {
    const t = Math.min(1, (now - began) / ms)
    const eased = 1 - (1 - t) ** 3
    node.textContent = String(Math.round(to * eased))
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

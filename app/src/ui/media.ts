// Attachment bytes sit behind Bearer auth, so they can never be a bare
// <img src>. They are fetched once, held as an object URL for as long as the
// page that asked for them is on screen, and revoked when it goes away.

import { download } from '../api/attachments'
import type { Uuid } from '../api/types'
import { h } from './dom'
import { icon } from './icons'
import { Latest } from '../api/http'

interface Held {
  url: string
  promise: Promise<string>
}

const held = new Map<Uuid, Held>()

export function objectUrl(id: Uuid, signal?: AbortSignal): Promise<string> {
  const existing = held.get(id)
  if (existing) return existing.promise
  const entry: Held = {
    url: '',
    promise: download(id, { signal }).then((blob) => {
      const url = URL.createObjectURL(blob)
      entry.url = url
      return url
    }),
  }
  entry.promise.catch(() => held.delete(id))
  held.set(id, entry)
  return entry.promise
}

/** Called by the router on every navigation: nothing outlives its page. */
export function releaseAll(): void {
  for (const entry of held.values()) if (entry.url) URL.revokeObjectURL(entry.url)
  held.clear()
}

export interface ImageOptions {
  alt: string
  className?: string
  /** Keeps the box from collapsing while the bytes are in flight. */
  ratio?: { width: number; height: number }
  onReady?: (url: string, image: HTMLImageElement) => void
}

/**
 * Returns the element immediately and fills it in when the bytes arrive, so a
 * list can lay out before any image has loaded.
 */
export function attachmentImage(id: Uuid, options: ImageOptions): HTMLElement {
  const box = h('div', { class: ['shot-slot', options.className ?? ''] })
  if (options.ratio && options.ratio.width > 0 && options.ratio.height > 0) {
    box.style.aspectRatio = `${options.ratio.width} / ${options.ratio.height}`
  }
  box.appendChild(h('div.shot-wait', {}, icon('img')))
  objectUrl(id)
    .then((url) => {
      const image = h('img', { attrs: { src: url, alt: options.alt, loading: 'lazy' } })
      box.replaceChildren(image)
      options.onReady?.(url, image as HTMLImageElement)
    })
    .catch(() => {
      box.replaceChildren(h('div.shot-wait.failed', { text: '图片读取失败' }))
    })
  return box
}

/**
 * A chart the backend renders on demand. The SVG arrives as markup and is
 * parsed inertly before it is attached (see `parseSvg`), and it is never cached
 * to disk, localStorage or IndexedDB: it lives in this node and nowhere else.
 */
export class ChartView {
  readonly node = h('div.chart-slot')
  readonly #lane = new Latest()

  async show(fetcher: (signal: AbortSignal) => Promise<string>): Promise<void> {
    const signal = this.#lane.begin()
    this.node.replaceChildren(h('div.chart-wait', { text: '正在取这段行情…' }))
    try {
      const svg = await fetcher(signal)
      const root = parseSvg(svg)
      this.node.replaceChildren(root ?? h('div.chart-wait', { text: '这段行情画不出来。' }))
    } catch (error) {
      if (Latest.aborted(error)) return
      this.node.replaceChildren(
        h('div.chart-wait.failed', {
          text: error instanceof Error ? error.message : '行情暂时取不到。',
        }),
      )
    }
  }

  cancel(): void {
    this.#lane.cancel()
  }
}

/**
 * The chart comes from our own backend, but it is still markup arriving over
 * the wire, so it is parsed in an inert document and stripped of anything that
 * could run before it is attached.
 */
function parseSvg(source: string): SVGElement | null {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName === 'parsererror' || root.nodeName.toLowerCase() !== 'svg') return null
  for (const node of Array.from(root.querySelectorAll('script,foreignObject,a'))) node.remove()
  for (const node of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on') || (name === 'href' && !attr.value.startsWith('#'))) {
        node.removeAttribute(attr.name)
      }
    }
  }
  return document.importNode(root, true) as unknown as SVGElement
}

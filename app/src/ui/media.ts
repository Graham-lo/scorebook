// Attachment bytes sit behind Bearer auth, so they can never be a bare
// <img src>. They are fetched once, held as an object URL for as long as the
// page that asked for them is on screen, and revoked when it goes away.
//
// 手机上真正烧电的是图。一张现场图是 1320×2868 的 PNG，压缩后 1MB 左右，解开
// 是 14MB 的位图——而账本里它只占 92×64 的一格。所以列表里的图走两条规矩：
//   · 滚到跟前才去取（离屏的行一个字节都不花）；
//   · 取回来先按显示尺寸解一张小的，全尺寸的字节和大位图当场丢掉，只留下几 KB。
// 需要看清楚的地方（记录详情的大图、灯箱、拿去框选的查询图）照旧走全尺寸，
// 那才是证据本身，不能缩。

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
      // Navigation may finish before a download; never allocate an orphaned URL.
      if (held.get(id) !== entry) throw new DOMException('Page released', 'AbortError')
      const url = URL.createObjectURL(blob)
      entry.url = url
      return url
    }),
  }
  entry.promise.catch(() => { if (held.get(id) === entry) held.delete(id) })
  held.set(id, entry)
  return entry.promise
}

/* ---------------------------------------------------------------- 缩略图 */

/** 一张缩略图只有几 KB，翻回列表时不该再下载一遍，所以它活得比一次导航长。 */
const THUMB_KEEP = 80
const thumbs = new Map<string, Promise<string>>()
const thumbUrls = new Map<string, string>()

function thumbWidth(css: number): number {
  // 屏幕再密也只解到两倍，三倍的位图肉眼看不出差别，电量看得出来。
  return Math.round(css * Math.min(window.devicePixelRatio || 1, 2))
}

async function shrink(blob: Blob, width: number): Promise<Blob> {
  // 只给宽度，浏览器自己按比例缩，而且是在解码阶段就缩——全尺寸的位图从头到尾
  // 没有在内存里出现过。老浏览器不支持这组参数就退回去用 <img>，那条路会完整
  // 解一次码，但至少只解看得见的那几张。
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'medium' })
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) { bitmap.close(); throw new Error('no 2d context') }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const small = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82))
  canvas.width = canvas.height = 0
  if (!small) throw new Error('encode failed')
  return small
}

function thumbUrl(id: Uuid, css: number): Promise<string> {
  const width = thumbWidth(css)
  const key = `${id}@${width}`
  const existing = thumbs.get(key)
  if (existing) return existing
  const promise = download(id)
    .then(async (blob) => {
      let out = blob
      try {
        if (blob.size > 24_000) out = await shrink(blob, width)
      } catch {
        out = blob // 缩不了就用全尺寸那张，宁可慢一点也不能不显示。
      }
      const url = URL.createObjectURL(out)
      thumbUrls.set(key, url)
      // 超出上限就把最早的那几张还回去；这些 URL 只在本页内存里，不落盘。
      while (thumbUrls.size > THUMB_KEEP) {
        const oldest = thumbUrls.keys().next().value as string | undefined
        if (oldest === undefined || oldest === key) break
        URL.revokeObjectURL(thumbUrls.get(oldest) as string)
        thumbUrls.delete(oldest)
        thumbs.delete(oldest)
      }
      return url
    })
  promise.catch(() => { thumbs.delete(key) })
  thumbs.set(key, promise)
  return promise
}

/* ------------------------------------------------------- 滚到跟前才去取 */

const pending = new WeakMap<Element, () => void>()
let watcher: IntersectionObserver | null = null

function whenNear(node: Element, start: () => void): void {
  if (typeof IntersectionObserver !== 'function') { start(); return }
  if (!watcher) {
    watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          watcher?.unobserve(entry.target)
          const run = pending.get(entry.target)
          pending.delete(entry.target)
          run?.()
        }
      },
      // 还差半屏就开始取，滚到的时候图已经在了。
      { rootMargin: '400px 0px' },
    )
  }
  pending.set(node, start)
  watcher.observe(node)
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
  /**
   * 这张图在页面上最宽占多少 CSS 像素。给了就按这个尺寸解一张小的——列表、
   * 缩略图、聊天里带的图都该给。不给就按全尺寸解，详情页的大图和要框选的图属于
   * 这一类。
   */
  maxWidth?: number
  /** 默认滚到跟前才取；确实要立刻出现的（弹窗里那张）传 false。 */
  lazy?: boolean
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
  const load = () => {
    const bytes = options.maxWidth ? thumbUrl(id, options.maxWidth) : objectUrl(id)
    bytes
      .then((url) => {
        const image = h('img', {
          attrs: { src: url, alt: options.alt, loading: 'lazy', decoding: 'async' },
        })
        box.replaceChildren(image)
        options.onReady?.(url, image as HTMLImageElement)
      })
      .catch(() => {
        box.replaceChildren(h('div.shot-wait.failed', { text: '图片读取失败' }))
      })
  }
  if (options.lazy === false) load()
  else whenNear(box, load)
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

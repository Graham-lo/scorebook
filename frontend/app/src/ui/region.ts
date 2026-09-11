// Dragging a box over a picture that is on screen at some arbitrary size, and
// reporting it in the pixels of the file that was uploaded.
//
// The preview is almost never displayed at 1:1, so the scale factor between
// the rendered box and the image's natural size is applied on every reported
// rectangle. The uploaded original is never re-encoded or resized, so these
// coordinates address exactly the bytes the backend holds.

import type { Region } from '../api/types'
import { h } from './dom'

export interface RegionPicker {
  /** The element to place in the layout; it wraps the image. */
  node: HTMLElement
  region(): Region | null
  clear(): void
  destroy(): void
}

export function regionPicker(
  image: HTMLImageElement,
  onChange: (region: Region | null) => void,
  initialRegion: Region | null = null,
): RegionPicker {
  const marquee = h('div.marquee', { hidden: true })
  const hint = h('div.region-hint', { text: '在图上拖一个框，只搜这一块' })
  const node = h('div.region', {}, image, marquee, hint)

  let start: { x: number; y: number } | null = null
  let box: { x: number; y: number; w: number; h: number } | null = null
  let selected = initialRegion

  const local = (e: PointerEvent) => {
    const rect = image.getBoundingClientRect()
    return {
      x: Math.min(Math.max(e.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(e.clientY - rect.top, 0), rect.height),
    }
  }

  const paint = () => {
    if (!start && selected && image.naturalWidth && image.naturalHeight) {
      const rect = image.getBoundingClientRect()
      box = { x: selected.x * rect.width / image.naturalWidth, y: selected.y * rect.height / image.naturalHeight,
        w: selected.width * rect.width / image.naturalWidth, h: selected.height * rect.height / image.naturalHeight }
      hint.hidden = true
    }
    if (!box || box.w < 4 || box.h < 4) {
      marquee.hidden = true
      return
    }
    const rect = image.getBoundingClientRect()
    const host = node.getBoundingClientRect()
    marquee.hidden = false
    marquee.style.left = `${rect.left - host.left + box.x}px`
    marquee.style.top = `${rect.top - host.top + box.y}px`
    marquee.style.width = `${box.w}px`
    marquee.style.height = `${box.h}px`
  }

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return
    image.setPointerCapture(e.pointerId)
    start = local(e)
    box = { ...start, w: 0, h: 0 }
    hint.hidden = true
    paint()
  }
  const move = (e: PointerEvent) => {
    if (!start) return
    const at = local(e)
    box = {
      x: Math.min(start.x, at.x),
      y: Math.min(start.y, at.y),
      w: Math.abs(at.x - start.x),
      h: Math.abs(at.y - start.y),
    }
    paint()
  }
  const up = (e: PointerEvent) => {
    if (!start) return
    image.releasePointerCapture(e.pointerId)
    start = null
    if (!box || box.w < 4 || box.h < 4) {
      box = null
      marquee.hidden = true
      hint.hidden = false
    }
    selected = current()
    onChange(selected)
  }

  function current(): Region | null {
    if (!box) return null
    const rect = image.getBoundingClientRect()
    if (!rect.width || !rect.height || !image.naturalWidth || !image.naturalHeight) return null
    const sx = image.naturalWidth / rect.width
    const sy = image.naturalHeight / rect.height
    const x = Math.round(box.x * sx)
    const y = Math.round(box.y * sy)
    const width = Math.round(box.w * sx)
    const height = Math.round(box.h * sy)
    return {
      x: Math.max(0, Math.min(x, image.naturalWidth - 1)),
      y: Math.max(0, Math.min(y, image.naturalHeight - 1)),
      width: Math.max(1, Math.min(width, image.naturalWidth - x)),
      height: Math.max(1, Math.min(height, image.naturalHeight - y)),
    }
  }

  image.addEventListener('pointerdown', down)
  image.addEventListener('pointermove', move)
  image.addEventListener('pointerup', up)
  image.addEventListener('pointercancel', up)
  image.addEventListener('dragstart', (e) => e.preventDefault())
  window.addEventListener('resize', paint)
  image.addEventListener('load', paint)
  if (image.complete) paint()

  return {
    node,
    region: current,
    clear() {
      selected = null
      box = null
      marquee.hidden = true
      hint.hidden = false
      onChange(null)
    },
    destroy() {
      window.removeEventListener('resize', paint)
      image.removeEventListener('load', paint)
    },
  }
}

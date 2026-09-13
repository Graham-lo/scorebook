import { ImageUploads, type UploadImage } from '../data/image-uploads'
import { h } from './dom'
import { screenshotActions } from '../features/relive/screenshot'
import { objectUrl } from './media'
import { stile } from './stile'
import type { Uuid } from '../api/types'
import { lightbox } from './lightbox'
import { problem } from './toast'

export function imagePicker(model: ImageUploads, label: string, changed: () => void, enabled: () => boolean = () => true) {
  const input = h('input', { type: 'file', hidden: true, attrs: { accept: 'image/png,image/jpeg,image/webp', multiple: 'multiple', 'aria-label': label } }) as HTMLInputElement
  const grid = h('div.upload-images')
  const add = h('button.btn.sm', { text: label, on: { click: () => input.click() } }) as HTMLButtonElement
  const count = h('span.faint')
  const node = h('section.image-picker', {}, h('div.row', { style: 'gap:10px;flex-wrap:wrap' }, add, count), input, grid)
  const pick = (files: File[]) => {
    if (!enabled() || !files.length) return
    try { model.add(files) } catch (error) { problem((error as Error).message) }
  }
  input.addEventListener('change', () => { pick(Array.from(input.files ?? [])); input.value = '' })
  node.addEventListener('dragover', event => event.preventDefault())
  node.addEventListener('drop', event => { event.preventDefault(); pick(Array.from(event.dataTransfer?.files ?? [])) })
  node.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'))
    if (files.length) { event.preventDefault(); pick(files) }
  })
  const cards = new Map<UploadImage, { node: HTMLElement; status: HTMLElement; retry: HTMLButtonElement; remove: HTMLButtonElement; shot: HTMLElement }>()
  function render(): void {
    const active = new Set(model.items)
    for (const [item, card] of cards) {
      if (!active.has(item)) { card.node.remove(); cards.delete(item) }
    }
    count.textContent = model.items.length ? `${model.items.length} 张${model.pending ? ' · 还没传完' : ''}${model.duplicates ? ` · 已合并 ${model.duplicates} 张重复图` : ''}` : ''
    add.disabled = !enabled() || model.items.length >= model.limit
    for (const [i, item] of model.items.entries()) {
      let card = cards.get(item)
      if (!card) {
        const shot = item.preview
          ? h('a.upload-preview', { href: item.preview, attrs: { target: '_blank', rel: 'noopener' } }, h('img', { attrs: { src: item.preview, alt: `截图 ${i + 1}`, decoding: 'async', loading: 'lazy' } }))
          : item.id ? stile({ id: item.id as Uuid, compact: true, alt: `截图 ${i + 1}` }) : h('span')
        const status = h('span')
        const retry = h('button.linkbtn', { text: '重试', on: { click: () => void model.send(item) } }) as HTMLButtonElement
        const remove = h('button.linkbtn', { text: '移除', on: { click: () => model.remove(item) } }) as HTMLButtonElement
        card = { node: h('figure.upload-image', {}, shot, h('figcaption', {}, status, retry, remove)), shot, status, retry, remove }
        // 缩略图统一裁小，点开看原图；真实走势走图下面那行小字。
        shot.addEventListener('click', event => {
          event.preventDefault()
          if (item.preview) { lightbox(item.preview, `截图 ${i + 1}`); return }
          if (item.id) void objectUrl(item.id).then(url => lightbox(url, `截图 ${i + 1}`)).catch(() => problem('原图暂时读不出来'))
        })
        cards.set(item, card)
      }
      // Progress only changes text and controls, preserving decoded images and focus.
      const status = item.error ?? (item.uploading ? `${Math.round(item.progress * 100)}%` : `截图 ${i + 1}`)
      if (card.status.textContent !== status) card.status.textContent = status
      card.retry.hidden = !item.error
      card.retry.disabled = card.remove.disabled = !enabled()
      card.remove.setAttribute('aria-label', `移除截图 ${i + 1}`)
      if (item.id && !card.node.querySelector('.screenshot-actions')) card.node.appendChild(screenshotActions(item.id))
      // 传完了就把本地预览换成截图板：板面是对上的那段真实走势，原图在「看截图」后面。
      if (item.id && !card.node.querySelector('.stile')) {
        const board = stile({ id: item.id as Uuid, compact: true, alt: `截图 ${i + 1}` })
        card.shot.replaceWith(board)
        card.shot = board
      }
      if (item.preview && !item.id) card.shot.setAttribute('aria-label', `查看截图 ${i + 1}`)
      card.shot.querySelector('img')?.setAttribute('alt', `截图 ${i + 1}`)
      if (grid.children[i] !== card.node) grid.insertBefore(card.node, grid.children[i] ?? null)
    }
  }
  model.onChange = () => { render(); changed() }
  render()
  return { node, render, pick, dispose: () => { model.onChange = changed } }
}

export function reviewImages(ids: string[] = [], label = '复盘时的后续走势'): HTMLElement | null {
  if (!ids.length) return null
  return h('div.review-shots', {}, h('div.dlabel', { text: label }),
    h('div.shots', {}, ...ids.map((id) => {
      const card = stile({
        id: id as Uuid,
        label,
        tone: label === '当时' ? '' : 'after',
        acts: screenshotActions(id, undefined, (at) => card.locate(at)),
        alt: label,
      })
      return card
    })))
}

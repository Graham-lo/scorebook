import { getLocate, type AttachmentLocation } from '../../api/replay'
import type { Attachment, CallDetail } from '../../api/types'
import { h } from '../../ui/dom'
import { sheet } from '../../ui/sheet'
import { locatePanel } from './locate'
import { openMarketChart } from './market-view'

export function findSimilar(id: string): void { window.location.hash = `/search/like/${id}` }

export function showLocated(id: string, at: AttachmentLocation, fullscreen = false): void {
  openMarketChart({ symbol: at.symbol, market: at.market, interval: at.interval,
    start_at: at.start_at, end_at: at.end_at, source: at.source === 'monthly_archive' ? 'monthly_archive' : 'rest' },
  '截图对应区间', { attachmentId: id, fullscreen })
}

/** Every screenshot follows one path: saved coordinates → chart; otherwise wait/choose. */
export function openScreenshot(id: string, caption = '截图走势', known?: AttachmentLocation | null,
  context: { call?: CallDetail; attachment?: Attachment; onChange?: (at: AttachmentLocation) => void } = {}): void {
  if (known) { showLocated(id, known); return }
  const holder = h('div')
  const panel = locatePanel({ call: context.call, attachment: context.attachment ?? { id }, pending: true,
    onChange: at => { if (at) { context.onChange?.(at); layer.close(); showLocated(id, at) } },
    onCancel: () => layer.close() })
  holder.append(panel.node, h('button.btn.sm.ghost', { text: '找相似', on: { click: () => findSimilar(id) } }))
  const layer = sheet(caption, holder, () => panel.destroy())
  panel.start()
}

/** Cheap status reads only; no recognition is started by displaying a thumbnail. */
export function screenshotActions(id: string, known?: AttachmentLocation | null, onChange?: (at: AttachmentLocation) => void): HTMLElement {
  let location = known ?? null
  const open = h('button.linkbtn', { text: location ? '看真实走势 ↗' : '读取定位…', on: { click: () => openScreenshot(id, '截图走势', location, { onChange: at => { location = at; open.textContent = '看真实走势 ↗'; onChange?.(at) } }) } })
  const node = h('div.screenshot-actions', {}, open,
    h('button.linkbtn', { text: '找相似', on: { click: () => findSimilar(id) } }))
  if (!location) {
    const read = async () => {
      if (!node.isConnected) return
      try {
        const state = await getLocate(id)
        if (!node.isConnected) return
        if (state.location) { location = state.location; open.textContent = '看真实走势 ↗'; onChange?.(location) }
        else if (state.job && ['queued', 'running', 'retry_wait'].includes(state.job.status)) {
          open.textContent = '正在匹配走势…'; window.setTimeout(() => void read(), 3000)
        } else open.textContent = state.job?.result?.candidates?.length ? '选择对应走势' : '手动校准'
      } catch { if (node.isConnected) open.textContent = '查看截图走势' }
    }
    requestAnimationFrame(() => void read())
  }
  return node
}

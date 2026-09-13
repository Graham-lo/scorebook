// 截图板 —— 页面上所有「这里有一张截图」的地方，都长成同一块小板子。
//
// 板面不放原图：对上行情的放这段真实 K 线，没对上的放一层晨雾。原图永远在
// 「看截图」后面，点开才放大。板子是缩小版：标准 200px 宽，紧凑 150px 宽，
// 宽屏也不放大，放不下就换行。
//
// 一块板子只负责展示和取图，定位、候选、手动校准这些能力仍旧由
// features/relive/screenshot.ts 提供，调用方把那一行操作塞进脚注里。

import { chartSvg } from '../api/market'
import { getLocate } from '../api/replay'
import type { AttachmentLocation, ChartRequest, Uuid } from '../api/types'
import { Gate } from '../data/store'
import { h } from './dom'
import { icon } from './icons'
import { lightbox } from './lightbox'
import { ChartView, objectUrl } from './media'
import { problem } from './toast'

/** 板子上的行情是顺手取的，不跟正文抢带宽。 */
const gate = new Gate(3)

export interface StileOptions {
  /** 这块板子说的是哪一张截图。 */
  id: Uuid
  /** 左上角那枚角标上的字（当时图 / 参考图 / 之后的图 …）。没有就不画角标。 */
  label?: string | null
  /** 角标的颜色档：参考图偏金，之后的图偏蓝。 */
  tone?: 'ref' | 'after' | ''
  /** 紧凑板：150px 宽，脚注只留一行 meta。 */
  compact?: boolean
  /** 已经知道的定位。给了就不再问一次后端。 */
  location?: AttachmentLocation | null
  /** 板子自己问出定位之后告诉调用方，省得两边各问一次。 */
  onLocation?: (at: AttachmentLocation) => void
  /** 右上角的 `···`。不给就不画。 */
  onMenu?: () => void
  /** 脚注里那一行操作（一般是 screenshotActions）。紧凑板不画。 */
  acts?: Node | null
  /** 角标可点时的无障碍名字。 */
  alt?: string
}

export function stile(options: StileOptions): HTMLElement {
  const name = options.label ?? '截图'
  const board = mistBoard()
  const meta = h('div.stile-meta.none', {}, h('i'), h('span', { text: '还没对上行情' }))
  const see = h(
    'button.stile-see',
    {
      type: 'button',
      title: '看截图',
      attrs: { 'aria-label': `看${name}` },
      on: {
        click: (event) => {
          event.preventDefault()
          event.stopPropagation()
          void objectUrl(options.id)
            .then((url) => lightbox(url, name))
            .catch(() => problem('原图暂时读不出来'))
        },
      },
    },
    icon('zoom'),
    h('span', { text: '看截图' }),
  )
  const foot = h('div.stile-foot', {}, meta)
  if (!options.compact && options.acts) foot.appendChild(h('div.stile-acts', {}, options.acts))
  const card = h('article.stile', {}, h('div.stile-top', {}, board, see), foot)
  if (options.compact) card.classList.add('compact')
  if (options.label) {
    card.appendChild(h('span.stile-badge', { class: options.tone ?? '', text: options.label }))
  }
  if (options.onMenu) {
    card.appendChild(
      h('button.stile-menu', {
        type: 'button',
        title: '图片操作',
        attrs: { 'aria-label': `${name}操作` },
        text: '···',
        on: {
          click: (event) => {
            event.preventDefault()
            event.stopPropagation()
            options.onMenu?.()
          },
        },
      }),
    )
  }

  void fill()
  return card

  function say(text: string, located: boolean): void {
    meta.classList.toggle('none', !located)
    meta.replaceChildren(h('i'), h('span', { text }))
  }

  async function fill(): Promise<void> {
    let at = options.location ?? null
    if (!at) {
      try {
        const state = await gate.run(() => getLocate(options.id))
        if (!card.isConnected && !document.contains(card)) return
        at = state.location ?? null
        if (!at) {
          if (state.job && ['queued', 'running', 'retry_wait'].includes(state.job.status)) {
            say('正在匹配走势…', false)
          }
          return
        }
        options.onLocation?.(at)
      } catch {
        return
      }
    }
    say(`${at.symbol} · ${at.interval}`, true)
    const view = new ChartView()
    board.className = 'stile-board'
    board.replaceChildren(view.node, h('i.sweep'))
    await gate.run(() => view.show((signal) => chartSvg(segment(at), { signal })))
    tune(view.node)
  }
}

function mistBoard(): HTMLElement {
  return h('div.stile-board.mist', {}, h('div.glyph', {}, icon('img')))
}

/** 板面画的就是截图对上的那一段，不多画一根后来的 K 线。 */
function segment(at: AttachmentLocation): ChartRequest {
  return {
    symbol: at.symbol,
    market: at.market,
    interval: at.interval,
    start_at: at.start_at,
    end_at: at.end_at,
    source: at.source === 'monthly_archive' ? 'monthly_archive' : 'rest',
  }
}

/**
 * 后端画的是一张 1200×580 的完整图表：有白底、有价格轴、有时间。板面只要中间
 * 那片 K 线，所以把画布裁到绘图区并允许非等比拉伸，其余由样式收拾。
 */
function tune(slot: HTMLElement): void {
  const svg = slot.querySelector('svg')
  if (!svg) return
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.setAttribute('viewBox', '20 46 1088 472')
  svg.setAttribute('preserveAspectRatio', 'none')
}

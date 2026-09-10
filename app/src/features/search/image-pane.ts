// 查询图这一栏：放进来的那张截图、图上拖的那个框，以及换图。
//
// 图上拖的框按上传文件自己的像素坐标发出去，字节不重新编码。框会活到离开这一
// 页为止——重画、去别处转一圈再回来，它都还在原处。

import { uploadWithProgress } from '../../api/attachments'
import { ApiError, NetworkError } from '../../api/errors'
import { h, append, clear } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { objectUrl } from '../../ui/media'
import { dropzone, openFileDialog } from '../../ui/pick'
import { regionPicker, type RegionPicker } from '../../ui/region'
import { note } from '../../ui/states'
import { problem } from '../../ui/toast'
import { controls } from './controls'
import { forgetAnalysis, forgetRun, period, state, syncQuery, uploadAction, type SearchCtx } from './state'

/** 每一次重画认一个号，迟到的读图回包认不出自己那一次就不再往上写。 */
let paintNo = 0
let picker: RegionPicker | null = null
let detachDrop: (() => void) | null = null
let controlsHost: HTMLElement | null = null

export function repaintControls(ctx: SearchCtx): void {
  controlsHost?.replaceChildren(controls(ctx))
}

/** 离开这一页时把框和拖放监听都收掉。 */
export function disposeQueryPane(): void {
  picker?.destroy()
  picker = null
  detachDrop?.()
  detachDrop = null
  controlsHost = null
}

export function paintQuery(ctx: SearchCtx, pane: HTMLElement): void {
  const paint = ++paintNo
  picker?.destroy()
  clear(pane)
  detachDrop?.()
  detachDrop = null
  picker = null

  if (!state.queryId) {
    const zone = h(
      'div.dropbig',
      {},
      h('div.h3', { text: '把截图放进来' }),
      h('div.tip', { text: '拖进来、Ctrl/⌘+V 粘贴，或者点这里选一张 PNG / JPEG / WebP。' }),
    )
    detachDrop = dropzone(zone, {
      onPick: (file) => void takeFile(ctx, pane, file),
      onReject: (why) => problem(why),
    })
    pane.appendChild(zone)
    pane.appendChild(
      note('info', '这张图只作为查询用，不会变成任何一条记录的截图，也不会出现在检索结果里。'),
    )
    controlsHost = h('div', {}, controls(ctx))
    pane.appendChild(controlsHost)
    return
  }

  const slot = h('div.shot-slot', { style: 'min-height:180px' }, h('div.shot-wait', {}, icon('img')))
  pane.appendChild(
    h(
      'div',
      {},
      h(
        'div.sh',
        { style: 'margin-bottom:9px' },
        h('span.eyebrow.noline', { text: '查询图' }),
        h('span.faint', { style: 'margin-left:auto', text: state.queryName }),
      ),
      slot,
    ),
  )

  void objectUrl(state.queryId)
    .then((url) => {
      if (!ctx.alive() || paint !== paintNo) return
      const image = h('img', { attrs: { src: url, alt: '用来搜索的截图' } }) as HTMLImageElement
      const made = regionPicker(
        image,
        (region) => {
          state.region = region
          period.reset()
          // 框变了，上一次认图说的就不是这一块的事了。
          forgetAnalysis()
          syncQuery()
          ctx.repaintResults()
          paintRegionLine()
          repaintControls(ctx)
        },
        state.region,
      )
      picker = made
      slot.replaceWith(made.node)
      paintRegionLine()
    })
    .catch(() => {
      if (ctx.alive() && paint === paintNo) {
        slot.replaceChildren(h('div.shot-wait.failed', { text: '这张图读不出来。' }))
      }
    })

  const regionLine = h('div.row', { style: 'gap:10px;flex-wrap:wrap' })
  pane.appendChild(regionLine)
  function paintRegionLine(): void {
    clear(regionLine)
    if (state.region) {
      const r = state.region
      append(regionLine, [
        h('span.tag', { text: `只比框中的 ${r.width}×${r.height} 像素` }),
        h('button.btn.sm.ghost', { text: '整张图', on: { click: () => picker?.clear() } }),
      ])
    } else {
      regionLine.appendChild(h('span.faint', { text: '在图上拖一个框，可以只比画面里的一块。' }))
    }
  }

  pane.appendChild(
    h(
      'div.row',
      { style: 'gap:10px' },
      h('button.btn.sm.ghost', {
        text: '换一张图',
        on: {
          click: () =>
            openFileDialog({
              onPick: (file) => void takeFile(ctx, pane, file),
              onReject: (why) => problem(why),
            }),
        },
      }),
    ),
  )
  controlsHost = h('div', {}, controls(ctx))
  pane.appendChild(controlsHost)
}

async function takeFile(ctx: SearchCtx, pane: HTMLElement, file: File): Promise<void> {
  const bar = h('div.progress', {}, h('i', { style: 'width:0%' }))
  pane.prepend(bar)
  const fill = bar.firstElementChild as HTMLElement
  const key = uploadAction.keyFor({ name: file.name, size: file.size, at: file.lastModified })
  try {
    const uploaded = await uploadWithProgress(file, 'query', key, {
      filename: file.name,
      onProgress: (fraction) => {
        fill.style.width = `${Math.round(fraction * 100)}%`
      },
    })
    uploadAction.reset()
    if (!ctx.alive()) return
    state.queryId = uploaded.id
    period.reset()
    state.queryName = `${uploaded.width}×${uploaded.height}`
    state.region = null
    forgetAnalysis()
    forgetRun()
    ctx.repaintQuery()
    ctx.repaintResults()
  } catch (error) {
    if (!ctx.alive()) return
    bar.remove()
    const again = error instanceof NetworkError || (error instanceof ApiError && error.canRetry)
    problem(
      error instanceof Error ? error.message : '这张图没有传上去。',
      again ? () => void takeFile(ctx, pane, file) : undefined,
    )
  }
}

/** 粘贴和拖放这两条入口共用同一段收图逻辑。 */
export function acceptFile(ctx: SearchCtx, pane: HTMLElement, file: File): void {
  void takeFile(ctx, pane, file)
}

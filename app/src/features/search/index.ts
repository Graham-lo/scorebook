// 按图索骥 —— 拿一张截图去问「这种画面以前在哪儿见过」。
//
// v4 之后这件事是一条有三步的路，每一步都不替人做决定：
//
//   认图    POST /v1/chart-analyses —— 数出多少根 K 线、间距匀不匀、图上的字认出了
//           什么。认不出品种和周期就是认不出：形状里没有币种这个信息，前端不猜。
//   起检索  POST /v1/chart-search/runs —— 比哪一堆图必须由人明说：自己的复盘截图，
//           还是币安的公开历史。方向默认保持原样，反向要人自己勾。
//   看结果  GET  /v1/chart-search/runs/{id} —— 中途出现的 provisional 只是候选；
//           只有 final 才做完了来源哈希核验和几何精排。停手要带 expected_generation。
//
// 排序是结构相似度，不是胜率，也不是上涨概率。到今天为止，真实截图的盲测验收还
// 没有做过，所以这一页不会把任何结果说成「验过了」。
//
// 查询图上传成 kind `query`，后端不接受它作为任何一条记录的证据，搜索污染不了库。
// 图上拖的框按上传文件自己的像素坐标发出去，字节不重新编码。公开行情的 K 线和画
// 出来的图只在内存里活到这次查看结束，不落盘、不进本地缓存；原截图是用户自己的
// 东西，照常按附件接口显示。
//
// 这个文件只做两件事：把这一页拼起来，和把各个模块共用的那点东西（还在不在、
// 怎么等、图怎么收）交给它们。具体每一块长什么样在同目录的其他文件里，见
// `state.ts` 开头那份地图。

import { awake } from '../../ui/awake'
import type { SearchScope } from '../../api/chart'
import { forgetQuery } from '../../data/query-context'
import type { Uuid } from '../../api/types'
import { go } from '../../router'
import { h } from '../../ui/dom'
import { ChartView } from '../../ui/media'
import { onPaste } from '../../ui/pick'
import { problem } from '../../ui/toast'
import { acceptFile, disposeQueryPane, paintQuery, repaintControls } from './image-pane'
import { paintResults } from './results'
import { poll, runSearch, stopSearch } from './run'
import { forgetAnalysis, forgetRun, period, lane, state, restoreSearch, syncQuery, queryFingerprint, onSubmissionSettled, type SearchCtx } from './state'

export function searchPage(host: HTMLElement, arg: string): () => void {
  restoreSearch()
  // 人已经回来了，准备页上那条「回到刚才那次检索」就该收掉。
  forgetQuery()
  let alive = true
  const charts: ChartView[] = []
  /** 每一处还在轮询的东西留一个停手的开关，离开页面时一起关掉。 */
  const watchers = new Set<() => void>()

  // #/search/like/<attachment_id> — 从一条记录的现场图直接开搜。
  if (arg.startsWith('like/')) {
    const id = arg.slice(5)
    if (id && id !== state.queryId) {
      state.queryId = id
      period.reset()
      state.queryName = '这条记录的现场图'
      state.region = null
      forgetAnalysis()
      forgetRun()
    }
  }

  const queryPane = h('div.sheet.pad.stack')
  const resultPane = h('div')
  let displayedQuery = queryFingerprint()

  const ctx: SearchCtx = {
    alive: () => alive,
    onLeave: (stop) => { watchers.add(stop) },
    // 离开这一页时立刻醒过来：否则轮询会停在一个永远不 resolve 的 await 上，
    // 它的 finally 也就永远跑不到。
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        let left = false
        const stop = () => {
          clearTimeout(timer)
          watchers.delete(stop)
          left = true
          resolve()
        }
        const timer = setTimeout(() => {
          clearTimeout(timer)
          watchers.delete(stop)
          // 离开这一页要立刻醒，页面在后台则继续等——两件事不能互相盖掉。
          void awake().then(() => { if (!left) resolve() })
        }, ms)
        watchers.add(stop)
      }),
    chart: () => {
      const view = new ChartView()
      charts.push(view)
      return view
    },
    dropCharts: () => {
      for (const chart of charts.splice(0)) chart.cancel()
    },
    repaintQuery: () => {
      syncQuery()
      paintQuery(ctx, queryPane)
      const next = queryFingerprint()
      if (displayedQuery !== next) { displayedQuery = next; ctx.repaintResults() }
    },
    repaintResults: () => paintResults(ctx),
    repaintControls: () => repaintControls(ctx),
    runSearch: () => void runSearch(ctx),
    stopSearch: () => void stopSearch(ctx),
    resultPane,
  }

  const head = h(
    'div.sheet.pad',
    {},
    h(
      'div.row',
      { style: 'justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap' },
      h(
        'div',
        {},
        h('h1.h1', { text: '按图找同类局面' }),
        // 一句就够。怎么用写在每一步旁边，不在页面顶上摆一整段说明。
        h('div.tip', {
          style: 'margin-top:6px;max-width:44ch',
          text: '觉得「这种画面见过」的时候，问样本，别问记忆。',
        }),
      ),
      scopeSwitch(),
    ),
  )

  host.append(head, h('div.searchgrid', {}, queryPane, resultPane))

  ctx.repaintQuery()
  ctx.repaintResults()
  // POST 可以在离开后才返回；由此刻挂载的页面接手同一任务。
  watchers.add(onSubmissionSettled(() => {
    ctx.repaintControls()
    if (state.runId) { ctx.repaintResults(); void poll(ctx) }
  }))
  // 上一次的检索可能还在后台跑着：回到这一页就接着读它的进度，不重新起一次。
  if (state.runId) void poll(ctx)

  const detachPaste = onPaste({
    onPick: (file) => acceptFile(ctx, queryPane, file),
    onReject: (why) => problem(why),
  })

  /* ----------------------------------------------------------- 跟谁比 */

  function scopeSwitch(): HTMLElement {
    const seg = h('span.seg.lg')
    const options: { id: SearchScope; label: string }[] = [
      { id: 'private', label: '我的记录库' },
      { id: 'binance_history', label: '币安公开历史' },
    ]
    for (const option of options) {
      seg.appendChild(
        h('button', {
          class: state.scope === option.id ? 'on' : '',
          text: option.label,
          on: {
            click: () => {
              if (state.scope === option.id) return
              state.scope = option.id
              for (const button of seg.querySelectorAll('button')) {
                button.classList.toggle('on', button.textContent === option.label)
              }
              forgetRun()
              ctx.repaintQuery()
              ctx.repaintResults()
            },
          },
        }),
      )
    }
    return seg
  }

  return () => {
    syncQuery()
    alive = false
    disposeQueryPane()
    lane.cancel()
    detachPaste()
    for (const stop of watchers) stop()
    for (const chart of charts) chart.cancel()
  }
}

/** Where the call page sends the trader when they want more like this picture. */
export function searchLike(attachmentId: Uuid): void {
  go(`search/like/${attachmentId}`)
}

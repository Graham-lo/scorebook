// 两条路各自的前提，摆在结果下面。
//
// 私库这一侧：截图先算过特征才进得了候选。没算过的不是「搜不到」，是压根没进
// 到候选里——这件事必须说出来，否则空结果会被当成「我没写过这种局面」。
//
// 公开历史这一侧：现在能搜到多少段，还有多少段正在准备。准备本身、合约目录、
// 来源订正都在「公开历史」那一页，不挤在检索结果旁边。

import { GEOMETRY_MODEL, VISUAL_MODEL, imageIndexStatus, indexAllImages, type ImageIndexStatus } from '../../api/chart'
import { explain } from '../../api/errors'
import { publishedCoverage } from '../../api/history'
import * as jobs from '../../api/jobs'
import type { Uuid } from '../../api/types'
import * as prep from '../../data/prep'
import { rememberQuery } from '../../data/query-context'
import { go } from '../../router'
import { h, clear } from '../../ui/dom'
import { note, progressLine } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { period, reindexAction, state, type SearchCtx } from './state'

export function scopePane(ctx: SearchCtx): HTMLElement {
  return state.scope === 'private' ? indexPane(ctx) : coveragePane(ctx)
}

/* ------------------------------------------- 私库：截图算过特征没有 */

function indexPane(ctx: SearchCtx): HTMLElement {
  const right = h('span.faint', { style: 'margin-left:auto', text: '正在读…' })
  const rows = h('div', { style: 'padding:6px 18px 16px' })
  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '现场截图算过特征没有' }), right),
    rows,
  )

  const refresh = (): void => {
    void imageIndexStatus()
      .then((status) => {
        if (!ctx.alive()) return
        paintIndex(ctx, status, rows, right, refresh)
      })
      .catch(() => {
        if (!ctx.alive()) return
        right.textContent = ''
        rows.replaceChildren(h('div.tip', { text: '读不到截图的处理进度，稍后再看。' }))
      })
  }
  refresh()
  return box
}

function paintIndex(
  ctx: SearchCtx,
  status: ImageIndexStatus,
  rows: HTMLElement,
  right: HTMLElement,
  refresh: () => void,
): void {
  clear(rows)
  right.textContent = `${status.originals} 张现场图`
  const models: { id: string; label: string }[] = [
    { id: GEOMETRY_MODEL, label: '按走势结构' },
    { id: VISUAL_MODEL, label: '按画面样子' },
  ]
  let missing = 0
  for (const model of models) {
    const ready = status.items.find((i) => i.model_id === model.id && i.status === 'ready')
    const unsupported = status.items.find((i) => i.model_id === model.id && i.status === 'unsupported')
    const done = ready?.count ?? 0
    const left = Math.max(0, status.originals - done - (unsupported?.count ?? 0))
    missing = Math.max(missing, left)
    const line = h(
      'div.covrow',
      {},
      h('span', {
        class: ['badge', left === 0 && done > 0 ? 'ready' : 'wait'],
        text: left === 0 && done > 0 ? '都算过了' : '还没算完',
      }),
      h('span', { text: model.label }),
      h('span.faint', { text: `${done} / ${status.originals} 张算好了` }),
    )
    if (unsupported?.count) {
      line.appendChild(
        h('span.faint', {
          style: 'margin-left:auto',
          text: `${unsupported.count} 张不是能比的 K 线图`,
        }),
      )
    }
    rows.appendChild(line)
  }

  if (status.originals === 0) {
    rows.appendChild(h('div.tip', { text: '复盘库里还没有现场截图。先带着图记几条，才有东西可以比。' }))
    return
  }
  if (missing > 0) {
    rows.appendChild(
      h('div.tip', { text: '没算过特征的截图不会出现在结果里。补算跑在后端，关掉页面也不影响。' }),
    )
    const start = h('button.btn.sm', {
      text: '把还没算过的补上',
      on: {
        click: () => {
          start.disabled = true
          void indexAllImages(reindexAction.keyFor({ at: 'all' }))
            .then((started) => {
              reindexAction.reset()
              if (!ctx.alive()) return
              watchIndexJob(ctx, started.job_id, rows, refresh)
            })
            .catch((error: unknown) => {
              start.disabled = false
              problem(error instanceof Error ? error.message : '没有排上队。')
            })
        },
      },
    }) as HTMLButtonElement
    rows.appendChild(h('div.acts', { style: 'margin-top:8px' }, start))
  }
}

/** 补算是一项后台任务：一次处理 8 张，两种比法都算。 */
function watchIndexJob(ctx: SearchCtx, id: Uuid, host: HTMLElement, refresh: () => void): void {
  const line = h('div', { style: 'margin-top:10px' }, progressLine('排上队了，马上开始', 0.1))
  host.appendChild(line)
  let stopped = false
  ctx.onLeave(() => {
    stopped = true
  })
  void (async () => {
    for (;;) {
      if (stopped || !ctx.alive()) return
      let job
      try {
        job = await jobs.get(id)
      } catch {
        if (stopped || !ctx.alive()) return
        await ctx.sleep(8_000)
        continue
      }
      if (stopped || !ctx.alive()) return
      if (jobs.isRunning(job)) {
        const said = jobs.jobLine(job.status)
        line.replaceChildren(progressLine(said.text, said.progress))
        await ctx.sleep(4_000)
        continue
      }
      if (job.status === 'succeeded') {
        toast('截图的特征都补算好了。')
        refresh()
        return
      }
      line.replaceChildren(note('warn', job.error_code ? explain(job.error_code) : '这次补算没有做完。'))
      return
    }
  })()
}

/* ------------------------------------------------- 能搜到哪些公开历史 */

function coveragePane(ctx: SearchCtx): HTMLElement {
  const right = h('span.faint', { style: 'margin-left:auto', text: '正在读…' })
  const body = h('div', { style: 'padding:0 18px 16px' })
  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '能搜到哪些公开历史' }), right),
    body,
  )

  const running = prep.list().length
  const goPrepare = h('button.btn.sm', {
    type: 'button',
    text: '去准备历史',
    on: {
      click: () => {
        // 带着这次问的是什么过去。检索页的状态活在模块里，回来时图、框、周期
        // 和范围都还在，准备页那边只需要给一条回来的路。
        if (state.queryId) {
          rememberQuery({ attachmentId: state.queryId, interval: period.value, scope: state.scope, symbol: state.symbol, market: state.market })
        }
        go('history')
      },
    },
  })

  body.appendChild(h('div.tip', { text: '正在读已经发布的范围…' }))
  const filter = { ...(period.value ? { interval: period.value } : {}), ...(state.symbol ? { symbol: state.symbol } : {}), ...(state.market ? { market: state.market } : {}) }
  void publishedCoverage(filter)
    .then((page) => {
      if (!ctx.alive()) return
      clear(body)
      const shown = page.items.length + (page.next_cursor ? 1 : 0)
      right.textContent = shown ? `${page.items.length}${page.next_cursor ? '+' : ''} 段` : '还没有'
      if (!page.items.length) {
        body.appendChild(
          h('div.tip', {
            text: '还没有准备过任何一段公开历史，所以这边搜不出东西来——那是还没做，不是这种局面没出现过。',
          }),
        )
      } else {
        const names = page.items.slice(0, 6).map((entry) => `${entry.coverage.symbol} ${entry.coverage.interval}`)
        body.appendChild(
          h('div.faint', { text: `现在能搜到：${names.join('、')}${page.next_cursor ? ' 等' : ''}。` }),
        )
        body.appendChild(
          h('div.tip', {
            style: 'margin-top:6px',
            text: '只有准备过的时间段会被搜到；中间有缺口的那几段没有发布出去，也搜不到。',
          }),
        )
      }
      if (running > 0) {
        body.appendChild(h('div.tip', { style: 'margin-top:6px', text: `另外有 ${running} 段正在准备。` }))
      }
      body.appendChild(h('div.acts', { style: 'margin-top:10px' }, goPrepare))
    })
    .catch(() => {
      if (!ctx.alive()) return
      clear(body)
      right.textContent = ''
      body.appendChild(h('div.tip', { text: '读不到已经发布的范围，稍后再看。' }))
      body.appendChild(h('div.acts', { style: 'margin-top:10px' }, goPrepare))
    })
  return box
}

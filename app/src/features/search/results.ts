// 结果这一栏：这次检索走到哪儿了，以及走完之后看到了什么。
//
// 中途出现的 provisional 只是候选，会照样画出来但明说还没定；任务说做完了却没
// 有最终结果，就照实说，不拿候选冒充结论。

import { CHART_MATCH_PROTOCOL, type ChartSearchRun, type ExcludedCandidate, type FinalResult } from '../../api/chart'
import { explain } from '../../api/errors'
import * as jobs from '../../api/jobs'
import type { JobStatus } from '../../api/types'
import { dateTime, utcDateTime } from '../../data/time'
import { h, clear } from '../../ui/dom'
import { empty, foldout, note, progressLine } from '../../ui/states'
import { kvRow } from './bits'
import { hitList } from './hits'
import { scopePane } from './scope'
import { moving, state, type SearchCtx } from './state'

export function paintResults(ctx: SearchCtx): void {
  const pane = ctx.resultPane
  clear(pane)
  ctx.dropCharts()

  const run = state.run
  if (!state.runId || !run) {
    pane.appendChild(
      empty({
        title: '还没有开始搜',
        tip:
          state.scope === 'private'
            ? '放一张截图，就能在自己写过的记录里找画面接近的那几条。'
            : '放一张截图，在已经准备好的公开历史里找结构接近的片段。',
      }),
    )
    pane.appendChild(scopePane(ctx))
    return
  }

  if (moving(run.status)) {
    const said = jobs.jobLine(run.status as JobStatus)
    const box = h('div.sheet.pad', {})
    box.appendChild(progressLine(said.text, said.progress))
    box.appendChild(
      h(
        'div.acts',
        { style: 'margin-top:10px' },
        h('button.btn.sm.ghost', { text: '不搜了', on: { click: () => ctx.stopSearch() } }),
        h('span.faint', { text: `这次检索的编号 ${run.id.slice(0, 8)}` }),
      ),
    )
    pane.appendChild(box)
    const provisional = run.result
    if (provisional && provisional.status === 'provisional') {
      pane.appendChild(
        note(
          'info',
          '下面这些还只是候选：来源核验和结构精排都在最后一步做，最终结果里它们可能换位置，也可能整条被排掉。',
        ),
      )
      pane.appendChild(hitList(ctx, provisional.items, false))
    }
    return
  }

  if (run.status === 'cancelled') {
    pane.appendChild(
      empty({ title: '这次检索停手了', tip: '条件不用重填，按上面的按钮就能再搜一次。' }),
    )
    pane.appendChild(scopePane(ctx))
    return
  }

  if (run.status !== 'succeeded') {
    const why = run.error_code ? explain(run.error_code) : '这次检索没有做完。'
    pane.appendChild(note('warn', why))
    pane.appendChild(
      h(
        'div.acts',
        { style: 'margin-top:10px' },
        h('button.btn.sm', { text: '再搜一次', on: { click: () => ctx.runSearch() } }),
      ),
    )
    pane.appendChild(scopePane(ctx))
    return
  }

  const result = run.result
  if (!result || result.status !== 'final') {
    // 任务说做完了，但没有最终结果——照实说，不拿候选冒充结论。
    pane.appendChild(note('warn', '这次检索没有给出最终结果，重新搜一次。'))
    pane.appendChild(scopePane(ctx))
    return
  }
  paintFinal(ctx, result, run)
}

/** 这次到底按不按周期筛。`interval` 为 null 有两种可能，得看策略才分得清。 */
function anyInterval(result: FinalResult): boolean {
  return result.interval_policy === 'any_interval'
}

/** 结果头上那一句里的周期：不限、某个周期，或者旧检索根本没记。 */
function periodLabel(result: FinalResult): string {
  if (anyInterval(result)) return '不限周期'
  return result.interval ?? '旧检索未限定周期'
}

function paintFinal(ctx: SearchCtx, result: FinalResult, run: ChartSearchRun): void {
  const pane = ctx.resultPane
  const items = result.items ?? []
  if (!items.length) {
    pane.appendChild(
      empty({
        title: '没有找到结构接近的片段',
        tip:
          result.scope !== 'private'
            ? '只在已经准备好并发布的范围里找。换个条件，或者先把更多时间段准备出来。'
            : anyInterval(result)
              ? '只有已经算过特征的现场截图才会被搜到。这次已经不按周期筛了，还是没有形状接近的；放宽品种范围，或者等更多截图索引出来。'
              : '只有已经算过特征的现场截图才会被搜到。可放宽品种范围，或补全记录周期并等待截图索引；不会改用其他周期。'
      }),
    )
  } else {
    pane.append(
      h(
        'div.sheet.sh',
        {},
        h('span.eyebrow.noline', {
          text: result.scope === 'private' ? '画面接近的记录' : '历史上结构接近的片段',
        }),
        h('span.faint', {
          text: `${periodLabel(result)} · ${items.length} 条 · ${dateTime(run.completed_at ?? run.created_at)} 完成`,
        }),
      ),
      hitList(ctx, items, true),
    )
    pane.appendChild(
      note(
        'info',
        anyInterval(result)
          ? result.scope === 'binance_history'
            ? '这次不按周期筛，只比形状：命中的片段各自是什么周期，看每一条自己写的。每个品种保留最接近的一个片段。结构接近程度不是胜率。'
            : '这次不按周期筛，只比形状：命中的记录各自是什么周期，看每一条自己写的，没注明周期的记录也在里面。同一张截图和同一组记录只留最接近的那一条。结构接近程度不是胜率。'
          : result.scope === 'binance_history'
            ? '只比较同周期，每个品种保留最接近的一个片段。结构接近程度不是胜率。'
            : '只比较同周期的记录，同一张截图和同一组记录只留最接近的那一条。结构接近程度不是胜率。',
      ),
    )
  }
  if (result.excluded_candidates?.length) pane.appendChild(excludedPane(result.excluded_candidates))
  pane.appendChild(metaPane(result))
  pane.appendChild(scopePane(ctx))
}

/* ------------------------------------------------------ 被排掉的候选 */

function excludedPane(items: ExcludedCandidate[]): HTMLElement {
  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h(
      'div.sh',
      {},
      h('span.eyebrow.noline', { text: '排掉了几条' }),
      h('span.faint', { style: 'margin-left:auto', text: `${items.length} 条` }),
    ),
  )
  const rows = h('div', { style: 'padding:6px 18px 16px' })
  for (const item of items) {
    rows.appendChild(
      h(
        'div.covrow',
        {},
        h('span.badge.wait', { text: '未采用' }),
        h('span.mono', { text: (item.id ?? item.attachment_id ?? '').slice(0, 8) }),
        h('span', { text: excludeReason(item.reason) }),
      ),
    )
  }
  box.appendChild(rows)
  return box
}

function excludeReason(reason: string): string {
  if (reason === 'source_changed_or_incomplete') {
    return '这一段的来源和当初记下的对不上，或者那段本来就不完整，所以不拿它当结果。'
  }
  return explain(reason)
}

/* -------------------------------------------------------- 这次的口径 */

/**
 * 这次到底在什么范围里找的。范围本身一直摆在外面——搜过哪儿、没搜过哪儿是
 * 结果能不能信的前提，不是技术细节；真正属于内部实现的那几项（先筛多少条、
 * 比法版本）收进「详情」。
 */
function metaPane(result: FinalResult): HTMLElement {
  const kv = h('div.kv', { style: 'padding:6px 18px 14px' })
  kv.appendChild(kvRow('跟谁比的', result.scope === 'private' ? '我自己的现场截图' : '币安公开历史'))
  kv.appendChild(
    kvRow(
      '匹配周期',
      anyInterval(result)
        ? '不限周期：只比形状，命中的周期看每一条自己写的'
        : (result.interval ?? '旧检索未限定周期，请重新选择周期搜索'),
    ),
  )
  kv.appendChild(
    kvRow(
      '只看这个时刻之前',
      result.scope === 'binance_history'
        ? `${utcDateTime(result.cutoff_at)} UTC`
        : dateTime(result.cutoff_at),
    ),
  )
  if (result.scope === 'binance_history') {
    kv.appendChild(
      kvRow(
        '覆盖到哪儿',
        result.coverage === 'published_geometry_v2_only'
          ? '只在已经发布的几何索引里找，没准备过的时间段不在里面'
          : result.coverage,
      ),
    )
  }
  kv.appendChild(kvRow('质量验收', result.quality_validated ? '已验收' : '尚未验收'))

  const inner = h('div.kv', {})
  inner.appendChild(kvRow('先筛多少条再精排', `${result.candidate_budget} → ${result.rerank_budget}`))
  inner.appendChild(
    kvRow('原始行情有没有留下来', result.raw_market_storage === 'none' ? '没有留' : result.raw_market_storage),
  )
  inner.appendChild(kvRow('比法版本', result.protocol || CHART_MATCH_PROTOCOL))
  return h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '这次检索的范围' })),
    kv,
    h('div', { style: 'padding:0 18px 16px' }, foldout('内部口径详情', inner)),
  )
}

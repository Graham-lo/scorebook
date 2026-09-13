// 参照 —— 同一条规则，如果不是在你说的那一刻，而是在过去 250 天里每一天的同一
// 分钟各跑一遍，会是什么结果。
//
// 它回答的只有一件事：这套规则本身在这段行情上，大致是个什么成色。它不是「大盘
// 平均水平」，不是别人的成绩，更不是对下一次的预测。用它对照，是为了知道你那条
// 判断有没有比「随便挑一天说同样的话」好。
//
// 三条边界必须写在脸上：只对 T1 那类标准成立；取的每一根 K 线都在你提交之前，
// 不用未来的数据；没取到样本的那些判断算「缺」，缺就是缺，不折算成别的数字。

import { ApiError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import {
  baselineRun,
  createBaseline,
  type BaselineGroup,
  type BaselineRun,
  type GroupMetric,
} from '../../api/statistics'
import type { Uuid } from '../../api/types'
import * as store from '../../data/stats'
import { clear, h } from '../../ui/dom'
import { empty, jobLine, note, spinner } from '../../ui/states'
import { problem } from '../../ui/toast'
import type { RunView } from './index'
import { STALLED, share, shortSignature, whyStopped, type Live } from './shared'

const baselineAction = new WriteAction()

export function baselineSheet(live: Live): {
  node: HTMLElement
  paint: (view: RunView) => void
} {
  const body = h('div', { style: 'padding:4px 18px 18px' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '参照' })),
    body,
  )

  let shownRun: Uuid | null = null
  let statsGroups: GroupMetric[] = []

  function paint(view: RunView): void {
    const run = view.run
    if (!run || run.status !== 'ready' || !run.stats) {
      shownRun = null
      clear(body)
      node.hidden = true
      return
    }
    node.hidden = false
    if (shownRun === run.id) return
    shownRun = run.id
    statsGroups = run.stats.groups
    clear(body)
    const slot = h('div')
    body.appendChild(slot)
    const known = store.find(run.id)?.baseline_id ?? null
    if (known) void watch(known, run.id, slot, live, () => statsGroups)
    else slot.appendChild(startPane(run.id, slot, live, () => statsGroups))
  }

  return { node, paint }
}

function startPane(
  runId: Uuid,
  slot: HTMLElement,
  live: Live,
  groups: () => GroupMetric[],
): HTMLElement {
  const go = h('button.btn.sm', {
    type: 'button',
    text: '算一份参照',
    on: {
      click: () => {
        go.disabled = true
        const input = {
          statistics_run_id: runId,
          source_plan: 'rest_closed_minute_endpoints_v1' as const,
          calendar: 'natural_hours' as const,
        }
        void createBaseline(input, baselineAction.keyFor(input))
          .then((started) => {
            baselineAction.reset()
            store.rememberBaseline(runId, started.baseline_run_id)
            if (!live.alive()) return
            void watch(started.baseline_run_id, runId, slot, live, groups)
          })
          .catch((error: unknown) => {
            go.disabled = false
            problem(error instanceof Error ? error.message : '没保存上，再试一次')
          })
      },
    },
  }) as HTMLButtonElement
  return h('div.acts', {}, go)
}

async function watch(
  id: Uuid,
  runId: Uuid,
  slot: HTMLElement,
  live: Live,
  groups: () => GroupMetric[],
): Promise<void> {
  clear(slot)
  slot.appendChild(spinner('正在加载'))
  for (;;) {
    if (!live.alive()) return
    let run: BaselineRun
    try {
      run = await baselineRun(id)
    } catch (error) {
      if (!live.alive()) return
      clear(slot)
      if (error instanceof ApiError && error.status === 404) {
        store.rememberBaseline(runId, null)
        slot.appendChild(note('warn', '这份参照后端没有了'))
        slot.appendChild(startPane(runId, slot, live, groups))
        return
      }
      slot.appendChild(note('warn', error instanceof Error ? error.message : '没读出来'))
      return
    }
    if (!live.alive()) return
    clear(slot)
    if (run.status === 'ready' && run.result) {
      slot.appendChild(resultPane(run, groups()))
      return
    }
    if (STALLED.has(run.job_status)) {
      slot.appendChild(
        note('warn', whyStopped(run.error_code, '停下来了')),
      )
      return
    }
    slot.appendChild(jobLine('还在算', run.next_day / 250))
    await live.sleep(3000)
  }
}

function resultPane(run: BaselineRun, groups: GroupMetric[]): HTMLElement {
  const result = run.result
  const box = h('div')
  if (!result) return box
  const bySignature = new Map(groups.map((g) => [g.signature, g] as const))
  if (!result.groups.length) {
    box.appendChild(empty({ title: '没有能算参照的' }))
    return box
  }
  for (const group of result.groups) {
    box.appendChild(compareRow(group, bySignature.get(group.signature) ?? null))
  }
  return box
}

function compareRow(group: BaselineGroup, mine: GroupMetric | null): HTMLElement {
  const base = share(group.equal_call_realization_rate)
  const ours = mine ? share(mine.realization_rate) : null
  return h(
    'div.lrow',
    {},
    h(
      'div.body',
      {},
      h('span.mono', { text: `规则 #${shortSignature(group.signature)}` }),
      h('div.tip', {
        style: 'margin-top:3px',
        text: `样本 ${group.valid_calls} 条 · 缺 ${group.missing_calls} 条 · 有结论 ${group.valid_samples} 次`,
      }),
    ),
    h(
      'div.side',
      {},
      h('div.mono', { text: base ?? '—' }),
      h('div.faint', {
        style: 'font-size:11px',
        text: ours ? `你这次 ${ours}` : '没有这一组',
      }),
    ),
  )
}

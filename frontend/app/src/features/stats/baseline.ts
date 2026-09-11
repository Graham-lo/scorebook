// 参照基准 B1 —— 同一条规则，如果不是在你说的那一刻，而是在过去 250 天里每一天
// 的同一分钟各跑一遍，会是什么下场。
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
import { note, spinner } from '../../ui/states'
import { problem } from '../../ui/toast'
import type { RunView } from './index'
import { STALLED, kv, share, shortSignature, whyStopped, type Live } from './shared'

const baselineAction = new WriteAction()

export function baselineSheet(live: Live): {
  node: HTMLElement
  paint: (view: RunView) => void
} {
  const body = h('div', { style: 'padding:4px 18px 18px' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '参照基准 B1' })),
    body,
  )

  let shownRun: Uuid | null = null
  let statsGroups: GroupMetric[] = []

  function paint(view: RunView): void {
    const run = view.run
    if (!run || run.status !== 'ready' || !run.stats) {
      shownRun = null
      clear(body)
      body.appendChild(
        h('div.tip', {
          text: '等这一份统计数完，才能拿同一批判断去算参照——参照要照着成员表一条一条跑。',
        }),
      )
      return
    }
    if (shownRun === run.id) return
    shownRun = run.id
    statsGroups = run.stats.groups
    clear(body)
    body.appendChild(explainPane())
    const slot = h('div', { style: 'margin-top:12px' })
    body.appendChild(slot)
    const known = store.find(run.id)?.baseline_id ?? null
    if (known) void watch(known, run.id, slot, live, () => statsGroups)
    else slot.appendChild(startPane(run.id, slot, live, () => statsGroups))
  }

  return { node, paint }
}

function explainPane(): HTMLElement {
  return h(
    'div',
    {},
    h('div.tip', {
      style: 'max-width:64ch',
      text: '同一条规则，把提交时刻往前挪到过去 250 天里的每一天，同一分钟各跑一遍，看它们分别是什么下场。这样得出的比例，是这条规则在这段行情上的成色。',
    }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:64ch',
      text: '它不是对下一次的预测，也不是别人的成绩。你那一条比参照好，说明挑的时机有价值；差不多，说明这次的功劳多半在规则本身。',
    }),
  )
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
            problem(error instanceof Error ? error.message : '这份参照没有开始。')
          })
      },
    },
  }) as HTMLButtonElement
  return h(
    'div',
    {},
    h('div.acts', {}, go),
    h('div.tip', {
      style: 'margin-top:8px',
      text: '一条判断要跑 250 天，样本是一根一根去取的，条数多的时候要等一会儿。中途离开这一页不影响它跑。',
    }),
  )
}

async function watch(
  id: Uuid,
  runId: Uuid,
  slot: HTMLElement,
  live: Live,
  groups: () => GroupMetric[],
): Promise<void> {
  clear(slot)
  slot.appendChild(spinner('正在读这份参照…'))
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
        slot.appendChild(
          note('warn', '这台机器上记的那份参照后端已经没有了，可以重新算一份。'),
        )
        slot.appendChild(startPane(runId, slot, live, groups))
        return
      }
      slot.appendChild(note('warn', error instanceof Error ? error.message : '读不到这份参照。'))
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
        note('warn', whyStopped(run.error_code, '这份参照停下来了，等人处理之后才会继续。')),
      )
      return
    }
    slot.appendChild(
      spinner(
        `正在跑第 ${run.next_ordinal + 1} 条判断的第 ${run.next_day} 天（每条要往前跑 250 天）…`,
      ),
    )
    await live.sleep(3000)
  }
}

function resultPane(run: BaselineRun, groups: GroupMetric[]): HTMLElement {
  const result = run.result
  const box = h('div')
  if (!result) return box
  const bySignature = new Map(groups.map((g) => [g.signature, g] as const))
  if (!result.groups.length) {
    box.appendChild(
      note(
        'info',
        '这一份里没有一组能算参照。B1 只对「方向 + 期限 + 阈值」那一类标准成立，别的标准不适用——不是算不出来，是这个参照对它们没有意义。',
      ),
    )
    return box
  }
  for (const group of result.groups) {
    box.appendChild(compareRow(group, bySignature.get(group.signature) ?? null))
  }
  box.appendChild(
    h('div', { style: 'margin-top:12px' }, kv([
      ['协议', result.protocol] as const,
      ['取价', '每天同一分钟的收盘，必须有真实成交才算数'] as const,
      ['用没用未来数据', result.future_data_allowed ? '用了' : '没有，样本全在提交时刻之前'] as const,
      ['别的标准', '不适用'] as const,
    ])),
  )
  box.appendChild(
    h('div.tip', {
      style: 'margin-top:8px',
      text: '「缺」是那一天的行情没取到、或者收盘那一刻没有成交。缺的部分就是缺，不会拿别的日子补上去，也不会折算成一个比例。',
    }),
  )
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
        text: `参照取到 ${group.valid_calls} 条判断的样本，缺 ${group.missing_calls} 条；一共跑了 ${group.attempted_samples} 次，其中 ${group.valid_samples} 次有结论。`,
      }),
    ),
    h(
      'div.side',
      {},
      h('div.mono', { text: base ?? '—' }),
      h('div.faint', {
        style: 'font-size:11px',
        text: ours ? `你这次 ${ours}` : '这一组不在前 100 组里',
      }),
    ),
  )
}

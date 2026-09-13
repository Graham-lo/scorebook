// 统计 —— 在一套定死的规则和一段定死的历史里，把已经发生过的事数清楚。
//
// 一次统计对应一份冻结下来的样本：分组、样本、参照、待你定全都挂在同一个编号上；
// 换口径就新建一份，原来那份原样留着。屏幕上的每一个数字都能追到样本里具体的几
// 条记录，追不到的数字这里就不显示。
//
// 「战绩」那一屏不走这套 run 机制，它直接从记录列表算，见 ./record.ts。

import { awake } from '../../ui/awake'
import { WriteAction } from '../../api/http'
import {
  RESULT_STATES,
  createStatistics,
  statisticsRun,
  type SampleFilter,
  type StatisticsInput,
  type StatisticsRun,
} from '../../api/statistics'
import type { JobStatus, Market, OutcomeState, Uuid } from '../../api/types'
import { PATHS, STANCES } from '../../data/criteria'
import { INTERVALS, MARKET_LABELS } from '../../data/session'
import * as store from '../../data/stats'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { empty, jobLine, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { baselineSheet } from './baseline'
import { groupsSheet } from './groups'
import { recordView } from './record'
import { STALLED, STATE_COLORS, STATE_LABELS, kv, whyStopped, type Live } from './shared'
import { verdictSheet } from './verdicts'

const createAction = new WriteAction()

/** 一份统计还在算的时候，页面上挂着的那些块都听这一个信号。 */
export interface RunView {
  run: StatisticsRun | null
  /** 读这一份时出的错，读不到就把话摆出来，不假装没有这份。 */
  error: string | null
}

export function statsPage(
  host: HTMLElement,
  arg: string,
  query: URLSearchParams,
): () => void {
  if (query.get('view') !== 'runs' && !/^[0-9a-f-]{36}$/i.test(arg)) return recordView(host)
  return runsView(host, arg)
}

function runsView(host: HTMLElement, arg: string): () => void {
  let alive = true
  const timers = new Set<number>()
  const live: Live = {
    alive: () => alive,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(() => {
          timers.delete(id)
          // 页面在后台就先不问，等它回到眼前再继续。
          void awake().then(resolve)
        }, ms)
        timers.add(id)
      }),
  }

  if (/^[0-9a-f-]{36}$/i.test(arg)) store.setCurrent(arg)

  const painters: ((view: RunView) => void)[] = []
  let view: RunView = { run: null, error: null }

  const paintAll = () => {
    for (const paint of painters) paint(view)
  }

  /** 读一份统计，没算完就一直盯着，直到算完或者停下来等人。 */
  async function follow(id: Uuid): Promise<void> {
    for (;;) {
      if (!live.alive()) return
      if (store.current() !== id) return
      try {
        const run = await statisticsRun(id)
        if (!live.alive() || store.current() !== id) return
        view = { run, error: null }
        paintAll()
        if (run.status === 'ready') return
        if (STALLED.has(run.job.status)) return
      } catch (error) {
        if (!live.alive()) return
        view = { run: null, error: error instanceof Error ? error.message : '没读出来' }
        paintAll()
        return
      }
      await live.sleep(2000)
    }
  }

  const select = (id: Uuid | null) => {
    store.setCurrent(id)
    view = { run: null, error: null }
    paintAll()
    if (id) void follow(id)
  }

  const mount = (section: { node: HTMLElement; paint: (view: RunView) => void }) => {
    painters.push(section.paint)
    return section.node
  }

  const build = buildSheet(select)
  const overview = mount(overviewSheet())
  overview.classList.add('full')
  host.append(
    h('div.spread', {},
      h('div.lead', {}, mount(runSheet(select, () => build.focus()))),
      h('div.bulk.two-up', {}, mount(build), overview, mount(groupsSheet(live)), mount(baselineSheet(live)), verdictSheet(live)),
    ),
  )

  const current = store.current()
  if (current) void follow(current)
  else paintAll()

  return () => {
    alive = false
    for (const id of timers) window.clearTimeout(id)
    timers.clear()
  }
}

/* ------------------------------------------------- 现在看的是哪一份 */

function runSheet(
  select: (id: Uuid | null) => void,
  openBuild: () => void,
): { node: HTMLElement; paint: (view: RunView) => void } {
  const body = h('div', { style: 'padding:4px 18px 16px' })
  const right = h('span.faint', { style: 'margin-left:auto' })
  const node = h(
    'div.sheet',
    {},
    h('div.sh', {}, h('span.eyebrow.noline', { text: '统计' }), right),
    body,
  )

  function paint(view: RunView): void {
    clear(body)
    const id = store.current()
    if (!id) {
      right.textContent = ''
      body.appendChild(
        empty({
          title: '还没有统计',
          action: h('button.btn.sm.primary', {
            type: 'button',
            text: '新建统计',
            on: { click: () => openBuild() },
          }),
        }),
      )
      return
    }
    if (view.error) {
      right.textContent = ''
      body.appendChild(note('warn', view.error))
      body.appendChild(
        h('div.acts', { style: 'margin-top:10px' }, forgetBtn(id, select), pickOther(select)),
      )
      return
    }
    const run = view.run
    if (!run) {
      right.textContent = ''
      body.appendChild(spinner('正在加载'))
      return
    }
    const f = run.definition.filters
    right.textContent = run.status === 'ready' ? '算完了' : '还在算'
    body.appendChild(h('div.h2', { text: run.definition.name }))
    body.appendChild(h('div', { style: 'margin-top:10px' }, kv(definitionRows(f, run))))
    if (run.status !== 'ready') {
      body.appendChild(h('div', { style: 'margin-top:10px' }, buildingLine(run)))
    }
    body.appendChild(
      h('div.acts', { style: 'margin-top:12px' }, pickOther(select), forgetBtn(run.id, select)),
    )
  }

  return { node, paint }
}

function pickOther(select: (id: Uuid | null) => void): HTMLElement {
  const box = h('span.popwrap')
  const list = store.list().filter((entry) => entry.id !== store.current())
  if (!list.length) return box
  for (const entry of list.slice(0, 4)) {
    box.appendChild(
      h('button.btn.sm.ghost', {
        type: 'button',
        text: entry.name,
        title: dateTime(entry.started_at),
        on: { click: () => select(entry.id) },
      }),
    )
  }
  return box
}

function forgetBtn(id: Uuid, select: (id: Uuid | null) => void): HTMLElement {
  return h('button.btn.sm.ghost', {
    type: 'button',
    text: '不看这份了',
    on: {
      click: () => {
        store.forget(id)
        select(store.list()[0]?.id ?? null)
      },
    },
  })
}

function definitionRows(f: SampleFilter, run: StatisticsRun): (readonly [string, string])[] {
  const rows: (readonly [string, string])[] = []
  if (f.start_at || f.end_at) {
    rows.push([
      '记录时间',
      `${f.start_at ? dateTime(f.start_at) : '最早'} — ${f.end_at ? dateTime(f.end_at) : '现在'}`,
    ] as const)
  }
  if (f.instrument) rows.push(['品种', f.instrument] as const)
  if (f.market) rows.push(['市场', MARKET_LABELS[f.market as Market] ?? f.market] as const)
  if (f.timeframe) rows.push(['周期', f.timeframe] as const)
  if (f.path) rows.push(['当时顺序', PATHS[f.path] ?? f.path] as const)
  if (f.stance) rows.push(['方向', STANCES[f.stance as keyof typeof STANCES] ?? f.stance] as const)
  if (f.source_entry) rows.push(['来源', f.source_entry] as const)
  if (f.adoption) rows.push(['是否照做', ADOPTIONS[f.adoption] ?? f.adoption] as const)
  if (f.result_states?.length) {
    rows.push(['只看结果', f.result_states.map((s) => STATE_LABELS[s] ?? s).join('、')] as const)
  }
  rows.push([
    '分组',
    run.definition.grouping === 'episode_rule' ? '同一段只算一次' : '每条各算一次',
  ] as const)
  if (run.source_snapshot_at) rows.push(['冻结于', dateTime(run.source_snapshot_at)] as const)
  return rows
}

const ADOPTIONS: Record<string, string> = {
  planned: '进了计划',
  executed: '真的做了',
  not_executed: '看过但没做',
  unknown: '没记有没有做',
}

function buildingLine(run: StatisticsRun): HTMLElement {
  const status = run.job.status as JobStatus
  if (STALLED.has(status)) return note('warn', whyStopped(run.job.error_code, '停下来了'))
  return jobLine('还在算')
}

/* ----------------------------------------------------------- 新建统计 */

interface Draft {
  name: string
  start: string
  end: string
  instrument: string
  market: string
  timeframe: string
  path: string
  stance: string
  adoption: string
  grouping: 'episode_rule' | 'call_rule'
  states: Set<OutcomeState>
}

function buildSheet(select: (id: Uuid | null) => void): {
  node: HTMLElement
  paint: (view: RunView) => void
  focus: () => void
} {
  const body = h('div', { style: 'padding:4px 18px 16px' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '新建统计' })),
    body,
  )

  const draft: Draft = {
    name: '',
    start: '',
    end: '',
    instrument: '',
    market: '',
    timeframe: '',
    path: '',
    stance: '',
    adoption: '',
    grouping: 'episode_rule',
    states: new Set(),
  }

  const name = h('input.input', {
    placeholder: '起个名字',
    on: {
      input: (e) => {
        draft.name = (e.target as HTMLInputElement).value
      },
    },
  }) as HTMLInputElement
  const from = h('input.input', {
    type: 'date',
    on: {
      change: (e) => {
        draft.start = (e.target as HTMLInputElement).value
      },
    },
  }) as HTMLInputElement
  const to = h('input.input', {
    type: 'date',
    on: {
      change: (e) => {
        draft.end = (e.target as HTMLInputElement).value
      },
    },
  }) as HTMLInputElement
  const instrument = h('input.input', {
    placeholder: '不限',
    on: {
      input: (e) => {
        draft.instrument = (e.target as HTMLInputElement).value.trim().toUpperCase()
      },
    },
  }) as HTMLInputElement

  const chips = (
    label: string,
    options: (readonly [string, string])[],
    read: () => string,
    write: (value: string) => void,
  ) => {
    const row = h('div.filters')
    const paint = () => {
      clear(row)
      for (const [value, text] of [['', '不限'] as const, ...options]) {
        row.appendChild(
          h('button', {
            type: 'button',
            class: ['chip', read() === value ? 'on' : ''],
            text,
            on: {
              click: () => {
                write(value)
                paint()
              },
            },
          }),
        )
      }
    }
    paint()
    return h('div.field', {}, h('label', { text: label }), row)
  }

  const grouping = h('div.seg')
  const paintGrouping = () => {
    clear(grouping)
    const options = [
      ['episode_rule', '同一段只算一次'],
      ['call_rule', '每条各算一次'],
    ] as const
    for (const [value, text] of options) {
      grouping.appendChild(
        h('button', {
          type: 'button',
          class: draft.grouping === value ? 'on' : '',
          text,
          on: {
            click: () => {
              draft.grouping = value
              paintGrouping()
            },
          },
        }),
      )
    }
  }
  paintGrouping()

  const stateRow = h('div.filters')
  const paintStates = () => {
    clear(stateRow)
    for (const state of RESULT_STATES) {
      stateRow.appendChild(
        h('button', {
          type: 'button',
          class: ['chip', draft.states.has(state) ? 'on' : ''],
          text: STATE_LABELS[state],
          on: {
            click: () => {
              if (draft.states.has(state)) draft.states.delete(state)
              else draft.states.add(state)
              paintStates()
            },
          },
        }),
      )
    }
  }
  paintStates()

  const go = h('button.btn.primary', {
    type: 'button',
    text: '开始数',
    on: { click: () => void submit() },
  }) as HTMLButtonElement

  async function submit(): Promise<void> {
    if (!draft.name.trim()) {
      problem('先起个名字')
      name.focus()
      return
    }
    const filters: SampleFilter = {}
    if (draft.start) filters.start_at = new Date(`${draft.start}T00:00:00Z`).toISOString()
    if (draft.end) filters.end_at = new Date(`${draft.end}T00:00:00Z`).toISOString()
    if (draft.instrument) filters.instrument = draft.instrument
    if (draft.market) filters.market = draft.market
    if (draft.timeframe) filters.timeframe = draft.timeframe
    if (draft.path) filters.path = draft.path
    if (draft.stance) filters.stance = draft.stance
    if (draft.adoption) filters.adoption = draft.adoption as SampleFilter['adoption']
    if (draft.states.size) filters.result_states = [...draft.states]
    if (filters.start_at && filters.end_at && filters.start_at >= filters.end_at) {
      problem('起要早于止')
      return
    }
    const input: StatisticsInput = {
      name: draft.name.trim(),
      filters,
      comparison_policy: 'exact_frozen_rule',
      grouping: draft.grouping,
      calendar: 'natural_hours',
      outcome_policy: 'current_formal_head',
    }
    go.disabled = true
    try {
      const started = await createStatistics(input, createAction.keyFor(input))
      createAction.reset()
      store.remember({
        id: started.statistics_run_id,
        name: input.name,
        grouping: input.grouping,
        started_at: new Date().toISOString(),
        baseline_id: null,
      })
      select(started.statistics_run_id)
      toast('开始数了')
    } catch (error) {
      problem(error instanceof Error ? error.message : '没保存上，再试一次')
    } finally {
      go.disabled = false
    }
  }

  body.append(
    h('div.field', {}, h('label', { text: '名字' }), name),
    h(
      'div.grid2',
      { style: 'margin-top:10px' },
      h('div.field', {}, h('label', { text: '起' }), from),
      h('div.field', {}, h('label', { text: '止' }), to),
    ),
    h('div.field', { style: 'margin-top:10px' }, h('label', { text: '品种' }), instrument),
    chips(
      '市场',
      (['usd_m', 'coin_m'] as Market[]).map((m) => [m, MARKET_LABELS[m]] as const),
      () => draft.market,
      (v) => {
        draft.market = v
      },
    ),
    chips(
      '周期',
      INTERVALS.map((i) => [i, i] as const),
      () => draft.timeframe,
      (v) => {
        draft.timeframe = v
      },
    ),
    chips(
      '当时的顺序',
      Object.entries(PATHS)
        .filter(([key]) => key !== 'unknown')
        .map(([key, label]) => [key, label] as const),
      () => draft.path,
      (v) => {
        draft.path = v
      },
    ),
    chips(
      '方向',
      (['L', 'S', 'C', '?'] as const).map((s) => [s, STANCES[s]] as const),
      () => draft.stance,
      (v) => {
        draft.stance = v
      },
    ),
    chips(
      '是否照做',
      Object.entries(ADOPTIONS).map(([key, label]) => [key, label] as const),
      () => draft.adoption,
      (v) => {
        draft.adoption = v
      },
    ),
    h('div.field', { style: 'margin-top:10px' }, h('label', { text: '分组' }), grouping),
    h('div.field', { style: 'margin-top:10px' }, h('label', { text: '只看某几种结果' }), stateRow),
    h('div.acts', { style: 'margin-top:12px' }, go),
  )

  return {
    node,
    paint: () => {},
    focus: () => {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' })
      name.focus({ preventScroll: true })
    },
  }
}

/* ------------------------------------------------------------ 总览 */

function overviewSheet(): { node: HTMLElement; paint: (view: RunView) => void } {
  const body = h('div', { style: 'padding:4px 18px 18px' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '这一份数到了什么' })),
    body,
  )

  function paint(view: RunView): void {
    clear(body)
    const run = view.run
    if (!run) {
      node.hidden = true
      return
    }
    node.hidden = false
    const stats = run.stats
    if (run.status !== 'ready' || !stats) {
      body.appendChild(jobLine('还在算'))
      return
    }
    const c = stats.counts
    const grid = h('div.stats')
    const cells: (readonly [string, string])[] = [
      ['判断条数', String(c.call_count)],
      ['规则条数', String(c.claim_count)],
      ['行情段数', String(c.episode_count)],
      ['计入的代表', String(c.representative_count)],
      ['不算数的', String(c.excluded_count)],
      ['被结果筛掉的', String(c.result_filter_excluded_count)],
    ]
    for (const [k, v] of cells) {
      grid.appendChild(h('div.stat', {}, h('span.k', { text: k }), h('span.v', { text: v })))
    }
    body.appendChild(grid)

    body.appendChild(h('div.eyebrow', { style: 'margin-top:16px', text: '六种结果' }))
    body.appendChild(sixBar(stats.states))

    const running = Object.entries(stats.processing_states)
      .filter(([key, n]) => key !== 'absent' && n > 0)
      .reduce((sum, [, n]) => sum + n, 0)

    body.appendChild(
      h('div', { style: 'margin-top:14px' }, kv([
        ['分组数', String(stats.group_count)] as const,
        ['作废的', String(c.voided_count)] as const,
        ...(running ? [['还在算', `${running} 条`] as const] : []),
      ])),
    )
  }

  return { node, paint }
}

function sixBar(states: Record<string, number>): HTMLElement {
  const order = RESULT_STATES
  const total = order.reduce((sum, key) => sum + (states[key] ?? 0), 0)
  const bar = h('div.sixbar', { style: 'margin-top:8px' })
  const legend = h('div.sixleg', { style: 'margin-top:10px' })
  for (const key of order) {
    const n = states[key] ?? 0
    if (total > 0 && n > 0) {
      bar.appendChild(
        h('i', {
          style: `width:${(n / total) * 100}%;background:${STATE_COLORS[key]}`,
          title: `${STATE_LABELS[key]} ${n}`,
        }),
      )
    }
    // 计数之间的占比，用整数算到一位小数，不经过浮点的四舍五入。
    const tenths = total > 0 ? Math.round((n * 1000) / total) : 0
    const portion = total > 0 ? `${Math.floor(tenths / 10)}.${tenths % 10}%` : null
    legend.appendChild(
      h(
        'span',
        {},
        h('i', { style: `background:${STATE_COLORS[key]}` }),
        `${STATE_LABELS[key]} `,
        h('b', { text: String(n) }),
        portion && n > 0 ? ` · ${portion}` : '',
      ),
    )
  }
  return h('div', {}, bar, legend)
}

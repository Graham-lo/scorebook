// 长期统计 —— 在一套定死的规则和一段定死的历史里，把已经发生过的事数清楚。
//
// 这一页只做一件事：数。它不预测，也不排名。屏幕上的每一个数字都能追到成员表里
// 具体的几条记录，追不到的数字这里就不显示。
//
// 三件事要拎清楚：
//
//   快照  一次统计对应一份冻结下来的成员表。分组、成员、参照基准、待裁决全都挂
//         在同一个编号上；换口径就重新数一份，原来那份原样留着。
//   比例  `realization_rate` 是「这一组里判定为兑现的，占有结论的多少」。它是对
//         过去的计数，不是胜率，也不是下一次的概率，页面上不改名。
//   裁决  后端只会在某一组攒够 20 条新结论时提醒一句，不带倾向。认不认这条证据
//         是人按下去的事，模型不替人按。
//
// 挑过结果的统计（只看某几种下场）能看，但它的比例没有分母上的意义，后端也不会
// 为它排待裁决——这一点页面上直说。

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
import { empty, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { baselineSheet } from './baseline'
import { groupsSheet } from './groups'
import { STALLED, STATE_COLORS, STATE_LABELS, kv, whyStopped, type Live } from './shared'
import { verdictSheet } from './verdicts'

const createAction = new WriteAction()

/** 一份统计还在算的时候，页面上挂着的那些块都听这一个信号。 */
export interface RunView {
  run: StatisticsRun | null
  /** 读这一份时出的错，读不到就把话摆出来，不假装没有这份。 */
  error: string | null
}

export function statsPage(host: HTMLElement, arg: string): () => void {
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
        view = {
          run: null,
          error: error instanceof Error ? error.message : '读不到这一份统计。',
        }
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

  host.append(
    headSheet(),
    mount(runSheet(select)),
    mount(buildSheet(select)),
    mount(overviewSheet()),
    mount(groupsSheet(live)),
    mount(baselineSheet(live)),
    verdictSheet(live),
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

/* --------------------------------------------------------------- 抬头 */

function headSheet(): HTMLElement {
  return h(
    'div.sheet.pad',
    {},
    h('h1.h1', { text: '长期统计' }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:64ch',
      text: '数的是已经发生过的事：在一套定死的规则、一段定死的历史里，你的判断分别落到了哪一种下场。这里不预测下一次。',
    }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:64ch',
      text: '一次统计对应一份冻结下来的成员表。翻页、看某一组的成员、算参照基准，用的都是同一份；想换口径就重新数一份，原来那份原样留着。',
    }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:64ch',
      text: '「兑现比例」是这一组里判定为兑现的条数，除以有结论的条数。它是一个计数，不是胜率，也不是下一次会怎么样的概率。',
    }),
  )
}

/* ------------------------------------------------- 现在看的是哪一份 */

function runSheet(select: (id: Uuid | null) => void): {
  node: HTMLElement
  paint: (view: RunView) => void
} {
  const body = h('div', { style: 'padding:4px 18px 16px' })
  const right = h('span.faint', { style: 'margin-left:auto' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '这一份统计' }), right),
    body,
  )

  function paint(view: RunView): void {
    clear(body)
    const id = store.current()
    if (!id) {
      right.textContent = ''
      body.appendChild(
        empty({
          title: '还没有数过',
          tip: '在下面挑一段历史和一套口径，数出来的那一份会一直挂在这一页上。',
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
      body.appendChild(spinner('正在读这一份统计…'))
      return
    }
    const f = run.definition.filters
    right.textContent = run.status === 'ready' ? '已经数完' : '正在数'
    body.appendChild(h('div.h2', { text: run.definition.name }))
    body.appendChild(
      h('div.tip', {
        style: 'margin-top:4px',
        text:
          run.definition.grouping === 'episode_rule'
            ? '同一段行情里重复的判断只算一条，取最早的那一条当代表。'
            : '每一条判断各算一次，同一段行情里说过几次就是几次。',
      }),
    )
    body.appendChild(
      h('div', { style: 'margin-top:10px' }, kv(definitionRows(f, run))),
    )
    if (run.status !== 'ready') {
      body.appendChild(h('div', { style: 'margin-top:10px' }, buildingLine(run)))
    }
    body.appendChild(
      h(
        'div.acts',
        { style: 'margin-top:12px' },
        pickOther(select),
        forgetBtn(run.id, select),
      ),
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
        title: `${dateTime(entry.started_at)} 数的那一份`,
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
    title: '只是把这台机器上记的编号去掉，后端那份快照原样留着。',
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
    rows.push(['记录时间', `${f.start_at ? dateTime(f.start_at) : '最早'} — ${f.end_at ? dateTime(f.end_at) : '现在'}`] as const)
  }
  if (f.instrument) rows.push(['品种', f.instrument] as const)
  if (f.market) rows.push(['市场', MARKET_LABELS[f.market as Market] ?? f.market] as const)
  if (f.timeframe) rows.push(['周期', f.timeframe] as const)
  if (f.path) rows.push(['当时顺序', PATHS[f.path] ?? f.path] as const)
  if (f.stance) rows.push(['方向', STANCES[f.stance as keyof typeof STANCES] ?? f.stance] as const)
  if (f.source_entry) rows.push(['来源', f.source_entry] as const)
  if (f.adoption) rows.push(['是否照做', ADOPTIONS[f.adoption] ?? f.adoption] as const)
  if (f.result_states?.length) {
    rows.push([
      '只看下场',
      f.result_states.map((s) => STATE_LABELS[s] ?? s).join('、'),
    ] as const)
  }
  rows.push(['口径', '绝对价位各算各的 · 自然小时 · 只认当前正式结论'] as const)
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
  if (STALLED.has(status)) {
    return note(
      'warn',
      whyStopped(run.job.error_code, '这次统计停下来了，等人处理之后才会继续。'),
    )
  }
  return spinner(
    run.status === 'queued' ? '正在冻结这一份成员表…' : '成员表已经冻住，正在一组一组地数…',
  )
}

/* --------------------------------------------------------- 数一份新的 */

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
} {
  const body = h('div', { style: 'padding:4px 18px 16px' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '数一份新的' })),
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
    placeholder: '给这一份起个名字，比如「今年的 BTC 一小时」',
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
    placeholder: '不填就是所有品种',
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
  const stateWarn = h('div.tip', { style: 'margin-top:6px' })
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
    stateWarn.textContent = draft.states.size
      ? '挑了下场之后，这一份只是「把这几种记录挑出来看看」：分母已经被挑过，比例不再有意义，后端也不会为它排待裁决。'
      : '不挑就是六种下场全都数进去。这样数出来的比例才有分母上的意义。'
  }
  paintStates()

  const go = h('button.btn.primary', {
    type: 'button',
    text: '开始数',
    on: { click: () => void submit() },
  }) as HTMLButtonElement

  async function submit(): Promise<void> {
    if (!draft.name.trim()) {
      problem('先给这一份起个名字，过两个月你才认得出它数的是什么。')
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
      problem('开始时间要早于结束时间。')
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
      toast('开始数了。成员表冻好之后，下面的数字就是这一份的。')
    } catch (error) {
      problem(error instanceof Error ? error.message : '这一份没有开始，请再试一次。')
    } finally {
      go.disabled = false
    }
  }

  body.append(
    h('div.field', {}, h('label', { text: '名字' }), name),
    h(
      'div.grid2',
      { style: 'margin-top:10px' },
      h('div.field', {}, h('label', { text: '记录时间从' }), from),
      h('div.field', {}, h('label', { text: '到' }), to),
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
      '是否照着做了',
      Object.entries(ADOPTIONS).map(([key, label]) => [key, label] as const),
      () => draft.adoption,
      (v) => {
        draft.adoption = v
      },
    ),
    h('div.field', { style: 'margin-top:10px' }, h('label', { text: '同一段行情里说过好几次' }), grouping),
    h('div.field', { style: 'margin-top:10px' }, h('label', { text: '只看某几种下场' }), stateRow, stateWarn),
    h(
      'div.tip',
      { style: 'margin-top:10px' },
      '口径是定死的：绝对价位各算各的（3.5 万和 3.6 万不会被算成同一条规则）、按自然小时算时限、只认当前的正式结论，试算不算数。',
    ),
    h('div.acts', { style: 'margin-top:12px' }, go),
  )

  return { node, paint: () => {} }
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
      body.appendChild(h('div.tip', { text: '先挑一份统计，或者数一份新的。' }))
      return
    }
    const stats = run.stats
    if (run.status !== 'ready' || !stats) {
      body.appendChild(h('div.tip', { text: '数完之前不给中间数字——半份统计比没有统计更容易骗人。' }))
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
      ['被下场筛掉的', String(c.result_filter_excluded_count)],
    ]
    for (const [k, v] of cells) {
      grid.appendChild(h('div.stat', {}, h('span.k', { text: k }), h('span.v', { text: v })))
    }
    body.appendChild(grid)

    body.appendChild(h('div.eyebrow', { style: 'margin-top:16px', text: '六种下场' }))
    body.appendChild(sixBar(stats.states))

    const processing = Object.entries(stats.processing_states).filter(
      ([key, n]) => key !== 'absent' && n > 0,
    )
    if (processing.length) {
      body.appendChild(
        h('div.tip', {
          style: 'margin-top:12px',
          text: `还有 ${processing.map(([key, n]) => `${n} 条停在「${key}」`).join('，')}——这些条目已经在成员表里，只是结论还没落定。`,
        }),
      )
    }

    body.appendChild(
      h('div', { style: 'margin-top:14px' }, kv([
        ['分组数', `${stats.group_count}${stats.groups_complete ? '' : '（还没列完，下面可以翻）'}`] as const,
        ['作废的', String(c.voided_count)] as const,
        [
          '挑没挑过下场',
          stats.selection === 'unconditioned' ? '没有挑过，六种下场全在里面' : '挑过下场，比例不作数',
        ] as const,
      ])),
    )

    body.appendChild(
      note(
        'info',
        '后端没有给置信区间，理由是同一段行情里的多条判断彼此不独立——套一个区间公式只会给出一个看着精确、其实站不住的数。所以这里只有计数和比例。',
      ),
    )
    if (stats.selection === 'result_conditioned') {
      body.appendChild(
        note(
          'warn',
          '这一份是挑过下场的：分母已经被挑走了一部分，下面的比例只能当作「这几种记录长什么样」，不能当作这套规则的兑现率。后端也不会为它排待裁决。',
        ),
      )
    }
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

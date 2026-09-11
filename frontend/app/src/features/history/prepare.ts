// 准备一段公开历史。
//
// 「准备」这两个字在这里有确切的意思：把一段公开行情按固定长度切成一个个片段，
// 逐段记下 K 线的几何特征，然后把这一代发布出去。发布过的才搜得到；原始 K 线和
// 系统画出来的图一律不留。
//
// 从哪里取要说清楚。交易所接口只有还在交易的合约拿得到；退市的、早年的，只有官方
// 月度归档里有——那种情况后端会直接拒绝走接口，而不是给你一段空的。
//
// 一次请求装得下就走 `/v1/history/indexes`；装不下（超过 5 万根 K 线或 1000 个片段）
// 交给 `/v1/history/plans`，由后端一段一段往下做，中途能暂停、继续、不做了。两边
// 都跑在后端：交出去之后关掉页面也不影响。

import { lifecycleRange } from './lifecycle-range'
import { pendingQuery } from '../../data/query-context'
import { ApiError } from '../../api/errors'
import { GEOMETRY_MODEL } from '../../api/chart'
import { explain } from '../../api/errors'
import { WriteAction } from '../../api/http'
import {
  estimate as estimateRange,
  requestIndex,
  type Estimate,
  type HistoryModel,
  type HistorySource,
} from '../../api/history'
import * as jobs from '../../api/jobs'
import * as plans from '../../api/plans'
import type { HistoryPlan, Market, Uuid } from '../../api/types'
import * as prep from '../../data/prep'
import {
  INTERVALS,
  INTERVAL_SECONDS,
  MARKET_LABELS,
  defaultMarket,
  findInstruments,
  type Interval,
} from '../../data/session'
import { shortDate } from '../../data/time'
import { h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { popChip } from '../../ui/pop'
import { note, progressLine, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

export const WINDOW_BARS = 64
export const STRIDE_BARS = 16
/** 一次请求的上限：再多就得分段做。 */
const MAX_BARS_PER_REQUEST = 50_000
const MAX_WINDOWS = 1_000

/**
 * 页面借给这个模块的几样东西：还在不在、怎么挂停手、怎么等一会儿，以及「已经准备
 * 好的范围变了，该重读了」。这样轮询不会活过页面本身。
 */
export interface Live {
  alive(): boolean
  onStop(stop: () => void): void
  sleep(ms: number): Promise<void>
  changed(): void
}

const indexAction = new WriteAction()
const planAction = new WriteAction()
const planControlAction = new WriteAction()
const retryAction = new WriteAction()

const SOURCES: readonly [
  { id: HistorySource; label: string; tip: string },
  { id: HistorySource; label: string; tip: string },
] = [
  {
    id: 'rest',
    label: '交易所接口',
    tip: '直接问币安要这段 K 线。只有还在交易的合约拿得到，最近的行情走这条最快。',
  },
  {
    id: 'monthly_archive',
    label: '官方月度归档',
    tip: '从币安发布的月度归档文件里取，每一份都核对校验值。退市的合约和早年的行情只有这里有。',
  },
]

/** 把正在准备的那几段摆出来。刷新页面之后还能接着看，因为编号记在本机。 */
export function runningPane(live: Live): HTMLElement {
  const host = h('div')
  for (const entry of prep.list()) host.appendChild(watchCard(entry, host, live))
  return host
}

/**
 * 一段正在准备的历史，从头看到尾。
 *
 * 这张卡片只做两件事：把后端此刻的状态用人话说出来，以及在它停下来等人的时候给出
 * 能按的按钮。它不替人做决定，也不把「不知道」显示成「在做」。
 */
export function watchCard(entry: prep.PrepEntry, host: HTMLElement, live: Live): HTMLElement {
  const card = h('div.prep')
  const head = h(
    'div.prephead',
    {},
    h('span.mono', { text: entry.symbol }),
    h('span.faint', {
      text: `${MARKET_LABELS[entry.market as Market] ?? entry.market} · ${entry.interval}`,
    }),
    h('span.faint', { text: `${shortDate(entry.start_at)} – ${shortDate(entry.end_at)}` }),
  )
  const line = h('div', { style: 'margin-top:8px' }, spinner('正在读进度…'))
  const acts = h('div.acts', { style: 'margin-top:8px' })
  card.append(head, line, acts)

  let stopped = false
  const done = (): void => {
    stopped = true
    prep.forget(entry.id)
  }
  live.onStop(() => {
    stopped = true
  })

  const say = (element: HTMLElement, ...buttons: HTMLElement[]): void => {
    line.replaceChildren(element)
    acts.replaceChildren(...buttons)
  }
  const drop = (): void => {
    card.classList.add('leaving')
    setTimeout(() => card.remove(), 260)
  }
  const closeBtn = (text: string) =>
    h('button.linkbtn', {
      type: 'button',
      text,
      on: {
        click: () => {
          done()
          drop()
        },
      },
    })

  async function watchJob(): Promise<void> {
    for (;;) {
      if (stopped || !live.alive()) return
      let job
      try {
        job = await jobs.get(entry.id)
      } catch (error) {
        if (stopped || !live.alive()) return
        if (error instanceof ApiError && error.status === 404) {
          done()
          say(note('warn', '这段准备工作已经不在了，重新准备一次吧。'), closeBtn('知道了'))
          return
        }
        say(note('warn', error instanceof Error ? error.message : '读不到这段的进度。'))
        await live.sleep(8_000)
        continue
      }
      if (stopped || !live.alive()) return
      if (jobs.isRunning(job)) {
        const said = jobs.jobLine(job.status)
        say(progressLine(said.text, said.progress))
        await live.sleep(4_000)
        continue
      }
      if (job.status === 'succeeded') {
        done()
        say(progressLine('这一段准备好了，可以按图搜索了', 1), closeBtn('收起'))
        toast('这段历史准备好了，可以按图搜索了。')
        live.changed()
        return
      }
      if (job.status === 'cancelled') {
        done()
        say(note('info', '这段准备已经取消。'), closeBtn('收起'))
        return
      }
      const why = job.error_code ? explain(job.error_code) : `${jobs.jobLine(job.status).text}。`
      say(
        note('warn', why),
        ...(jobs.canRetry(job) ? [retryBtn(job.id, job.generation)] : []),
        closeBtn('不再看这一段'),
      )
      return
    }
  }

  function retryBtn(
    id: Uuid,
    generation: number,
    resume: () => Promise<void> = watchJob,
  ): HTMLElement {
    const button = h('button.btn.sm', {
      type: 'button',
      text: '再试一次',
      on: {
        click: () => {
          button.disabled = true
          void jobs
            .retry(id, generation, retryAction.keyFor({ id, generation }))
            .then(() => {
              retryAction.reset()
              if (stopped || !live.alive()) return
              say(progressLine('重新排上队了', 0.1))
              void resume()
            })
            .catch((error: unknown) => {
              button.disabled = false
              problem(error instanceof Error ? error.message : '没能重新开始。')
            })
        },
      },
    }) as HTMLButtonElement
    return button
  }

  async function watchPlan(): Promise<void> {
    for (;;) {
      if (stopped || !live.alive()) return
      let plan
      try {
        plan = await plans.get(entry.id)
      } catch (error) {
        if (stopped || !live.alive()) return
        if (error instanceof ApiError && error.status === 404) {
          done()
          say(note('warn', '这段准备工作已经不在了，重新准备一次吧。'), closeBtn('知道了'))
          return
        }
        say(note('warn', error instanceof Error ? error.message : '读不到这段的进度。'))
        await live.sleep(8_000)
        continue
      }
      if (stopped || !live.alive()) return
      if (plan.status !== 'running') {
        paintPlan(plan)
        return
      }
      // 计划说自己在跑，不等于真的在跑：它靠一项后台任务一段一段往下走，那项任务
      // 停在需要人处理的地方时，计划这一行还是「running」。所以两边都要看一眼。
      const job = await jobs.get(entry.id).catch(() => null)
      if (stopped || !live.alive()) return
      if (job && jobs.needsPerson(job)) {
        say(
          note(
            'warn',
            job.error_code ? explain(job.error_code) : '这一段停下来了，要你决定接下来怎么办。',
          ),
          h('span.faint', {
            text: plan.completed_chunks ? `已经准备好 ${plan.completed_chunks} 段` : '还没有一段完成',
          }),
          ...(jobs.canRetry(job) ? [retryBtn(job.id, job.generation, watchPlan)] : []),
          controlBtn(plan, 'cancel', '不做了'),
        )
        return
      }
      paintPlan(plan)
      await live.sleep(5_000)
    }
  }

  function paintPlan(plan: HistoryPlan): void {
    const chunks = h('span.faint', {
      text: plan.completed_chunks ? `已经准备好 ${plan.completed_chunks} 段` : '还没有一段完成',
    })
    if (plan.status === 'completed') {
      done()
      say(progressLine(`这一段都准备好了，共 ${plan.completed_chunks} 段`, 1), closeBtn('收起'))
      toast('这段历史准备好了，可以按图搜索了。')
      live.changed()
      return
    }
    if (plan.status === 'cancelled') {
      done()
      say(note('info', '这段准备已经取消，已经做完的那几段还留着。'), closeBtn('收起'))
      return
    }
    if (plan.status === 'running') {
      say(
        progressLine('正在一段一段地准备，可以先去做别的', planProgress(plan)),
        chunks,
        controlBtn(plan, 'pause', '暂停'),
        controlBtn(plan, 'cancel', '不做了'),
      )
      return
    }
    if (plan.status === 'paused') {
      say(
        note('info', '已暂停。做完的那几段留着，继续之后从没做完的地方往下走。'),
        chunks,
        controlBtn(plan, 'resume', '继续'),
        controlBtn(plan, 'cancel', '不做了'),
      )
      return
    }
    say(
      note('warn', '中间有一段没有准备成功，停在这里了。可以从这里接着往下，也可以不做了。'),
      chunks,
      controlBtn(plan, 'resume', '接着往下'),
      controlBtn(plan, 'cancel', '不做了'),
    )
  }

  /**
   * 走到哪儿了。品种和周期各算一格，格子里按时间走到哪儿算比例——这是后端自己记下
   * 的位置，不是估出来的。
   */
  function planProgress(plan: HistoryPlan): number {
    const units = Math.max(1, plan.body.symbols.length * plan.body.intervals.length)
    const finished = plan.symbol_no * plan.body.intervals.length + plan.interval_no
    const from = Date.parse(plan.body.start_at)
    const to = Date.parse(plan.body.end_at)
    const at = Date.parse(plan.next_start)
    const within = to > from ? Math.min(1, Math.max(0, (at - from) / (to - from))) : 0
    return Math.min(0.99, (finished + within) / units)
  }

  function controlBtn(
    plan: HistoryPlan,
    action: 'pause' | 'resume' | 'cancel',
    text: string,
  ): HTMLElement {
    const button = h('button', {
      class: ['btn', 'sm', action === 'cancel' ? 'ghost' : ''],
      type: 'button',
      text,
      on: {
        click: () => {
          button.disabled = true
          const body = { expected_revision: plan.revision, action }
          void plans
            .control(plan.id, body, planControlAction.keyFor({ id: plan.id, ...body }))
            .then(() => {
              planControlAction.reset()
              if (stopped || !live.alive()) return
              void watchPlan()
            })
            .catch((error: unknown) => {
              button.disabled = false
              problem(error instanceof Error ? error.message : '这个操作没有生效。')
              // 状态被别处改过就重新读一次，按钮跟着换成对的那几个。
              void watchPlan()
            })
        },
      },
    }) as HTMLButtonElement
    return button
  }

  void (entry.kind === 'plan' ? watchPlan() : watchJob())
  host.prepend(card)
  return card
}

/** 准备一段新的历史。先能估一估，再决定要不要做。 */
export function prepareForm(live: Live, running: HTMLElement): HTMLElement {
  const today = new Date()
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  const query = pendingQuery()
  let symbol = query?.symbol ?? 'BTCUSDT'
  let market: Market = query?.market ?? defaultMarket()
  let interval: Interval = (query?.interval ?? '1h') as Interval
  let source: HistorySource = 'rest'
  let fullRange: { start: Date; end: Date } | null = null
  let rangeRequest = 0
  function invalidateRange(): void { fullRange = null; rangeRequest += 1 }
  const from = h('input.input', { type: 'date', value: iso(monthAgo) }) as HTMLInputElement
  const to = h('input.input', { type: 'date', value: iso(today) }) as HTMLInputElement
  const status = h('div', { style: 'margin-top:10px' })
  const sourceTip = h('div.tip', { text: SOURCES[0].tip })

  const symbolChip = popChip({
    label: () => symbol,
    active: () => true,
    search: '搜合约',
    items: async (query) => {
      const found = await findInstruments(query, { market })
      return found.length
        ? found.map((item) => ({ label: item.symbol, value: item.symbol }))
        : [{ label: '没有匹配的合约', value: '' }]
    },
    onPick: (value) => {
      if (!value) return
      invalidateRange()
      symbol = value
      symbolChip.refresh()
      size.refresh()
    },
    footer: () => '这里只列当前目录里的合约。退市的合约要走归档准备。',
  })
  const marketChip = popChip({
    label: () => MARKET_LABELS[market],
    active: () => true,
    items: () => [
      { label: MARKET_LABELS.usd_m, value: 'usd_m', on: market === 'usd_m' },
      { label: MARKET_LABELS.coin_m, value: 'coin_m', on: market === 'coin_m' },
    ],
    onPick: (value) => {
      invalidateRange()
      market = value as Market
      marketChip.refresh()
      size.refresh()
    },
  })
  const intervalChip = popChip({
    label: () => interval,
    active: () => true,
    items: () => INTERVALS.map((item) => ({ label: item, value: item, on: item === interval })),
    onPick: (value) => {
      invalidateRange()
      interval = value as Interval
      intervalChip.refresh()
      size.refresh()
    },
  })

  const sourceSeg = h('span.seg')
  for (const option of SOURCES) {
    sourceSeg.appendChild(
      h('button', {
        type: 'button',
        class: source === option.id ? 'on' : '',
        text: option.label,
        on: {
          click: () => {
            invalidateRange()
            source = option.id
            for (const button of sourceSeg.children) {
              button.classList.toggle('on', button.textContent === option.label)
            }
            sourceTip.textContent = option.tip
          },
        },
      }),
    )
  }

  // 这段时间有多长，页面自己先算一遍：一次装得下就一次做完，装不下就交给后端分段
  // 做。两种做法的区别只在这一行字里说清楚，不必让人自己去凑时间段。
  const size = {
    node: h('span.faint', { text: '' }),
    refresh(): void {
      const plan = shape()
      this.node.textContent = plan
        ? plan.windows > 0
          ? `${plan.bars} 根 K 线，切成 ${plan.windows} 个片段` +
            (plan.split ? '，会分成几段陆续准备' : '')
          : '这段时间太短了，装不下一个片段。'
        : ''
    },
  }
  from.addEventListener('change', () => { invalidateRange(); size.refresh() })
  to.addEventListener('change', () => { invalidateRange(); size.refresh() })

  function bounds(): { start: Date; end: Date } | null {
    if (fullRange) return fullRange
    const start = new Date(`${from.value}T00:00:00Z`)
    const end = new Date(`${to.value}T00:00:00Z`)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null
    return { start, end }
  }

  function shape(): { bars: number; windows: number; split: boolean } | null {
    const range = bounds()
    if (!range) return null
    const seconds = INTERVAL_SECONDS[interval]
    const bars = Math.floor((range.end.getTime() - range.start.getTime()) / 1000 / seconds)
    const windows = bars < WINDOW_BARS ? 0 : Math.floor((bars - WINDOW_BARS) / STRIDE_BARS) + 1
    return { bars, windows, split: Boolean(fullRange) || bars > MAX_BARS_PER_REQUEST || windows > MAX_WINDOWS }
  }
  size.refresh()

  const lifetime = h('button.btn.sm.ghost', {
    type: 'button', text: '从上线到最新收盘',
    on: { click: async () => {
      const generation = ++rangeRequest
      lifetime.disabled = true
      try {
        if (source !== 'rest') throw new Error('这个快捷范围使用已核实的上线时间，请先选择交易所接口。归档范围请按实际可用日期填写。')
        const range = await lifecycleRange(market, symbol, interval)
        if (!live.alive() || generation !== rangeRequest) return
        fullRange = range
        from.value = range.start.toISOString().slice(0, 10)
        to.value = range.end.toISOString().slice(0, 10)
        size.refresh()
        status.replaceChildren(note('info', `已选择 ${range.start.toISOString()} 至 ${range.end.toISOString()}（UTC），周期 ${interval}。这里只选择范围；点击“准备这一段”才会拉取数据，不会自动订阅。`))
      } catch (error) {
        if (live.alive() && generation === rangeRequest) problem(error instanceof Error ? error.message : '读不到合约上线时间。')
      } finally { lifetime.disabled = false }
    } },
  }) as HTMLButtonElement

  const guess = h('button.btn.sm.ghost', {
    type: 'button',
    text: '先估一估',
    on: {
      click: () => {
        const range = bounds()
        if (!range) {
          problem('请选好开始和结束日期。')
          return
        }
        guess.disabled = true
        status.replaceChildren(spinner('正在估这一段有多大…'))
        void estimateRange({
          market,
          symbols: [symbol],
          intervals: [interval],
          start_at: range.start.toISOString(),
          end_at: range.end.toISOString(),
        })
          .then((result) => {
            guess.disabled = false
            if (!live.alive()) return
            status.replaceChildren(estimatePane(result))
          })
          .catch((error: unknown) => {
            guess.disabled = false
            if (!live.alive()) return
            status.replaceChildren(
              note('warn', error instanceof Error ? error.message : '这一段估不出来。'),
            )
          })
      },
    },
  }) as HTMLButtonElement

  const start = h('button.btn.sm.primary', {
    type: 'button',
    text: '准备这一段',
    on: {
      click: () => {
        const range = bounds()
        if (!range) {
          problem('结束日期要晚于开始日期。')
          return
        }
        const plan = shape()
        if (!plan || plan.windows === 0) {
          problem(`这段时间装不下一个片段，至少要有 ${WINDOW_BARS} 根 ${interval} K 线。`)
          return
        }
        start.disabled = true
        void prepare(
          {
            source,
            symbol,
            market,
            interval,
            start_at: range.start.toISOString(),
            end_at: range.end.toISOString(),
            window_bars: WINDOW_BARS,
            stride_bars: STRIDE_BARS,
            models: [GEOMETRY_MODEL],
          },
          plan.split,
          status,
          running,
          live,
        ).finally(() => {
          start.disabled = false
        })
      },
    },
  }) as HTMLButtonElement

  return h(
    'div.stack',
    { style: 'gap:12px' },
    h('div.tip', {
      text: '准备一段历史，就是把这段行情按固定长度切开、逐段记下 K 线的几何特征，之后才能用图去找。原始 K 线和画出来的图都不会留下来。',
    }),
    h('div.filters', {}, symbolChip.node, marketChip.node, intervalChip.node),
    h(
      'div.row',
      { style: 'gap:10px;flex-wrap:wrap' },
      h('label.faint', {}, '从 ', from),
      h('label.faint', {}, '到 ', to),
      lifetime,
    ),
    h(
      'div',
      {},
      h('div.sh', { style: 'margin-bottom:9px' }, h('span.eyebrow.noline', { text: '从哪里取' })),
      sourceSeg,
      sourceTip,
    ),
    h(
      'div.acts',
      {},
      start,
      guess,
      h('span.faint', { text: `每段 ${WINDOW_BARS} 根 K 线，每 ${STRIDE_BARS} 根取一段。` }),
      size.node,
    ),
    status,
  )
}

/** 后端估出来的上限，照它自己的口径说：这是上限，不是实际会有多少。 */
export function estimatePane(result: Estimate): HTMLElement {
  const box = h('div.kv', { style: 'margin-top:6px' })
  const row = (label: string, value: string) =>
    h('div.kvrow', {}, h('span.k', { text: label }), h('span.v', { text: value }))
  box.appendChild(row('要准备的合约', `${result.symbols} 个`))
  box.appendChild(row('最多会存下多少个片段', `${result.upper_bound_vectors.toLocaleString()} 个`))
  box.appendChild(row('这些片段大约占多少', bytes(result.vector_payload_bytes)))
  box.appendChild(row('现在已经存了多少', `${bytes(result.observed_feature_table_bytes)}，约 ${result.approximate_observed_rows.toLocaleString()} 个片段`))
  return h(
    'div',
    {},
    box,
    h('div.tip', {
      text: '这是按你报的时间范围算的上限，还没有去问来源那边真有多少；实际只会更少。占用的空间也没算索引本身。',
    }),
  )
}

function bytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit += 1
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`
}

/**
 * 把一段历史交给后端去准备。装得下走一次请求，装不下交给分段计划——区别只有一个：
 * 交出去之后拿到的是哪一种编号。
 */
async function prepare(
  input: {
    source: HistorySource
    symbol: string
    market: Market
    interval: string
    start_at: string
    end_at: string
    window_bars: number
    stride_bars: number
    models: HistoryModel[]
  },
  split: boolean,
  status: HTMLElement,
  running: HTMLElement,
  live: Live,
): Promise<void> {
  status.replaceChildren(spinner('正在安排这段历史…'))
  try {
    const id = split
      ? (
          await plans.create(
            {
              source: input.source,
              symbols: [input.symbol],
              market: input.market,
              intervals: [input.interval],
              start_at: input.start_at,
              end_at: input.end_at,
              window_bars: input.window_bars,
              stride_bars: input.stride_bars,
              models: input.models,
            },
            planAction.keyFor(input),
          )
        ).plan_id
      : (await requestIndex(input, indexAction.keyFor(input))).job_id
    if (split) planAction.reset()
    else indexAction.reset()
    if (!live.alive()) return
    const entry: prep.PrepEntry = {
      kind: split ? 'plan' : 'index',
      id,
      symbol: input.symbol,
      market: input.market,
      interval: input.interval,
      start_at: input.start_at,
      end_at: input.end_at,
      started_at: new Date().toISOString(),
    }
    prep.remember(entry)
    status.replaceChildren(
      h('div.tip', { text: '已经交给后端了，进度在上面那一段里看，关掉页面也不影响。' }),
    )
    stagger([watchCard(entry, running, live)])
  } catch (error) {
    if (!live.alive()) return
    status.replaceChildren(
      note('warn', error instanceof Error ? error.message : '这段历史没有安排上。'),
    )
  }
}

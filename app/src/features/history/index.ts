// 公开历史 —— 按图去公开行情里找同类局面，靠的是这里准备出来的东西。
//
// 三件事长得像，但完全不是一回事，页面上也分成三段摆着：
//
//   合约目录     币安上有过哪些合约，什么时候上的、退没退。目录里有，不代表那段
//                历史现在拿得到。
//   现在能搜到   已经发布出去的那些代次。只有这些段，按图搜索才可能命中。
//   正在准备     交给后端在做的那些。做完之前它们不在检索范围里。
//
// 一段历史搜不到，可能是这里没准备过，也可能是准备了但那一段中间有缺口没发布出去
// ——两种情况这页都会直说，不会让人误以为是「我没写过这种局面」。
//
// 准备好的只有 K 线的几何特征。原始行情和系统画出来的图都不留，所以这页看不到
// 「历史行情库」这种东西，也不该有。

import { ApiError, explain, known } from '../../api/errors'
import { awake } from '../../ui/awake'
import { Latest, WriteAction } from '../../api/http'
import {
  allIndexes,
  archiveCatalog,
  catalog,
  publishedCoverage,
  refreshCatalog,
  revalidate,
  subscribe,
  subscription,
  subscriptionBudget,
  subscriptionControl,
  type ArchiveFile,
  type CatalogEntry,
  type CoverageEntry,
  type HistorySource,
  type Subscription,
} from '../../api/history'
import * as jobs from '../../api/jobs'
import type { HistoryIndexRecord, JobStatus, Market, Uuid } from '../../api/types'
import * as prep from '../../data/prep'
import { pendingQuery } from '../../data/query-context'
import { icon } from '../../ui/icons'
import {
  INTERVALS,
  MARKET_LABELS,
  defaultMarket,
  findInstruments,
  type Interval,
} from '../../data/session'
import { dateTime, shortDate } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { popChip } from '../../ui/pop'
import { note, progressLine, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { prepareForm, runningPane, type Live } from './prepare'

/** 认得的码翻成人话；认不得的把后端的原话摆出来，不用一句通用的话盖过去。 */
function whyStopped(code: string | null, fallback: string): string {
  if (!code) return fallback
  return known(code) ? explain(code) : `后端停在这里，它给的说法是「${code}」。`
}

const refreshAction = new WriteAction()
const revalidateAction = new WriteAction()
const followAction = new WriteAction()
const followControlAction = new WriteAction()
const budgetAction = new WriteAction()
const retryAction = new WriteAction()

/** 后台任务停在这些状态上，就是在等人，不会自己往下走。 */
const STALLED = new Set<JobStatus>(['needs_attention', 'blocked_capability', 'awaiting_input', 'failed'])
const lane = new Latest()

export function historyPage(host: HTMLElement): () => void {
  let alive = true
  const stops: (() => void)[] = []
  const timers = new Set<number>()

  const live: Live = {
    alive: () => alive,
    onStop: (stop) => stops.push(stop),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(() => {
          timers.delete(id)
          // 页面在后台就先不问，等它回到眼前再继续。
          void awake().then(resolve)
        }, ms)
        timers.add(id)
      }),
    changed: () => {
      readyRefresh?.()
      coverageRefresh?.()
    },
  }

  let readyRefresh: (() => void) | null = null
  let coverageRefresh: (() => void) | null = null

  const back = backToQuery()
  host.append(headSheet())
  if (back) host.append(back)
  host.append(
    coverageSheet(live, (fn) => {
      coverageRefresh = fn
    }),
    prepareSheet(live),
    readySheet(live, (fn) => {
      readyRefresh = fn
    }),
    followSheet(live),
    catalogSheet(live),
  )

  return () => {
    alive = false
    lane.cancel()
    for (const stop of stops) stop()
    for (const id of timers) window.clearTimeout(id)
    timers.clear()
  }
}

/**
 * 从检索结果点「去准备历史」过来的，页面顶上给一条回去的路。图、框、周期和
 * 范围都还在检索页那边原封不动，所以这里只是一条链接，不需要重传什么。
 * 直接打开这一页的人看不到它。
 */
function backToQuery(): HTMLElement | null {
  const context = pendingQuery()
  if (!context) return null
  const where = context.scope === 'private' ? '我的记录库' : '币安公开历史'
  return h(
    'div.backq',
    {},
    h('span.ic', {}, icon('search')),
    h(
      'div.b',
      {},
      h('b', { text: '刚才那次检索还留着' }),
      h('span', {
        text: context.interval
          ? `那张查询图、框选的范围和 ${context.interval} 周期都在原处，范围是${where}。准备完这一段就可以直接回去再搜一次。`
          : `那张查询图和框选的范围都在原处，范围是${where}。准备完这一段就可以直接回去再搜一次。`,
      }),
    ),
    h('a.btn.sm', { href: '#/search', text: '回到刚才那次检索' }),
  )
}

/* --------------------------------------------------------------- 抬头 */

function headSheet(): HTMLElement {
  return h(
    'div.sheet.pad',
    {},
    h('h1.h1', { text: '公开历史' }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:64ch',
      text: '按图去公开行情里找同类局面，只能在这里准备过的时间段里找。没准备过的那段不会出现在结果里——那是还没做，不是那种局面没出现过。',
    }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:64ch',
      text: '准备下来的只有每段 K 线的几何特征。原始行情和画出来的图都不会留下来，所以这里不是一个行情库。',
    }),
  )
}

/* ------------------------------------------------- 现在真的能搜到哪些 */

function coverageSheet(live: Live, expose: (fn: () => void) => void): HTMLElement {
  const right = h('span.faint', { style: 'margin-left:auto', text: '正在读…' })
  const rows = h('div', { style: 'padding:6px 18px 0' })
  const foot = h('div', { style: 'padding:10px 18px 16px' })
  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '现在能搜到哪些' }), right),
    rows,
    foot,
  )

  let cursor: string | null = null
  let count = 0
  let scope = ''
  let cutoff: string | null = null

  const more = h('button.btn.sm.ghost', {
    type: 'button',
    text: '再看一些',
    on: {
      click: () => {
        more.disabled = true
        void load(false).finally(() => {
          more.disabled = false
        })
      },
    },
  }) as HTMLButtonElement

  async function load(fresh: boolean): Promise<void> {
    if (fresh) {
      cursor = null
      count = 0
      clear(rows)
      clear(foot)
      rows.appendChild(spinner('正在读已经发布的范围…'))
    }
    try {
      const page = await publishedCoverage({ cursor: cursor ?? undefined })
      if (!live.alive()) return
      scope = page.scope
      cutoff = page.cutoff_at
      cursor = page.next_cursor
      count += page.items.length
      if (fresh) clear(rows)
      if (fresh && !page.items.length) {
        rows.appendChild(
          h('div.tip', {
            text: '还没有任何一段发布出来。下面先准备一段，准备完了才能在公开历史里按图搜索。',
          }),
        )
      }
      stagger(page.items.map((entry) => rows.appendChild(coverageRow(entry))))
      right.textContent = count ? `${count}${cursor ? '+' : ''} 段已发布` : '还没有'
      paintFoot()
    } catch (error) {
      if (!live.alive()) return
      if (fresh) clear(rows)
      rows.appendChild(
        note('warn', error instanceof Error ? error.message : '读不到已经发布的范围。'),
      )
      right.textContent = ''
    }
  }

  function paintFoot(): void {
    clear(foot)
    if (cursor) foot.appendChild(more)
    const lines: string[] = []
    if (cutoff) lines.push(`只算 ${dateTime(cutoff)} 之前起点的那些段。`)
    if (scope === 'published_derived_market_only') {
      lines.push('这里列的都是公开行情算出来的特征；原始 K 线和系统画的图都没有留。')
    } else if (scope) {
      lines.push(`范围口径：${scope}`)
    }
    if (lines.length) foot.appendChild(h('div.tip', { text: lines.join(' ') }))
  }

  void load(true)
  expose(() => void load(true))
  return box
}

/** 一段已经发布的覆盖。缺口和跳过的片段要说出来，不然搜不到会被当成没写过。 */
function coverageRow(entry: CoverageEntry): HTMLElement {
  const c = entry.coverage
  const row = h(
    'div.covrow',
    {},
    h('span.badge.ready', { text: '可以搜' }),
    h('span.mono', { text: c.symbol }),
    h('span', { text: `${MARKET_LABELS[c.market] ?? c.market} · ${c.interval}` }),
    h('span', {
      text: c.actual_start
        ? `${shortDate(c.actual_start)} – ${shortDate(c.actual_end)}`
        : `${shortDate(c.requested_start)} – ${shortDate(c.requested_end)}（实际取到多少没有记下来）`,
    }),
    h('span.faint', {
      style: 'margin-left:auto',
      text: `${c.feature_rows.toLocaleString()} 个片段`,
    }),
  )
  if (!c.source_range_complete) {
    row.appendChild(
      h('span.faint', {
        title: '这一段行情中间有缺口，缺口那几段没有发布出去，按图搜索也搜不到那里。',
        text: '中间有缺口',
      }),
    )
  }
  if (c.windows_skipped_for_gaps > 0) {
    row.appendChild(h('span.faint', { text: `跳过 ${c.windows_skipped_for_gaps} 个片段` }))
  }
  row.appendChild(h('span.faint', { text: `发布于 ${shortDate(entry.published_at)}` }))
  return row
}

/* ------------------------------------------------------- 准备新的一段 */

function prepareSheet(live: Live): HTMLElement {
  const running = runningPane(live)
  return h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '准备一段历史' })),
    h('div', { style: 'padding:0 18px' }, running),
    h('div', { style: 'padding:0 18px 16px' }, prepareForm(live, running)),
  )
}

/* --------------------------------------------- 准备过的那些 / 来源订正 */

function readySheet(live: Live, expose: (fn: () => void) => void): HTMLElement {
  const right = h('span.faint', { style: 'margin-left:auto', text: '正在读…' })
  const rows = h('div', { style: 'padding:6px 18px 16px' })
  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '准备过的范围' }), right),
    rows,
    h('div', { style: 'padding:0 18px 16px' }, h('div.tip', {
      text: '怀疑某一段当初取错了，可以让它重新去源头取一遍并核对校验。核出来的是新的一代，旧的一代原样留着——同一段历史现在读出来不一样了，这件事本身要留档。',
    })),
  )

  const refresh = (): void => {
    void allIndexes()
      .then((list) => {
        if (!live.alive()) return
        right.textContent = list.length ? `${list.length} 段` : '还没有'
        clear(rows)
        if (!list.length) {
          rows.appendChild(h('div.tip', { text: '还没有准备过任何范围。' }))
          return
        }
        for (const row of list.slice().reverse().slice(0, 12)) {
          rows.appendChild(readyRow(row, live))
        }
        if (list.length > 12) {
          rows.appendChild(h('div.tip', { text: `另外还有 ${list.length - 12} 段，这里只列最近的。` }))
        }
      })
      .catch(() => {
        if (!live.alive()) return
        right.textContent = ''
        clear(rows)
        rows.appendChild(h('div.tip', { text: '读不到已准备的范围，稍后再看。' }))
      })
  }
  refresh()
  expose(refresh)
  return box
}

function readyRow(row: HistoryIndexRecord, live: Live): HTMLElement {
  const ready = row.status === 'ready'
  const b = row.body
  const line = h(
    'div.covrow',
    {},
    h('span', { class: ['badge', ready ? 'ready' : 'wait'], text: ready ? '可以搜' : '准备中' }),
    h('span.mono', { text: b.symbol }),
    h('span', { text: `${MARKET_LABELS[b.market] ?? b.market} · ${b.interval}` }),
    h('span', { text: `${shortDate(b.start_at)} – ${shortDate(b.end_at)}` }),
  )
  const tail = h('span', { style: 'margin-left:auto;display:inline-flex;gap:10px;align-items:center' })
  line.appendChild(tail)
  if (ready && row.coverage) {
    const c = row.coverage
    tail.appendChild(
      h('span.faint', {
        text: c.source_range_complete
          ? `${c.source_bars_fetched} 根 K 线，全段完整`
          : `${c.source_bars_fetched} 根 K 线，中间有缺口`,
      }),
    )
  } else if (!ready) {
    tail.appendChild(h('span.faint', { text: '正在准备这段历史' }))
  }
  if (ready) tail.appendChild(recheckBtn(row.id, live))
  return line
}

function recheckBtn(indexId: Uuid, live: Live): HTMLElement {
  const button = h('button.linkbtn', {
    type: 'button',
    text: '重新核对来源',
    on: {
      click: () => {
        button.disabled = true
        void revalidate(indexId, revalidateAction.keyFor({ indexId }))
          .then((started) => {
            revalidateAction.reset()
            if (!live.alive()) return
            toast('已经开始重新取这一段并核对校验，做完会成为新的一代。')
            const said = h('span.faint', { text: '正在重新核对来源…' })
            button.replaceWith(said)
            void watchOne(started.job_id, said, live)
          })
          .catch((error: unknown) => {
            button.disabled = false
            problem(error instanceof Error ? error.message : '没能开始重新核对。')
          })
      },
    },
  }) as HTMLButtonElement
  return button
}

/** 盯着一项后台作业，把结论写回一小段文字里。 */
async function watchOne(id: Uuid, slot: HTMLElement, live: Live): Promise<void> {
  for (;;) {
    if (!live.alive()) return
    let job
    try {
      job = await jobs.get(id)
    } catch (error) {
      if (!live.alive()) return
      if (error instanceof ApiError && error.status === 404) {
        slot.textContent = '这项工作已经不在了。'
        return
      }
      await live.sleep(8_000)
      continue
    }
    if (!live.alive()) return
    if (jobs.isRunning(job)) {
      slot.textContent = `${jobs.jobLine(job.status).text}…`
      await live.sleep(5_000)
      continue
    }
    if (job.status === 'succeeded') {
      slot.textContent = '核对完了，这一段有了新的一代。'
      live.changed()
      return
    }
    slot.textContent = whyStopped(job.error_code, `${jobs.jobLine(job.status).text}。`)
    return
  }
}

/* --------------------------------------------------------- 一直跟着做 */

function followSheet(live: Live): HTMLElement {
  const list = h('div', { style: 'padding:6px 18px 0' })
  const form = h('div', { style: 'padding:0 18px 16px' })
  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '一直跟着做' })),
    h(
      'div',
      { style: 'padding:0 18px' },
      h('div.tip', {
        text: '让后端从某个起点一直往前准备下去，新收完的时间段自动接上。一个周期最多写多少条特征由你定，超了它会停下来问你，而不是先做一半。',
      }),
      h('div.tip', {
        style: 'margin-top:6px',
        text: '在跟哪几个是记在这台机器上的。换一台机器打开，这份名单是空的，但后端那边照样在跟。',
      }),
    ),
    list,
    form,
  )

  const entries = prep.follows()
  if (!entries.length) {
    list.appendChild(h('div.tip', { text: '现在没有在跟的合约。' }))
  }
  for (const entry of entries) list.appendChild(followCard(entry, live))
  form.appendChild(followForm(list, live))
  return box
}

function followForm(list: HTMLElement, live: Live): HTMLElement {
  let symbol = 'BTCUSDT'
  let market: Market = defaultMarket()
  let interval: Interval = '1h'
  let source: HistorySource = 'rest'
  const since = h('input.input', {
    type: 'date',
    value: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10),
  }) as HTMLInputElement
  const budget = h('input.input', {
    type: 'number',
    value: '200000',
    style: 'width:130px',
    attrs: { min: '1000', step: '1000' },
  }) as HTMLInputElement
  const status = h('div', { style: 'margin-top:10px' })

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
      symbol = value
      symbolChip.refresh()
    },
  })
  const marketChip = popChip({
    label: () => MARKET_LABELS[market],
    active: () => true,
    items: () => [
      { label: MARKET_LABELS.usd_m, value: 'usd_m', on: market === 'usd_m' },
      { label: MARKET_LABELS.coin_m, value: 'coin_m', on: market === 'coin_m' },
    ],
    onPick: (value) => {
      market = value as Market
      marketChip.refresh()
    },
  })
  const intervalChip = popChip({
    label: () => interval,
    active: () => true,
    items: () => INTERVALS.map((item) => ({ label: item, value: item, on: item === interval })),
    onPick: (value) => {
      interval = value as Interval
      intervalChip.refresh()
    },
  })
  const sourceChip = popChip({
    label: () => (source === 'rest' ? '交易所接口' : '官方月度归档'),
    active: () => true,
    items: () => [
      { label: '交易所接口', value: 'rest', on: source === 'rest' },
      { label: '官方月度归档', value: 'monthly_archive', on: source === 'monthly_archive' },
    ],
    onPick: (value) => {
      source = value as HistorySource
      sourceChip.refresh()
    },
  })

  const start = h('button.btn.sm.primary', {
    type: 'button',
    text: '开始跟这个',
    on: {
      click: () => {
        const from = new Date(`${since.value}T00:00:00Z`)
        const max = Number(budget.value)
        if (Number.isNaN(from.getTime())) {
          problem('请选一个起点日期。')
          return
        }
        if (!Number.isFinite(max) || max <= 0) {
          problem('一个周期最多写多少条特征，要填一个大于 0 的数。')
          return
        }
        const input = {
          market,
          symbols: [symbol],
          intervals: [interval],
          start_at: from.toISOString(),
          source,
          max_vectors: Math.round(max),
        }
        start.disabled = true
        status.replaceChildren(spinner('正在安排…'))
        void subscribe(input, followAction.keyFor(input))
          .then((started) => {
            followAction.reset()
            start.disabled = false
            if (!live.alive()) return
            const entry: prep.FollowEntry = {
              id: started.subscription_id,
              market,
              symbols: [symbol],
              intervals: [interval],
              start_at: input.start_at,
              source,
              started_at: new Date().toISOString(),
            }
            prep.rememberFollow(entry)
            status.replaceChildren(
              h('div.tip', {
                text: `已经开始跟了。按你报的范围，这一轮最多会写下 ${started.estimate.upper_bound_vectors.toLocaleString()} 个片段——这是上限，实际只会更少。`,
              }),
            )
            if (list.firstChild?.textContent === '现在没有在跟的合约。') list.firstChild.remove()
            stagger([list.appendChild(followCard(entry, live))])
          })
          .catch((error: unknown) => {
            start.disabled = false
            if (!live.alive()) return
            status.replaceChildren(
              note('warn', error instanceof Error ? error.message : '没能开始跟这个合约。'),
            )
          })
      },
    },
  }) as HTMLButtonElement

  return h(
    'div.stack',
    { style: 'gap:12px;margin-top:12px' },
    h('div.filters', {}, symbolChip.node, marketChip.node, intervalChip.node, sourceChip.node),
    h(
      'div.row',
      { style: 'gap:10px;flex-wrap:wrap;align-items:center' },
      h('label.faint', {}, '从 ', since, ' 起'),
      h('label.faint', {}, '一个周期最多 ', budget, ' 个片段'),
    ),
    h('div.acts', {}, start),
    status,
  )
}

/** 一个正在跟的合约：它现在在做什么，以及此刻能按的那几个按钮。 */
function followCard(entry: prep.FollowEntry, live: Live): HTMLElement {
  const card = h('div.prep')
  const head = h(
    'div.prephead',
    {},
    h('span.mono', { text: entry.symbols.join('、') }),
    h('span.faint', {
      text: `${MARKET_LABELS[entry.market as Market] ?? entry.market} · ${entry.intervals.join('、')}`,
    }),
    h('span.faint', {
      text: `${shortDate(entry.start_at)} 起 · ${entry.source === 'rest' ? '交易所接口' : '官方月度归档'}`,
    }),
  )
  const line = h('div', { style: 'margin-top:8px' }, spinner('正在读状态…'))
  const acts = h('div.acts', { style: 'margin-top:8px' })
  card.append(head, line, acts)

  let stopped = false
  live.onStop(() => {
    stopped = true
  })
  const drop = (): void => {
    prep.forgetFollow(entry.id)
    card.classList.add('leaving')
    setTimeout(() => card.remove(), 260)
  }

  async function watch(): Promise<void> {
    for (;;) {
      if (stopped || !live.alive()) return
      let row: Subscription
      try {
        row = await subscription(entry.id)
      } catch (error) {
        if (stopped || !live.alive()) return
        if (error instanceof ApiError && error.status === 404) {
          line.replaceChildren(note('warn', '这条跟进已经不在了。'))
          acts.replaceChildren(h('button.linkbtn', { type: 'button', text: '收起', on: { click: drop } }))
          return
        }
        line.replaceChildren(
          note('warn', error instanceof Error ? error.message : '读不到这条跟进的状态。'),
        )
        await live.sleep(10_000)
        continue
      }
      if (stopped || !live.alive()) return
      paint(row)
      if (row.status !== 'active') return
      await live.sleep(15_000)
    }
  }

  function paint(row: Subscription): void {
    const where = row.watermark
      ? `已经做到 ${dateTime(row.watermark)}`
      : '还没有确认做完的时间段'
    const stats = h('span.faint', { text: `${where} · 第 ${row.cycle} 轮` })

    if (row.status === 'cancelled') {
      line.replaceChildren(note('info', '这条跟进已经不做了，之前做完的那些段还留着。'))
      acts.replaceChildren(h('button.linkbtn', { type: 'button', text: '收起', on: { click: drop } }))
      return
    }
    if (row.status === 'needs_attention') {
      line.replaceChildren(
        note('warn', whyStopped(row.error_code, '这条跟进停下来了，要你决定接下来怎么办。')),
      )
      acts.replaceChildren(
        stats,
        budgetBtn(row),
        controlBtn(row, 'resume', '接着做'),
        controlBtn(row, 'cancel', '不跟了'),
      )
      return
    }
    if (row.status === 'paused') {
      line.replaceChildren(note('info', '已暂停。做完的那些段留着，继续之后从水位往下走。'))
      acts.replaceChildren(
        stats,
        budgetBtn(row),
        controlBtn(row, 'resume', '继续'),
        controlBtn(row, 'cancel', '不跟了'),
      )
      return
    }
    // 跟进本身还写着「在跟」，不等于这一轮真的在往前走：它靠一项后台任务推进，那项
    // 任务停在等人的地方时，这一行还是 active。两边都要看，停住了就直说。
    const jobStatus = row.job_status as JobStatus | null
    if (jobStatus && STALLED.has(jobStatus)) {
      line.replaceChildren(
        note('warn', whyStopped(row.error_code, `这一轮${jobs.jobLine(jobStatus).text}。`)),
      )
      acts.replaceChildren(
        stats,
        ...(row.job_id ? [againBtn(row.job_id)] : []),
        controlBtn(row, 'pause', '先停下'),
        controlBtn(row, 'cancel', '不跟了'),
      )
      return
    }
    const said = jobStatus
      ? jobs.jobLine(jobStatus)
      : { text: `下一轮在 ${dateTime(row.next_run_at)}`, progress: 0 }
    line.replaceChildren(progressLine(said.text, said.progress))
    acts.replaceChildren(stats, controlBtn(row, 'pause', '暂停'), controlBtn(row, 'cancel', '不跟了'))
  }

  /** 让停住的那一轮重来一次。能不能重来是后端说了算，所以先把这项任务读回来。 */
  function againBtn(jobId: Uuid): HTMLElement {
    const button = h('button.btn.sm', {
      type: 'button',
      text: '再试一次',
      on: {
        click: () => {
          button.disabled = true
          void jobs
            .get(jobId)
            .then(async (job) => {
              if (!jobs.canRetry(job)) {
                problem('这一轮不能就这么重来，得先改配额或者换个做法。')
                button.disabled = false
                return
              }
              await jobs.retry(job.id, job.generation, retryAction.keyFor({ id: job.id, g: job.generation }))
              retryAction.reset()
              if (stopped || !live.alive()) return
              void watch()
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

  function controlBtn(
    row: Subscription,
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
          const body = { expected_revision: row.revision, action }
          void subscriptionControl(row.id, body, followControlAction.keyFor({ id: row.id, ...body }))
            .then(() => {
              followControlAction.reset()
              if (stopped || !live.alive()) return
              void watch()
            })
            .catch((error: unknown) => {
              button.disabled = false
              problem(error instanceof Error ? error.message : '这个操作没有生效。')
              // 版本对不上说明别处动过了：把新状态读回来，不盲重试盖过去。
              void watch()
            })
        },
      },
    }) as HTMLButtonElement
    return button
  }

  /** 配额只有停着的时候能改，改完还要自己按继续——后端就是这么规定的，照说。 */
  function budgetBtn(row: Subscription): HTMLElement {
    const now = row.body.definition.max_vectors
    const button = h('button.linkbtn', {
      type: 'button',
      text: '放大这一轮的配额',
      on: { click: () => openEditor() },
    }) as HTMLButtonElement

    function openEditor(): void {
      const field = h('input.input', {
        type: 'number',
        value: String(now * 2),
        style: 'width:130px',
        attrs: { min: '1', step: '1000' },
      }) as HTMLInputElement
      const save = h('button.btn.sm', {
        type: 'button',
        text: '就这么多',
        on: {
          click: () => {
            const max = Number(field.value)
            if (!Number.isFinite(max) || max <= 0) {
              problem('要填一个大于 0 的数。')
              return
            }
            save.disabled = true
            const body = { expected_revision: row.revision, max_vectors: Math.round(max) }
            void subscriptionBudget(row.id, body, budgetAction.keyFor({ id: row.id, ...body }))
              .then((result) => {
                budgetAction.reset()
                if (stopped || !live.alive()) return
                toast(
                  result.next_action === 'resume'
                    ? '配额改好了。它还停着，按「继续」才会接着做。'
                    : '配额改好了。',
                )
                void watch()
              })
              .catch((error: unknown) => {
                save.disabled = false
                problem(error instanceof Error ? error.message : '配额没能改。')
                // 版本对不上说明别处动过了：读回来再说，不盲重试盖过去。
                void watch()
              })
          },
        },
      }) as HTMLButtonElement
      const editor = h(
        'span',
        { style: 'display:inline-flex;gap:8px;align-items:center' },
        h('span.faint', { text: `现在是每轮 ${now.toLocaleString()} 个片段，改成` }),
        field,
        save,
        h('button.linkbtn', {
          type: 'button',
          text: '算了',
          on: { click: () => editor.replaceWith(button) },
        }),
      )
      button.replaceWith(editor)
      field.focus()
      field.select()
    }

    return button
  }

  void watch()
  return card
}

/* ------------------------------------------------------------ 合约目录 */

/** 归档文件按周期分开存；这一页列月份的时候统一按这个周期问，界面上也照实说。 */
const ARCHIVE_PROBE_INTERVAL = '1h'

function catalogSheet(live: Live): HTMLElement {
  const right = h('span.faint', { style: 'margin-left:auto' })
  const rows = h('div', { style: 'padding:6px 18px 0' })
  const foot = h('div', { style: 'padding:10px 18px 16px' })
  let market: Market = defaultMarket()
  let symbol = ''
  let cursor: string | null = null
  let policy = ''

  const search = h('input.input', {
    type: 'search',
    placeholder: '合约名要写全，比如 BTCUSDT',
    style: 'max-width:240px',
  }) as HTMLInputElement
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    symbol = search.value.trim().toUpperCase()
    void load(true)
  })
  search.addEventListener('search', () => {
    symbol = search.value.trim().toUpperCase()
    void load(true)
  })

  const marketChip = popChip({
    label: () => MARKET_LABELS[market],
    active: () => true,
    items: () => [
      { label: MARKET_LABELS.usd_m, value: 'usd_m', on: market === 'usd_m' },
      { label: MARKET_LABELS.coin_m, value: 'coin_m', on: market === 'coin_m' },
    ],
    onPick: (value) => {
      market = value as Market
      marketChip.refresh()
      void load(true)
    },
  })

  const recheck = h('button.btn.sm.ghost', {
    type: 'button',
    text: '重新核对目录',
    on: {
      click: () => {
        recheck.disabled = true
        void refreshCatalog(refreshAction.keyFor({ what: 'catalog' }))
          .then((started) => {
            refreshAction.reset()
            if (!live.alive()) return
            const said = h('span.faint', { text: '正在核对目录…' })
            right.replaceChildren(said)
            void watchOne(started.job_id, said, live).then(() => {
              recheck.disabled = false
              void load(true)
            })
          })
          .catch((error: unknown) => {
            recheck.disabled = false
            problem(error instanceof Error ? error.message : '没能开始核对目录。')
          })
      },
    },
  }) as HTMLButtonElement

  const more = h('button.btn.sm.ghost', {
    type: 'button',
    text: '再列一些',
    on: {
      click: () => {
        more.disabled = true
        void load(false).finally(() => {
          more.disabled = false
        })
      },
    },
  }) as HTMLButtonElement

  const box = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '合约目录' }), right),
    h(
      'div',
      { style: 'padding:0 18px' },
      h('div.tip', {
        text: '币安上有过哪些合约。目录里有，不代表那段历史现在就拿得到——退市的和早年的只有官方月度归档里有，要准备它们得明说走归档。',
      }),
      h('div.filters', { style: 'margin-top:10px' }, marketChip.node, search, recheck),
    ),
    rows,
    foot,
  )

  async function load(fresh: boolean): Promise<void> {
    if (fresh) {
      cursor = null
      clear(rows)
      rows.appendChild(spinner('正在读目录…'))
      clear(foot)
    }
    const signal = lane.begin()
    try {
      const page = await catalog(
        { market, symbol: symbol || undefined, cursor: cursor ?? undefined },
        { signal },
      )
      if (!live.alive()) return
      policy = page.coverage_policy
      cursor = page.next_cursor
      if (fresh) clear(rows)
      if (fresh && !page.items.length) {
        rows.appendChild(
          h('div.tip', {
            text: symbol
              ? `目录里没有叫 ${symbol} 的合约。这里按完整名字找，不认前缀；也可能是还没核对过目录。`
              : '目录还是空的，先核对一次。',
          }),
        )
      }
      stagger(page.items.map((item) => rows.appendChild(catalogRow(item, live))))
      paintFoot(rows.childElementCount)
    } catch (error) {
      if (!live.alive()) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (fresh) clear(rows)
      rows.appendChild(note('warn', error instanceof Error ? error.message : '读不到合约目录。'))
    }
  }

  function paintFoot(count: number): void {
    right.textContent = symbol ? '按名字找' : `${count} 个${cursor ? '，还有更多' : ''}`
    clear(foot)
    if (cursor) foot.appendChild(more)
    if (policy === 'catalog_presence_does_not_prove_history_availability') {
      foot.appendChild(
        h('div.tip', { text: '后端自报：目录里有这个合约，不等于它的历史行情现在拿得到。' }),
      )
    }
  }

  void load(true)
  return box
}

const LIVE_STATUSES = new Set(['TRADING', 'PENDING_TRADING'])

function catalogRow(item: CatalogEntry, live: Live): HTMLElement {
  const archiveOnly =
    item.status === 'archive_only' || item.status === 'absent_from_current_catalog'
  const line = h(
    'div.covrow',
    {},
    h('span', {
      class: ['badge', LIVE_STATUSES.has(item.status) ? 'ready' : 'wait'],
      text: catalogStatus(item.status),
    }),
    h('span.mono', { text: item.symbol }),
    h('span.faint', {
      text: item.onboard_at ? `${shortDate(item.onboard_at)} 上线` : '上线时间不明',
    }),
    item.delivery_at ? h('span.faint', { text: `${shortDate(item.delivery_at)} 交割` }) : null,
  )
  const tail = h('span', {
    style: 'margin-left:auto;display:inline-flex;gap:10px;align-items:center',
  })
  line.appendChild(tail)
  if (archiveOnly) {
    tail.appendChild(
      h('span.faint', {
        title: '这个合约不在当前目录里，它的历史只在官方月度归档里。准备它必须明说走归档。',
        text: '只能从归档取',
      }),
    )
  }
  const slot = h('div', { hidden: true, style: 'padding:2px 0 10px' })
  const look = h('button.linkbtn', {
    type: 'button',
    text: '归档里有哪几个月',
    on: {
      click: () => {
        if (!slot.hidden) {
          slot.hidden = true
          return
        }
        slot.hidden = false
        clear(slot)
        slot.appendChild(spinner('正在列归档文件…'))
        void archiveCatalog({
          market: item.market,
          symbol: item.symbol,
          interval: ARCHIVE_PROBE_INTERVAL,
        })
          .then((listing) => {
            if (!live.alive()) return
            clear(slot)
            slot.appendChild(archivePane(listing.items, listing.complete_listing, listing.status))
          })
          .catch((error: unknown) => {
            if (!live.alive()) return
            clear(slot)
            slot.appendChild(
              note('warn', error instanceof Error ? error.message : '列不出这个合约的归档文件。'),
            )
          })
      },
    },
  })
  if (item.archive_discovered) tail.appendChild(look)
  else tail.appendChild(h('span.faint', { text: '还没有在归档里见过它' }))
  return h('div', {}, line, slot)
}

function archivePane(files: ArchiveFile[], complete: boolean, status: string): HTMLElement {
  if (!files.length) {
    return h('div.tip', {
      text: `这个合约按 ${ARCHIVE_PROBE_INTERVAL} 线在归档里没有列到文件。`,
    })
  }
  const all = files.map(
    (file) => file.source_key.match(/(\d{4}-\d{2})/)?.[1] ?? file.source_key,
  )
  const months = all.slice(0, 24)
  const rest = all.length - months.length
  const box = h(
    'div',
    {},
    h('div.faint', {
      text:
        `按 ${ARCHIVE_PROBE_INTERVAL} 线列到 ${files.length} 份月度文件：${months.join('、')}` +
        (rest > 0 ? `，还有 ${rest} 个月没列在这里。` : '。'),
    }),
  )
  if (!complete) box.appendChild(h('div.tip', { text: '这一页还没列完，只列到这些。' }))
  if (status === 'discovered_not_yet_checksum_verified') {
    box.appendChild(
      h('div.tip', {
        text: '后端自报：这只是列到了文件，还没有核过校验值。真准备的时候会一份一份核。',
      }),
    )
  }
  return box
}

const CATALOG_STATUS: Record<string, string> = {
  TRADING: '在交易',
  PENDING_TRADING: '待上线',
  SETTLING: '结算中',
  DELIVERING: '交割中',
  DELIVERED: '已交割',
  CLOSE: '已下架',
  archive_only: '只在归档里',
  absent_from_current_catalog: '目录里已经没有',
}

function catalogStatus(status: string): string {
  return CATALOG_STATUS[status] ?? status
}

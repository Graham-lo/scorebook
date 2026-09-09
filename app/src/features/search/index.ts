// 按图搜索 —— the new thing this product can do that the prototype could not.
//
// Two different searches live here, and they are deliberately kept apart
// because they answer different questions:
//
//   我的记录库  POST /v1/similarity/search — 「我以前在这种画面上说过什么」.
//               Only my own scene pictures, only ones that were already on a
//               record before that record was written.
//   历史行情    POST /v1/history/search — 「这种画面在历史上还出现在哪里」.
//               Only ranges that have been prepared; the backend says so
//               itself (`scope: only_ready_indexes`), and the page says it too.
//
// Both are ranked by distance in a descriptor space. That is a similarity
// order, not a probability and not a win rate, and nothing on this page is
// allowed to imply otherwise.
//
// The query picture is uploaded as kind `query`, which the backend refuses to
// accept as evidence on a record, so searching can never pollute the library.
// A box drawn on the picture is sent as coordinates in the uploaded file's own
// pixels; the bytes are never re-encoded.

import { uploadWithProgress } from '../../api/attachments'
import { ApiError, NetworkError, explain } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import * as jobs from '../../api/jobs'
import { chartSvg } from '../../api/market'
import * as plans from '../../api/plans'
import {
  HISTORY_MODELS,
  allIndexes,
  feedback as sendFeedback,
  requestIndex,
  searchHistory,
  searchLibrary,
  type HistoryModel,
  type LibraryModel,
} from '../../api/search'
import type {
  HistoryCoverage,
  HistoryIndexRecord,
  HistoryPlan,
  HistoryItem,
  Market,
  Region,
  SimilarityItem,
  Uuid,
} from '../../api/types'
import * as prep from '../../data/prep'
import {
  INTERVALS,
  INTERVAL_SECONDS,
  MARKET_LABELS,
  defaultMarket,
  findInstruments,
  isLive,
  type Interval,
} from '../../data/session'
import { dateTime, range as dateRange, shortDate } from '../../data/time'
import { go } from '../../router'
import { append, clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { ChartView, objectUrl } from '../../ui/media'
import { stagger } from '../../ui/motion'
import { dropzone, onPaste, openFileDialog } from '../../ui/pick'
import { popChip, type PopItem } from '../../ui/pop'
import { regionPicker, type RegionPicker } from '../../ui/region'
import { empty, note, progressLine, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

type Mode = 'library' | 'history'

interface ModelChoice {
  id: LibraryModel
  label: string
  help: string
  /** The capability that has to be live before this one can be offered. */
  needs: 'structure' | 'visual' | 'both'
}

const MODELS: ModelChoice[] = [
  {
    id: 'candle-profile-v1',
    label: '按走势形状',
    help: '比较 K 线本身的形态：涨跌节奏、波动幅度、量的分布。和配色、界面无关。',
    needs: 'structure',
  },
  {
    id: 'dinov2-small-v1',
    label: '按画面样子',
    help: '比较整张图看起来像不像，包括布局和画面结构。需要本机的视觉模型在运行。',
    needs: 'visual',
  },
  {
    id: 'hybrid-v1',
    label: '两种一起',
    help: '两种比法各排一次名次，再把名次合起来。这时只有先后顺序，没有一个接近程度的数值。',
    needs: 'both',
  },
]

const WINDOW_BARS = 64
const STRIDE_BARS = 16
// 后端一次准备最多接受这么多：再多就得分成几段陆续做。
const MAX_BARS_PER_REQUEST = 50_000
const MAX_WINDOWS = 1_000

/** What the page is holding onto between visits, so a query survives a detour. */
const state: {
  mode: Mode
  queryId: Uuid | null
  queryName: string
  region: Region | null
  model: LibraryModel
  historyModel: HistoryModel
  instrument: string | null
  market: Market | null
  timeframe: string | null
  limit: number
  library: SimilarityItem[] | null
  librarySession: Uuid | null
  history: HistoryItem[] | null
  historyCoverage: HistoryCoverage[]
  searchedAt: string | null
} = {
  mode: 'library',
  queryId: null,
  queryName: '',
  region: null,
  model: 'candle-profile-v1',
  historyModel: 'candle-profile-v1',
  instrument: null,
  market: null,
  timeframe: null,
  limit: 12,
  library: null,
  librarySession: null,
  history: null,
  historyCoverage: [],
  searchedAt: null,
}

const uploadAction = new WriteAction()
const libraryAction = new WriteAction()
const historyAction = new WriteAction()
const indexAction = new WriteAction()
const planAction = new WriteAction()
const planControlAction = new WriteAction()
const retryAction = new WriteAction()
const lane = new Latest()

export function searchPage(host: HTMLElement, arg: string): () => void {
  let alive = true
  let picker: RegionPicker | null = null
  const charts: ChartView[] = []
  /** 每张「正在准备」的卡片留一个停手的开关，离开页面时一起关掉。 */
  const watchers: (() => void)[] = []
  /** 准备好一段之后重读「可以搜的范围」，不动页面上其它东西。 */
  let refreshCoverage: (() => void) | null = null
  let detachPaste: (() => void) | null = null
  let detachDrop: (() => void) | null = null

  // #/search/like/<attachment_id> — 从一条记录的现场图直接开搜。
  if (arg.startsWith('like/')) {
    const id = arg.slice(5)
    if (id && id !== state.queryId) {
      state.queryId = id
      state.queryName = '这条记录的现场图'
      state.region = null
      state.library = null
      state.history = null
    }
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
        h('div.tip', {
          style: 'margin-top:6px;max-width:52ch',
          text: '觉得「这种画面见过」的时候，问样本，别问记忆。放一张截图进来，找出画面接近的那几条，看当时的自己是怎么说的。图上可以拖一个框，只比那一块。',
        }),
      ),
      modeSwitch(),
    ),
  )

  const queryPane = h('div.sheet.pad.stack')
  const resultPane = h('div')
  const grid = h('div.searchgrid', {}, queryPane, resultPane)
  host.append(head, grid)

  paintQuery()
  paintResults()

  detachPaste = onPaste({
    onPick: (file) => void takeFile(file),
    onReject: (why) => problem(why),
  })

  /* ----------------------------------------------------------- 顶部切换 */

  function modeSwitch(): HTMLElement {
    const seg = h('span.seg.lg')
    const options: { id: Mode; label: string }[] = [
      { id: 'library', label: '我的记录库' },
      { id: 'history', label: '历史行情' },
    ]
    for (const option of options) {
      seg.appendChild(
        h('button', {
          class: state.mode === option.id ? 'on' : '',
          text: option.label,
          on: {
            click: () => {
              if (state.mode === option.id) return
              state.mode = option.id
              paintQuery()
              paintResults()
            },
          },
        }),
      )
    }
    return seg
  }

  /* ------------------------------------------------------------ 查询图 */

  function paintQuery(): void {
    clear(queryPane)
    detachDrop?.()
    detachDrop = null
    picker = null

    if (!state.queryId) {
      const zone = h(
        'div.dropbig',
        {},
        h('div.art', {}, icon('img')),
        h('div.h3', { text: '把截图放进来' }),
        h('div.tip', { text: '拖进来、Ctrl/⌘+V 粘贴，或者点这里选一张 PNG / JPEG / WebP。' }),
      )
      detachDrop = dropzone(zone, {
        onPick: (file) => void takeFile(file),
        onReject: (why) => problem(why),
      })
      queryPane.appendChild(zone)
      queryPane.appendChild(
        note(
          'info',
          '这张图只作为查询用，不会变成任何一条记录的截图，也不会出现在检索结果里。',
        ),
      )
      queryPane.appendChild(controls())
      return
    }

    const slot = h('div.shot-slot', { style: 'min-height:180px' }, h('div.shot-wait', {}, icon('img')))
    queryPane.appendChild(
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
        if (!alive) return
        const image = h('img', { attrs: { src: url, alt: '用来搜索的截图' } }) as HTMLImageElement
        const made = regionPicker(image, (region) => {
          state.region = region
          paintRegionLine()
        })
        picker = made
        slot.replaceWith(made.node)
        paintRegionLine()
      })
      .catch(() => {
        if (alive) slot.replaceChildren(h('div.shot-wait.failed', { text: '这张图读不出来。' }))
      })

    const regionLine = h('div.row', { style: 'gap:10px;flex-wrap:wrap' })
    queryPane.appendChild(regionLine)
    function paintRegionLine(): void {
      clear(regionLine)
      if (state.region) {
        const r = state.region
        append(regionLine, [
          h('span.tag', { text: `只搜框中的 ${r.width}×${r.height} 像素` }),
          h('button.btn.sm.ghost', {
            text: '整张图',
            on: {
              click: () => {
                picker?.clear()
              },
            },
          }),
        ])
      } else {
        regionLine.appendChild(h('span.faint', { text: '在图上拖一个框，可以只搜画面里的一块。' }))
      }
    }

    queryPane.appendChild(
      h(
        'div.row',
        { style: 'gap:10px' },
        h('button.btn.sm.ghost', {
          text: '换一张图',
          on: {
            click: () =>
              openFileDialog({
                onPick: (file) => void takeFile(file),
                onReject: (why) => problem(why),
              }),
          },
        }),
      ),
    )
    queryPane.appendChild(controls())
  }

  async function takeFile(file: File): Promise<void> {
    const bar = h('div.progress', {}, h('i', { style: 'width:0%' }))
    queryPane.prepend(bar)
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
      if (!alive) return
      state.queryId = uploaded.id
      state.queryName = `${uploaded.width}×${uploaded.height}`
      state.region = null
      state.library = null
      state.history = null
      state.librarySession = null
      paintQuery()
      paintResults()
    } catch (error) {
      if (!alive) return
      bar.remove()
      const again = error instanceof NetworkError || (error instanceof ApiError && error.canRetry)
      problem(
        error instanceof Error ? error.message : '这张图没有传上去。',
        again ? () => void takeFile(file) : undefined,
      )
    }
  }

  /* -------------------------------------------------------------- 控制 */

  function controls(): HTMLElement {
    const box = h('div.stack', { style: 'gap:14px' })
    box.appendChild(modelPicker())
    box.appendChild(filterRow())

    const run = h('button.btn.primary.lg', {
      text: state.mode === 'library' ? '在我的记录里找' : '在历史行情里找',
      disabled: !state.queryId,
      on: { click: () => void runSearch() },
    })
    box.appendChild(h('div.acts', {}, run, h('span.faint', { text: '每次检索只按当前这张图和这些条件。' })))
    if (!state.queryId) {
      box.appendChild(h('div.tip', { text: '先放一张图，才能开始检索。' }))
    }
    return box
  }

  function modelPicker(): HTMLElement {
    const visual = isLive('image_visual_search')
    const list = state.mode === 'library' ? MODELS : MODELS.filter((m) => m.needs !== 'both')
    // Each choice carries a sentence of explanation, so they stack instead of
    // sitting in the three-across row the stance buttons use.
    const opts = h('div.opts.mopts')
    const chosen = state.mode === 'library' ? state.model : state.historyModel

    for (const model of list) {
      const blocked = model.needs !== 'structure' && !visual
      const button = h(
        'button',
        {
          class: ['opt', chosen === model.id ? 'on' : ''],
          disabled: blocked,
          title: blocked ? '本机的视觉模型没有在运行' : model.help,
          on: {
            click: () => {
              if (state.mode === 'library') state.model = model.id
              else state.historyModel = model.id as HistoryModel
              paintQuery()
            },
          },
        },
        model.label,
        h('span.lb2', { text: blocked ? '视觉模型没有启动' : model.help }),
      )
      opts.appendChild(button)
    }

    const box = h(
      'div',
      {},
      h('div.sh', { style: 'margin-bottom:9px' }, h('span.eyebrow.noline', { text: '怎么比' })),
      opts,
    )
    if (!visual) {
      box.appendChild(
        h('div.tip', {
          text: '本机的视觉模型现在没有运行，只能按走势形状比较。启动它之后刷新页面就会多出另外两种。',
        }),
      )
    }
    return box
  }

  function filterRow(): HTMLElement {
    const row = h('div.filters')
    const isLibrary = state.mode === 'library'

    row.appendChild(
      popChip({
        label: () => state.instrument ?? '不限品种',
        active: () => Boolean(state.instrument),
        search: '搜合约，比如 BTCUSDT',
        items: async (query) => {
          const found = await findInstruments(query, {
            market: state.market ?? undefined,
          })
          const rows: PopItem[] = found.map((item) => ({
            label: item.symbol,
            value: item.symbol,
            hint: MARKET_LABELS[item.market],
          }))
          return rows.length ? rows : [{ label: '没有匹配的合约', value: '' }]
        },
        onPick: (value) => {
          if (!value) return
          state.instrument = value
          paintQuery()
        },
        onClear: () => {
          state.instrument = null
          paintQuery()
        },
      }).node,
    )

    row.appendChild(
      popChip({
        label: () => (state.market ? MARKET_LABELS[state.market] : '不限市场'),
        active: () => Boolean(state.market),
        items: () => [
          { label: MARKET_LABELS.usd_m, value: 'usd_m', on: state.market === 'usd_m' },
          { label: MARKET_LABELS.coin_m, value: 'coin_m', on: state.market === 'coin_m' },
        ],
        onPick: (value) => {
          state.market = value as Market
          paintQuery()
        },
        onClear: () => {
          state.market = null
          paintQuery()
        },
      }).node,
    )

    row.appendChild(
      popChip({
        label: () => state.timeframe ?? (isLibrary ? '不限周期' : '不限周期'),
        active: () => Boolean(state.timeframe),
        items: () =>
          INTERVALS.map((interval) => ({
            label: interval,
            value: interval,
            on: state.timeframe === interval,
          })),
        onPick: (value) => {
          state.timeframe = value
          paintQuery()
        },
        onClear: () => {
          state.timeframe = null
          paintQuery()
        },
        footer: () =>
          isLibrary
            ? '按记录上写的周期筛选，没写周期的记录不会出现。'
            : '按已准备范围的周期筛选。',
      }).node,
    )

    row.appendChild(
      popChip({
        label: () => `最多 ${state.limit} 条`,
        active: () => state.limit !== 12,
        items: () =>
          [6, 12, 24, 50].map((n) => ({
            label: `最多 ${n} 条`,
            value: String(n),
            on: state.limit === n,
          })),
        onPick: (value) => {
          state.limit = Number(value)
          paintQuery()
        },
      }).node,
    )
    return row
  }

  /* -------------------------------------------------------------- 检索 */

  async function runSearch(): Promise<void> {
    if (!state.queryId) return
    resultPane.replaceChildren(spinner('正在比对画面…'))
    const signal = lane.begin()
    try {
      if (state.mode === 'library') {
        const query = {
          attachment_id: state.queryId,
          ...(state.region ? { region: state.region } : {}),
          model_id: state.model,
          ...(state.instrument ? { instrument: state.instrument } : {}),
          ...(state.market ? { market: state.market } : {}),
          ...(state.timeframe ? { timeframe: state.timeframe } : {}),
          limit: state.limit,
        }
        const result = await searchLibrary(query, libraryAction.keyFor(query), { signal })
        if (!alive) return
        state.library = result.items
        state.librarySession = result.session_id ?? null
      } else {
        const query = {
          attachment_id: state.queryId,
          ...(state.region ? { region: state.region } : {}),
          model_id: state.historyModel,
          ...(state.instrument ? { symbol: state.instrument } : {}),
          ...(state.market ? { market: state.market } : {}),
          ...(state.timeframe ? { interval: state.timeframe } : {}),
          limit: state.limit,
        }
        const result = await searchHistory(query, historyAction.keyFor(query), { signal })
        if (!alive) return
        state.history = result.items
        state.historyCoverage = result.coverage
      }
      state.searchedAt = new Date().toISOString()
      paintResults()
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      resultPane.replaceChildren(
        empty({
          art: 'info',
          title: '这次没有搜成',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void runSearch() } }),
        }),
      )
    }
  }

  /* -------------------------------------------------------------- 结果 */

  function paintResults(): void {
    clear(resultPane)
    for (const chart of charts.splice(0)) chart.cancel()
    if (state.mode === 'library') paintLibrary()
    else paintHistory()
  }

  function paintLibrary(): void {
    const items = state.library
    if (!items) {
      resultPane.appendChild(
        empty({
          art: 'img',
          title: '还没有开始搜',
          tip: '放一张截图，选好怎么比，就能在自己写过的记录里找画面接近的那几条。',
        }),
      )
      return
    }
    if (!items.length) {
      resultPane.appendChild(
        empty({
          art: 'search',
          title: '没有找到接近的记录',
          tip: '只有已经带着现场图存下来的记录才会被搜到。放宽品种或周期，或者先多记几条。',
        }),
      )
      return
    }

    const head2 = h(
      'div.sheet.sh',
      {},
      h('span.eyebrow.noline', { text: '画面接近的记录' }),
      h('span.faint', { text: `${items.length} 条 · ${dateTime(state.searchedAt)} 检索` }),
    )
    const list = h('div.hits')
    items.forEach((item, index) => list.appendChild(libraryHit(item, index)))
    resultPane.append(head2, list)
    resultPane.appendChild(
      note(
        'info',
        '排序是画面上的接近程度，不是胜率，也不是概率。相同的图只留一张，同一段行情只留最接近的一条。',
      ),
    )
    stagger(list.children)
  }

  function libraryHit(item: SimilarityItem, index: number): HTMLElement {
    const words = item.original_text.trim()
    const meta = [
      item.instrument ?? '未标品种',
      item.timeframe ?? '未标周期',
      item.market ? MARKET_LABELS[item.market] : null,
    ].filter(Boolean) as string[]

    const shot = h('div.shot-slot', { style: 'height:84px' }, h('div.shot-wait', {}, icon('img')))
    void objectUrl(item.attachment_id)
      .then((url) => {
        if (!alive) return
        shot.replaceChildren(h('img', { attrs: { src: url, alt: '这条记录的现场图' } }))
      })
      .catch(() => shot.replaceChildren(h('div.shot-wait.failed', { text: '图读不出来' })))
    shot.style.cursor = 'pointer'
    shot.addEventListener('click', () => go(`call/${item.call_id}`))

    const right = h(
      'div',
      {},
      h(
        'div.line',
        {},
        h('span.rank', { text: `#${index + 1}` }),
        ...meta.map((text) => h('span', { text })),
        h('span', { text: dateTime(item.submitted_at) }),
      ),
      // 原话是用户输入，按纯文本渲染。
      h('div.words', { text: words || '（这条只有图，没有文字）' }),
      nearness(item),
    )

    const actions = h(
      'div.acts',
      { style: 'margin-top:8px' },
      h('a.btn.sm.ghost', { href: `#/call/${item.call_id}`, text: '打开这条' }),
    )
    if (state.librarySession) {
      const session = state.librarySession
      const said = h('span.faint', { text: '' })
      const mark = (relevant: boolean, label: string) =>
        h('button.btn.sm.ghost', {
          text: label,
          on: {
            click: async (e: Event) => {
              const button = e.currentTarget as HTMLButtonElement
              button.disabled = true
              try {
                const payload = {
                  session_id: session,
                  attachment_id: item.attachment_id,
                  relevant,
                }
                await sendFeedback(payload, new WriteAction().keyFor(payload))
                said.textContent = relevant ? '已记为有关' : '已记为无关'
              } catch (error) {
                button.disabled = false
                problem(error instanceof Error ? error.message : '这次反馈没有存下来。')
              }
            },
          },
        })
      actions.append(mark(true, '确实像'), mark(false, '不像'), said)
    }
    right.appendChild(actions)

    return h('div.hit', { style: `--i:${index}` }, shot, right)
  }

  /** Distance is shown as distance, with the scale named, and never as a score. */
  function nearness(item: SimilarityItem): HTMLElement {
    if (typeof item.cosine_distance !== 'number') {
      return h('div.line', {}, h('span.faint', { text: '两种比法合起来的名次，没有单独的数值。' }))
    }
    const distance = item.cosine_distance
    const closeness = Math.max(0, Math.min(1, 1 - distance))
    return h(
      'div.near',
      { title: '0 表示两张图在这种比法下完全一样，数越大越不像。它不是胜率。' },
      h('span.faint', { text: '接近程度' }),
      h('span.track', {}, h('i', { style: `width:${(closeness * 100).toFixed(1)}%` })),
      h('span.num', { text: distance.toFixed(3) }),
    )
  }

  /* ------------------------------------------------------ 历史行情检索 */

  function paintHistory(): void {
    const items = state.history
    if (items && items.length) {
      const head2 = h(
        'div.sheet.sh',
        {},
        h('span.eyebrow.noline', { text: '历史上接近的片段' }),
        h('span.faint', { text: `${items.length} 段 · ${dateTime(state.searchedAt)} 检索` }),
      )
      const list = h('div.hits')
      items.forEach((item, index) => list.appendChild(historyHit(item, index)))
      resultPane.append(head2, list)
      resultPane.appendChild(
        note(
          'info',
          '只在已经准备好的范围里找，不是全部历史。K 线和图都是临时取来画的，页面关掉就没有了。',
        ),
      )
      stagger(list.children)
    } else if (items) {
      resultPane.appendChild(
        empty({
          art: 'search',
          title: '这些范围里没有接近的片段',
          tip: '可以换一种比法，或者先把更多时间段准备出来再搜。',
        }),
      )
    } else {
      resultPane.appendChild(
        empty({
          art: 'img',
          title: '还没有开始搜',
          tip: '历史检索只覆盖已经准备过的时间段，下面列出的就是现在能搜的范围。',
        }),
      )
    }
    resultPane.appendChild(coveragePane())
  }

  function historyHit(item: HistoryItem, index: number): HTMLElement {
    const view = new ChartView()
    charts.push(view)
    const drawn = h('div', { hidden: true }, view.node)

    const draw = h('button.btn.sm.ghost', {
      text: '把这一段画出来',
      on: {
        click: (e: Event) => {
          const button = e.currentTarget as HTMLButtonElement
          button.disabled = true
          drawn.hidden = false
          void view
            .show((signal) => chartSvg(item.chart_request, { signal }))
            .finally(() => {
              button.disabled = false
              button.textContent = '重新画一次'
            })
        },
      },
    })

    const body = h(
      'div',
      {},
      h(
        'div.line',
        {},
        h('span.rank', { text: `#${index + 1}` }),
        h('span.mono', { text: item.symbol }),
        h('span', { text: MARKET_LABELS[item.market] }),
        h('span', { text: item.interval }),
        h('span', { text: `${item.bars_count} 根` }),
      ),
      h('div.words', { style: 'font-size:14px', text: dateRange(item.start_at, item.end_at) }),
      historyNearness(item),
      h('div.acts', { style: 'margin-top:8px' }, draw),
      drawn,
    )
    return h('div.hit', { style: `--i:${index};grid-template-columns:1fr` }, body)
  }

  function historyNearness(item: HistoryItem): HTMLElement {
    const closeness = Math.max(0, Math.min(1, 1 - item.cosine_distance))
    return h(
      'div.near',
      { title: '0 表示两张图在这种比法下完全一样，数越大越不像。它不是胜率。' },
      h('span.faint', { text: '接近程度' }),
      h('span.track', {}, h('i', { style: `width:${(closeness * 100).toFixed(1)}%` })),
      h('span.num', { text: item.cosine_distance.toFixed(3) }),
    )
  }

  /* --------------------------------------------- 已准备 / 准备新的范围 */

  function coveragePane(): HTMLElement {
    const right = h('span.faint', { style: 'margin-left:auto', text: '正在读…' })
    const box = h(
      'div.sheet',
      { style: 'margin-top:18px' },
      h('div.sh', {}, h('span.eyebrow.noline', { text: '可以搜的历史范围' }), right),
    )
    // 正在准备的那几段排在最上面：它们是这一刻唯一会变的东西。表单只建一次，
    // 列表单独重读，这样一段准备完之后，手上正在填的东西不会被刷掉。
    const running = h('div', { style: 'padding:0 18px' })
    const rows = h('div', { style: 'padding:6px 18px 0' })
    const form = h('div', { style: 'padding:0 18px 16px' }, prepareForm(running))
    box.append(running, rows, form)
    for (const entry of prep.list()) running.appendChild(watchCard(entry, running))
    rows.appendChild(h('div.tip', { text: '正在读已经准备好的范围…' }))

    refreshCoverage = (): void => {
      void allIndexes()
        .then((list) => {
          if (!alive) return
          right.textContent = list.length ? `${list.length} 段` : '还没有'
          clear(rows)
          if (!list.length) {
            rows.appendChild(
              h('div.tip', {
                text: '还没有准备过任何范围。先准备一段，才能在历史行情里按图搜索。',
              }),
            )
          }
          for (const row of list.slice().reverse().slice(0, 12)) rows.appendChild(coverageRow(row))
        })
        .catch(() => {
          if (!alive) return
          right.textContent = ''
          clear(rows)
          rows.appendChild(h('div.tip', { text: '读不到已准备的范围，稍后再看。' }))
        })
    }
    refreshCoverage()
    return box
  }

  function coverageRow(row: HistoryIndexRecord): HTMLElement {
    const ready = row.status === 'ready'
    const b = row.body
    const line = h(
      'div.covrow',
      {},
      h('span', { class: ['badge', ready ? 'ready' : 'wait'], text: ready ? '可以搜' : '准备中' }),
      h('span.mono', { text: b.symbol }),
      h('span', { text: `${MARKET_LABELS[b.market]} · ${b.interval}` }),
      h('span', { text: `${shortDate(b.start_at)} – ${shortDate(b.end_at)}` }),
    )
    if (ready && row.coverage) {
      const c = row.coverage
      line.appendChild(
        h('span.faint', {
          style: 'margin-left:auto',
          text: c.source_range_complete
            ? `${c.source_bars_fetched} 根 K 线，全段完整`
            : `${c.source_bars_fetched} 根 K 线，中间有缺口`,
        }),
      )
      if (c.windows_skipped_for_gaps > 0) {
        line.appendChild(
          h('span.faint', { text: `${c.windows_skipped_for_gaps} 个片段因为缺口跳过了` }),
        )
      }
    } else if (!ready) {
      line.appendChild(h('span.faint', { style: 'margin-left:auto', text: '正在准备这段历史' }))
    }
    return line
  }

  /* --------------------------------------------- 正在准备的那几段 */

  /**
   * 一段正在准备的历史，从头看到尾。
   *
   * 准备工作跑在后端，不在这个页面里：关掉页面它照样继续。所以这张卡片只做两件
   * 事——把后端此刻的状态用人话说出来，以及在它停下来等人的时候给出能按的按钮。
   * 编号记在本机，刷新页面之后还能接着看；行情和图不会留下来。
   */
  function watchCard(entry: prep.PrepEntry, host: HTMLElement): HTMLElement {
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
    watchers.push(() => {
      stopped = true
    })

    const say = (element: HTMLElement, ...buttons: HTMLElement[]): void => {
      line.replaceChildren(element)
      acts.replaceChildren(...buttons)
    }
    const drop = (): void => {
      card.classList.add('leaving')
      setTimeout(() => card.remove(), 260)
      if (!host.querySelector('.prep')) host.replaceChildren()
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

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })

    async function watchJob(): Promise<void> {
      for (;;) {
        if (stopped || !alive) return
        let job
        try {
          job = await jobs.get(entry.id)
        } catch (error) {
          if (stopped || !alive) return
          if (error instanceof ApiError && error.status === 404) {
            done()
            say(note('warn', '这段准备工作已经不在了，重新准备一次吧。'), closeBtn('知道了'))
            return
          }
          say(note('warn', error instanceof Error ? error.message : '读不到这段的进度。'))
          await sleep(8_000)
          continue
        }
        if (stopped || !alive) return
        if (jobs.isRunning(job)) {
          const said = jobs.jobLine(job.status)
          say(progressLine(said.text, said.progress))
          await sleep(4_000)
          continue
        }
        if (job.status === 'succeeded') {
          done()
          say(progressLine('这一段准备好了，可以按图搜索了', 1), closeBtn('收起'))
          toast('这段历史准备好了，可以按图搜索了。')
          refreshCoverage?.()
          return
        }
        if (job.status === 'cancelled') {
          done()
          say(note('info', '这段准备已经取消。'), closeBtn('收起'))
          return
        }
        const why = job.error_code
          ? explain(job.error_code)
          : jobs.jobLine(job.status).text + '。'
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
                if (stopped || !alive) return
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
        if (stopped || !alive) return
        let plan
        try {
          plan = await plans.get(entry.id)
        } catch (error) {
          if (stopped || !alive) return
          if (error instanceof ApiError && error.status === 404) {
            done()
            say(note('warn', '这段准备工作已经不在了，重新准备一次吧。'), closeBtn('知道了'))
            return
          }
          say(note('warn', error instanceof Error ? error.message : '读不到这段的进度。'))
          await sleep(8_000)
          continue
        }
        if (stopped || !alive) return
        if (plan.status !== 'running') {
          paintPlan(plan)
          return
        }
        // 计划说自己在跑，不等于真的在跑：它靠一项后台任务一段一段往下走，那项任务
        // 停在需要人处理的地方时，计划这一行还是「running」。所以两边都要看一眼。
        const job = await jobs.get(entry.id).catch(() => null)
        if (stopped || !alive) return
        if (job && jobs.needsPerson(job)) {
          say(
            note(
              'warn',
              job.error_code
                ? explain(job.error_code)
                : '这一段停下来了，要你决定接下来怎么办。',
            ),
            h('span.faint', {
              text: plan.completed_chunks
                ? `已经准备好 ${plan.completed_chunks} 段`
                : '还没有一段完成',
            }),
            ...(jobs.canRetry(job) ? [retryBtn(job.id, job.generation, watchPlan)] : []),
            controlBtn(plan, 'cancel', '不做了'),
          )
          return
        }
        paintPlan(plan)
        await sleep(5_000)
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
        refreshCoverage?.()
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
     * 走到哪儿了。品种和周期各算一格，格子里按时间走到哪儿算比例——这是后端自己
     * 记下的位置，不是估出来的。
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
                if (stopped || !alive) return
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

    if (entry.kind === 'plan') void watchPlan()
    else void watchJob()
    return card
  }

  /** 准备一段历史：一次后台作业，进度只用业务语言说。 */
  function prepareForm(running: HTMLElement): HTMLElement {
    const today = new Date()
    const monthAgo = new Date(today.getTime() - 30 * 86_400_000)
    const iso = (d: Date) => d.toISOString().slice(0, 10)

    let symbol = state.instrument ?? 'BTCUSDT'
    let market: Market = state.market ?? defaultMarket()
    let interval: Interval = (state.timeframe as Interval) ?? '1h'
    const from = h('input.input', { type: 'date', value: iso(monthAgo) }) as HTMLInputElement
    const to = h('input.input', { type: 'date', value: iso(today) }) as HTMLInputElement
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
        size.refresh()
      },
    })
    const intervalChip = popChip({
      label: () => interval,
      active: () => true,
      items: () =>
        INTERVALS.map((item) => ({ label: item, value: item, on: item === interval })),
      onPick: (value) => {
        interval = value as Interval
        intervalChip.refresh()
        size.refresh()
      },
    })

    // 这段时间有多长，页面自己先算一遍：一次装得下就一次做完，装不下就交给后端
    // 分段做。两种做法的区别只在这一行字里说清楚，不必让人自己去凑时间段。
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
    from.addEventListener('change', () => size.refresh())
    to.addEventListener('change', () => size.refresh())

    function shape(): { bars: number; windows: number; split: boolean } | null {
      const startAt = new Date(`${from.value}T00:00:00Z`)
      const endAt = new Date(`${to.value}T00:00:00Z`)
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null
      if (endAt <= startAt) return null
      const seconds = INTERVAL_SECONDS[interval]
      const bars = Math.floor((endAt.getTime() - startAt.getTime()) / 1000 / seconds)
      const windows = bars < WINDOW_BARS ? 0 : Math.floor((bars - WINDOW_BARS) / STRIDE_BARS) + 1
      return { bars, windows, split: bars > MAX_BARS_PER_REQUEST || windows > MAX_WINDOWS }
    }
    size.refresh()

    const start = h('button.btn.sm.primary', {
      text: '准备这一段',
      on: {
        click: () => {
          const startAt = new Date(`${from.value}T00:00:00Z`)
          const endAt = new Date(`${to.value}T00:00:00Z`)
          if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
            problem('请选好开始和结束日期。')
            return
          }
          if (endAt <= startAt) {
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
              symbol,
              market,
              interval,
              start_at: startAt.toISOString(),
              end_at: endAt.toISOString(),
              window_bars: WINDOW_BARS,
              stride_bars: STRIDE_BARS,
              models: [state.historyModel],
            },
            plan.split,
            status,
            running,
          ).finally(() => {
            start.disabled = false
          })
        },
      },
    }) as HTMLButtonElement

    return h(
      'details.disc',
      { style: 'margin-top:14px' },
      h('summary', {}, icon('tri'), '准备一段新的历史'),
      h('div.tip', {
        text: '准备一段历史，就是把这段行情按固定长度切开、逐段记下画面特征，之后才能用图去找。原始 K 线和画出来的图都不会留下来。',
      }),
      h(
        'div.filters',
        { style: 'margin-top:10px' },
        symbolChip.node,
        marketChip.node,
        intervalChip.node,
      ),
      h(
        'div.row',
        { style: 'gap:10px;margin-top:10px;flex-wrap:wrap' },
        h('label.faint', {}, '从 ', from),
        h('label.faint', {}, '到 ', to),
      ),
      h(
        'div.acts',
        {},
        start,
        h('span.faint', { text: `每段 ${WINDOW_BARS} 根 K 线，每 ${STRIDE_BARS} 根取一段。` }),
        size.node,
      ),
      status,
    )
  }

  /**
   * 把一段历史交给后端去准备。
   *
   * 一次请求装得下就走 `/v1/history/indexes`；装不下的（超过 5 万根 K 线或 1000 个
   * 片段）交给 `/v1/history/plans`，由后端一段一段往下做，中途可以暂停、继续。
   * 两种做法在这里的区别只有一个：交出去之后拿到的是哪一种编号。
   */
  async function prepare(
    input: {
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
  ): Promise<void> {
    status.replaceChildren(spinner('正在安排这段历史…'))
    try {
      const id = split
        ? (
            await plans.create(
              {
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
      if (!alive) return
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
        h('div.tip', { text: '已经交给后端了，进度在上面这一段里看，关掉页面也不影响。' }),
      )
      const card = watchCard(entry, running)
      running.prepend(card)
      stagger([card])
    } catch (error) {
      if (!alive) return
      status.replaceChildren(
        note('warn', error instanceof Error ? error.message : '这段历史没有安排上。'),
      )
    }
  }

  return () => {
    alive = false
    lane.cancel()
    detachPaste?.()
    detachDrop?.()
    for (const stop of watchers) stop()
    for (const chart of charts) chart.cancel()
  }
}

/** Where the call page sends the trader when they want more like this picture. */
export function searchLike(attachmentId: Uuid): void {
  go(`search/like/${attachmentId}`)
}

export const HISTORY_MODEL_IDS = HISTORY_MODELS

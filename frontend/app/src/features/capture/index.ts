// 记录判断 —— 一步一页的记录流程。
//
// 一条记录 = 一次判断的完整发生过程。以前这十几个字段全摊在一个浮层里一次
// 涌出来，人不知道从哪儿下笔。现在拆成三步，一步一页，各自是自己的网址
// （#/new、#/new/step/2、#/new/step/3、#/new/done）：返回手势、刷新、走开
// 一会儿再回来接着填都能用。草稿暂存在这台设备，翻页和刷新后可以继续。
//
// 第一步就能存。市场不等人，判断发生的那一刻只要一张截图加一句话这条就成
// 立了，底下那颗「记下来」在每一步都在，后两步永远是可选的补充。
//
// 三条老规矩不变。方向、期限和每一项标准都来自人按过的控件，不从写下的中
// 文里猜，以 / 开头的那种写法交给后端 /v1/calls/preview 解析。截图先传完再
// 写记录，记录里指到的附件一定已经存在。每次写都带一个由请求体算出来的幂
// 等键，断线重试重放的是第一次的结果，不会多写一条。
import { create, preview, type NewCall } from '../../api/calls'
import { analyze, type RecognizedIndicator } from '../../api/chart'
import { ApiError, NetworkError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import { createTag } from '../../api/knowledge'
import type {
  CreatedCall,
  Instrument,
  Path,
  Stance,
  TagRecord,
  Template,
} from '../../api/types'
import {
  PATHS,
  STANCE_CHOICES,
  STANCES,
  TEMPLATES,
  TEMPLATE_NOTES,
  sentence,
  templateName,
} from '../../data/criteria'
import {
  INTERVALS,
  MARKET_LABELS,
  cached,
  contractLabel,
  findInstruments,
  identityOf,
} from '../../data/session'
import { knownTags, tagIndex } from '../../data/store'
import { dateTime, horizon, relative } from '../../data/time'
import { markFresh } from '../find/state'
import { invalidateArchive } from '../archive'
import { invalidateLedger } from '../find'
import { go, route } from '../../router'
import { append, clear, h } from '../../ui/dom'
import { stamp } from '../../ui/bits'
import { stagger } from '../../ui/motion'
import { icon } from '../../ui/icons'
import { ImageUploads } from '../../data/image-uploads'
import { imagePicker } from '../../ui/image-picker'
import { popChip } from '../../ui/pop'
import { problem, toast } from '../../ui/toast'
import {
  build,
  emptyCriteriaDraft,
  problems,
  ratioFromPercent,
  type CriteriaDraft,
} from './criteria'
import { CAPTURE_KEY, decodeCapture, type StoredCapture } from './draft-storage'
import { putChartSetup } from '../../api/replay'
import { setupIsEmpty } from '../relive/setup'
import { recognizedNames, recognizedTip, setupFromRecognized } from '../relive/recognized-setup'

interface Draft {
  text: string
  images: ImageUploads
  instrument: Instrument | null
  /** 图上认出来、还没被采纳的那个代码。 */
  guess: string | null
  timeframe: string | null
  stance: Stance
  path: Path
  confidence: string
  claimedAt: string
  tags: TagRecord[]
  crit: CriteriaDraft
  saving: boolean
  done: CreatedCall | null
  pendingSave: StoredCapture['pendingSave']
  missingImages: number
}

function blank(): Draft {
  return {
    text: '',
    images: new ImageUploads('scene'),
    instrument: null,
    guess: null,
    timeframe: null,
    stance: 'unknown',
    path: 'unknown',
    confidence: '',
    claimedAt: '',
    tags: [],
    crit: emptyCriteriaDraft(),
    saving: false,
    done: null,
    pendingSave: null,
    missingImages: 0,
  }
}

// The draft outlives the overlay: closing it to look something up must never
// throw away what has been written.
let draft = restoreDraft()
let storageFailed = false
const saveAction = new WriteAction()

function restoreDraft(): Draft {
  const fresh = blank()
  try {
    const saved = decodeCapture(localStorage.getItem(CAPTURE_KEY))
    if (!saved) return fresh
    const { attachmentIds, pendingImages, ...fields } = saved
    Object.assign(fresh, fields)
    fresh.missingImages = pendingImages
    fresh.images.restore(attachmentIds)
  } catch { /* Storage may be unavailable; capture still works in memory. */ }
  return fresh
}

function remember(): void {
  try {
    if (draft.done) localStorage.removeItem(CAPTURE_KEY)
    else {
      const { images, guess: _guess, saving: _saving, done: _done, missingImages, ...fields } = draft
      const saved: StoredCapture = {
        ...fields,
        attachmentIds: images.ids,
        pendingImages: missingImages + images.items.filter(item => !item.id).length,
      }
      localStorage.setItem(CAPTURE_KEY, JSON.stringify(saved))
    }
    storageFailed = false
  } catch { storageFailed = true }
}

function discard(): void {
  draft.images.clear()
  draft = blank()
  saveAction.reset()
  picker = null
  guessImage = null
  remember()
}

/**
 * 这一页上的那几个盒子。
 *
 * 每一块内容都有自己的盒子，画的时候只认盒子、不管现在停在第几步：翻到哪一
 * 步就把那几个盒子挂进正文，没挂上的照样画，只是没人看见。改一个字段要连带
 * 刷新的那几块，因此不用先问一句「这一块这会儿在不在屏幕上」。
 */
interface Ui {
  step: Step
  panel: HTMLElement
  shot: HTMLElement
  pictures: Picker
  ctx: HTMLElement
  text: HTMLTextAreaElement
  parse: HTMLElement
  stance: HTMLElement
  crit: HTMLElement
  extras: HTMLElement
  trigger: HTMLElement
  foot: HTMLElement
  nav: HTMLElement
  detach: (() => void)[]
}

type Picker = ReturnType<typeof imagePicker>

let ui: Ui | null = null
let composing = false

/**
 * 挑图的那一块跨步保留。
 *
 * 翻页会把整页拆掉重画，可已经选好的图不该跟着没。上传进度、缩略图、正在重
 * 试的那张都存在这个挑图器里，重建一个等于全部重来一遍。
 */
let picker: Picker | null = null
function pictures(): Picker {
  if (!picker) {
    let previousCount = draft.images.items.length
    picker = imagePicker(
      draft.images,
      '拖图进来，或 ⌘V',
      () => {
        const count = draft.images.items.length
        if (count > previousCount) draft.missingImages = Math.max(0, draft.missingImages - (count - previousCount))
        previousCount = count
        if (!draft.images.ids.includes(guessImage ?? '')) {
          draft.guess = null
          guessImage = null
          paintCtx()
        }
        paintFoot()
        void sniff()
      },
      () => !draft.saving && !draft.done,
    )
  }
  return picker
}

/* ------------------------------------------------------------------ page */

interface Step {
  n: number
  title: string
  next: string
}

const STEPS: Step[] = [
  { n: 1, title: '看到什么', next: '你的判断' },
  { n: 2, title: '你的判断', next: '怎么算对' },
  { n: 3, title: '怎么算对', next: '记下' },
]

/** 去记一条。地址是 #/new，返回、刷新、以后再打开都还是这一条草稿。 */
export function openCapture(): void {
  go('new')
}

export function capturePage(host: HTMLElement, arg: string): () => void {
  const parts = arg ? arg.split('/') : []
  const done = parts[0] === 'done'
  if (!done && draft.done) discard()
  // 直接把 #/new/done 贴进地址栏的人手上没有那条记录，回到第一步。
  if (done && !draft.done) {
    go('new')
    return () => undefined
  }
  const at = STEPS.find((step) => String(step.n) === (parts[1] ?? '1')) ?? STEPS[0]!

  host.appendChild(
    h(
      'div.crumb',
      {},
      h('a', { href: '#/find', text: '记录' }),
      h('span.sep', { text: '›' }),
      h('span', { text: done ? '记下了' : `第 ${at.n} 步 · ${at.title}` }),
    ),
  )
  const wiz = h('div.wiz')
  host.appendChild(wiz)

  if (done && draft.done) {
    wiz.appendChild(doneCard(draft.done))
    return () => {
      // 走到别的地方去了，这一条才算翻篇；留在 #/new 里是「再记一条」。
      if (draft.done && route().page !== 'new') discard()
    }
  }

  const text = h('textarea', {
    id: 'capText',
    rows: 2,
    placeholder: '一句话：看到什么，打算怎么做',
    value: draft.text,
  }) as HTMLTextAreaElement

  const panel = h('div.panel.cappanel')
  const box: Ui = {
    step: at,
    panel,
    shot: pictures().node,
    pictures: pictures(),
    ctx: h('div.ctx'),
    text,
    parse: h('div.parse'),
    stance: h('div.capseg'),
    crit: h('div.more-fields'),
    extras: h('div.more-fields'),
    trigger: h('div.more-fields'),
    foot: h('div.pf'),
    nav: h('div.wizfoot'),
    detach: [],
  }
  ui = box

  wiz.append(rail(), heading(), panel, box.nav)

  if (at.n === 1) {
    append(panel, [
      h('div.ph', {}, box.ctx),
      h('div.capsec.shots', {}, box.shot),
      h('div.pin', {}, text, shorthandTip()),
      h('div.capsec', {}, box.trigger),
      box.parse,
      box.foot,
    ])
    wireText()
  } else if (at.n === 2) {
    append(panel, [
      h('div.capsec', {}, h('div.dlabel', { text: '方向' }), box.stance),
      h('div.capsec', {}, box.extras),
    ])
  } else {
    append(panel, [
      h('div.capsec', {}, box.crit),
      h('div.capsec', {}, box.parse),
    ])
  }

  paintAll()
  const beforeUnload = (event: BeforeUnloadEvent) => {
    remember()
    if (draft.images.pending || storageFailed) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  box.detach.push(() => window.removeEventListener('beforeunload', beforeUnload))
  stagger([...panel.children])
  if (at.n === 1) {
    autosize(text)
    text.focus()
    text.setSelectionRange(text.value.length, text.value.length)
  }

  return () => {
    remember()
    for (const off of box.detach) off()
    ui = null
    composing = false
    if (draft.done && route().page !== 'new') discard()
  }

  /** 走到第几步了。已经填过东西的那几步打勾，剩下的是灰的，都能直接跳。 */
  function rail(): HTMLElement {
    const bar = h('div.wizrail')
    for (const step of STEPS) {
      const state = step.n === at.n ? 'now' : filled(step.n) ? 'done' : 'todo'
      const node = h('a.wstep', { href: hrefOf(step.n), attrs: { 'data-state': state } })
      node.append(
        h('span.wn', { text: state === 'done' ? '✓' : String(step.n) }),
        h('span.wt', { text: step.title }),
      )
      bar.appendChild(node)
    }
    return bar
  }

  function heading(): HTMLElement {
    return h(
      'header.wizhead',
      {},
      h('h1.wizt', {}, h('span.k', { text: `第 ${at.n} 步` }), at.title),
    )
  }

  /** 第一步的输入框：改一个字就重画一次预览，回车直接存。 */
  function wireText(): void {
    text.addEventListener('compositionstart', () => {
      composing = true
      paintFoot()
    })
    text.addEventListener('compositionend', () => {
      composing = false
      draft.text = text.value
      paintParse()
      paintFoot()
    })
    text.addEventListener('input', () => {
      draft.text = text.value
      autosize(text)
      remember()
      if (composing) return
      paintParse()
      paintFoot()
    })
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return
      // 输入法正在组字的时候，回车是拿去选词的。
      if (composing || e.isComposing) return
      e.preventDefault()
      void save()
    })
    const pasteImages = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
        file.type.startsWith('image/'),
      )
      if (files.length) {
        event.preventDefault()
        pictures().pick(files)
      }
    }
    document.addEventListener('paste', pasteImages)
    box.detach.push(() => document.removeEventListener('paste', pasteImages))
  }
}

function hrefOf(n: number): string {
  return n === 1 ? '#/new' : `#/new/step/${n}`
}

/** 这一步上写过东西没有。顶上那条据此打勾，不是按走到哪儿算。 */
function filled(n: number): boolean {
  if (n === 1) return draft.text.trim().length > 0 || draft.images.items.length > 0
  if (n === 2) {
    return (
      draft.stance !== 'unknown' ||
      draft.tags.length > 0 ||
      draft.confidence.trim().length > 0 ||
      draft.claimedAt.length > 0
    )
  }
  return draft.crit.template !== 'T0'
}

/* ----------------------------------------------------------------- paint */

function paintAll(): void {
  paintShot()
  paintCtx()
  paintParse()
  paintStance()
  paintCrit()
  paintExtras()
  paintTrigger()
  paintFoot()
}

function autosize(node: HTMLTextAreaElement): void {
  node.style.height = 'auto'
  node.style.height = `${Math.min(260, node.scrollHeight)}px`
}

function paintShot(): void {
  ui?.pictures.render()
}

function paintCtx(): void {
  if (!ui) return
  clear(ui.ctx)

  const choices = new Map<string, Instrument>()
  const instrument = popChip({
    label: () => (draft.instrument ? '换品种' : '选品种'),
    active: () => draft.instrument !== null,
    search: '品种，如 BTC',
    items: async (q) => {
      const list = await findInstruments(q, {})
      for (const row of list) choices.set(`${row.market}:${row.symbol}`, row)
      return list.map((row) => ({
        label: row.symbol,
        value: `${row.market}:${row.symbol}`,
        hint: [MARKET_LABELS[row.market], contractLabel(row.body.contractType)]
          .filter(Boolean)
          .join(' · '),
        on: draft.instrument?.symbol === row.symbol && draft.instrument.market === row.market,
      }))
    },
    onPick: (symbol) => {
      draft.instrument = choices.get(symbol) ?? null
      paintCtx()
      paintParse()
    },
    onClear: () => {
      draft.instrument = null
      paintCtx()
      paintParse()
    },
  })

  const timeframe = popChip({
    label: () => draft.timeframe ?? '周期',
    active: () => draft.timeframe !== null,
    items: () =>
      INTERVALS.map((value) => ({ label: value, value, on: draft.timeframe === value })),
    onPick: (value) => {
      draft.timeframe = value
      paintCtx()
      paintParse()
    },
    onClear: () => {
      draft.timeframe = null
      paintCtx()
      paintParse()
    },
  })

  append(ui.ctx, [
    h(
      'div.r1',
      {},
      h(
        'span.sym',
        {},
        icon('scale'),
        draft.instrument?.symbol ?? '未标品种',
        draft.instrument ? h('span.mkt', { text: MARKET_LABELS[draft.instrument.market] }) : null,
      ),
      instrument.node,
      timeframe.node,
      h('span.faint', { text: relative(new Date().toISOString()) }),
    ),
    draft.instrument ? h('div.win', { text: identityOf(draft.instrument) }) : guessRow(),
    indicatorRow(),
  ])
}

/**
 * 粘进来的那张图上写着品种，就问一句要不要用它。认不出就什么都不说——形状里
 * 没有品种这个信息，前端不猜。
 */
function guessRow(): HTMLElement | null {
  if (!draft.guess) return null
  const symbol = draft.guess
  return h(
    'div.guess',
    {},
    h('span', { text: `图上是 ${symbol}，用它？` }),
    h('button.btn.sm', {
      type: 'button',
      text: '用',
      on: { click: () => void useGuess(symbol) },
    }),
  )
}

/** 图上读到的指标，一行事实。不问、不引导，就是把认出来的东西摆在这儿。 */
function indicatorRow(): HTMLElement | null {
  const id = draft.images.ids[0]
  const list = id ? sniffedIndicators.get(id) : undefined
  const names = recognizedNames(list)
  if (!names.length) return null
  return h('div.win', { title: recognizedTip(list) }, pk('指标', names.join(' · ')))
}

async function useGuess(symbol: string): Promise<void> {
  const current = draft
  try {
    if (!cached(symbol)) await findInstruments(symbol, {})
    const found = cached(symbol)
    if (!found || draft !== current || draft.guess !== symbol || draft.saving || draft.done) return
    draft.instrument = found
    draft.guess = null
    paintCtx()
    paintParse()
  } catch {
    // 目录没查着就当没认出来，人自己选。
  }
}

/** 认过的那几张图，认过就不再认。 */
const sniffed = new Map<string, string | null>()
/** 同一次识别顺手读到的指标，按附件 id 留着：记完一笔写进记录当种子。 */
const sniffedIndicators = new Map<string, RecognizedIndicator[]>()
const chartSetupAction = new WriteAction()
const sniffing = new Set<string>()
let guessImage: string | null = null

async function sniff(): Promise<void> {
  if (draft.instrument || draft.guess || draft.saving || draft.done) return
  const current = draft
  const id = current.images.ids[0]
  if (!id || sniffing.has(id)) return
  sniffing.add(id)
  try {
    let symbol = sniffed.get(id)
    if (symbol === undefined) {
      const action = new WriteAction()
      const input = { attachment_id: id }
      const got = await analyze(input, action.keyFor(input))
      symbol = got.recognized.symbol ?? null
      sniffed.set(id, symbol)
      sniffedIndicators.set(id, got.recognized.indicators ?? [])
      // 只认出指标、没认出品种的时候也要把那一行摆出来。
      if (draft === current && draft.images.ids[0] === id && recognizedNames(got.recognized.indicators).length) paintCtx()
    }
    if (!symbol || draft !== current || draft.images.ids[0] !== id || draft.instrument || draft.saving || draft.done) return
    guessImage = id
    draft.guess = symbol
    paintCtx()
  } catch {
    // 自动建议失败仍可手动选择品种。
  } finally {
    sniffing.delete(id)
  }
}

/** 速记写法只放在这颗问号的 tooltip 里，页面上不出现。 */
function shorthandTip(): HTMLElement {
  return h('button.qm', {
    type: 'button',
    text: '?',
    attrs: { 'aria-label': '速记写法' },
    title: '速记：/kt L s=61500 h=72 | 正文；第三步点「按这行填」',
  })
}

function pk(key: string | null, value: string, extra = ''): HTMLElement {
  return h('span', { class: ['pk', extra] }, key ? h('span.k', { text: key }) : null, value)
}

function thresholdChip(): HTMLElement {
  const c = draft.crit
  if (c.template === 'T5') {
    return pk('振幅', c.atrMultiple.trim() ? `${c.atrMultiple.trim()}×ATR14` : '1.5×ATR14（默认）')
  }
  if (c.thresholdKind === 'percent') {
    const ratio = ratioFromPercent(c.thresholdPercent)
    return pk('阈值', ratio ? `${c.thresholdPercent.trim()}%` : '待填', ratio ? '' : 'ambig')
  }
  if (c.thresholdKind === 'atr') {
    return pk('阈值', c.atrMultiple.trim() ? `${c.atrMultiple.trim()}×ATR14` : '待填')
  }
  return pk('阈值', '1×ATR14（默认）')
}

function paintParse(): void {
  paintFoot()
  if (!ui) return
  const box = ui.parse
  clear(box)
  const c = draft.crit

  if (!draft.text.trim() && !draft.images.items.length) {
    return
  }

  const list: HTMLElement[] = []
  if (draft.instrument) {
    list.push(pk('品种', `${draft.instrument.symbol} · ${MARKET_LABELS[draft.instrument.market]}`))
  } else {
    list.push(pk(null, '没写品种', 'free'))
  }
  if (draft.timeframe) list.push(pk('周期', draft.timeframe))
  list.push(pk('方向', STANCES[draft.stance]))
  list.push(pk('怎么算对', TEMPLATES[c.template], c.template === 'T0' ? 'free' : ''))

  if (c.template !== 'T0') {
    list.push(pk('期限', `${horizon(c.horizonHours)}${c.horizonTouched ? '' : '（默认）'}`))
    if (c.template !== 'T4') list.push(thresholdChip())
    if (['T1', 'T2', 'T3'].includes(c.template) && c.invalidation.trim()) {
      list.push(pk('失效', c.invalidation.trim()))
    }
    if (c.template === 'T4') {
      list.push(
        pk(
          c.boundaryKind === 'upper_ceiling' ? '上边界' : '下边界',
          c.boundary.trim() || '待填',
          c.boundary.trim() ? '' : 'ambig',
        ),
      )
    }
    if (c.template === 'T3') {
      list.push(
        pk(
          '触发',
          `${c.triggerPrice.trim() || '待填'} ${c.triggerComparator === 'gte' ? '以上' : '以下'}${c.triggerKind === 'bar_close' ? '收盘确认' : '成交触及'} · ${horizon(c.triggerWindowHours)}内有效`,
          c.triggerPrice.trim() ? '' : 'ambig',
        ),
      )
    }
  }
  for (const tag of draft.tags) list.push(pk(null, `#${tag.name}`))
  if (draft.path !== 'unknown') list.push(pk('触发', PATHS[draft.path] ?? draft.path))
  if (draft.claimedAt) list.push(pk('原话时间', dateTime(claimedIso() ?? '')), pk(null, '事后补记'))
  for (const issue of problems(c)) list.push(pk(null, issue, 'ambig'))

  if (protocolText()) {
    list.push(
      h('button.btn.ghost.sm', {
        text: '按这行填',
        title: '把以 / 开头的那一行交给后端解析，再填进上面的选项',
        on: { click: () => void applyProtocol() },
      }),
    )
  }
  append(box, list)
}

function paintStance(): void {
  if (!ui) return
  const box = ui.stance
  clear(box)
  const seg = h('span.seg.big')
  for (const value of STANCE_CHOICES) {
    seg.appendChild(
      h('button', {
        class: draft.stance === value ? 'on' : '',
        text: STANCES[value],
        on: {
          click: () => {
            // 再点一下就是撤回，方向从来只认人按过的那颗。
            draft.stance = draft.stance === value ? 'unknown' : value
            draft.crit.direction = draft.stance === 'L' || draft.stance === 'S' ? draft.stance : null
            paintParse()
            paintStance()
            paintCtx()
          },
        },
      }),
    )
  }
  box.appendChild(seg)
}

function field(label: string, control: HTMLElement, span = false): HTMLElement {
  const input = control.matches('input,select,textarea')
  return h(
    input ? 'label.field' : 'div.field',
    {
      style: span ? 'grid-column:span 2' : '',
      attrs: input ? {} : { role: 'group', 'aria-label': label },
    },
    h('span', { text: label }),
    control,
  )
}

function input(
  value: string,
  placeholder: string,
  onInput: (value: string) => void,
  type = 'text',
): HTMLInputElement {
  return h('input.input', {
    value,
    placeholder,
    type,
    on: {
      input: (e: Event) => {
        onInput((e.target as HTMLInputElement).value)
        paintParse()
        paintCtx()
      },
    },
  }) as HTMLInputElement
}

function paintCrit(): void {
  if (!ui) return
  const box = ui.crit
  clear(box)
  const c = draft.crit

  const templates: Template[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5']
  const tplSeg = h('span.seg.wrap')
  for (const value of templates) {
    tplSeg.appendChild(
      h('button', {
        class: c.template === value ? 'on' : '',
        text: templateName(value),
        title: TEMPLATE_NOTES[value],
        on: {
          click: () => {
            c.template = value
            if (value === 'T5') c.thresholdKind = 'atr'
            paintCrit()
            paintParse()
            paintStance()
            paintCtx()
          },
        },
      }),
    )
  }

  const said = sentence(build(draft.crit))
  append(box, [
    h('div', {
      class: ['sentence', c.template === 'T0' ? 'faint' : ''],
      style: 'grid-column:span 2',
      text: c.template === 'T0' ? '怎么算对，如：48 小时内跌破 190' : said,
    }),
    field('怎么算对', tplSeg, true),
    h('div.faint', { style: 'grid-column:span 2;margin-top:-4px', text: TEMPLATE_NOTES[c.template] }),
  ])

  if (c.template !== 'T0') {
    const quick = h('span.seg')
    for (const [hours, label] of [[24, '24 小时'], [72, '72 小时'], [168, '7 天']] as [number, string][]) {
      quick.appendChild(
        h('button', {
          class: c.horizonHours === hours ? 'on' : '',
          text: label,
          on: {
            click: () => {
              c.horizonHours = hours
              c.horizonTouched = true
              paintCrit()
              paintParse()
              paintCtx()
            },
          },
        }),
      )
    }
    box.appendChild(field('期限', quick, true))
    const custom = input(
      String(c.horizonHours),
      '小时',
      (value) => {
        const hours = Number(value)
        c.horizonHours = Number.isFinite(hours) ? Math.floor(hours) : 0
        c.horizonTouched = true
      },
      'number',
    )
    box.appendChild(field('小时', custom))
  }

  if (c.template === 'T1' || c.template === 'T2' || c.template === 'T3') {
    const kindSeg = h('span.seg')
    for (const [value, label] of [
      ['default', '默认 1×ATR14'],
      ['percent', '百分比'],
      ['atr', 'ATR 倍数'],
    ] as const) {
      kindSeg.appendChild(
        h('button', {
          class: c.thresholdKind === value ? 'on' : '',
          text: label,
          on: {
            click: () => {
              c.thresholdKind = value
              paintCrit()
              paintParse()
              paintCtx()
            },
          },
        }),
      )
    }
    box.appendChild(field('阈值', kindSeg, true))
    if (c.thresholdKind === 'percent') {
      box.appendChild(
        field(
          '百分比',
          input(c.thresholdPercent, '如 2 表示 2%', (value) => (c.thresholdPercent = value)),
        ),
      )
    }
    if (c.thresholdKind === 'atr') {
      box.appendChild(
        field('ATR 倍数', input(c.atrMultiple, '如 1.5', (value) => (c.atrMultiple = value))),
      )
    }
    box.appendChild(
      field(
        '失效价',
        input(c.invalidation, c.template === 'T2' ? '必填' : '可留空', (value) => (c.invalidation = value)),
      ),
    )
  }

  if (c.template === 'T4') {
    const kindSeg = h('span.seg')
    for (const [value, label] of [
      ['lower_floor', '不破下边界'],
      ['upper_ceiling', '不过上边界'],
    ] as const) {
      kindSeg.appendChild(
        h('button', {
          class: c.boundaryKind === value ? 'on' : '',
          text: label,
          on: {
            click: () => {
              c.boundaryKind = value
              paintCrit()
              paintParse()
              paintCtx()
            },
          },
        }),
      )
    }
    append(box, [
      field('边界方向', kindSeg),
      field('边界价格', input(c.boundary, '如 61500', (value) => (c.boundary = value))),
    ])
  }

  if (c.template === 'T5') {
    box.appendChild(
      field(
        '振幅（×ATR14）',
        input(c.atrMultiple, '留空按 1.5', (value) => (c.atrMultiple = value)),
      ),
    )
  }

  if (c.template === 'T3') {
    const cmpSeg = h('span.seg')
    for (const [value, label] of [
      ['gte', '站上'],
      ['lte', '跌破'],
    ] as const) {
      cmpSeg.appendChild(
        h('button', {
          class: c.triggerComparator === value ? 'on' : '',
          text: label,
          on: {
            click: () => {
              c.triggerComparator = value
              paintCrit()
              paintParse()
            },
          },
        }),
      )
    }
    const kindSeg = h('span.seg')
    for (const [value, label] of [
      ['bar_close', '收盘确认'],
      ['trade_touch', '成交触及'],
    ] as const) {
      kindSeg.appendChild(
        h('button', {
          class: c.triggerKind === value ? 'on' : '',
          text: label,
          on: {
            click: () => {
              c.triggerKind = value
              paintCrit()
              paintParse()
            },
          },
        }),
      )
    }
    append(box, [
      field('触发方式', cmpSeg),
      field('确认方式', kindSeg),
      field('触发价', input(c.triggerPrice, '如 63000', (value) => (c.triggerPrice = value))),
      field(
        '等待窗口（小时）',
        input(
          String(c.triggerWindowHours),
          '24',
          (value) => {
            const hours = Number(value)
            c.triggerWindowHours = Number.isFinite(hours) ? Math.floor(hours) : 0
          },
          'number',
        ),
      ),
    ])
  }

}

/** 把握、标签、原话时间。都记在记录本身上，都可以空着。 */
function paintExtras(): void {
  if (!ui) return
  const box = ui.extras
  clear(box)
  const tagRow = h('div.row', { style: 'flex-wrap:wrap;gap:7px' })
  for (const tag of draft.tags) {
    tagRow.appendChild(
      h(
        'span.tag',
        {},
        `#${tag.name}`,
        h('button.x', {
          type: 'button',
          attrs: { 'aria-label': `去掉标签 ${tag.name}` },
          title: '去掉',
          on: {
            click: () => {
              draft.tags = draft.tags.filter((t) => t.id !== tag.id)
              paintExtras()
              paintParse()
            },
          },
        }),
      ),
    )
  }
  tagRow.appendChild(tagPicker().node)

  append(box, [
    field('把握', confidenceRow(), true),
    field('标签', tagRow, true),
    field(
      '原话时间',
      input(
        draft.claimedAt,
        '',
        (value) => {
          draft.claimedAt = value
        },
        'datetime-local',
      ),
    ),
    draft.claimedAt ? h('div', { style: 'align-self:end' }, h('span.tag', { text: '事后补记' })) : null,
  ])
}

/** 把握是一根 50–100 的滑杆：没动过就是没写，动过就记下那个数。 */
function confidenceRow(): HTMLElement {
  const now = draft.confidence.trim() ? Number(draft.confidence) : null
  const said = h('span.pct', { text: now === null ? '没写' : `${Math.round(now)}%` })
  const bar = h('input.range', {
    type: 'range',
    value: String(now === null ? 70 : Math.max(50, Math.min(100, Math.round(now)))),
    attrs: { min: '50', max: '100', step: '1', 'aria-label': '把握' },
  }) as HTMLInputElement
  bar.addEventListener('input', () => {
    draft.confidence = bar.value
    said.textContent = `${bar.value}%`
    paintParse()
  })
  const reset = h('button.btn.ghost.sm', {
    type: 'button', text: '清除', hidden: now === null,
    on: { click: () => { draft.confidence = ''; paintExtras(); paintParse() } },
  })
  bar.addEventListener('input', () => { reset.hidden = false })
  return h('div.confrow', {}, bar, said, reset)
}

/**
 * 谁先触发谁：先看到图才有想法，还是先有想法再去图上找证据。这两种直觉的可靠
 * 性要分开看，所以它是必填的。
 */
function paintTrigger(): void {
  if (!ui) return
  const box = ui.trigger
  clear(box)
  const seg = h('span.seg')
  for (const value of ['chart_first', 'thought_first'] as Path[]) {
    seg.appendChild(
      h('button', {
        class: draft.path === value ? 'on' : '',
        text: PATHS[value] ?? value,
        on: {
          click: () => {
            draft.path = draft.path === value ? 'unknown' : value
            paintTrigger()
            paintParse()
            paintFoot()
          },
        },
      }),
    )
  }
  box.appendChild(field('触发', seg, true))
}

function tagPicker() {
  return popChip({
    label: () => '+ 标签',
    active: () => false,
    search: '标签名',
    items: async (q) => {
      await tagIndex()
      const query = q.trim()
      const all = knownTags()
      const matched = all
        .filter((t) => !query || t.name.includes(query) || t.aliases.some((a) => a.includes(query)))
        .slice(0, 30)
        .map((t) => ({
          label: t.name,
          value: t.id,
          hint: t.definition ? t.definition.slice(0, 24) : null,
          on: draft.tags.some((x) => x.id === t.id),
        }))
      if (query && !all.some((t) => t.name === query)) {
        matched.unshift({ label: `新建「${query}」`, value: `new:${query}`, hint: null, on: false })
      }
      return matched
    },
    onPick: (value) => {
      if (value.startsWith('new:')) {
        void addNewTag(value.slice(4))
        return
      }
      const tag = knownTags().find((t) => t.id === value)
      if (tag && !draft.tags.some((x) => x.id === tag.id)) draft.tags.push(tag)
      paintExtras()
      paintParse()
    },
  })
}

async function addNewTag(name: string): Promise<void> {
  const current = draft
  const action = new WriteAction()
  const input = { name, definition: '', aliases: [] as string[] }
  try {
    const created = await createTag(input, action.keyFor(input))
    const record: TagRecord = {
      id: created.id,
      name,
      definition: '',
      aliases: [],
      version: created.version,
      created_at: new Date().toISOString(),
    }
    if (draft !== current || draft.saving || draft.done) return
    draft.tags.push(record)
    paintExtras()
    paintParse()
    await tagIndex({ refresh: true })
    if (draft !== current) return
    paintExtras()
    paintParse()
    toast('记下了')
  } catch (error) {
    problem(error instanceof Error ? error.message : '没保存上，再试一次')
  }
}

function paintFoot(): void {
  remember()
  if (!ui) return
  const at = ui.step
  ui.panel.inert = draft.saving
  ui.panel.classList.toggle('saving', draft.saving)
  clear(ui.foot)
  clear(ui.nav)
  const blocked = saveBlocker()

  if (at.n === 1) {
    append(ui.foot, [
      h(
        'span.ime',
        { class: composing ? 'on' : '' },
        h('i'),
        composing ? '输入法组字中' : '回车记下 · ⇧回车换行',
      ),
      h('span.go', {}, h('span.faint', { text: `${draft.text.trim().length} 字` })),
    ])
  }

  const last = at.n === STEPS.length
  const keep = h(
    'button',
    {
      class: last ? 'btn primary next' : 'btn',
      disabled: blocked !== null || draft.saving,
      title: blocked ?? '存下来就不改了',
      on: { click: () => void save() },
    },
    draft.saving ? '正在保存' : '记下',
    last ? h('span.kbd', { text: '↩' }) : null,
  )

  if (at.n > 1) {
    const back = STEPS[at.n - 2]!
    ui.nav.appendChild(
      h('a.btn.ghost', { href: hrefOf(back.n), text: `上一步 · ${back.title}` }),
    )
  }
  ui.nav.appendChild(keep)
  if (!last) {
    ui.nav.appendChild(
      h('a.btn.primary.next', { href: hrefOf(at.n + 1) }, at.next, icon('go')),
    )
  }
  if (blocked) {
    ui.nav.appendChild(h('div.whyoff', { attrs: { role: 'status' } }, blocked,
      draft.missingImages ? h('button.btn.ghost.sm', {
        text: '不保留这些图',
        on: { click: () => { draft.missingImages = 0; paintFoot() } },
      }) : null,
    ))
  }
  if (storageFailed) ui.nav.appendChild(h('div.whyoff', { text: '草稿暂存失败，刷新会丢失' }))
}

/** The one reason the record cannot be written yet, or null. */
function saveBlocker(): string | null {
  if (draft.done) return '这条已经记下了'
  if (draft.missingImages) return `有 ${draft.missingImages} 张图未传完，请重新添加`
  if (!draft.text.trim() && !draft.images.items.length) return '先写一句话，或者放一张图'
  if (draft.images.uploading) return '截图还在传'
  if (draft.images.pending) return '有截图没传上'
  if (draft.path === 'unknown') return '先看到图，还是先有想法？'
  const issues = problems(draft.crit)
  return issues[0] ?? null
}

/* -------------------------------------------------------------- protocol */

/** The explicit slash prefix, the only thing the backend parser reads. */
function protocolText(): string | null {
  const text = draft.text
  return text.trim().startsWith('/') && text.includes(' | ') ? text : null
}

async function applyProtocol(): Promise<void> {
  const text = protocolText()
  const current = draft
  if (!text) return
  try {
    const parsed = await preview(text)
    if (draft !== current || draft.text !== text || draft.saving || draft.done) return
    if (parsed.issues.length) {
      problem(`这一行认不出：${parsed.issues.join('、')}`)
      return
    }
    draft.stance = parsed.stance
    draft.path = parsed.path
    const c = parsed.criteria
    draft.crit.template = c.template
    draft.crit.direction = c.direction === 'L' || c.direction === 'S' ? c.direction : null
    if (c.horizon_hours) {
      draft.crit.horizonHours = c.horizon_hours
      draft.crit.horizonTouched = c.selected_by === 'explicit'
    }
    if (c.threshold_ratio) {
      draft.crit.thresholdKind = 'percent'
      const asPercent = Number(c.threshold_ratio) * 100
      draft.crit.thresholdPercent = Number.isFinite(asPercent) ? String(asPercent) : ''
    }
    draft.crit.invalidation = c.invalidation ?? ''
    paintAll()
    toast('填好了')
  } catch (error) {
    problem(error instanceof Error ? error.message : '这一行认不出')
  }
}

/* ------------------------------------------------------------------ save */

function claimedIso(): string | null {
  if (!draft.claimedAt) return null
  const at = new Date(draft.claimedAt)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString()
}

function body(): NewCall {
  const criteria = build(draft.crit)
  const confidence = draft.confidence.trim() ? Number(draft.confidence) : null
  const payload: NewCall = {
    original_text: draft.text.trim(),
    instrument: draft.instrument?.symbol ?? null,
    market: draft.instrument?.market ?? null,
    timeframe: draft.timeframe,
    path: draft.path,
    stance: draft.stance,
    confidence:
      confidence !== null && Number.isFinite(confidence)
        ? Math.max(0, Math.min(100, Math.round(confidence)))
        : null,
    criteria: criteria ? [criteria] : [],
    attachments: draft.images.ids,
    tags: draft.tags.map((t) => t.id),
    original_claimed_at: claimedIso(),
    source_entry: 'web_capture',
  }
  return payload
}

async function save(): Promise<void> {
  if (draft.saving) return
  const blocked = saveBlocker()
  if (blocked) {
    problem(blocked)
    return
  }
  const current = draft
  const payload = body()
  const signature = JSON.stringify(payload)
  const key = draft.pendingSave?.signature === signature ? draft.pendingSave.key : saveAction.keyFor(payload)
  draft.pendingSave = { signature, key }
  draft.saving = true
  paintShot()
  ui?.panel.classList.add('saving')
  ui?.panel.prepend(h('div.progress', {}, h('i')))
  paintFoot()
  try {
    const created = await create(payload, key)
    // 截图上认出来的那几条指标存成这条记录的种子：以后要画的时候有现成参数。
    const seed = setupFromRecognized(sniffedIndicators.get(payload.attachments?.[0] ?? ''))
    if (!setupIsEmpty(seed)) {
      void putChartSetup(created.id, seed, chartSetupAction.keyFor({ id: created.id, seed })).catch(() => {
        /* 种子没写上不影响这一笔：以后画图时用默认参数 */
      })
    }
    current.saving = false
    current.done = created
    if (draft === current) remember()
    saveAction.reset()
    markFresh(created.id)
    invalidateLedger()
    invalidateArchive()
    toast(`记下了 · ${payload.instrument ?? '没写品种'} ${STANCES[payload.stance ?? 'unknown']}`, { href: `#/call/${created.id}`, text: '打开' })
    if (draft === current && route().page === 'new') go('new/done')
  } catch (error) {
    current.saving = false
    if (draft !== current) return
    paintShot()
    ui?.panel.classList.remove('saving')
    ui?.panel.querySelector('.progress')?.remove()
    paintFoot()
    const retryable = error instanceof NetworkError || (error instanceof ApiError && error.canRetry)
    problem(
      error instanceof Error ? error.message : '没保存上，再试一次',
      retryable ? () => { if (draft === current && !draft.done) void save() } : undefined,
    )
  }
}

/** 后端拿这条标准做了什么，一句话。 */
function statusLine(created: CreatedCall): string {
  const first = created.criteria_status[0]
  if (!first || first.state === 'no_criteria') return '不判对错'
  if (first.state === 'insufficient_data') return '行情不足，暂时判不了'
  return '等市场'
}

/** 存下来之后的那块回执。它自己是一页（#/new/done），不是一个浮层。 */
function doneCard(created: CreatedCall): HTMLElement {
  const backdated = created.evidence_identity === 'historical_unverified'
  const state = created.criteria_status[0]?.state ?? 'no_criteria'
  return h(
    'div.panel',
    {},
    h(
      'div.savedcard',
      {},
      h('div.stampbig', {}, stamp(state, true)),
      h(
        'div',
        {},
        h('div.t', { text: '记下了' }),
        h('div.tip', {
          text: `${draft.instrument?.symbol ?? '没写品种'} · ${dateTime(created.submitted_at)}`,
        }),
        h(
          'div.row',
          { style: 'justify-content:center;gap:7px;margin-top:6px' },
          h('span.tag', { text: statusLine(created) }),
          backdated ? h('span.tag', { text: '事后补记' }) : null,
        ),
        h('div.faint', {
          style: 'font-family:var(--mono);font-size:11.5px;margin-top:8px',
          text: created.display_id,
        }),
        h(
          'div.acts',
          {},
          h('a.btn.primary', { href: `#/call/${created.id}`, text: '打开' }),
          h('button.btn', {
            text: '再记一条',
            on: {
              click: () => {
                discard()
                go('new')
              },
            },
          }),
          h('a.btn.ghost', { href: '#/find', text: '记录' }),
        ),
      ),
    ),
  )
}

export { discard as resetCapture }

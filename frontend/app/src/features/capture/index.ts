// 记录判断 —— 一步一页的记录流程。
//
// 一条记录 = 一次判断的完整发生过程。以前这十几个字段全摊在一个浮层里一次
// 涌出来，人不知道从哪儿下笔。现在拆成三步，一步一页，各自是自己的网址
// （#/new、#/new/step/2、#/new/step/3、#/new/done）：返回手势、刷新、走开
// 一会儿再回来接着填都能用。草稿存在这个模块里，翻页不会掉。
//
// 第一步就能存。市场不等人，判断发生的那一刻只要一张截图加一句话这条就成
// 立了，底下那颗「记下来」在每一步都在，后两步永远是可选的补充。
//
// 三条老规矩不变。方向、期限和每一项标准都来自人按过的控件，不从写下的中
// 文里猜，以 / 开头的那种写法交给后端 /v1/calls/preview 解析。截图先传完再
// 写记录，记录里指到的附件一定已经存在。每次写都带一个由请求体算出来的幂
// 等键，断线重试重放的是第一次的结果，不会多写一条。
import { create, preview, type NewCall } from '../../api/calls'
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
import { PATHS, STANCES, TEMPLATES, sentence } from '../../data/criteria'
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
  TEMPLATE_HELP,
  type CriteriaDraft,
} from './criteria'

interface Draft {
  text: string
  images: ImageUploads
  instrument: Instrument | null
  timeframe: string | null
  stance: Stance
  path: Path
  confidence: string
  claimedAt: string
  tags: TagRecord[]
  crit: CriteriaDraft
  saving: boolean
  done: CreatedCall | null
}

function blank(): Draft {
  return {
    text: '',
    images: new ImageUploads('scene'),
    instrument: null,
    timeframe: null,
    stance: 'unknown',
    path: 'unknown',
    confidence: '',
    claimedAt: '',
    tags: [],
    crit: emptyCriteriaDraft(),
    saving: false,
    done: null,
  }
}

// The draft outlives the overlay: closing it to look something up must never
// throw away what has been written.
let draft = blank()
const saveAction = new WriteAction()

function discard(): void {
  draft.images.clear()
  draft = blank()
  saveAction.reset()
  picker = null
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
  hint: HTMLElement
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
    picker = imagePicker(draft.images, '上传当时截图', () => paintFoot(), () => !draft.saving && !draft.done)
  }
  return picker
}

/* ------------------------------------------------------------------ page */

interface Step {
  n: number
  title: string
  lead: string
  next: string
}

const STEPS: Step[] = [
  {
    n: 1,
    title: '现在看到什么',
    lead: '一张截图，一句你现在的想法，这条就成立了——底下那颗「记下来」现在就能按。后面两步是给这条记录加上以后能算分的东西，愿意就接着填，不填也不影响它存下来。',
    next: '说说你的判断',
  },
  {
    n: 2,
    title: '你的判断',
    lead: '看多还是看空，这个想法是先在图上看见的，还是先在脑子里冒出来再去图上找证据。方向只认你按的这几颗按钮，你写下的中文一个字都不会被拿去猜。',
    next: '定个算对的标准',
  },
  {
    n: 3,
    title: '怎么算你对了',
    lead: '趁市场还没开口，把「什么样算你说对了」先说死。定了标准，到期市场自己给答案，你的直觉才有分可记；不定也行，这条就只留下话和图，不判对错。',
    next: '记下来',
  },
]

/** 去记一条。地址是 #/new，返回、刷新、以后再打开都还是这一条草稿。 */
export function openCapture(): void {
  go('new')
}

export function capturePage(host: HTMLElement, arg: string): () => void {
  const parts = arg ? arg.split('/') : []
  const done = parts[0] === 'done'
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
      h('span', { text: done ? '记下来了' : `第 ${at.n} 步 · ${at.title}` }),
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
    placeholder: '现在看到什么、为什么这么想，直接说。这句话存下就不改了。',
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
    hint: h('div.mini-hint'),
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
      h('div.pin', {}, text),
      box.parse,
      box.foot,
    ])
    wireText()
  } else if (at.n === 2) {
    append(panel, [
      h('div.capsec', {}, h('div.dlabel', { text: '这一次你怎么看' }), box.stance),
      h('div.capsec', {}, h('div.dlabel', { text: '这条记录的来龙去脉' }), box.extras),
      box.hint,
    ])
  } else {
    append(panel, [
      // 这一格不另起标题：里头第一行就是「这条记下去算什么」的原话，
      // 再压一句「算对的标准」等于把同一句话说两遍。
      h('div.capsec', {}, box.crit),
      h('div.capsec', {}, h('div.dlabel', { text: '这条记下去会是什么样' }), box.parse),
    ])
  }

  paintAll()
  stagger([...panel.children])
  if (at.n === 1) {
    autosize(text)
    text.focus()
    text.setSelectionRange(text.value.length, text.value.length)
  }

  return () => {
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
      h('p.wizl', { text: at.lead }),
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
      draft.path !== 'unknown' ||
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
  paintHint()
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

  const instrument = popChip({
    label: () => (draft.instrument ? '换品种' : '选品种'),
    active: () => draft.instrument !== null,
    search: '搜合约代码，如 BTCUSDT',
    items: async (q) => {
      const list = await findInstruments(q, {})
      return list.map((row) => ({
        label: row.symbol,
        value: row.symbol,
        hint: [MARKET_LABELS[row.market], contractLabel(row.body.contractType)]
          .filter(Boolean)
          .join(' · '),
        on: draft.instrument?.symbol === row.symbol && draft.instrument.market === row.market,
      }))
    },
    onPick: (symbol) => {
      // findInstruments filled the catalogue cache, so the picked row is there.
      draft.instrument = cached(symbol)
      paintCtx()
      paintParse()
    },
    onClear: () => {
      draft.instrument = null
      paintCtx()
      paintParse()
    },
    footer: () => '品种身份来自交易所合约目录，不按代码名称推断。',
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

  const identity = draft.instrument
    ? identityOf(draft.instrument)
    : '没选品种也能记。只是这条不会和同品种的其他判断连成一段行情，回头看不出你的看法是在哪一步转的。'

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
    h('div.win', { text: identity }),
  ])
}

function pk(key: string | null, value: string, extra = ''): HTMLElement {
  return h('span', { class: ['pk', extra] }, key ? h('span.k', { text: key }) : null, value)
}

function thresholdChip(): HTMLElement {
  const c = draft.crit
  if (c.thresholdKind === 'percent') {
    const ratio = ratioFromPercent(c.thresholdPercent)
    return pk('阈值', ratio ? `${c.thresholdPercent.trim()}%` : '待填', ratio ? '' : 'ambig')
  }
  if (c.thresholdKind === 'atr') {
    return pk('阈值', c.atrMultiple.trim() ? `${c.atrMultiple.trim()}×ATR14` : '待填')
  }
  return pk('阈值', c.template === 'T5' ? '1.5×ATR14（默认）' : '1×ATR14（默认）')
}

function paintParse(): void {
  if (!ui) return
  const box = ui.parse
  clear(box)
  const c = draft.crit

  if (!draft.text.trim() && !draft.images.items.length) {
    box.appendChild(
      h('span.faint', {
        text: '先说一句话，或者放一张截图，一样就够。方向、标准、标签都可以空着——市场还没开口，先别为了填表耽误盘面。系统不会从你写的中文里猜方向。',
      }),
    )
    return
  }

  const list: HTMLElement[] = []
  if (draft.instrument) {
    list.push(pk('品种', `${draft.instrument.symbol} · ${MARKET_LABELS[draft.instrument.market]}`))
  } else {
    list.push(pk(null, '没选品种：可以记，只是连不成一段行情', 'free'))
  }
  if (draft.timeframe) list.push(pk('周期', draft.timeframe))
  list.push(pk('方向', STANCES[draft.stance]))
  list.push(pk('算对的标准', TEMPLATES[c.template], c.template === 'T0' ? 'free' : ''))

  if (c.template !== 'T0') {
    list.push(pk('期限', `${horizon(c.horizonHours)}${c.horizonTouched ? '' : '（默认）'}`))
    if (c.template !== 'T4') list.push(thresholdChip())
    if (c.invalidation.trim()) list.push(pk('失效', c.invalidation.trim()))
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
  if (draft.path !== 'unknown') list.push(pk('顺序', PATHS[draft.path] ?? draft.path))
  if (draft.claimedAt) list.push(pk('原话时间', dateTime(claimedIso() ?? '')))
  for (const issue of problems(c)) list.push(pk(null, issue, 'ambig'))

  if (protocolText()) {
    list.push(
      h('button.btn.ghost.sm', {
        text: '按上面的写法解析',
        title: '把以 / 开头的一行交给后端解析，再填进上面的选项',
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
  const stances: Stance[] = ['unknown', 'L', 'S', '?', 'C']
  const seg = h('span.seg.big')
  for (const value of stances) {
    seg.appendChild(
      h('button', {
        class: draft.stance === value ? 'on' : '',
        text: STANCES[value],
        on: {
          click: () => {
            draft.stance = value
            // A direction is only ever the stance the trader picked.
            draft.crit.direction = value === 'L' || value === 'S' ? value : null
            paintParse()
            paintStance()
            paintCtx()
          },
        },
      }),
    )
  }
  append(box, [
    seg,
    h('div.tip', {
      text: '「不确定」也是一种判断，照样记：同一个盘面上多空都看得见的时候，把这件事记下来，比事后回忆自己当时到底偏哪边靠谱。',
    }),
  ])
}

function field(label: string, control: HTMLElement, span = false): HTMLElement {
  return h(
    'label.field',
    { style: span ? 'grid-column:span 2' : '' },
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
  const tplSeg = h('span.seg')
  for (const value of templates) {
    tplSeg.appendChild(
      h('button', {
        class: c.template === value ? 'on' : '',
        text: value,
        title: TEMPLATES[value],
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

  append(box, [
    h('div.sentence', { style: 'grid-column:span 2', text: sentence(build(draft.crit)) }),
    field('算对的标准', tplSeg, true),
    h('div.faint', { style: 'grid-column:span 2;margin-top:-4px', text: TEMPLATE_HELP[c.template] }),
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
    box.appendChild(field('多久之内算数', quick, true))
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
    box.appendChild(field('期限（小时）', custom))
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
          '走满百分之几',
          input(c.thresholdPercent, '例如 2 表示 2%', (value) => (c.thresholdPercent = value)),
        ),
      )
    }
    if (c.thresholdKind === 'atr') {
      box.appendChild(
        field('几倍 ATR14', input(c.atrMultiple, '例如 1.5', (value) => (c.atrMultiple = value))),
      )
    }
    box.appendChild(
      field(
        c.template === 'T2' ? '失效价（必填）' : '失效价（可留空）',
        input(c.invalidation, '触及就算没走成', (value) => (c.invalidation = value)),
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
      field('边界价格', input(c.boundary, '例如 61500', (value) => (c.boundary = value))),
    ])
  }

  if (c.template === 'T5') {
    box.appendChild(
      field(
        '振幅门槛（×ATR14）',
        input(c.atrMultiple, '留空按 1.5×ATR14', (value) => (c.atrMultiple = value)),
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
      field('触发价', input(c.triggerPrice, '例如 63000', (value) => (c.triggerPrice = value))),
      field(
        '等它成立的窗口（小时）',
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

/**
 * 标签、想法的来路、当时有几分把握、这句话其实是什么时候说的。
 *
 * 这几样都记在记录本身上，都可以空着，但「谁先触发谁」值得花两秒：先看到图
 * 才有想法，和先有想法再去图上找证据，这两种直觉的可靠性要分开看。
 */
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
        h('span.x', {
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
  box.appendChild(field('标签', tagRow, true))

  const pathSeg = h('span.seg')
  for (const value of ['unknown', 'chart_first', 'thought_first', 'interwoven'] as Path[]) {
    pathSeg.appendChild(
      h('button', {
        class: draft.path === value ? 'on' : '',
        text: PATHS[value] ?? value,
        on: {
          click: () => {
            draft.path = value
            paintExtras()
            paintParse()
          },
        },
      }),
    )
  }
  append(box, [
    field('这次是谁先触发谁', pathSeg, true),
    field(
      '当时有几分把握（0–100，可留空）',
      input(draft.confidence, '留空表示没记', (value) => (draft.confidence = value), 'number'),
    ),
    field(
      '这句话其实是什么时候说的',
      input(
        draft.claimedAt,
        '',
        (value) => {
          draft.claimedAt = value
        },
        'datetime-local',
      ),
    ),
  ])

}

function paintHint(): void {
  if (!ui) return
  const hint = ui.hint
  clear(hint)
  append(hint, [
    '「谁先触发谁」记的是：这次是先看到图上的结构才有想法，还是先有想法再去图上找证据。两种在你身上都有，分开记才知道各自靠不靠得住。想写快一点，第一步那句话可以用这种写法：',
    h('code', { text: '/kt L s=61500 h=72 | 正文' }),
    '，写完在第三步点「按上面的写法解析」，由后端解析后填进这几项。你写的中文本身不会被当成方向。',
  ])
}

function tagPicker() {
  return popChip({
    label: () => '加标签',
    active: () => false,
    search: '搜已有标签，或输入新名字',
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
        matched.unshift({ label: `新建标签「${query}」`, value: `new:${query}`, hint: null, on: false })
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
    footer: () => '标签是给同一类局面起的名字；新建的之后可以在「局面类别」里补上定义。',
  })
}

async function addNewTag(name: string): Promise<void> {
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
    draft.tags.push(record)
    await tagIndex({ refresh: true })
    paintExtras()
    paintParse()
    toast(`已建立标签 #${name}`)
  } catch (error) {
    problem(error instanceof Error ? error.message : '标签没能建立。')
  }
}

function paintFoot(): void {
  if (!ui) return
  const at = ui.step
  clear(ui.foot)
  clear(ui.nav)
  const blocked = saveBlocker()

  if (at.n === 1) {
    append(ui.foot, [
      h(
        'span.ime',
        { class: composing ? 'on' : '' },
        h('i'),
        composing ? '输入法组字中，回车不会提交' : '回车直接记下来 · ⇧回车换行',
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
      title: blocked ?? '存下来就不改了；后面几步不填也一样成立',
      on: { click: () => void save() },
    },
    draft.saving ? '正在保存…' : '记下来',
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
}

/** The one reason the record cannot be written yet, or null. */
function saveBlocker(): string | null {
  if (!draft.text.trim() && !draft.images.items.length) return '至少要写一句话或者放一张图。'
  if (draft.images.uploading) return '截图还在上传，请稍等。'
  if (draft.images.pending) return '还有截图未上传成功，请重试或移除。'
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
  if (!text) return
  try {
    const parsed = await preview(text)
    if (parsed.issues.length) {
      problem(`这一行里有看不懂的地方（${parsed.issues.join('、')}），已经选好的标准没有改动。`)
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
    toast('已经按这一行填好标准，仍然可以改。')
  } catch (error) {
    problem(error instanceof Error ? error.message : '这一行没能解析出来。')
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
  const payload = body()
  const key = saveAction.keyFor(payload)
  draft.saving = true
  paintShot()
  ui?.panel.classList.add('saving')
  ui?.panel.prepend(h('div.progress', {}, h('i')))
  paintFoot()
  try {
    const created = await create(payload, key)
    draft.saving = false
    draft.done = created
    saveAction.reset()
    markFresh(created.id)
    invalidateLedger()
    go('new/done')
  } catch (error) {
    draft.saving = false
    paintShot()
    ui?.panel.classList.remove('saving')
    ui?.panel.querySelector('.progress')?.remove()
    paintFoot()
    const retryable = error instanceof NetworkError || (error instanceof ApiError && error.canRetry)
    problem(
      error instanceof Error ? error.message : '这条没有存下来。',
      retryable ? () => void save() : undefined,
    )
  }
}

/** What the backend actually did with the criteria, said plainly. */
function statusLine(created: CreatedCall): string {
  const first = created.criteria_status[0]
  if (!first) return '已经记下来了。'
  if (first.state === 'no_criteria') {
    return first.reason && first.reason !== 'no_explicit_criteria'
      ? `标准没有生效：${first.reason}。这条只留下话和图。`
      : '这条只留下话和图，不判对错。'
  }
  if (first.state === 'insufficient_data') {
    return '标准已经定下来，正在等这段行情走完，到期后自动给结果。'
  }
  return '标准已经定下来。'
}

/** 存下来之后的那块回执。它自己是一页（#/new/done），不是一个浮层。 */
function doneCard(created: CreatedCall): HTMLElement {
  const evidence =
    created.evidence_identity === 'historical_unverified'
      ? '这条标记为「事后补记」，时间以你填的原话时间为准，未经证明。'
      : null
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
        h('div.t', { text: '已经记下来了' }),
        h('div.tip', {
          text: `${draft.instrument?.symbol ?? '未标品种'} · ${dateTime(created.submitted_at)}`,
        }),
        h('div.sentence', { style: 'max-width:44ch;margin:6px auto 0', text: statusLine(created) }),
        evidence ? h('div.tip', { style: 'max-width:44ch;margin:4px auto 0', text: evidence }) : null,
        h('div.faint', {
          style: 'font-family:var(--mono);font-size:11.5px;margin-top:8px',
          text: created.display_id,
        }),
        h('div.tip', {
          style: 'max-width:46ch;margin:10px auto 0',
          text:
            state === 'no_criteria'
              ? '这条不判对错，但它一样留在你的记录里：以后再遇到同一类局面，翻回来能看见当时的原话和当时那张图。'
              : '接下来这条会自己往前走：到期市场给出答案，它会出现在「复盘」里等你回来打分。',
        }),
        h(
          'div.acts',
          {},
          h('a.btn.primary', { href: `#/call/${created.id}`, text: '打开这条记录' }),
          h('button.btn', {
            text: '再记一条',
            on: {
              click: () => {
                discard()
                go('new')
              },
            },
          }),
          h('a.btn.ghost', { href: '#/find', text: '回到我的记录' }),
        ),
      ),
    ),
  )
}

export { discard as resetCapture }

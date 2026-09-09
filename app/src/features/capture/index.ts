// 记录判断 —— the capture overlay.
//
// Three rules shape this panel. Nothing is inferred from the Chinese the
// trader types: stance, horizon and every criteria field come from a control
// they touched, and the slash protocol is parsed by the backend's own
// /v1/calls/preview when they ask for it. The screenshot is uploaded before
// the record is written, so the record can name an attachment that already
// exists. And every write carries one idempotency key per action, minted from
// the request body, so retrying after a dropped connection replays the first
// result instead of writing a second record.

import { uploadWithProgress } from '../../api/attachments'
import { create, preview, type NewCall } from '../../api/calls'
import { ApiError, NetworkError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import { createTag } from '../../api/knowledge'
import type {
  Attachment,
  CreatedCall,
  Instrument,
  Path,
  Stance,
  TagRecord,
  Template,
} from '../../api/types'
import { PATHS, STANCES, TEMPLATES, sentence } from '../../data/criteria'
import { INTERVALS, MARKET_LABELS, cached, findInstruments, identityOf } from '../../data/session'
import { knownTags, tagIndex } from '../../data/store'
import { dateTime, horizon, relative } from '../../data/time'
import { markFresh } from '../find/state'
import { invalidateLedger } from '../find'
import { reload, route } from '../../router'
import { append, clear, h } from '../../ui/dom'
import { stamp } from '../../ui/bits'
import { icon } from '../../ui/icons'
import { dropzone, onPaste } from '../../ui/pick'
import { anyPopOpen, popChip } from '../../ui/pop'
import { progressLine } from '../../ui/states'
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
  file: File | null
  fileUrl: string | null
  attachment: Attachment | null
  uploading: boolean
  progress: number
  uploadFailed: string | null
  instrument: Instrument | null
  timeframe: string | null
  stance: Stance
  path: Path
  confidence: string
  claimedAt: string
  tags: TagRecord[]
  more: boolean
  crit: CriteriaDraft
  saving: boolean
  done: CreatedCall | null
}

function blank(): Draft {
  return {
    text: '',
    file: null,
    fileUrl: null,
    attachment: null,
    uploading: false,
    progress: 0,
    uploadFailed: null,
    instrument: null,
    timeframe: null,
    stance: 'unknown',
    path: 'unknown',
    confidence: '',
    claimedAt: '',
    tags: [],
    more: false,
    crit: emptyCriteriaDraft(),
    saving: false,
    done: null,
  }
}

// The draft outlives the overlay: closing it to look something up must never
// throw away what has been written.
let draft = blank()
const uploadAction = new WriteAction()
const saveAction = new WriteAction()

function discard(): void {
  if (draft.fileUrl) URL.revokeObjectURL(draft.fileUrl)
  draft = blank()
  uploadAction.reset()
  saveAction.reset()
}

interface Ui {
  layer: HTMLElement
  panel: HTMLElement
  shot: HTMLElement
  ctx: HTMLElement
  text: HTMLTextAreaElement
  parse: HTMLElement
  ctrls: HTMLElement
  more: HTMLElement
  hint: HTMLElement
  foot: HTMLElement
  detach: (() => void)[]
}

let ui: Ui | null = null
let composing = false

/* ------------------------------------------------------------------ open */

export function openCapture(): void {
  if (ui) {
    ui.text.focus()
    return
  }
  const layer = document.getElementById('layer')
  if (!layer) return

  const text = h('textarea', {
    id: 'capText',
    rows: 2,
    placeholder: '现在看到什么、为什么这么想，直接说。这句话存下就不改了。',
    value: draft.text,
  }) as HTMLTextAreaElement

  const panel = h('div.panel')
  const shot = h('div.shot.none')
  const ctx = h('div.ctx')
  const parse = h('div.parse')
  const ctrls = h('div.ctrls')
  const more = h('div.more-fields', { hidden: true })
  const hint = h('div.mini-hint', { hidden: true })
  const foot = h('div.pf')

  const close = h(
    'button.close',
    { title: '关闭（Esc）', on: { click: () => closeCapture() } },
    icon('close'),
  )

  append(panel, [
    close,
    h('div.ph', {}, shot, ctx),
    h('div.pin', {}, text),
    parse,
    ctrls,
    more,
    hint,
    foot,
  ])

  const backdrop = h('div.ov', {
    on: {
      click: (e: MouseEvent) => {
        if (e.target === backdrop) closeCapture()
      },
    },
  })
  backdrop.appendChild(h('div.ovwrap', {}, panel))
  clear(layer)
  layer.appendChild(backdrop)

  ui = { layer, panel, shot, ctx, text, parse, ctrls, more, hint, foot, detach: [] }

  ui.detach.push(dropzone(shot, { onPick: pick, onReject: (why) => problem(why) }))
  ui.detach.push(onPaste({ onPick: pick }))

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !ui) return
    // The menus get Escape first; they close on their own listener.
    if (anyPopOpen()) return
    if (document.querySelector('.lightbox')) return
    e.preventDefault()
    closeCapture()
  }
  document.addEventListener('keydown', onKey, true)
  ui.detach.push(() => document.removeEventListener('keydown', onKey, true))

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
    // A pending IME composition owns the Return key.
    if (composing || e.isComposing) return
    e.preventDefault()
    void save()
  })

  paintAll()
  autosize(text)
  text.focus()
  text.setSelectionRange(text.value.length, text.value.length)
}

export function closeCapture(): void {
  if (!ui) return
  for (const off of ui.detach) off()
  clear(ui.layer)
  ui = null
  composing = false
  if (draft.done) discard()
}

/* --------------------------------------------------------------- picture */

function pick(file: File): void {
  if (draft.fileUrl) URL.revokeObjectURL(draft.fileUrl)
  uploadAction.reset()
  draft.file = file
  draft.fileUrl = URL.createObjectURL(file)
  draft.attachment = null
  draft.uploadFailed = null
  draft.progress = 0
  paintShot()
  paintFoot()
  void send(file)
}

function signature(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`
}

/**
 * The scene shot goes up as its own action. A retry reuses the key minted for
 * this file, so a dropped connection cannot leave two copies behind.
 */
async function send(file: File): Promise<Attachment | null> {
  draft.uploading = true
  draft.uploadFailed = null
  paintShot()
  const key = uploadAction.keyFor(signature(file))
  const claimed = new Date(file.lastModified)
  try {
    const attachment = await uploadWithProgress(file, 'scene', key, {
      filename: file.name,
      capturedAt: claimed.getTime() < Date.now() ? claimed : undefined,
      onProgress: (fraction) => {
        draft.progress = fraction
        if (ui) paintShot()
      },
    })
    draft.attachment = attachment
    draft.uploading = false
    draft.progress = 1
    paintShot()
    paintFoot()
    return attachment
  } catch (error) {
    draft.uploading = false
    draft.uploadFailed = error instanceof Error ? error.message : '图片上传失败。'
    paintShot()
    paintFoot()
    return null
  }
}

function dropShot(): void {
  if (draft.fileUrl) URL.revokeObjectURL(draft.fileUrl)
  uploadAction.reset()
  draft.file = null
  draft.fileUrl = null
  draft.attachment = null
  draft.uploadFailed = null
  draft.uploading = false
  paintShot()
  paintFoot()
}

/* ----------------------------------------------------------------- paint */

function paintAll(): void {
  paintShot()
  paintCtx()
  paintParse()
  paintCtrls()
  paintMore()
  paintFoot()
}

function autosize(node: HTMLTextAreaElement): void {
  node.style.height = 'auto'
  node.style.height = `${Math.min(260, node.scrollHeight)}px`
}

function paintShot(): void {
  if (!ui) return
  const box = ui.shot
  // dropzone() parks its hidden <input type=file> inside this element, so it
  // is lifted out and put back rather than wiped on every repaint.
  const picker = box.querySelector('input[type=file]')
  clear(box)
  if (picker) box.appendChild(picker)
  box.classList.toggle('none', !draft.fileUrl)
  if (!draft.fileUrl) {
    append(box, [
      icon('img'),
      h('div', { text: '把截图拖进来' }),
      h('div.faint', { text: '也可以直接粘贴，或点这里选文件' }),
    ])
    return
  }
  const image = h('img', { attrs: { src: draft.fileUrl, alt: '现场图' } })
  append(box, [image])
  if (draft.uploading) {
    box.appendChild(progressLine('正在上传现场图', draft.progress))
  } else if (draft.uploadFailed) {
    box.appendChild(
      h(
        'div.note.warn',
        {},
        h('span', { text: draft.uploadFailed }),
        h('button.btn.sm', {
          text: '重试',
          on: {
            click: (e: Event) => {
              e.stopPropagation()
              if (draft.file) void send(draft.file)
            },
          },
        }),
        h('button.btn.ghost.sm', {
          text: '换一张',
          on: {
            click: (e: Event) => {
              e.stopPropagation()
              dropShot()
            },
          },
        }),
      ),
    )
  } else if (draft.attachment) {
    const a = draft.attachment
    append(box, [
      h('div.cap', {
        text: a.captured_at
          ? `${a.width}×${a.height} · 文件时间 ${dateTime(a.captured_at)}（未经证明）`
          : `${a.width}×${a.height} · 已上传`,
      }),
      h('button.btn.ghost.sm', {
        text: '换一张',
        on: {
          click: (e: Event) => {
            e.stopPropagation()
            dropShot()
          },
        },
      }),
    ])
  }
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
        hint: `${MARKET_LABELS[row.market]} · ${row.body.contractType}`,
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
    h('div.sentence', { text: sentence(build(draft.crit)) }),
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

  if (!draft.text.trim() && !draft.file) {
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

function paintCtrls(): void {
  if (!ui) return
  const box = ui.ctrls
  clear(box)
  const stances: Stance[] = ['unknown', 'L', 'S', '?', 'C']
  const stanceSeg = h('span.seg')
  for (const value of stances) {
    stanceSeg.appendChild(
      h('button', {
        class: draft.stance === value ? 'on' : '',
        text: STANCES[value],
        on: {
          click: () => {
            draft.stance = value
            // A direction is only ever the stance the trader picked.
            draft.crit.direction = value === 'L' || value === 'S' ? value : null
            paintParse()
            paintCtrls()
            paintCtx()
          },
        },
      }),
    )
  }

  const horizons: [number, string][] = [
    [24, '24 小时'],
    [72, '72 小时'],
    [168, '7 天'],
  ]
  const hzSeg = h('span.seg')
  for (const [hours, label] of horizons) {
    hzSeg.appendChild(
      h('button', {
        class: draft.crit.horizonHours === hours ? 'on' : '',
        text: label,
        disabled: draft.crit.template === 'T0',
        on: {
          click: () => {
            draft.crit.horizonHours = hours
            draft.crit.horizonTouched = true
            paintParse()
            paintCtrls()
            paintCtx()
            paintMore()
          },
        },
      }),
    )
  }

  append(box, [
    h('span.lbl', { text: '方向' }),
    stanceSeg,
    h('span.lbl', { text: '期限' }),
    hzSeg,
    h(
      'button.btn.ghost.sm.more',
      {
        on: {
          click: () => {
            draft.more = !draft.more
            paintMore()
          },
        },
      },
      draft.more ? '收起' : '标准和标签',
      icon('chev'),
    ),
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

function paintMore(): void {
  if (!ui) return
  const box = ui.more
  const hint = ui.hint
  box.hidden = !draft.more
  hint.hidden = !draft.more
  clear(box)
  clear(hint)
  if (!draft.more) return
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
            paintMore()
            paintParse()
            paintCtrls()
            paintCtx()
          },
        },
      }),
    )
  }

  append(box, [
    field('算对的标准', tplSeg, true),
    h('div.faint', { style: 'grid-column:span 2;margin-top:-4px', text: TEMPLATE_HELP[c.template] }),
  ])

  if (c.template !== 'T0') {
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
              paintMore()
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
              paintMore()
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
              paintMore()
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
              paintMore()
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

  // Tags, the order the thought arrived in, and how sure the trader was: all
  // stored on the record itself, all optional.
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
              paintMore()
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
            paintMore()
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

  append(hint, [
    '「谁先触发谁」记的是：这次是先看到图上的结构才有想法，还是先有想法再去图上找证据。两种在你身上都有，分开记才知道各自靠不靠得住。想写快一点，可以用这种写法：',
    h('code', { text: '/kt L s=61500 h=72 | 正文' }),
    '，写完点「按上面的写法解析」，由后端解析后填进上面的选项。你写的中文本身不会被当成方向。',
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
      paintMore()
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
    paintMore()
    paintParse()
    toast(`已建立标签 #${name}`)
  } catch (error) {
    problem(error instanceof Error ? error.message : '标签没能建立。')
  }
}

function paintFoot(): void {
  if (!ui) return
  const box = ui.foot
  clear(box)
  const count = draft.text.trim().length
  const blocked = saveBlocker()
  append(box, [
    h(
      'span.ime',
      { class: composing ? 'on' : '' },
      h('i'),
      composing ? '输入法组字中，回车不会提交' : '回车提交 · ⇧回车换行',
    ),
    h(
      'span.go',
      {},
      h('span.faint', { text: `${count} 字` }),
      h(
        'button.btn.primary',
        {
          disabled: blocked !== null || draft.saving,
          title: blocked ?? '',
          on: { click: () => void save() },
        },
        draft.saving ? '正在保存…' : '记下来',
        h('span.kbd', { text: '↩' }),
      ),
    ),
  ])
}

/** The one reason the record cannot be written yet, or null. */
function saveBlocker(): string | null {
  if (!draft.text.trim() && !draft.attachment) return '至少要写一句话或者放一张图。'
  if (draft.uploading) return '现场图还在上传。'
  if (draft.file && !draft.attachment) return '现场图没有上传成功，重试或换一张。'
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
    attachments: draft.attachment ? [draft.attachment.id] : [],
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
    paintDone(created)
    if (route().page === 'find') reload()
  } catch (error) {
    draft.saving = false
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

function paintDone(created: CreatedCall): void {
  if (!ui) return
  const panel = ui.panel
  clear(panel)
  const evidence =
    created.evidence_identity === 'historical_unverified'
      ? '这条标记为「事后补记」，时间以你填的原话时间为准，未经证明。'
      : null
  const state = created.criteria_status[0]?.state ?? 'no_criteria'
  panel.appendChild(
    h(
      'div.done',
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
        h('div.faint', { style: 'font-family:var(--mono);font-size:11.5px;margin-top:8px', text: created.display_id }),
        h(
          'div.acts',
          {},
          h('a.btn.primary', {
            href: `#/call/${created.id}`,
            text: '打开这条记录',
            on: { click: () => window.setTimeout(() => closeCapture(), 0) },
          }),
          h('button.btn', {
            text: '再记一条',
            on: {
              click: () => {
                discard()
                closeCapture()
                openCapture()
              },
            },
          }),
          h(
            'button.btn.ghost',
            { on: { click: () => closeCapture() } },
            '关闭',
            h('span.kbd', { text: 'Esc' }),
          ),
        ),
      ),
    ),
  )
}

export { discard as resetCapture }

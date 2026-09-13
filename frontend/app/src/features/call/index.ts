// 详情 —— 一次判断的全过程，按五段摊开：判断 → 走势 → 结果 → 复盘 → 打法。
//
// 这一页上的每个字都来自 GET /v1/calls/{id}：不可改的正文、图和它们的身份、
// 结果版本、复盘、标签、归组。没有一处是这里重新算出来的。
//
// 每一次写入都是带 `expected_revision` 的追加，各自带幂等键；写完重新读一遍
// 记录，屏幕上不留猜测。

import { uploadWithProgress } from '../../api/attachments'
import { correct, judge, setScene, supplement, voidCall } from '../../api/calls'
import { ApiError, NetworkError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import { createTag, linkTag } from '../../api/knowledge'
import { chartSvg } from '../../api/market'
import { openMarketChart } from '../relive/market-view'
import * as reviews from '../../api/reviews'
import type {
  Attachment,
  AttachmentKind,
  CallDetail,
  Criteria,
  Outcome,
  OutcomeState,
  ReviewDraftState,
  ReviewRecord,
  Uuid,
} from '../../api/types'
import { PATHS, STANCES, sentence } from '../../data/criteria'
import { STAGES, flowOf, fromCallDetail, type Flow } from '../../data/flow'
import { figures, head as headOutcome, pendingState, whyLine } from '../../data/outcome'
import { MARKET_SHORT } from '../../data/session'
import { detail, invalidate, knownTags, tagIndex } from '../../data/store'
import { dateTime, shortDate } from '../../data/time'
import { ATTACHMENT_IDENTITY, identityLabel, stamp, stanceBadge, tagChip } from '../../ui/bits'
import { append, clear, h } from '../../ui/dom'
import { screenshotActions } from '../relive/screenshot'
import { ChartView } from '../../ui/media'
import { stile } from '../../ui/stile'
import { flowBar } from '../../ui/flow'
import { stagger } from '../../ui/motion'
import { openFileDialog } from '../../ui/pick'
import { popChip } from '../../ui/pop'
import { displayId } from '../../ui/record-row'
import { sheet } from '../../ui/sheet'
import { empty, foldout, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { invalidateArchive } from '../archive'
import { invalidateLedger } from '../find'
import { executionSection } from './execution'
import { canReplaceScene, inMainViewer, replacedNote, supersededBlock } from './scene'
import { followupChart, locatedShots, sameInstrumentHref } from './facts'
import { describeSetup } from '../relive/indicator-choice'
import { normalizeSetup } from '../relive/setup'

export function callPage(host: HTMLElement, arg: string): () => void {
  const id = arg.split('/')[0] ?? ''
  const focusSection = arg.split('/')[1]
  let alive = true
  let data: CallDetail | null = null
  let loadVersion = 0
  /** 草稿状态只用来判断这条走到哪一步了；正文还是由复盘编辑区自己读写。 */
  let draftState: ReviewDraftState | null | undefined

  const chart = new ChartView()
  let chartFor: string | null = null
  let chartAttachmentId: Uuid | null = null

  const supplementAction = new WriteAction()
  const sceneAction = new WriteAction()
  const tagAction = new WriteAction()
  const correctAction = new WriteAction()
  const voidAction = new WriteAction()
  const judgeAction = new WriteAction()

  const crumb = h('div.crumb', {}, h('a', { href: '#/find', text: '记录' }))
  const head = h('div.callhead')
  const grid = h('div.detail')
  const rail = h('nav.rail')
  const aside = h('aside.aside')
  // 宽屏是三栏：左边一条竖着的进度轨，中间是这一条本身，右边是事实和操作。
  // 窄屏这几层壳子是一列，顺序和以前一样。
  host.append(h('div.detailwrap', {}, crumb, head, rail, grid, aside))
  const three = window.matchMedia('(min-width:1440px)')
  const relayout = () => { if (alive && data) render() }
  three.addEventListener('change', relayout)

  if (!id) {
    grid.replaceChildren(
      empty({ title: '没有这条记录', action: h('a.btn.sm', { href: '#/find', text: '记录' }) }),
    )
    return () => {
      alive = false
    }
  }

  grid.replaceChildren(spinner('正在加载'))
  void load()

  async function load(refresh = false): Promise<void> {
    if (!alive) return
    const version = ++loadVersion
    try {
      const [fresh, saved] = await Promise.all([
        detail(id, { refresh }),
        // 草稿读不出来不该挡住整页；读不到就是「不知道有没有」，不冒充「没有」。
        reviews.draft(id).catch(() => undefined),
      ])
      if (!alive || version !== loadVersion) return
      data = fresh
      draftState = saved
      render()
    } catch (error) {
      if (!alive || version !== loadVersion) return
      grid.replaceChildren(
        empty({
          title: error instanceof ApiError && error.status === 404 ? '没有这条记录' : '没读出来',
          action: h('a.btn.sm', { href: '#/find', text: '记录' }),
        }),
      )
    }
  }

  /** 写完重新读一遍，屏幕上不留猜测。 */
  async function afterWrite(options: { ledger?: boolean } = {}): Promise<void> {
    invalidate(id)
    if (options.ledger) {
      invalidateLedger()
      // 判过对错、挂过局面之后，战绩和局面那两屏数出来的东西就变了。
      invalidateArchive()
    }
    await load(true)
  }

  /* --------------------------------------------------------------- 画 */

  function render(): void {
    if (!data) return
    const d = data
    const body = d.body
    const claim = body.criteria[0] ?? null
    const now = headOutcome(d)
    const flow = flowOf(fromCallDetail(d, draftState))

    clear(crumb)
    append(crumb, [
      h('a', { href: '#/find', text: '记录' }),
      h('span.sep', { text: '/' }),
      h('span', { text: `${d.instrument ?? '没写'} ${dateTime(d.submitted_at)}` }),
    ])

    clear(head)
    const facts = factsRow(d)
    const acts = actionRow(d)
    clear(aside)
    if (three.matches) {
      // 标签和那个主按钮搬到右栏，是搬不是复制；窄一点的屏幕它们还在头部。
      const tags = facts.querySelector('.ctags')
      append(head, [facts, flowBar(flow)])
      append(aside, [
        asideFacts(d, now),
        h('div.card', {}, acts),
        tags && tags.childElementCount ? h('div.card', {}, tags) : null,
      ])
    } else {
      append(head, [facts, acts, flowBar(flow)])
    }
    paintRail(d, flow)

    const story = h('div.cstages')
    story.appendChild(
      stageBlock('record', '判断', [
        shotsRow(d, ['scene', 'reference']),
        wordsSection(d),
        factsGrid(d),
        criteriaSection(d, claim),
      ]),
    )
    story.appendChild(stageBlock('observe', '走势', [trendSection(d)]))
    story.appendChild(stageBlock('outcome', '结果', [resultSection(d, now, claim)]))
    story.appendChild(stageBlock('review', '复盘', [reviewSection(d)]))
    story.appendChild(stageBlock('distill', '打法', [playSection(d), linkFacts(d)]))
    const care = maintenanceSection(d)
    if (care) story.appendChild(care)
    story.appendChild(
      h('div.recid', { text: `编号 ${displayId({ id: d.id, submitted_at: d.submitted_at })}` }),
    )

    grid.replaceChildren(story)
    stagger([...story.children])
    if (focusSection === 'distill' || focusSection === 'result') {
      requestAnimationFrame(() => {
        if (alive) document.getElementById(`call-${focusSection}`)?.scrollIntoView({ block: 'center' })
      })
    }
  }

  /** 左栏那条竖着的进度轨。走到哪儿画到哪儿，每一段下面一行已有的事实。 */
  function paintRail(d: CallDetail, flow: Flow): void {
    clear(rail)
    rail.style.setProperty('--fp', `${flow.percent}%`)
    for (const stage of STAGES) {
      const mark = flow.marks[stage.id]
      const small = railFact(d, stage.id)
      rail.appendChild(
        h('a', {
          href: `#call-${stage.id}`,
          class: mark === 'now' ? 'on' : mark === 'done' ? 'done' : '',
          on: {
            click: (event: Event) => {
              event.preventDefault()
              document.getElementById(`call-${stage.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            },
          },
        }, h('span', { text: stage.title }), small ? h('small', { text: small }) : null),
      )
    }
  }

  /** 轨上那一行小字，只写这一段已经有的事实。 */
  function railFact(d: CallDetail, stage: string): string | null {
    if (stage === 'record') {
      const at = new Date(d.submitted_at)
      return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    }
    if (stage === 'observe') {
      const n = d.attachments.filter(inMainViewer).length
      return n ? `${n} 张图` : null
    }
    if (stage === 'outcome') {
      const now = headOutcome(d)
      const state: OutcomeState = now ? now.result.state : pendingState(Boolean(d.body.criteria[0]))
      return stamp(state).textContent
    }
    if (stage === 'review') return d.reviews.length ? '已写' : null
    if (stage === 'distill') return d.tags.length || d.adoptions.length ? '已写' : null
    return null
  }

  /** 右栏第一张卡：这一条的事实，字和值都取现有的。 */
  function asideFacts(d: CallDetail, now: Outcome | null): HTMLElement {
    const b = d.body
    const state: OutcomeState = now ? now.result.state : pendingState(Boolean(b.criteria[0]))
    const list = h('div.fl')
    const rows: [string, HTMLElement | string][] = [
      ['方向', STANCES[b.stance] ?? '没写'],
      ['把握', b.confidence === null || b.confidence === undefined ? '没写' : `${b.confidence}%`],
      ['周期', d.timeframe ?? '没写'],
      ['触发', PATHS[b.path] ?? '没写'],
      ['结果', stamp(state)],
    ]
    for (const [key, value] of rows) {
      list.appendChild(h('div', {}, h('div.k', { text: key }),
        h('div.v', {}, typeof value === 'string' ? value : value)))
    }
    return h('div.card', {}, list)
  }

  /** 一段。左边一个段名，右边是这一段里真正发生的事。 */
  function stageBlock(id: string, title: string, parts: (HTMLElement | null)[]): HTMLElement {
    const body = h('div.cstage-in')
    for (const part of parts) if (part) body.appendChild(part)
    return h(
      'section.cstage',
      { id: `call-${id}` },
      h('header.cstage-h', {}, h('h2.cstage-t', { text: title })),
      body,
    )
  }

  /* ------------------------------------------------------------- 头部 */

  /** 一行事实：品种 · 方向 · 把握 · 周期 · 触发 · 时间。右边是标签。 */
  function factsRow(d: CallDetail): HTMLElement {
    const b = d.body
    const line = h('div.cfacts')
    line.appendChild(
      h(
        'h1.h1',
        {},
        d.instrument ?? '没写',
        d.market ? h('span.lat', { text: MARKET_SHORT[d.market] }) : null,
      ),
    )
    const bits: (HTMLElement | string)[] = [
      stanceBadge(b.stance),
      b.confidence === null || b.confidence === undefined ? '没写' : `把握 ${b.confidence}%`,
      d.timeframe ?? '没写',
      PATHS[b.path] ?? '没写',
      dateTime(d.submitted_at),
    ]
    for (const bit of bits) {
      line.appendChild(h('span.dot'))
      line.appendChild(typeof bit === 'string' ? h('span', { text: bit }) : bit)
    }
    if (d.voided) {
      line.appendChild(h('span.dot'))
      line.appendChild(h('span.stamp.flat', { text: '已作废' }))
    }
    return h('div.chead-top', {}, line, tagsRow(d))
  }

  function tagsRow(d: CallDetail): HTMLElement {
    const row = h('div.ctags')
    for (const tag of d.tags) {
      const chip = h('a', { href: `#/find/tag/${encodeURIComponent(tag.name)}` }, tagChip(tag.name))
      row.appendChild(chip)
    }
    if (!d.voided) row.appendChild(tagPicker(d))
    return row
  }

  /**
   * 只有一个主按钮。有已对上的图才重温得了；没有就是 `先对上行情`，按下去滚到
   * 截图卡那儿。
   */
  function actionRow(d: CallDetail): HTMLElement {
    const ready = locatedShots(d).length > 0
    const button = ready
      ? h('a.btn.primary', {
          href: `#/relive/${d.id}/1`,
          text: '重温',
          title: '重温（R）',
        })
      : h('button.btn.primary', {
          text: '先对上行情',
          on: {
            click: () => document.getElementById('call-record')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          },
        })
    return h('div.chead-act', {}, button)
  }

  function tagPicker(d: CallDetail): HTMLElement {
    const linked = new Set(d.tags.map((t) => t.id))
    return popChip({
      label: () => '+ 标签',
      active: () => false,
      search: '标签名',
      items: async (query) => {
        await tagIndex()
        const q = query.trim()
        const rows = knownTags()
          .filter((t) => !linked.has(t.id))
          .filter((t) => !q || t.name.includes(q) || t.aliases.some((a) => a.includes(q)))
          .slice(0, 30)
          .map((t) => ({ label: `#${t.name}`, value: t.id, hint: t.definition || null }))
        const exact = knownTags().some((t) => t.name === q)
        if (q && !exact) rows.unshift({ label: `新建「${q}」`, value: `new:${q}`, hint: null })
        return rows.length ? rows : [{ label: '还没有标签', value: '', hint: null }]
      },
      onPick: (value) => {
        if (!value) return
        void attachTag(d, value)
      },
    }).node
  }

  async function attachTag(d: CallDetail, value: string): Promise<void> {
    try {
      let tagId = value
      if (value.startsWith('new:')) {
        const name = value.slice(4)
        const made = await createTag({ name, definition: '', aliases: [] }, new WriteAction().keyFor({ name }))
        tagId = made.id
        await tagIndex({ refresh: true })
      }
      const payload = { call_id: d.id, tag_id: tagId, expected_revision: d.revision }
      await linkTag(payload, tagAction.keyFor(payload))
      tagAction.reset()
      toast('记下了')
      await afterWrite({ ledger: true })
    } catch (error) {
      writeFailed(error, () => void attachTag(d, value))
    }
  }

  /* --------------------------------------------------------- 判断：图 */

  /**
   * 截图卡。一张一卡，状态行永远在：已对上 / 没对上 / 正在对行情。角标可点，
   * 右上角 `···` 是换当时图、补图和改身份。
   */
  function shotsRow(d: CallDetail, kinds: AttachmentKind[]): HTMLElement | null {
    const shots = [...d.attachments]
      .filter((a) => kinds.includes(a.kind))
      .filter(inMainViewer)
      .sort(order)
    const strip = h('div.shots')
    if (!shots.length) {
      if (d.voided) return null
      strip.appendChild(
        h(
          'div.shot.shot-none',
          {},
          h('span.faint', { text: '没有图' }),
          h('button.btn.sm.ghost', {
            text: '加参考图',
            on: { click: () => addPicture(d, 'reference') },
          }),
        ),
      )
      return strip
    }
    for (const shot of shots) strip.appendChild(shotCard(d, shot))
    const said = replacedNote(d)
    const old = supersededBlock(d)
    if (!said && !old) return strip
    return h(
      'div',
      {},
      strip,
      said ? h('div.faint.sceneflag', { text: said }) : null,
      old ? sceneHistory(d, old) : null,
    )
  }

  /**
   * 一张截图就是一块小板子：板面放它对上的那段真实行情，原图在「看截图」后面。
   * 定位、候选、手动校准、找相似这一行操作照旧挂在脚注里，`···` 还是那几项。
   */
  function shotCard(d: CallDetail, shot: Attachment): HTMLElement {
    // 对上（或解开）之后板子就地重画，记录对象同步改掉，回到这页不必刷新。
    const card = stile({
      id: shot.id,
      label: identityLabel(shot),
      tone: shot.kind === 'reference' ? 'ref' : shot.kind === 'supplement' ? 'after' : '',
      location: shot.location,
      onLocation: (at) => { shot.location = at },
      onMenu: d.voided ? undefined : () => shotMenu(d, shot),
      acts: screenshotActions(shot.id, shot.location, (at) => { shot.location = at; card.locate(at) }),
      alt: `${d.instrument ?? ''} ${identityLabel(shot)}`,
    })
    return card
  }

  const KIND_MENU: { kind: AttachmentKind; label: string }[] = [
    { kind: 'reference', label: '改成参考图' },
    { kind: 'scene', label: '改成当时图' },
    { kind: 'supplement', label: '改成之后的图' },
  ]

  function shotMenu(d: CallDetail, shot: Attachment): void {
    if (d.voided) return
    const list = h('div.menu')
    list.appendChild(
      h('button.menu-i', {
        text: shot.kind === 'scene' ? '换当时图' : shot.kind === 'reference' ? '再补一张参考图' : '再补一张之后的图',
        on: {
          click: () => {
            layer.close()
            if (shot.kind === 'scene') void replaceScene(d)
            else if (shot.kind === 'reference' || shot.kind === 'supplement') void addPicture(d, shot.kind)
          },
        },
      }),
    )
    for (const item of KIND_MENU) {
      if (item.kind === shot.kind) continue
      list.appendChild(
        h('button.menu-i', {
          text: item.label,
          on: {
            click: () => {
              layer.close()
              void changeKind(shot, item.kind)
            },
          },
        }),
      )
    }
    const layer = sheet(identityLabel(shot), list)
  }

  async function changeKind(shot: Attachment, kind: AttachmentKind): Promise<void> {
    try {
      const { patchKind } = await import('../../api/attachments')
      await patchKind(shot.id, kind)
      toast('记下了')
      await afterWrite()
    } catch (error) {
      writeFailed(error, () => void changeKind(shot, kind))
    }
  }

  /** 换下来的那几张，默认收着。一行都没删，随时指得回来。 */
  function sceneHistory(
    d: CallDetail,
    block: { label: string; items: { attachment_id: Uuid; uploaded_at: string; superseded_at: string }[] },
  ): HTMLElement {
    const list = h('div.scene-olds')
    for (const item of block.items) {
      list.appendChild(
        h(
          'div.scene-old-row',
          {},
          stile({ id: item.attachment_id, compact: true, label: '换下来的图', alt: '换下来的图' }),
          h('span.faint', { text: shortDate(item.superseded_at) }),
          d.voided
            ? null
            : h('button.btn.sm.ghost', {
                text: '换回这张',
                on: { click: () => void applyScene(d, item.attachment_id) },
              }),
        ),
      )
    }
    return foldout(block.label, list)
  }

  /* ------------------------------------------------------ 判断：话和事实 */

  function wordsSection(d: CallDetail): HTMLElement | null {
    if (!d.original_text.trim()) return null
    return h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '原话' })),
      // 原话是用户输入，按纯文本渲染。
      h('div.quote.lg', { text: d.original_text }),
    )
  }

  function factsGrid(d: CallDetail): HTMLElement {
    const b = d.body
    const rows: [string, string][] = [
      ['方向', STANCES[b.stance] ?? '没写'],
      ['触发', PATHS[b.path] ?? '没写'],
      ['把握', b.confidence === null || b.confidence === undefined ? '没写' : `${b.confidence}%`],
      ['周期', d.timeframe ?? '没写'],
    ]
    const grid2 = h('div.momentgrid')
    for (const [key, value] of rows) {
      grid2.appendChild(h('div.mf', {}, h('span.k', { text: key }), h('span.v', { text: value })))
    }
    return grid2
  }

  function criteriaSection(d: CallDetail, claim: Criteria | null): HTMLElement {
    const box = h('div.sec', {}, h('div.sh', {}, h('span.eyebrow.noline', { text: '怎么算对' })))
    if (claim && claim.template !== 'T0') {
      box.appendChild(h('div.sentence', { text: sentence(claim) }))
      return box
    }
    box.appendChild(
      h(
        'div.row',
        { style: 'gap:10px;align-items:center' },
        h('span.faint', { text: '没写' }),
        d.voided
          ? null
          : h('button.btn.sm.ghost', { text: '补一句', on: { click: () => openCorrection(d) } }),
      ),
    )
    return box
  }

  /* --------------------------------------------------------- 走势 */

  function trendSection(d: CallDetail): HTMLElement {
    const later = [...d.attachments].filter((a) => a.kind === 'supplement').sort(order)
    const box = h('div')
    if (later.length) {
      const strip = h('div.shots')
      for (const shot of later) strip.appendChild(shotCard(d, shot))
      box.appendChild(strip)
    }
    if (locatedShots(d).length) {
      box.appendChild(chartSection(d))
    }
    if (!d.voided) {
      box.appendChild(
        h('button.btn.sm.ghost', {
          text: '补一张之后的图',
          on: { click: () => addPicture(d, 'supplement') },
        }),
      )
    }
    return box
  }

  function chartSection(d: CallDetail): HTMLElement {
    const shots = locatedShots(d)
    let selected = shots.find((shot) => shot.id === chartAttachmentId) ?? shots[0]!
    const picks = h('div.row', { style: 'gap:8px;flex-wrap:wrap;margin-bottom:10px' })
    const facts = h('div.faint', { style: 'margin-bottom:10px' })
    const view = h('button.linkbtn', { text: '看 K 线', on: { click: () => {
      const request = followupChart(selected.location)
      if (request) openMarketChart(request, '这段走势', { attachmentId: selected.id, record: normalizeSetup(d.chart_setup ?? null) })
    } } }) as HTMLButtonElement
    const retry = h('button.linkbtn', { text: '重新加载', on: { click: () => paint(true) } })
    const controls = shots.map((shot, index) => {
      const button = h('button.btn.sm.ghost', { text: `${shot.location.symbol} · ${shot.location.interval} · 图 ${index + 1}`, on: { click: () => { selected = shot; paint() } } })
      picks.appendChild(button)
      return { shot, button }
    })
    function paint(refresh = false): void {
      chartAttachmentId = selected.id
      const at = selected.location
      controls.forEach(({ shot, button }) => {
        button.classList.toggle('on', shot.id === selected.id)
        button.setAttribute('aria-pressed', String(shot.id === selected.id))
      })
      const request = followupChart(at)
      view.disabled = !request
      if (!request) {
        chart.cancel()
        chartFor = null
        chart.node.replaceChildren(h('div.faint', { text: '这张图的行情位置不完整，请重新对上行情' }))
        return
      }
      const drawn = describeSetup(normalizeSetup(d.chart_setup ?? null))
      facts.textContent = `${at.symbol} · ${MARKET_SHORT[at.market]} · ${at.interval} · ${dateTime(at.start_at)} – ${dateTime(request.end_at)}${drawn ? ` · 指标 ${drawn}` : ''}`
      const key = JSON.stringify(request)
      if (refresh || chartFor !== key) {
        chartFor = key
        void chart.show(async (signal) => {
          const svg = await chartSvg(request, { signal })
          signal.throwIfAborted()
          return svg
        })
      }
    }
    paint()
    return h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '后续走势' }), view, retry),
      shots.length > 1 ? picks : null,
      facts,
      chart.node,
    )
  }

  /* --------------------------------------------------------- 结果 */

  const JUDGES: { state: 'realized' | 'unrealized' | 'not_triggered'; label: string }[] = [
    { state: 'realized', label: '对' },
    { state: 'unrealized', label: '错' },
    { state: 'not_triggered', label: '不算' },
  ]

  function resultSection(d: CallDetail, now: Outcome | null, claim: Criteria | null): HTMLElement {
    const box = h('div')
    const state: OutcomeState = now ? now.result.state : pendingState(Boolean(claim))
    const decided = state === 'realized' || state === 'unrealized' || state === 'not_triggered'
    const line = h('div.verdict-line', {}, stamp(state, true))
    if (decided && now) {
      line.appendChild(h('span.why', { text: `${dateTime(now.created_at)} 判的` }))
    } else {
      const why = whyLine(now?.result ?? null)
      if (why) line.appendChild(h('span.why', { text: why }))
    }
    box.appendChild(line)
    if (claim && claim.template !== 'T0') {
      box.appendChild(h('div.faint', { text: `按「怎么算对」判：${sentence(claim)}` }))
    }
    if (!decided && !d.voided && claim && claim.template !== 'T0') {
      const acts = h('div.acts')
      for (const item of JUDGES) {
        acts.appendChild(
          h('button.btn.sm.ghost', {
            text: item.label,
            on: { click: () => void setVerdict(d, item.state) },
          }),
        )
      }
      box.appendChild(acts)
    }
    const stats = figures(now?.result ?? null)
    if (stats.length) {
      const grid2 = h('div.stats')
      for (const row of stats) {
        grid2.appendChild(h('div.stat', {}, h('div.v', { text: row.value }), h('div.k', { text: row.key })))
      }
      box.appendChild(grid2)
    }
    return box
  }

  async function setVerdict(
    d: CallDetail,
    state: 'realized' | 'unrealized' | 'not_triggered',
  ): Promise<void> {
    const payload = { state, expected_revision: d.revision }
    try {
      await judge(d.id, payload, judgeAction.keyFor(payload))
      judgeAction.reset()
      toast('记下了')
      await afterWrite({ ledger: true })
    } catch (error) {
      writeFailed(error, () => void setVerdict(d, state))
    }
  }

  /* --------------------------------------------------------- 复盘 */

  function reviewSection(d: CallDetail): HTMLElement {
    const box = h('div')
    const list = [...d.reviews].sort((a, b) => a.created_at.localeCompare(b.created_at))
    list.forEach((item, at) => box.appendChild(reviewRow(item, at + 1)))
    if (d.voided) return box
    box.appendChild(
      h('a.btn.primary.sm', { href: `#/review/${d.id}/step/1`, text: '写复盘' }),
    )
    return box
  }

  function reviewRow(item: ReviewRecord, n: number): HTMLElement {
    return h(
      'div.inset',
      {},
      h('div.rvh', {}, h('b', { text: `第 ${n} 版 · ${shortDate(item.created_at)}` })),
      item.body.note ? h('div.quote.sm', { text: item.body.note }) : null,
      item.body.better_play ? h('div.quote.sm', { text: item.body.better_play }) : null,
    )
  }

  /* --------------------------------------------------------- 打法 */

  function playSection(d: CallDetail): HTMLElement {
    const box = h('div.row', { style: 'gap:10px;align-items:center;flex-wrap:wrap' })
    for (const tag of d.tags) {
      box.appendChild(h('a.btn.sm.ghost', { href: `#/archive/${tag.id}`, text: tag.name }))
    }
    if (d.adoptions.length) box.appendChild(h('span.faint', { text: '关联过打法' }))
    if (!d.voided) box.appendChild(h('a.btn.sm.ghost', { href: `#/archive?call=${d.id}`, text: d.tags.length ? '归到另一类局面' : '归到一类局面' }))
    else if (!d.tags.length) box.appendChild(h('span.faint', { text: '没归类' }))
    return box
  }

  /** 详情没有成交关联读取/计数字段；仅提供真实的查看和关联入口。 */
  function linkFacts(d: CallDetail): HTMLElement {
    const rows = h('div.factlines')
    const same = sameInstrumentHref(d)
    if (same) rows.appendChild(h('a.factline', { href: same, text: '查看同品种记录' }))
    rows.appendChild(h('a.factline', { href: '#/find?by=fills', text: '查看成交记录' }))
    if (d.voided) return rows
    const fills = h('div.factline')
    const slot = h('div', { hidden: true, style: 'margin-top:10px' })
    fills.appendChild(
      h('button.linkbtn', {
        text: '关联实际成交',
        on: {
          click: () => {
            slot.hidden = !slot.hidden
            if (!slot.hidden && !slot.firstChild) slot.appendChild(executionSection(d))
          },
        },
      }),
    )
    rows.append(fills, slot)
    return rows
  }

  /* ------------------------------------------------- 更正 / 作废 */

  function openCorrection(d: CallDetail): void {
    const field = h('textarea.textarea', { rows: 3 }) as HTMLTextAreaElement
    const body = h(
      'div',
      {},
      field,
      h(
        'div.acts',
        {},
        h('button.btn.sm.primary', {
          text: '记下',
          on: {
            click: () => {
              const text = field.value.trim()
              if (!text) return
              layer.close()
              void submitCorrection(d, text)
            },
          },
        }),
      ),
    )
    const layer = sheet('更正', body)
    field.focus()
  }

  function maintenanceSection(d: CallDetail): HTMLElement | null {
    if (d.voided) return null
    const reason = h('textarea.textarea', { rows: 2 }) as HTMLTextAreaElement
    return h(
      'div.care',
      {},
      h(
        'div.care-i',
        {},
        h('b', { text: '更正' }),
        h('span.faint', { text: '更正只补说明，不改对错' }),
        h('button.btn.sm.ghost', { text: '更正', on: { click: () => openCorrection(d) } }),
      ),
      foldout(
        '作废',
        h('div.faint', { text: '作废后不再复盘，内容保留' }),
        reason,
        h(
          'div.acts',
          {},
          h('button.btn.sm.danger', {
            text: '作废',
            on: {
              click: () => {
                const text = reason.value.trim()
                if (!text) return
                void submitVoid(d, text)
              },
            },
          }),
        ),
      ),
    )
  }

  async function submitCorrection(d: CallDetail, explanation: string): Promise<void> {
    const payload = { expected_revision: d.revision, category: 'annotation' as const, explanation }
    try {
      await correct(d.id, payload, correctAction.keyFor(payload))
      correctAction.reset()
      toast('记下了')
      await afterWrite()
    } catch (error) {
      writeFailed(error, () => void submitCorrection(d, explanation))
    }
  }

  async function submitVoid(d: CallDetail, reason: string): Promise<void> {
    const payload = { reason, expected_revision: d.revision }
    try {
      await voidCall(d.id, payload, voidAction.keyFor(payload))
      voidAction.reset()
      toast('记下了')
      await afterWrite({ ledger: true })
    } catch (error) {
      writeFailed(error, () => void submitVoid(d, reason))
    }
  }

  /* --------------------------------------------------------- 传图 */

  async function addPicture(
    d: CallDetail,
    kind: Extract<AttachmentKind, 'supplement' | 'reference'>,
  ): Promise<void> {
    openFileDialog({
      onReject: (why) => problem(why),
      onPick: (file) => {
        const bar = h('div.progress', {}, h('i'))
        host.prepend(bar)
        const fill = bar.firstElementChild as HTMLElement
        const key = supplementAction.keyFor({ kind, name: file.name, size: file.size, at: file.lastModified })
        void (async () => {
          try {
            const uploaded = await uploadWithProgress(file, kind, key, {
              filename: file.name,
              capturedAt:
                file.lastModified && file.lastModified < Date.now()
                  ? new Date(file.lastModified)
                  : undefined,
              onProgress: (fraction) => {
                fill.style.width = `${Math.round(fraction * 100)}%`
              },
            })
            const payload = { attachment_id: uploaded.id, expected_revision: d.revision }
            await supplement(d.id, payload, new WriteAction().keyFor(payload))
            supplementAction.reset()
            bar.remove()
            toast('记下了')
            await afterWrite()
          } catch (error) {
            bar.remove()
            writeFailed(error)
          }
        })()
      },
    })
  }

  /** 换的是「此刻拿哪一张当当时图」这个判断，不是证据；旧的那张留着。 */
  async function replaceScene(d: CallDetail): Promise<void> {
    if (!canReplaceScene(d)) {
      return
    }
    openFileDialog({
      onReject: (why) => problem(why),
      onPick: (file) => {
        const bar = h('div.progress', {}, h('i'))
        host.prepend(bar)
        const fill = bar.firstElementChild as HTMLElement
        const key = sceneAction.keyFor({ name: file.name, size: file.size, at: file.lastModified })
        void (async () => {
          try {
            const uploaded = await uploadWithProgress(file, 'scene', key, {
              filename: file.name,
              capturedAt:
                file.lastModified && file.lastModified < Date.now()
                  ? new Date(file.lastModified)
                  : undefined,
              onProgress: (fraction) => {
                fill.style.width = `${Math.round(fraction * 100)}%`
              },
            })
            bar.remove()
            // 上传成功但换图失败时不 reset：再试一次要拿同一个 key 去传同一张图。
            if (await applyScene(d, uploaded.id)) sceneAction.reset()
          } catch (error) {
            bar.remove()
            writeFailed(error)
          }
        })()
      },
    })
  }

  async function applyScene(d: CallDetail, attachmentId: Uuid): Promise<boolean> {
    const payload = { attachment_id: attachmentId, expected_revision: d.revision }
    try {
      await setScene(d.id, payload, new WriteAction().keyFor(payload))
      toast('记下了')
      await afterWrite()
      return true
    } catch (error) {
      writeFailed(error)
      return false
    }
  }

  function writeFailed(error: unknown, retry?: () => void): void {
    if (error instanceof ApiError && error.isConflict) {
      problem('没保存上，再试一次')
      void afterWrite()
      return
    }
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      problem('本机后端还没有这个接口')
      return
    }
    const again = error instanceof NetworkError || (error instanceof ApiError && error.canRetry)
    problem('没保存上，再试一次', again ? retry : undefined)
  }

  return () => {
    alive = false
    three.removeEventListener('change', relayout)
    chart.cancel()
  }
}

/** 当时图在最前，之后的按上传顺序。 */
function order(a: Attachment, b: Attachment): number {
  const rank = (kind: AttachmentKind) => (kind === 'scene' ? 0 : kind === 'supplement' ? 1 : 2)
  return rank(a.kind) - rank(b.kind) || a.uploaded_at.localeCompare(b.uploaded_at)
}

export { ATTACHMENT_IDENTITY }

import { screenshotActions } from '../relive/screenshot'
// 找 —— 一个输入框，说过的话、品种、标签，或者给一张图。
//
// 文字那一半问的是自己的记录：说过的话（语义 + 关键词）、标签和品种。图那一半
// 问的是形状：先认一下这张图（数 K 线、读图上的字），再拿它去比两堆——我的记录
// 里、币安历史里。两条检索一起跑，右上角按下「只看我的记录」就只跑前一条。
//
// 排的是形状上的接近程度，只说很像 / 像 / 有点像，不说后面会怎么走。
//
// 查询图上传成 kind `query`，后端不接受它作为任何一条记录的证据。公开行情的 K 线
// 只在内存里活到这次查看结束，不落盘。
//
// 分成几块：state.ts 记住的东西、run.ts 起检索读进度、hits.ts 一条结果长什么样、
// score.ts 那三个词。

import { uploadWithProgress } from '../../api/attachments'
import { analyze, type SearchCandidate } from '../../api/chart'
import * as chat from '../../api/chat'
import { Latest, WriteAction } from '../../api/http'
import { ApiError } from '../../api/errors'
import * as knowledge from '../../api/knowledge'
import type { KnowledgeHit } from '../../api/knowledge'
import type { Instrument, Market, Uuid } from '../../api/types'
import { INTERVALS, capabilityState, findInstruments } from '../../data/session'
import { knownTags, tagIndex } from '../../data/store'
import { shortDate } from '../../data/time'
import { go } from '../../router'
import { awake } from '../../ui/awake'
import { clear, debounce, h, highlight } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { ChartView, objectUrl } from '../../ui/media'
import { stagger } from '../../ui/motion'
import { morph } from '../../ui/morph'
import { lightbox } from '../../ui/lightbox'
import { onPaste, dropzone, openFileDialog } from '../../ui/pick'
import { popChip } from '../../ui/pop'
import { empty, jobLine } from '../../ui/states'
import { problem } from '../../ui/toast'
import { sourceButton, answerBlocks } from './sources'
import { find } from '../find/state'
import { resultPage } from './pagination'
import { hitList, ranked, syncHits, type HitCtx } from './hits'
import { launch, launchAll, poll, type RunCtx } from './run'
import { forgetImage, forgetRuns, forgetText, moving, state, type RunSlot } from './state'
import { recognizedNames } from '../relive/recognized-setup'

const uploadAction = new WriteAction()
const analyzeAction = new WriteAction()
const askAction = new WriteAction()

/** 认不出周期时让人点一下的那四个。`其它` 里是全部周期。 */
const QUICK: { label: string; value: string }[] = [
  { label: '15分', value: '15m' },
  { label: '1时', value: '1h' },
  { label: '4时', value: '4h' },
  { label: '1日', value: '1d' },
]

export function searchPage(host: HTMLElement, arg: string, query: URLSearchParams): () => void {
  let alive = true
  const textLane = new Latest()
  // `#/recall?q=…` 搬过来的旧地址：把那句话接着放进输入框。
  const asked = query.get('q')
  if (asked && asked !== state.text) {
    state.text = asked
    forgetText()
  }
  const charts: ChartView[] = []
  /** 眼下这一趟是「就地对齐」还是「整块重来」。就地对齐那一趟不许重建结果列。 */
  let patching = false
  /** 每一处还在等的东西留一个停手的开关，离开页面时一起关掉。 */
  const watchers = new Set<() => void>()

  const box = h('section.findwrap')
  const recog = h('div.frecog')
  const groups = h('div.fgroups')
  const lead = h('div.lead', {},
    h('header.pagehead.product-heading', {},
      h('div.lead', {}, h('h1', {}, '找到相似的', h('em', { text: '那一刻' })),
        h('p.sub', { text: '说过的话、品种、标签，或者给一张图。' }))))
  host.append(h('div.spread', {}, lead, h('div.bulk', {}, box, recog, groups)))

  const input = h('textarea#q', {
    class: 'fin',
    rows: 1,
    placeholder: '说过的话、品种、标签，或者给一张图',
    value: state.text,
  }) as HTMLTextAreaElement
  const camera = h('button.ficon', {
    title: '给一张图',
    on: { click: () => openFileDialog({ onPick: take, onReject: (why) => problem(why) }) },
  }, icon('img'))
  const shelf = h('div.fbshelf')
  box.append(h('div.findbox', {}, h('span.ficon.lens', {}, icon('search')), input, camera, h('button.btn.gold', { text: '找', on: { click: () => askText(true) } })), h('div.fbfoot', {}, shelf, mineSwitch()))

  const ctx: RunCtx & HitCtx = {
    alive: () => alive,
    queryAttachmentId: () => state.queryId,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        let left = false
        const stop = () => {
          clearTimeout(timer)
          watchers.delete(stop)
          left = true
          resolve()
        }
        const timer = setTimeout(() => {
          watchers.delete(stop)
          // 离开这一页要立刻醒，页面在后台则继续等——两件事不能互相盖掉。
          void awake().then(() => { if (!left) resolve() })
        }, ms)
        watchers.add(stop)
      }),
    repaint: () => patchGroups(),
    chart: () => {
      const view = new ChartView()
      charts.push(view)
      return view
    },
  }

  /* --------------------------------------------------------- 输入框 */

  const later = debounce(() => askText(), 450)
  input.addEventListener('input', e => {
    state.text = input.value
    grow()
    if (!(e as InputEvent).isComposing) later()
  })
  input.addEventListener('compositionend', () => { state.text = input.value; later() })
  input.addEventListener('keydown', (e) => {
    // 输入法正在拼字的那一下回车是选词，不是提交。
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    askText(true)
  })
  grow()

  const detachPaste = onPaste({ onPick: take, onReject: (why) => problem(why) })
  const detachDrop = dropzone(box, { onPick: take, onReject: (why) => problem(why) })

  function grow(): void {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 168)}px`
  }

  function mineSwitch(): HTMLElement {
    const knob = h('span.switch', {
      class: state.onlyMine ? 'on' : '',
      role: 'switch',
      tabIndex: 0,
      attrs: { 'aria-checked': String(state.onlyMine) },
    })
    const flip = () => {
      state.onlyMine = !state.onlyMine
      knob.classList.toggle('on', state.onlyMine)
      knob.setAttribute('aria-checked', String(state.onlyMine))
      if (state.queryId && state.interval) launchAll(ctx)
      paintGroups()
    }
    knob.addEventListener('click', flip)
    knob.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === ' ' || (e as KeyboardEvent).key === 'Enter') {
        e.preventDefault()
        flip()
      }
    })
    return h('label.fmine', {}, h('span', { text: '只看我的记录' }), knob)
  }

  /* ----------------------------------------------------------- 文字 */

  function askText(force = false): void {
    const query = state.text.trim()
    if (!query) {
      const hadWords = Boolean(state.asked)
      forgetText()
      answer = null
      summaryVersion += 1
      summing = false
      textLane.cancel()
      if (state.queryId && state.interval && (hadWords || force)) { state.mine.exclude = []; launch(state.mine, ctx) }
      paintGroups()
      return
    }
    if (!force && query === state.asked) return
    const changed = query !== state.asked
    const signal = textLane.begin()
    state.asked = query
    state.textBusy = true
    state.textError = null
    state.pendingSources = 0
    state.words = null
    state.tags = []
    state.symbols = []
    answer = null
    summaryVersion += 1
    summing = false
    if (state.queryId && state.interval && (changed || force)) { state.mine.exclude = []; launch(state.mine, ctx) }
    paintGroups()
    void (async () => {
      const [words, , symbols] = await Promise.all([
        knowledge.search({ query, limit: 8 }, { signal }).catch(() => null),
        tagIndex().catch(() => null),
        findInstruments(query, {}).catch(() => [] as Instrument[]),
      ])
      if (!alive || signal.aborted || state.asked !== query) return
      const needle = query.toLowerCase()
      state.words = words?.items ?? []
      state.textError = words ? null : '记录暂时没读出来'
      state.pendingSources = words?.coverage.pending_sources ?? 0
      state.tags = knownTags().filter((tag) => tag.name.toLowerCase().includes(needle)).slice(0, 8)
      state.symbols = symbols.slice(0, 8)
      state.textBusy = false
      paintGroups()
    })()
  }

  /* ------------------------------------------------------------- 图 */

  function take(file: File): void {
    forgetImage()
    const version = state.imageVersion
    summaryVersion += 1
    answer = null
    summing = false
    state.queryName = file.name
    paintShelf()
    paintRecog()
    paintGroups()
    const bar = h('div.fup')
    shelf.replaceChildren(bar)
    const key = uploadAction.keyFor({ name: file.name, size: file.size, at: file.lastModified })
    void (async () => {
      try {
        const up = await uploadWithProgress(file, 'query', key, {
          filename: file.name,
          onProgress: (fraction) => { if (alive && version === state.imageVersion) bar.replaceChildren(jobLine('正在加载', fraction)) },
        })
        if (!alive || version !== state.imageVersion) return
        uploadAction.reset()
        state.queryId = up.id
        state.queryName = `${up.width}×${up.height}`
        paintShelf()
        await recognise(up.id)
      } catch (error) {
        if (!alive || version !== state.imageVersion) return
        forgetImage()
        paintShelf()
        problem(error instanceof Error ? error.message : '没保存上，再试一次')
      }
    })()
  }

  async function recognise(id: Uuid): Promise<void> {
    const body = { attachment_id: id }
    state.recognitionError = false
    paintRecog()
    paintGroups()
    try {
      const found = await analyze(body, analyzeAction.keyFor(body))
      analyzeAction.reset()
      if (!alive || state.queryId !== id) return
      state.analysis = found
      state.unreadable = !found.geometry.supported
      const seen = found.recognized.interval
      state.interval = seen && (INTERVALS as readonly string[]).includes(seen) ? seen : null
    } catch (error) {
      if (!alive || state.queryId !== id) return
      if (error instanceof ApiError && ['chart_too_complex_select_region', 'ordinary_candles_not_resolved', 'chart_obstructed_or_unsupported', 'flat_chart_geometry'].includes(error.code)) state.unreadable = true
      else state.recognitionError = true
    }
    paintRecog()
    if (state.interval && !state.unreadable) launchAll(ctx)
    paintGroups()
  }

  function paintShelf(): void {
    clear(shelf)
    if (!state.queryId) return
    shelf.append(
      h(
        'span.fshelf',
        {},
        h('span.fico', { attrs: { 'aria-hidden': 'true' } }, icon('img')),
        h('span.ftitle', { text: state.queryName }),
        h('button.linkbtn.fsee', {
          type: 'button',
          text: '看截图',
          attrs: { 'aria-label': `看${state.queryName}` },
          on: {
            click: () => {
              const id = state.queryId
              if (!id) return
              void objectUrl(id).then(url => lightbox(url, state.queryName)).catch(() => problem('原图暂时读不出来'))
            },
          },
        }),
        screenshotActions(state.queryId),
        h('button.fx', {
          title: '不用这张图',
          on: {
            click: () => {
              forgetImage()
              answer = null
              summaryVersion += 1
              summing = false
              paintShelf()
              paintRecog()
              paintGroups()
            },
          },
        }, icon('close')),
      ),
    )
  }

  /* ------------------------------------------------------- 认出来了什么 */

  function paintRecog(): void {
    clear(recog)
    if (!state.queryId) return
    if (state.recognitionError) {
      recog.appendChild(h('div.sheet.pad.fcard', {}, h('div.fline', { text: '这次没读出图里的内容' }), h('button.btn.sm', { text: '再试一次', on: { click: () => { if (state.queryId) void recognise(state.queryId) } } })))
      return
    }
    if (state.unreadable) {
      recog.appendChild(h('div.sheet.pad.fcard', {}, h('div.fline', { text: '这张图认不出 K 线，换一张' })))
      return
    }
    if (!state.analysis) {
      recog.appendChild(h('div.sheet.pad.fcard', {}, jobLine('正在加载')))
      return
    }
    const seen = state.analysis.recognized
    const card = h('div.sheet.pad.fcard')
    const span = seen.start_at && seen.end_at
      ? `${shortDate(seen.start_at)}–${shortDate(seen.end_at)}`
      : '？'
    const names = recognizedNames(seen.indicators)
    card.appendChild(h('div.fline', {
      text: `认出来：${seen.symbol ?? '？'} · ${state.interval ?? '？'} · ${span}${names.length ? ` · 指标 ${names.join(' · ')}` : ''}`,
    }))
    if (!state.interval) card.appendChild(intervalChips())
    if (state.interval) card.appendChild(popChip({
      label: () => `周期 ${state.interval}`,
      active: () => false,
      items: () => INTERVALS.map(value => ({ label: value, value, on: value === state.interval })),
      onPick: pickInterval,
    }).node)
    if (state.interval) card.appendChild(popChip({
      label: () => `每页 ${state.limit} 条`,
      active: () => false,
      items: () => [3, 5, 10].map(n => ({ label: `${n} 条`, value: String(n) })),
      onPick: value => { state.limit = Number(value) as 3 | 5 | 10; state.mine.page = 0; state.market.page = 0; paintRecog(); paintGroups() },
    }).node)
    recog.appendChild(card)
  }

  function intervalChips(): HTMLElement {
    const row = h('div.fchips')
    for (const one of QUICK) {
      row.appendChild(h('button.chip.pick', {
        text: one.label,
        on: { click: () => pickInterval(one.value) },
      }))
    }
    row.appendChild(
      popChip({
        label: () => '其它',
        active: () => false,
        items: () => INTERVALS.map((value) => ({ label: value, value })),
        onPick: (value) => pickInterval(value),
      }).node,
    )
    return row
  }

  function pickInterval(value: string): void {
    forgetRuns()
    state.interval = value
    paintRecog()
    launchAll(ctx)
    paintGroups()
  }

  /* --------------------------------------------------------- 结果各组 */

  /**
   * 眼下这一页该是什么样。只算不画。
   *
   * 每一块带一个身份（`data-key`），换了一批数据回来时认得出哪一块还是哪一块。
   */
  function plan(): HTMLElement[] {
    const blocks: HTMLElement[] = []
    const words = wordGroup()
    if (words) blocks.push(words)
    const named = nameGroup()
    if (named) blocks.push(named)
    if (state.queryId && !state.unreadable && !state.recognitionError) {
      blocks.push(runGroup('mine', state.text.trim() ? '与图和文字相关的记录' : '我的记录里', state.mine))
      if (!state.onlyMine) blocks.push(runGroup('market', '历史匹配', state.market))
    }
    if (blocks.length) return blocks
    if (!state.text.trim() && !state.queryId) return []
    if (state.textBusy) return [keyed(h('div.sheet.pad', {}, jobLine('正在加载')), 'busy')]
    return [keyed(h('div.sheet.pad', {}, empty({ title: '没有找到', tip: '换个说法，或者给一张图' })), 'none')]
  }

  /** 换了一次查询：整块重来，从上到下依次入场。 */
  function paintGroups(): void {
    for (const chart of charts.splice(0)) chart.cancel()
    clear(groups)
    const blocks = plan()
    for (const block of blocks) groups.appendChild(block)
    if (blocks.length) stagger(groups.children)
  }

  /**
   * 同一次查询、每两秒读回来的那一版：就地对齐。
   *
   * 不清空、不重建、不重新错峰入场。屏幕上没变的那些字一个都不动，滚到哪儿还在
   * 哪儿，已经画出来的小 K 线一根都不重画；新冒出来的那几条自己进场一次，没了的
   * 那条自己走掉。
   */
  function patchGroups(): void {
    if (!groups.firstElementChild) { paintGroups(); return }
    const fresh = h('div.fgroups')
    patching = true
    try { for (const block of plan()) fresh.appendChild(block) } finally { patching = false }
    morph(groups, fresh)
  }

  function keyed(node: HTMLElement, key: string): HTMLElement {
    node.setAttribute('data-key', key)
    return node
  }

  function group(key: string, title: string, ...children: (Node | null)[]): HTMLElement {
    const block = keyed(h('section.sheet.pad.fgroup'), `grp:${key}`)
    block.appendChild(h('div.fghead', {}, h('span.eyebrow.noline', { text: title })))
    for (const child of children) if (child) block.appendChild(child)
    return block
  }

  /**
   * 一组结果那一列。
   *
   * 就地对齐的时候不重建它：活的那一列交给 `syncHits` 自己改，这里只放一个写着
   * 「别碰」的占位符——小 K 线要发网络请求才画得出来，重建一次就是全部重画一次。
   */
  function hitsBlock(key: string, items: SearchCandidate[]): HTMLElement {
    const id = `hits:${key}`
    const live = groups.querySelector(`.fhits[data-key="${id}"]`)
    if (patching && live) {
      syncHits(ctx, live as HTMLElement, items)
      return h('div.fhits', { attrs: { 'data-key': id, 'data-same': '' } })
    }
    return hitList(ctx, items, id)
  }

  function wordGroup(): HTMLElement | null {
    if (state.textBusy && state.words === null) return group('words', '说过的话', jobLine('正在加载'))
    if (state.textError) return group('words', '我的记录', h('div.fline', { text: state.textError }), h('button.btn.sm', { text: '再试一次', on: { click: () => askText(true) } }))
    const items = state.words ?? []
    if (!items.length && !state.pendingSources) return null
    const list = h('div.fwords')
    for (const hit of items) list.appendChild(wordRow(hit))
    return group('words', '说过的话', summaryButton(), state.pendingSources ? h('div.fline', { text: `还有 ${state.pendingSources} 条记录正在整理` }) : null, list)
  }

  function wordRow(hit: KnowledgeHit): HTMLElement {
    const line = h('div.fw')
    line.appendChild(highlight(readable(hit.excerpt), state.asked))
    const row = keyed(h('div.fword', {}, line, h('div.fm', { text: shortDate(hit.occurred_at) })), `w:${hit.source_kind}:${hit.source_id}`)
    if (hit.source_kind === 'call') {
      row.classList.add('link')
      row.setAttribute('role', 'link')
      row.tabIndex = 0
      row.addEventListener('click', () => go(`call/${hit.source_id}`))
      row.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') go(`call/${hit.source_id}`)
      })
    } else row.appendChild(sourceButton(hit))
    return row
  }

  function nameGroup(): HTMLElement | null {
    if (!state.tags.length && !state.symbols.length) return null
    const list = h('div.fnames')
    for (const tag of state.tags) {
      list.appendChild(keyed(h('button.chip.pick', {
        text: `#${tag.name}`,
        on: { click: () => go(`find/tag/${encodeURIComponent(tag.name)}`) },
      }), `t:${tag.name}`))
    }
    for (const one of state.symbols) {
      list.appendChild(keyed(h('button.chip.pick', {
        text: one.symbol,
        on: {
          click: () => {
            find.instrument = one.symbol
            find.market = one.market as Market
            go('find')
          },
        },
      }), `s:${one.market}:${one.symbol}`))
    }
    return group('names', '标签和品种', list)
  }

  function runGroup(key: string, title: string, slot: RunSlot): HTMLElement {
    if (!state.interval) return group(key, title, h('div.fline', { text: '先选周期' }))
    if (slot.failed || (slot.run && !moving(slot.run.status) && slot.run.status !== 'succeeded')) {
      return group(key, title, h('div.fline', { text: '这次没找完' }), h('button.btn.sm', {
        text: '再试一次', on: { click: () => {
          if (slot.failed && slot.runId && (!slot.run || moving(slot.run.status))) { slot.failed = false; void poll(slot, ctx) }
          else launch(slot, ctx)
          patchGroups()
        } },
      }))
    }
    const result = slot.run?.result ?? null
    const running = !slot.run || moving(slot.run.status) || result?.status !== 'final'
    if (running) return group(key, title, jobLine('正在加载'))
    const items = ranked(result?.status === 'final' ? result.ranked_items ?? result.items : [])
    const page = resultPage(items, slot.page, state.limit)
    slot.page = page.index
    const shown = page.items
    if (!shown.length) {
      if (running) return group(key, title, jobLine('正在加载'))
      return group(key, title, h('div.fline', { text: slot.scope === 'binance_history' ? '币安历史里没有很像的' : state.text.trim() ? '没有同时匹配这张图和这句话的记录' : '我的记录里没有很像的' }))
    }
    const navigate = (index: number): void => {
      slot.page = index
      paintGroups()
      const section = [...groups.querySelectorAll('section')].find(node => node.querySelector('.fghead')?.textContent === title)
      section?.scrollIntoView({ block: 'start' })
    }
    // 页码变了就是另一个按钮：留着旧节点等于留着指向旧页码的那一下点击。
    const pager = h('nav.acts', { attrs: { 'aria-label': `${title}分页`, 'data-key': `pg:${key}:${page.index}:${page.count}` } },
      h('button.btn.sm.ghost', { text: '上一批', disabled: page.index === 0, on: { click: () => navigate(page.index - 1) } }),
      h('span', { text: `第 ${page.index + 1} / ${page.count} 页 · ${items.length} 条`, attrs: { 'aria-live': 'polite' } }),
      h('button.btn.sm.ghost', { text: '下一批', disabled: page.index + 1 >= page.count, on: { click: () => navigate(page.index + 1) } }))
    return group(key, title, pager, hitsBlock(key, shown))
  }

  /* ------------------------------------------------------ 让它归纳一下 */

  let answer: chat.AnswerBlock[] | null = null
  let summing = false
  let summaryVersion = 0

  function summaryButton(): HTMLElement | null {
    if (capabilityState('chat_generation') !== 'ready') return null
    if (answer) return answerBlocks(answer)
    if (summing) return jobLine('正在加载')
    return h('div.acts', {}, h('button.btn.sm', {
      text: '结合这些内容回答',
      on: { click: () => void summarise() },
    }))
  }

  async function summarise(): Promise<void> {
    const question = state.asked
    if (!question || summing) return
    const version = ++summaryVersion
    const imageId = state.queryId
    summing = true
    paintGroups()
    try {
      const refs = (state.words ?? []).map(({ source_kind, source_id, source_version }) => ({ source_kind, source_id, source_version }))
      const body = { message: `${question}\n请结合当前检索到的来源回答，并引用核验后的证据。当前来源：${JSON.stringify(refs)}`, attachment_ids: imageId ? [imageId] : [] }
      const started = await chat.ask(body, askAction.keyFor(body))
      askAction.reset()
      for (;;) {
        if (!alive || version !== summaryVersion || state.asked !== question || state.queryId !== imageId) return
        const run = await chat.run(started.chat_run_id)
        if (!alive || version !== summaryVersion || state.asked !== question || state.queryId !== imageId) return
        if (run.answer?.length) {
          answer = run.answer
          break
        }
        if (run.status !== 'queued' && run.status !== 'running') { problem('这次没有完成回答，可以重试'); break }
        await ctx.sleep(2_000)
      }
    } catch {
      if (alive) problem('没保存上，再试一次')
    }
    if (version === summaryVersion) { summing = false; if (alive) paintGroups() }
  }

  /* ------------------------------------------ 从一条记录的图直接开搜 */

  if (arg.startsWith('like/')) {
    const id = arg.slice(5)
    const hint = pendingHint?.id === id ? pendingHint.hint : null
    pendingHint = null
    if (id && (hint || id !== state.queryId)) {
      forgetImage()
      state.queryId = id
      state.queryName = hint?.name ?? '当时图'
      void recognise(id)
    }
  }

  paintShelf()
  paintRecog()
  paintGroups()
  // 带着一句话进来（旧地址搬过来的，或者上一次留在这儿的），直接找一次。
  if (state.text.trim() && state.words === null) askText()
  // 上一次的检索可能还在后台跑着：回到这一页接着读它的进度，不重新起一次。
  for (const slot of [state.mine, state.market]) if (slot.runId) void poll(slot, ctx)

  return () => {
    alive = false
    textLane.cancel()
    summaryVersion += 1
    detachPaste()
    detachDrop()
    for (const stop of watchers) stop()
    for (const chart of charts) chart.cancel()
  }
}

/**
 * 那条记录已经知道的事，跟着图一起送过来。
 *
 * 只是起点，不是条件：进了这一页每一项都还在人自己手里。
 */
export interface SearchLikeHint {
  /** 记录上写的周期。没写就是没写，这里不拿形状去猜一个。 */
  interval?: string | null
  market?: Market | null
  /** 这张图在那条记录里叫什么：当时图，还是参考图。 */
  name?: string
}

/** 路由里只带得动一个附件号，剩下的提示搁在这儿等这一页自己来取。 */
let pendingHint: { id: Uuid; hint: SearchLikeHint } | null = null

/** 详情页的「找相似」把这张图送到这里。 */
export function searchLike(attachmentId: Uuid, hint: SearchLikeHint = {}): void {
  pendingHint = { id: attachmentId, hint }
  go(`search/like/${attachmentId}`)
}

/** 索引里的片段有时是整条记录的 JSON。把人说的那几句挑出来，读不出来就照原样给。 */
const SPOKEN_FIELDS = ['original_text', 'note', 'better_play', 'vs_last', 'text', 'summary', 'title', 'name']
export function readable(excerpt: string): string {
  const raw = excerpt.trim()
  if (!/^[a-z_]+\s*\n?\s*\{/.test(raw)) return raw
  const said: string[] = []
  for (const key of SPOKEN_FIELDS) {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    const got = m?.[1]
    if (got && got.trim()) {
      try { said.push(JSON.parse(`"${got}"`)) } catch { said.push(got) }
    }
  }
  if (said.length) return said.join(' · ')
  const fields: string[] = []
  for (const key of ['instrument', 'timeframe']) {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))
    const got = m?.[1]
    if (got) fields.push(got)
  }
  const kind = raw.match(/^([a-z_]+)/)?.[1] ?? ''
  const KIND: Record<string, string> = { call: '一条判断', outcome: '一次答案', episode: '一段行情', review: '一篇复盘', playbook: '一种打法' }
  const label = KIND[kind] ?? kind
  return [label, ...fields].filter(Boolean).join(' · ') || raw
}

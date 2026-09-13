// 复盘编辑区 —— 一份写到一半也不会丢的草稿。
//
// 这块界面唯一的承诺是：显示「已保存」的时候，服务器确实已经收下了这些字。
// 所以它只在收到回执之后才改状态文字，也从不用本地缓存冒充同步；关掉页面再
// 进来，恢复的是服务器确认过的那一版。未保存的编辑器留在当前标签页供重试，
// 刷新或关闭前用浏览器的离开提醒保护它，不把本地副本说成「已保存」。
//
// 三件事必须分清楚：
//   · 自动保存草稿   不动原判断，也不产生正式复盘，随便写随便改
//   · 发布           草稿变成一条不能再改的正式复盘，往后只能再追加一条
//   · 丢弃           只删这份草稿，原判断和以前发过的复盘都还在
//
// 发布时要一起交上「你编辑时看到的是哪一版结果」。如果这中间市场给出了新的
// 结果，后端会拒绝这次发布——你写的字一个都不会丢，但必须先看过新结果，再决
// 定这条复盘还算不算数。

import { ApiError, NetworkError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import { ImageUploads } from '../../data/image-uploads'
import { tradeEditor, tradeSummary } from './trades'
import { imagePicker, reviewImages } from '../../ui/image-picker'
import * as reviews from '../../api/reviews'
import type { CallDetail, Outcome, ReviewAction, ReviewPublished, ReviewTrade, ReviewTradeSnapshot, Uuid } from '../../api/types'
import { stateLook, whyLine } from '../../data/outcome'
import { dateTime } from '../../data/time'
import { ask } from '../../ui/confirm'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { note as noteBox, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

/** 四种「和上次比」的说法，后端只认这四个值。 */
export const REVIEW_ACTIONS: { value: ReviewAction; label: string; help: string }[] = [
  { value: 'did', label: '照上次说的做了', help: '' },
  { value: 'did_not', label: '没照上次说的做', help: '' },
  { value: 'keep', label: '维持原来的做法', help: '' },
  { value: 'new', label: '这次是新做法', help: '' },
]

export interface DraftEditorOptions {
  instrument?: string | null
  callId: Uuid
  /** 重新读这条记录，冲突和结果更新之后要用它拿到最新的一版。 */
  reread: () => Promise<CallDetail>
  /** 当前这条记录的结果（current_outcomes），用来说明「你看到的是哪一版」。 */
  outcomes: () => Outcome[]
  /** 正式复盘发布之后通知外面刷新。 */
  onPublished?: (result: ReviewPublished) => void
  /** 草稿状态变化（有没有内容、存没存下）时通知外面，用于列表上的小标记。 */
  onDraftChanged?: (info: { hasText: boolean; savedAt: string | null }) => void
  /** 第一次复盘和补写复盘的引导语不一样。 */
  lead?: string
}

/**
 * 编辑区拆开之后的几块。
 *
 * 一次性摊在一页上的时候它们叠在 `node` 里；引导式复盘一步一页，就把这几块
 * 分到各步里去。它们是同一批节点，同一份状态——分开摆不等于分开存，草稿仍然
 * 是整份自动保存的。
 */
export interface DraftParts {
  /** 后续走势截图。 */
  pictures: HTMLElement
  /** 实盘关联。 */
  trades: HTMLElement
  /** 这次看到了什么。 */
  note: HTMLElement
  /** 下次怎么做。 */
  better: HTMLElement
  /** 和上一次同类局面比。 */
  vsLast: HTMLElement
  /** 冲突和「结果变了」的横幅。 */
  banner: HTMLElement
  /** 每一步都能看到的保存状态和重试入口。 */
  status: HTMLElement
  /** 发布和丢弃。 */
  foot: HTMLElement
}

export interface DraftEditor {
  node: HTMLElement
  parts: DraftParts
  /**
   * 草稿读完了没有。
   *
   * 一步一页的时候这几块被搬到别的容器里，`node` 里那圈「正在读草稿」的转圈
   * 就看不见了；页面自己要知道什么时候才该把它们摆出来，不然会先摆出一组空
   * 框，两百毫秒之后字才跳进去。
   */
  opened: Promise<void>
  /** 这一步之后还能不能发布，引导式复盘用它决定「下一步」亮不亮。 */
  canPublish(): boolean
  hasText(): boolean
  hasUnsaved(): boolean
  /** 离开页面之前把没发出的那一次保存补上。 */
  flush(): Promise<void>
  /** 有未保存内容时拒绝释放，调用方必须保留编辑器以便恢复。 */
  dispose(): boolean
}

const SAVE_DELAY_MS = 800

export function draftEditor(options: DraftEditorOptions): DraftEditor {
  const save = new WriteAction()
  const publishAction = new WriteAction()
  const discardAction = new WriteAction()

  let alive = true
  let ready = false
  /** 草稿时钟。发布或丢弃之后继续往上走，不归零。 */
  let draftRevision = 0
  let callRevision = 0
  /** 用户此刻眼前的那一版结果。发布时必须原样交回去。 */
  let seenOutcomeIds: Uuid[] = []
  let savedAt: string | null = null
  let dirty = false
  let saving = false
  /** 冲突未解决之前不再自动提交，免得把别处的新版本盖掉。 */
  let paused = false
  let timer = 0
  let vs: ReviewAction | null = null
  let publishing = false
  let needsOutcomeReview = false
  let pendingSave: Promise<void> | null = null
  let saveFailed = false
  let imageSignature = '[]'
  const composing = new Set<HTMLTextAreaElement>()
  const positions = tradeEditor(options.instrument, touched, () => ready && !paused && !publishing)
  const images = new ImageUploads('supplement')
  const pictures = imagePicker(images, '补一张之后的图', () => {
    const signature = JSON.stringify(images.ids)
    if (signature !== imageSignature) {
      imageSignature = signature
      touched()
    }
    if (ready) { publish.disabled = !canPublish(); paintState() }
  }, () => ready && !paused && !publishing)

  function restoreImages(ids: Uuid[] = []): void {
    imageSignature = JSON.stringify(ids)
    images.restore(ids)
  }

  const noteInput = h('textarea.textarea', {
    rows: 4,
    placeholder: '当时那句话，哪一半站住了，哪一半没有',
  }) as HTMLTextAreaElement

  const betterInput = h('textarea.textarea', {
    rows: 3,
    placeholder: '同样的局面再来，改哪儿',
  }) as HTMLTextAreaElement

  const opts = h('div.opts.four')

  const state = h('span.dstate', { text: '正在加载', attrs: { role: 'status', 'aria-live': 'polite' } })
  const stateRetry = h('button.linkbtn', {
    text: '重试',
    hidden: true,
    on: { click: () => void flush(true) },
  }) as HTMLButtonElement

  const publish = h('button.btn.primary', {
    text: '发布',
    disabled: true,
    on: { click: () => void doPublish() },
  }) as HTMLButtonElement

  const discard = h('button.btn.ghost.sm', {
    text: '丢弃草稿',
    hidden: true,
    on: { click: () => void doDiscard() },
  }) as HTMLButtonElement

  /** 冲突和「结果变了」都长在这里，不用弹窗打断输入。 */
  const banner = h('div.dbanner', { hidden: true })

  const partPictures = h(
    'div.dpart',
    {},
    pictures.node,
  )
  const partNote = h('div.dpart', {}, noteInput)
  const partBetter = h(
    'div.dpart',
    {},
    h('div.dlabel', { text: '下次怎么做' }),
    betterInput,
  )
  const partVs = h(
    'div.dpart',
    {},
    h('div.dlabel', { text: '和上一次比' }),
    opts,
  )
  const partFoot = h(
    'div.dfoot',
    {},
    publish,
    discard,
  )
  const partStatus = h('span.dstatewrap', {}, state, stateRetry)
  const parts: DraftParts = {
    pictures: partPictures,
    trades: positions.node,
    note: partNote,
    better: partBetter,
    vsLast: partVs,
    banner,
    status: partStatus,
    foot: partFoot,
  }

  const body = h(
    'div.dbody',
    { hidden: true },
    options.lead ? h('div.dlead', { text: options.lead }) : null,
    partPictures,
    positions.node,
    partNote,
    partBetter,
    partVs,
    banner,
    partStatus,
    partFoot,
  )

  const loading = spinner('正在加载')
  const node = h('div.rvform', {}, loading, body)

  let settleOpen: () => void = () => undefined
  let failOpen: (error: unknown) => void = () => undefined
  const opened = new Promise<void>((resolve, reject) => {
    settleOpen = resolve
    failOpen = reject
  })
  // 没人接的时候也不能让它变成未捕获的拒绝。
  opened.catch(() => undefined)

  void open()

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasUnsaved()) return
    event.preventDefault()
    event.returnValue = ''
  }
  window.addEventListener('beforeunload', beforeUnload)

  async function open(): Promise<void> {
    try {
      const current = await reviews.draft(options.callId)
      if (!alive) return
      draftRevision = current.draft_revision
      callRevision = current.call_revision
      seenOutcomeIds = [...current.current_outcome_ids]
      if (current.draft) {
        noteInput.value = current.draft.body.note ?? ''
        betterInput.value = current.draft.body.better_play ?? ''
        vs = current.draft.body.vs_last ?? null
        restoreImages(current.draft.body.attachment_ids)
        positions.restore(current.draft.body.trades, current.draft.body.trade_snapshots)
        savedAt = current.draft.updated_at
      }
      ready = true
      positions.lock()
      pictures.render()
      loading.remove()
      body.hidden = false
      paintOptions()
      paintState()
      report()
      settleOpen()
    } catch (error) {
      if (!alive) return
      failOpen(error)
      loading.replaceWith(
        noteBox(
          'warn',
          '没读出来',
          h('button.linkbtn', { text: '重试', on: { click: () => void retryOpen() } }),
        ),
      )
    }
  }

  async function retryOpen(): Promise<void> {
    clear(node)
    node.append(loading, body)
    await open()
  }

  function paintOptions(): void {
    clear(opts)
    for (const item of REVIEW_ACTIONS) {
      opts.appendChild(
        h('button.opt', {
          class: vs === item.value ? 'on' : '',
          title: item.help,
          text: item.label,
          on: {
            click: () => {
              if (publishing) return
              vs = vs === item.value ? null : item.value
              paintOptions()
                  touched()
            },
          },
        }),
      )
    }
    publish.disabled = !canPublish()
  }

  function canPublish(): boolean {
    if (!ready || paused || publishing || needsOutcomeReview || images.pending || !positions.valid()) return false
    return Boolean(vs) && Boolean(noteInput.value.trim() || betterInput.value.trim())
  }

  function hasText(): boolean {
    return Boolean(noteInput.value.trim() || betterInput.value.trim() || vs || images.items.length || positions.hasContent())
  }

  function hasUnsaved(): boolean {
    return dirty || saving || Boolean(pendingSave) || paused || images.pending || publishing || composing.size > 0
  }

  function report(): void {
    options.onDraftChanged?.({ hasText: hasText(), savedAt })
  }

  function paintState(): void {
    positions.lock()
    stateRetry.hidden = true
    discard.hidden = !savedAt
    if (paused) {
      state.className = 'dstate bad'
      state.textContent = '这条复盘在别处改过，请先选一份留下来'
      return
    }
    if (images.pending) {
      state.className = images.uploading ? 'dstate saving' : 'dstate bad'
      state.textContent = images.uploading ? '图片上传中，草稿还没保存' : '有图片没传上，请在截图旁重试或移除'
      return
    }
    if (saving) {
      state.className = 'dstate saving'
      state.textContent = '保存中'
      return
    }
    if (saveFailed) {
      state.className = 'dstate bad'
      state.textContent = '没保存上，内容还在当前标签页'
      stateRetry.hidden = false
      return
    }
    if (dirty) {
      state.className = 'dstate'
      state.textContent = '还没保存'
      return
    }
    if (savedAt) {
      state.className = 'dstate ok'
      state.textContent = `已保存 · ${dateTime(savedAt)}`
      return
    }
    state.className = 'dstate'
    state.textContent = hasText() ? '还没保存' : ''
  }

  function touched(): void {
    if (!alive || !ready) return
    dirty = true
    publish.disabled = !canPublish()
    paintState()
    report()
    window.clearTimeout(timer)
    if (!paused) timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  for (const field of [noteInput, betterInput]) {
    // 中文输入法组词期间不提交半个字，等 compositionend 之后再算一次改动。
    field.addEventListener('compositionstart', () => {
      composing.add(field)
      window.clearTimeout(timer)
    })
    field.addEventListener('compositionend', () => {
      composing.delete(field)
      touched()
    })
    field.addEventListener('input', () => {
      if (!composing.has(field)) touched()
    })
    field.addEventListener('blur', () => {
      if (dirty) void flush(true)
    })
  }

  /**
   * 每条记录的保存请求串行。正在飞的那一次回来之前不再发第二次，回来之后如果
   * 内容又变了，再补一次，这样两条草稿不会串写。
   */
  async function flush(immediate = false): Promise<void> {
    if (immediate) window.clearTimeout(timer)
    if (!alive || composing.size) return
    await images.wait()
    if (images.pending) { paintState(); return }
    if (pendingSave) return pendingSave
    if (!ready || paused || !dirty) return
    pendingSave = (async () => {
      do {
        saveFailed = false
        await saveOnce()
      } while (dirty && !saveFailed && !paused && !images.pending && !composing.size)
    })().finally(() => { pendingSave = null })
    await pendingSave
  }

  async function saveOnce(): Promise<void> {
    if (!ready || paused || !dirty) return
    if (saving) return
    const payload = {
      expected_draft_revision: draftRevision,
      attachment_ids: images.ids,
      trades: positions.read(),
      note: noteInput.value,
      better_play: betterInput.value.trim() ? betterInput.value : null,
      vs_last: vs,
    }
    saving = true
    dirty = false
    paintState()
    try {
      // 内容变了才换幂等键；网络重试用的是同一把键和同一份正文。
      const result = await reviews.saveDraft(options.callId, payload, save.keyFor(payload))
      saving = false
      draftRevision = result.revision
      savedAt = result.updated_at
      save.reset()
      paintState()
      report()
    } catch (error) {
      saving = false
      saveFailed = true
      dirty = true
      if (error instanceof ApiError && error.code === 'draft_revision_conflict') {
        await onConflict()
        return
      }
      // 失败就近说明，不弹提示；文字全部留在编辑器里，重试用的还是同一把幂等键。
      state.className = 'dstate bad'
      state.textContent =
        error instanceof NetworkError ? '连不上本机服务' : '没保存上，再试一次'
      stateRetry.hidden = false
      report()
    }
  }

  /**
   * 另一处（另一个标签页、另一台机器）先存了。自动保存立刻停下，把那边的内容
   * 读回来并排给用户看，由用户决定留哪一份——绝不拿新版本号直接盖过去。
   */
  async function onConflict(): Promise<void> {
    paused = true
    publish.disabled = true
    paintState()
    pictures.render()
    let remote: Awaited<ReturnType<typeof reviews.draft>>
    try {
      remote = await reviews.draft(options.callId)
    } catch {
      if (!alive) return
      showBanner(
        '这条复盘在别处改过',
        '没读出来',
        [h('button.btn.sm', { text: '再读一次', on: { click: () => void onConflict() } })],
      )
      return
    }
    if (!alive) return
    const theirs = remote.draft?.body
    const mine = { note: noteInput.value, better: betterInput.value, vs }
    showBanner(
      '这条复盘在别处改过',
      theirs ? '选一份留下来' : '别处把草稿清掉了，可以重新存一次',
      [
        h('button.btn.sm.primary', {
          text: '保留我写的',
          on: {
            click: () => {
              draftRevision = remote.draft_revision
              hideBanner()
              paused = false
              saveFailed = false
              dirty = true
              pictures.render()
              publish.disabled = !canPublish()
              void flush(true).then(() => { if (needsOutcomeReview && !dirty && !paused) return onOutcomesChanged() })
            },
          },
        }),
        theirs
          ? h('button.btn.sm', {
              text: '改用别处那份',
              on: {
                click: () => {
                  noteInput.value = theirs.note ?? ''
                  betterInput.value = theirs.better_play ?? ''
                  vs = theirs.vs_last ?? null
                  restoreImages(theirs.attachment_ids)
                  positions.restore(theirs.trades, theirs.trade_snapshots)
                  draftRevision = remote.draft_revision
                  savedAt = remote.draft?.updated_at ?? null
                  hideBanner()
                  paused = false
                  dirty = false
                  saveFailed = false
                  save.reset()
                  pictures.render()
                  paintOptions()
                  paintState()
                  report()
                  if (needsOutcomeReview) void onOutcomesChanged()
                },
              },
            })
          : null,
      ].filter(Boolean) as HTMLElement[],
      theirs
        ? h(
            'div.dcompare',
            {},
            side('我写的', mine.note, mine.better, mine.vs, images.ids, positions.read()),
            side('别处', theirs.note, theirs.better_play, theirs.vs_last, theirs.attachment_ids, theirs.trades, theirs.trade_snapshots),
          )
        : null,
    )
  }

  function side(
    title: string,
    text: string,
    better: string | null,
    action: ReviewAction | null,
    imageIds: Uuid[] = [],
    trades: ReviewTrade[] = [],
    snapshots: ReviewTradeSnapshot[] = [],
  ): HTMLElement {
    const label = REVIEW_ACTIONS.find((a) => a.value === action)?.label
    return h(
      'div.dside',
      {},
      h('div.dside-t', { text: title }),
      h('div.quote.sm', { text: text.trim() || '没写' }),
      better?.trim() ? h('div.faint', { text: `下次怎么做 ${better.trim()}` }) : null,
      label ? h('div.faint', { text: `和上一次比 ${label}` }) : null,
      reviewImages(imageIds),
      tradeSummary(trades, snapshots),
    )
  }

  function showBanner(
    title: string,
    line: string,
    buttons: HTMLElement[],
    extra?: HTMLElement | null,
  ): void {
    clear(banner)
    banner.hidden = false
    banner.append(
      h('div.dbanner-t', {}, icon('info'), h('span', { text: title })),
      h('div.dbanner-l', { text: line }),
      extra ?? '',
      h('div.dbanner-a', {}, ...buttons),
    )
  }

  function hideBanner(): void {
    banner.hidden = true
    clear(banner)
  }

  async function doPublish(): Promise<void> {
    if (!canPublish()) return
    publishing = true
    positions.lock()
    pictures.render()
    noteInput.disabled = betterInput.disabled = true
    publish.disabled = true
    publish.textContent = '正在发布'
    try {
      // 发布之前先把最后一次草稿保存确认掉，否则发出去的会是上一版文字。
      await flush(true)
      if (dirty || paused || saving) {
        publish.textContent = '发布这条复盘'
        publish.disabled = !canPublish()
        problem('刚写的这几个字还没存下来，等它存好再发布。')
        return
      }
      const payload = {
        expected_draft_revision: draftRevision,
        expected_call_revision: callRevision,
        expected_outcome_ids: seenOutcomeIds,
      }
      const result = await reviews.publishDraft(
        options.callId,
        payload,
        publishAction.keyFor(payload),
      )
      if (!alive) return
      publishAction.reset()
      draftRevision = result.draft_revision
      callRevision = result.revision
      savedAt = null
      noteInput.value = ''
      betterInput.value = ''
      vs = null
      restoreImages()
      positions.restore()
      dirty = false
      discard.hidden = true
      publish.textContent = '发布这条复盘'
      publish.disabled = true
      paintOptions()
      paintState()
      report()
      toast('这条复盘已经发布，往后只能再追加，不能改。')
      options.onPublished?.(result)
    } catch (error) {
      if (!alive) return
      publish.textContent = '发布这条复盘'
      publish.disabled = !canPublish()
      if (error instanceof ApiError && error.code === 'review_outcomes_changed') {
        await onOutcomesChanged()
        return
      }
      if (error instanceof ApiError && error.code === 'draft_revision_conflict') {
        await onConflict()
        return
      }
      if (error instanceof ApiError && error.code === 'revision_conflict') {
        await onRecordMoved()
        return
      }
      problem(error instanceof Error ? error.message : '这条复盘没有发布成功。')
    } finally {
      publishing = false
      positions.lock()
      noteInput.disabled = betterInput.disabled = false
      pictures.render()
      publish.disabled = !canPublish()
    }
  }

  /**
   * 市场在你写字的时候给了新的结果。文字全部保留，但必须先看一眼新结果，
   * 再决定这条复盘是不是还算数——不能把没看过的结果悄悄绑上去。
   */
  async function onOutcomesChanged(): Promise<void> {
    needsOutcomeReview = true
    publish.disabled = true
    let fresh: CallDetail | null = null
    let latest: Awaited<ReturnType<typeof reviews.draft>> | null = null
    try {
      ;[fresh, latest] = await Promise.all([options.reread(), reviews.draft(options.callId)])
    } catch {
      if (alive) showBanner('这条记录有了新的结果', '新的结果没读出来，你写的内容还在。', [
        h('button.btn.sm', { text: '重试', on: { click: () => void onOutcomesChanged() } }),
      ])
      return
    }
    if (!alive) return
    if (latest.draft_revision !== draftRevision) { await onConflict(); return }
    const shown = fresh.current_outcomes.filter((o) => latest.current_outcome_ids.includes(o.id))
    if (shown.length !== latest.current_outcome_ids.length) {
      showBanner('结果又更新了', '这一版还没读全，你写的内容还在。', [
        h('button.btn.sm', { text: '再读一次', on: { click: () => void onOutcomesChanged() } }),
      ])
      return
    }
    showBanner(
      '这条记录有了新的结果',
      '你写的字一个都没动。先看一眼下面这一版结果，确认之后再发布，这条复盘就会绑在这一版上。',
      [
        h('button.btn.sm.primary', {
          text: '看过了，继续发布',
          on: {
            click: () => {
              seenOutcomeIds = [...latest.current_outcome_ids]
              callRevision = latest.call_revision
              needsOutcomeReview = false
              hideBanner()
              publish.disabled = !canPublish()
            },
          },
        }),
      ],
      shown.length
        ? h('div.douts', {}, ...shown.map(outcomeLine))
        : h('div.faint', { text: '当前没有结果版本' }),
    )
  }

  async function onRecordMoved(): Promise<void> {
    publish.disabled = true
    try {
      const [fresh, latest] = await Promise.all([options.reread(), reviews.draft(options.callId)])
      if (!alive) return
      if (latest.draft_revision !== draftRevision) { await onConflict(); return }
      if (latest.current_outcome_ids.length !== seenOutcomeIds.length || latest.current_outcome_ids.some((id) => !seenOutcomeIds.includes(id))) {
        await onOutcomesChanged()
        return
      }
      callRevision = latest.call_revision
      void fresh
      showBanner('这条记录刚刚被改过', '已经读到最新的一版，你写的字都还在，再发布一次就行。', [
        h('button.btn.sm.primary', {
          text: '知道了',
          on: {
            click: () => {
              hideBanner()
              publish.disabled = !canPublish()
            },
          },
        }),
      ])
    } catch {
      if (alive) problem('这条记录刚刚被改过，最新的一版还没读出来，稍后再发布一次。')
    }
  }

  async function doDiscard(): Promise<void> {
    if (publishing) return
    await flush(true)
    if (dirty || paused || saving || images.pending) { problem('请先完成图片上传和草稿保存，再丢弃。'); return }
    if (
      hasText() &&
      !(await ask({
        title: '丢掉这份草稿？',
        detail: '草稿中的文字和所选后续截图不会发布。当时那句话和以前发布过的复盘都还在。',
        confirm: '丢掉草稿',
        cancel: '继续写',
        danger: true,
      }))
    ) {
      return
    }
    discard.disabled = true
    const payload = { expected_draft_revision: draftRevision }
    try {
      const result = await reviews.discardDraft(
        options.callId,
        payload,
        discardAction.keyFor(payload),
      )
      if (!alive) return
      discardAction.reset()
      draftRevision = result.draft_revision
      noteInput.value = ''
      betterInput.value = ''
      vs = null
      restoreImages()
      positions.restore()
      savedAt = null
      dirty = false
      discard.hidden = true
      discard.disabled = false
      hideBanner()
      paused = false
      paintOptions()
      paintState()
      report()
      toast('草稿已经丢掉了，原判断没有动。')
    } catch (error) {
      if (!alive) return
      discard.disabled = false
      if (error instanceof ApiError && error.code === 'draft_revision_conflict') {
        await onConflict()
        return
      }
      problem(error instanceof Error ? error.message : '这份草稿没有丢掉。')
    }
  }

  return {
    node,
    opened,
    parts,
    canPublish,
    hasText,
    hasUnsaved,
    flush: () => flush(true),
    dispose() {
      if (hasUnsaved()) return false
      alive = false
      positions.dispose()
      pictures.dispose()
      window.clearTimeout(timer)
      window.removeEventListener('beforeunload', beforeUnload)
      images.onChange = () => {}
      images.clear()
      return true
    },
  }
}

/** 一行结果：状态戳 + 一句为什么，绝不显示内部字段。 */
export function outcomeLine(outcome: Outcome): HTMLElement {
  const look = stateLook(outcome.result.state)
  return h(
    'div.doutline',
    {},
    h('span.tag', { class: look.tone === 'good' ? 'warm' : '', text: look.label }),
    h('span.faint', { text: whyLine(outcome.result) }),
  )
}

// 复盘编辑区 —— 一份写到一半也不会丢的草稿。
//
// 这块界面唯一的承诺是：显示「已保存」的时候，服务器确实已经收下了这些字。
// 所以它只在收到回执之后才改状态文字，也从不用本地缓存冒充同步；关掉页面再
// 进来，恢复的是服务器确认过的那一版。
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
import * as reviews from '../../api/reviews'
import type { CallDetail, Outcome, ReviewAction, ReviewPublished, Uuid } from '../../api/types'
import { stateLook, whyLine } from '../../data/outcome'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { note as noteBox, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

/** 四种「和上次比」的说法，后端只认这四个值。 */
export const REVIEW_ACTIONS: { value: ReviewAction; label: string; help: string }[] = [
  { value: 'did', label: '照上次说的做了', help: '上一次复盘写下的改法，这次照做了。' },
  { value: 'did_not', label: '没照上次说的做', help: '上一次写下了改法，这次还是没做到。' },
  { value: 'keep', label: '维持原来的做法', help: '这次没有改，仍然按原来的方式处理。' },
  { value: 'new', label: '这次是新做法', help: '这次的处理方式和以前不一样。' },
]

export interface DraftEditorOptions {
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

export interface DraftEditor {
  node: HTMLElement
  hasText(): boolean
  /** 离开页面之前把没发出的那一次保存补上。 */
  flush(): Promise<void>
  dispose(): void
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

  const noteInput = h('textarea.textarea', {
    rows: 4,
    placeholder: '这次看到了什么？当时那句话哪一半站住了，哪一半是错觉？',
  }) as HTMLTextAreaElement

  const betterInput = h('textarea.textarea', {
    rows: 3,
    placeholder: '下次同样的局面，怎么做更好？',
  }) as HTMLTextAreaElement

  const opts = h('div.opts.four')
  const optHelp = h('div.tip', { text: '选一个，它会跟着这条复盘一起存下来。' })

  const state = h('span.dstate', { text: '正在读草稿…' })
  const stateRetry = h('button.linkbtn', {
    text: '重试',
    hidden: true,
    on: { click: () => void flush(true) },
  }) as HTMLButtonElement

  const publish = h('button.btn.primary', {
    text: '发布这条复盘',
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

  const body = h(
    'div.dbody',
    { hidden: true },
    h('div.dlead', { text: options.lead ?? '行情已经走完了，现在你怎么看当时那句话？' }),
    noteInput,
    h('div.dlabel', { text: '下次怎么做（可以不写）' }),
    betterInput,
    h('div.dlabel', { text: '和上一次同类局面比' }),
    opts,
    optHelp,
    banner,
    h(
      'div.dfoot',
      {},
      publish,
      discard,
      h('span.dstatewrap', {}, state, stateRetry),
    ),
  )

  const loading = spinner('正在读这条记录的草稿…')
  const node = h('div.rvform', {}, loading, body)

  void open()

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
        savedAt = current.draft.updated_at
      }
      ready = true
      loading.remove()
      body.hidden = false
      paintOptions()
      paintState()
      report()
    } catch (error) {
      if (!alive) return
      loading.replaceWith(
        noteBox(
          'warn',
          error instanceof Error ? error.message : '草稿读不出来。',
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
              vs = vs === item.value ? null : item.value
              paintOptions()
              optHelp.textContent = vs ? item.help : '选一个，它会跟着这条复盘一起存下来。'
              touched()
            },
          },
        }),
      )
    }
    publish.disabled = !canPublish()
  }

  function canPublish(): boolean {
    if (!ready || paused) return false
    return Boolean(vs) && Boolean(noteInput.value.trim() || betterInput.value.trim())
  }

  function hasText(): boolean {
    return Boolean(noteInput.value.trim() || betterInput.value.trim() || vs)
  }

  function report(): void {
    options.onDraftChanged?.({ hasText: hasText(), savedAt })
  }

  function paintState(): void {
    stateRetry.hidden = true
    if (saving) {
      state.className = 'dstate saving'
      state.textContent = '保存中…'
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
      discard.hidden = false
      return
    }
    state.className = 'dstate'
    state.textContent = hasText() ? '还没保存' : '写下的字会自动存成草稿，不会动原来那句话。'
  }

  function touched(): void {
    if (!ready) return
    dirty = true
    publish.disabled = !canPublish()
    paintState()
    report()
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  for (const field of [noteInput, betterInput]) {
    // 中文输入法组词期间不提交半个字，等 compositionend 之后再算一次改动。
    let composing = false
    field.addEventListener('compositionstart', () => {
      composing = true
    })
    field.addEventListener('compositionend', () => {
      composing = false
      touched()
    })
    field.addEventListener('input', () => {
      if (!composing) touched()
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
    if (!ready || paused || !dirty) return
    if (saving) return
    if (immediate) window.clearTimeout(timer)
    const payload = {
      expected_draft_revision: draftRevision,
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
      if (!alive) return
      saving = false
      draftRevision = result.revision
      savedAt = result.updated_at
      save.reset()
      paintState()
      report()
      if (dirty) void flush()
    } catch (error) {
      if (!alive) return
      saving = false
      dirty = true
      if (error instanceof ApiError && error.code === 'draft_revision_conflict') {
        await onConflict()
        return
      }
      // 失败就近说明，不弹提示；文字全部留在编辑器里，重试用的还是同一把幂等键。
      state.className = 'dstate bad'
      state.textContent =
        error instanceof NetworkError ? '尚未保存，网络没通。' : '这一次没有存下来。'
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
    state.className = 'dstate bad'
    state.textContent = '这条复盘已在另一处更新。'
    let remote: Awaited<ReturnType<typeof reviews.draft>>
    try {
      remote = await reviews.draft(options.callId)
    } catch {
      if (!alive) return
      showBanner(
        '这条复盘已在另一处更新',
        '另一处的内容还没读出来。你写的字都留着，网络好一点再试一次。',
        [h('button.btn.sm', { text: '再读一次', on: { click: () => void onConflict() } })],
      )
      return
    }
    if (!alive) return
    const theirs = remote.draft?.body
    const mine = { note: noteInput.value, better: betterInput.value, vs }
    showBanner(
      '这条复盘已在另一处更新',
      theirs
        ? '另一处保存的内容在下面。你这边写的字一个都没动，选一份留下来。'
        : '另一处把这份草稿清掉了。你写的字还在，可以按原样重新存一次。',
      [
        h('button.btn.sm.primary', {
          text: '保留我写的',
          on: {
            click: () => {
              draftRevision = remote.draft_revision
              callRevision = remote.call_revision
              seenOutcomeIds = [...remote.current_outcome_ids]
              hideBanner()
              paused = false
              dirty = true
              publish.disabled = !canPublish()
              void flush(true)
            },
          },
        }),
        theirs
          ? h('button.btn.sm', {
              text: '改用另一处那份',
              on: {
                click: () => {
                  noteInput.value = theirs.note ?? ''
                  betterInput.value = theirs.better_play ?? ''
                  vs = theirs.vs_last ?? null
                  draftRevision = remote.draft_revision
                  callRevision = remote.call_revision
                  seenOutcomeIds = [...remote.current_outcome_ids]
                  savedAt = remote.draft?.updated_at ?? null
                  hideBanner()
                  paused = false
                  dirty = false
                  paintOptions()
                  paintState()
                  report()
                },
              },
            })
          : null,
      ].filter(Boolean) as HTMLElement[],
      theirs
        ? h(
            'div.dcompare',
            {},
            side('我这边', mine.note, mine.better, mine.vs),
            side('另一处', theirs.note, theirs.better_play, theirs.vs_last),
          )
        : null,
    )
  }

  function side(
    title: string,
    text: string,
    better: string | null,
    action: ReviewAction | null,
  ): HTMLElement {
    const label = REVIEW_ACTIONS.find((a) => a.value === action)?.label
    return h(
      'div.dside',
      {},
      h('div.dside-t', { text: title }),
      h('div.quote.sm', { text: text.trim() || '（这一栏是空的）' }),
      better?.trim() ? h('div.faint', { text: `下次怎么做：${better.trim()}` }) : null,
      label ? h('div.faint', { text: `和上一次比：${label}` }) : null,
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
    publish.disabled = true
    publish.textContent = '正在发布…'
    try {
      // 发布之前先把最后一次草稿保存确认掉，否则发出去的会是上一版文字。
      if (dirty) await flush(true)
      if (dirty || paused) {
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
    }
  }

  /**
   * 市场在你写字的时候给了新的结果。文字全部保留，但必须先看一眼新结果，
   * 再决定这条复盘是不是还算数——不能把没看过的结果悄悄绑上去。
   */
  async function onOutcomesChanged(): Promise<void> {
    publish.disabled = true
    let fresh: CallDetail | null = null
    let latest: Awaited<ReturnType<typeof reviews.draft>> | null = null
    try {
      ;[fresh, latest] = await Promise.all([options.reread(), reviews.draft(options.callId)])
    } catch {
      /* 读不出来也要把提示留在页面上 */
    }
    if (!alive) return
    const shown = (fresh?.current_outcomes ?? options.outcomes()).filter((o) =>
      latest ? latest.current_outcome_ids.includes(o.id) : true,
    )
    showBanner(
      '这条记录有了新的结果',
      '你写的字一个都没动。先看一眼下面这一版结果，确认之后再发布，这条复盘就会绑在这一版上。',
      [
        h('button.btn.sm.primary', {
          text: '看过了，按这一版发布',
          on: {
            click: () => {
              if (latest) {
                seenOutcomeIds = [...latest.current_outcome_ids]
                draftRevision = latest.draft_revision
                callRevision = latest.call_revision
              }
              hideBanner()
              publish.disabled = !canPublish()
            },
          },
        }),
      ],
      shown.length
        ? h('div.douts', {}, ...shown.map(outcomeLine))
        : h('div.faint', { text: '新的结果还没读出来，稍后再看一次。' }),
    )
  }

  async function onRecordMoved(): Promise<void> {
    publish.disabled = true
    try {
      const [fresh, latest] = await Promise.all([options.reread(), reviews.draft(options.callId)])
      if (!alive) return
      callRevision = latest.call_revision
      draftRevision = latest.draft_revision
      seenOutcomeIds = [...latest.current_outcome_ids]
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
    if (hasText() && !window.confirm('丢掉这份草稿？写下的字不会留下来，原判断和以前的复盘都还在。')) {
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
    hasText,
    flush: () => flush(true),
    dispose() {
      alive = false
      window.clearTimeout(timer)
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

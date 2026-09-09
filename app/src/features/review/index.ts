// 复盘 —— 行情已经走完的判断，回头再看一次。
//
// 队列完全按后端 /v1/review-queue 分的四个篮子来：待复盘、继续填写、已完成、
// 稍后处理。顺序是后端定的（记录提交时间倒序），前端不另外排名、不加权、不算
// 总分，也不用当前这一页的条数冒充全库的数量。
//
// 一条记录展开之后就是可续写的草稿编辑区（draft.ts）。列表刷新时，正在写的那
// 一条保持展开、保持内容、不抢输入焦点——写到一半被列表刷新打断是最难受的事。

import { ApiError } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import * as reviews from '../../api/reviews'
import type { CallDetail, QueueItem, ReviewBucket, ReviewReason, Uuid } from '../../api/types'
import { detail, invalidate } from '../../data/store'
import { dateTime, relative } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { objectUrl } from '../../ui/media'
import { stagger } from '../../ui/motion'
import { empty, ledgerSkeleton, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { draftEditor, outcomeLine, type DraftEditor } from './draft'

const lane = new Latest()

const BUCKETS: { id: ReviewBucket; label: string; blank: string; tip: string }[] = [
  {
    id: 'needs_review',
    label: '待复盘',
    blank: '现在没有等着回头看的判断',
    tip: '市场已经给过答案、你还没回头对过的判断，排在这里。',
  },
  {
    id: 'in_progress',
    label: '继续填写',
    blank: '没有写到一半的复盘',
    tip: '写到一半的草稿都在这里，接着写就行，服务器替你记着写到哪了。',
  },
  {
    id: 'completed',
    label: '已完成',
    blank: '还没有发布过复盘',
    tip: '已经发布过复盘的记录。正式复盘不能改，想补充就再写一条。',
  },
  {
    id: 'snoozed',
    label: '稍后处理',
    blank: '没有推迟的记录',
    tip: '你按下「稍后再说」的记录。到时间它们会自己回到待复盘，没有系统推送。',
  },
]

/** 队列给的原因是内部枚举，这里换成人话。 */
const REASONS: Record<ReviewReason, string> = {
  first_review: '还没有复盘',
  continue_draft: '继续上次内容',
  new_outcome: '有新的结果',
  reviewed: '已复盘',
}

const SNOOZE_CHOICES: { label: string; hours: number | null }[] = [
  { label: '明天', hours: 24 },
  { label: '三天后', hours: 72 },
  { label: '下周', hours: 24 * 7 },
  { label: '不再推迟', hours: null },
]

export function reviewPage(host: HTMLElement): () => void {
  let alive = true
  let bucket: ReviewBucket = 'needs_review'
  let cursor: string | null = null
  /** 展开中的那一条：刷新列表时它要原样活下来。 */
  const openCards = new Map<Uuid, DraftEditor>()
  /** 本次会话里存过草稿/发过复盘的记录，用来在行上显示一枚小标记。 */
  const touched = new Map<Uuid, string>()
  /**
   * 刚发布完的那几张卡片。发布之后这条记录就从当前篮子里走了，但人还站在这儿，
   * 「查看这次复盘」不能跟着一起消失，所以原样留在列表最上面，直到换篮子。
   */
  const published = new Map<Uuid, HTMLElement>()

  const tabs = h('div.rvtabs')
  const list = h('div.stack', { style: 'gap:14px' })
  const more = h('div', { style: 'margin-top:16px' })
  const tipLine = h('div.tip', { style: 'margin-top:6px;max-width:60ch' })

  const head = h(
    'div.sheet.pad',
    {},
    h('h1.h1', { text: '复盘' }),
    h('div.tip', {
      style: 'margin-top:6px;max-width:60ch',
      text: '这里回答一个问题：同样的局面再来一次，怎么做更好。复盘只往后追加——当时那句话一个字都不会被改，改了它就不算判断了。',
    }),
    tabs,
    tipLine,
  )

  host.append(head, h('div', { style: 'margin-top:18px' }, list, more))
  paintTabs()
  list.appendChild(ledgerSkeleton(4))
  void load()

  function paintTabs(): void {
    clear(tabs)
    for (const item of BUCKETS) {
      tabs.appendChild(
        h('button.rvtab', {
          class: bucket === item.id ? 'on' : '',
          text: item.label,
          on: {
            click: () => {
              if (bucket === item.id) return
              bucket = item.id
              cursor = null
              published.clear()
              paintTabs()
              clear(list)
              clear(more)
              list.appendChild(ledgerSkeleton(3))
              void load()
            },
          },
        }),
      )
    }
    tipLine.textContent = BUCKETS.find((b) => b.id === bucket)?.tip ?? ''
  }

  /** 重新读第一页。展开中的编辑区不重建，用户正在写的内容不会被刷掉。 */
  async function load(append = false): Promise<void> {
    const signal = lane.begin()
    const asked = bucket
    // 只有「再看更早的」才带游标；重读第一页必须从头拿，否则刷新一次会把
    // 整份清单换成第二页。
    const from = append ? cursor : null
    try {
      const page = await reviews.queue({ bucket: asked, cursor: from, limit: 20 }, { signal })
      if (!alive || asked !== bucket) return
      cursor = page.next_cursor
      // 重画列表会把展开中的编辑区搬到新的卡片里，搬动会让它失去焦点。
      // 记下光标在谁身上，画完再还回去，正在打字的人不会被列表刷新打断。
      const focused = document.activeElement
      paint(page.items, append)
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus()
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(list)
      clear(more)
      list.appendChild(
        empty({
          art: 'info',
          title: '这份清单没有读出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load() } }),
        }),
      )
    }
  }

  function paint(items: QueueItem[], append: boolean): void {
    if (!append) clear(list)
    clear(more)
    // 已经不在这个篮子里、但刚刚在这一页上发布完的卡片，留在最上面。
    const kept = append
      ? []
      : [...published.entries()]
          .filter(([id]) => !items.some((i) => i.id === id))
          .map(([, node]) => node)
    for (const node of kept) list.appendChild(node)
    if (!items.length && !append && !kept.length) {
      const blank = BUCKETS.find((b) => b.id === bucket)
      list.appendChild(
        empty({
          art: bucket === 'needs_review' ? 'check' : 'review',
          title: blank?.blank ?? '这里现在是空的',
          tip:
            bucket === 'needs_review'
              ? '写下一条判断，等行情走完，它会自己排到这里来。'
              : '换一个篮子看看，或者先去写一条判断。',
          action: h('a.btn.sm.ghost', { href: '#/find', text: '去看全部记录' }),
        }),
      )
      return
    }
    const made = items.map((item) => card(item))
    for (const row of made) list.appendChild(row)
    stagger(made)
    if (cursor) {
      more.appendChild(
        h('button.btn.ghost', {
          text: '再看更早的 20 条',
          on: {
            click: (e) => {
              const button = e.currentTarget as HTMLButtonElement
              button.disabled = true
              button.textContent = '正在读…'
              void load(true)
            },
          },
        }),
      )
    }
  }

  /** 画出来的卡片，发布之后要按 id 找回它。 */
  const cards = new Map<Uuid, HTMLElement>()
  /** 卡片左上那枚原因标签，发布之后要就地改成「已复盘」。 */
  const reasonTags = new Map<Uuid, HTMLElement>()

  function card(item: QueueItem): HTMLElement {
    const kept = openCards.get(item.id)
    const slot = h('div', { hidden: !kept, style: 'margin-top:14px' })
    const open = h('button.btn.sm.primary', {
      text: kept ? '收起' : openLabel(item),
    }) as HTMLButtonElement
    let loaded = Boolean(kept)
    if (kept) slot.appendChild(kept.node)

    open.addEventListener('click', () => {
      if (loaded) {
        slot.hidden = !slot.hidden
        open.textContent = slot.hidden ? openLabel(item) : '收起'
        return
      }
      loaded = true
      slot.hidden = false
      open.textContent = '收起'
      slot.replaceChildren(spinner('正在读这条记录…'))
      void detail(item.id)
        .then((record) => {
          if (!alive) return
          slot.replaceChildren(editorFor(record, item))
        })
        .catch((error) => {
          if (!alive) return
          loaded = false
          slot.replaceChildren(
            note('warn', error instanceof Error ? error.message : '这条记录读不出来。'),
          )
        })
    })

    const savedMark = touched.get(item.id) ?? draftMark(item)
    const why = h('span.tag', { class: reasonTone(item.reason), text: REASONS[item.reason] })
    reasonTags.set(item.id, why)

    const node = h(
      'div.sheet.pad.rvcard',
      {},
      h(
        'div.row',
        { style: 'justify-content:space-between;gap:12px;align-items:flex-start' },
        h(
          'div.line',
          {},
          why,
          h('span', { text: dateTime(item.submitted_at) }),
          h('span.faint', { text: relative(item.submitted_at) }),
          item.instrument ? h('span.faint', { text: item.instrument }) : null,
          item.timeframe ? h('span.faint', { text: item.timeframe }) : null,
        ),
        h(
          'div.acts',
          { style: 'margin:0' },
          h('a.btn.sm.ghost', { href: `#/call/${item.id}`, text: '打开这条' }),
          open,
        ),
      ),
      // 原话是用户输入，按纯文本渲染。
      h('div.quote', { style: 'margin-top:10px', text: item.original_text }),
      savedMark ? h('div.faint', { style: 'margin-top:8px', text: savedMark }) : null,
      snoozeRow(item),
      slot,
    )
    cards.set(item.id, node)
    return node
  }

  function openLabel(item: QueueItem): string {
    if (item.reason === 'continue_draft') return '接着写'
    if (item.reason === 'reviewed') return '再写一条'
    return '写复盘'
  }

  function reasonTone(reason: ReviewReason): string {
    return reason === 'new_outcome' ? 'warm' : ''
  }

  function draftMark(item: QueueItem): string {
    if (item.draft_saved_at) return `草稿存于 ${dateTime(item.draft_saved_at)}`
    if (item.reviewed_at) return `上一条复盘发布于 ${dateTime(item.reviewed_at)}`
    return ''
  }

  /** 「稍后再说」：到时间自己回到待复盘，没有系统推送，所以这里也不承诺提醒。 */
  function snoozeRow(item: QueueItem): HTMLElement {
    const action = new WriteAction()
    const line = h('div.rvsnooze')
    const state = h('span.faint', {
      text: item.snoozed_until ? `推迟到 ${dateTime(item.snoozed_until)}，到时候自己回到待复盘。` : '',
    })
    const buttons = SNOOZE_CHOICES.filter((c) => c.hours !== null || item.snoozed_until).map(
      (choice) =>
        h('button.linkbtn', {
          text: choice.label,
          on: {
            click: async (e) => {
              const button = e.currentTarget as HTMLButtonElement
              button.disabled = true
              const until =
                choice.hours === null
                  ? null
                  : new Date(Date.now() + choice.hours * 3_600_000).toISOString()
              const payload = { expected_revision: item.preference_revision ?? 0, until }
              try {
                const saved = await reviews.remind(item.id, payload, action.keyFor(payload))
                if (!alive) return
                action.reset()
                item.preference_revision = saved.revision
                item.snoozed_until = saved.snoozed_until
                state.textContent = saved.snoozed_until
                  ? `推迟到 ${dateTime(saved.snoozed_until)}，到时候自己回到待复盘。`
                  : '已经放回待复盘。'
                toast(saved.snoozed_until ? '这条先放一放，到时间它会自己回来。' : '已经放回待复盘。')
              } catch (error) {
                if (!alive) return
                if (error instanceof ApiError && error.code === 'review_preference_conflict') {
                  problem('这条的推迟状态刚在另一处改过，刷新一下再设。')
                } else {
                  problem(error instanceof Error ? error.message : '这次没有设置成功。')
                }
              } finally {
                button.disabled = false
              }
            },
          },
        }),
    )
    line.append(h('span.faint', { text: '稍后再说：' }), ...buttons, state)
    return line
  }

  function editorFor(record: CallDetail, item: QueueItem): HTMLElement {
    const box = h('div.stack', { style: 'gap:12px' })

    const scene = record.attachments.find((a) => a.kind === 'scene')
    if (scene) {
      const shot = h('div.shot-slot', { style: 'height:170px' }, h('div.shot-wait', {}, icon('img')))
      box.appendChild(shot)
      void objectUrl(scene.id)
        .then((url) => {
          if (alive) shot.replaceChildren(h('img', { attrs: { src: url, alt: '当时的现场图' } }))
        })
        .catch(() => shot.replaceChildren(h('div.shot-wait.failed', { text: '图读不出来' })))
    }

    if (record.current_outcomes?.length) {
      box.appendChild(
        h(
          'div.douts',
          {},
          h('div.dlabel', { text: '市场给的答案' }),
          ...record.current_outcomes.map(outcomeLine),
        ),
      )
    } else {
      box.appendChild(
        h('div.tip', { text: '这条没有写算对的标准，所以没有自动结果。用文字复盘一样算数。' }),
      )
    }

    if (record.reviews.length) {
      box.appendChild(
        h('div.tip', {
          text: `这条已经有 ${record.reviews.length} 条正式复盘。以前写的不会被改，这次写的会作为新的一条追加上去。`,
        }),
      )
    }

    if (record.voided) {
      box.appendChild(note('warn', '这条记录已经作废，不再接受新的复盘。'))
      return box
    }

    const editor = draftEditor({
      callId: record.id,
      lead: record.reviews.length
        ? '再看一次：这次和上一条复盘相比，判断变了没有？'
        : '行情已经走完了，现在你怎么看当时那句话？',
      reread: async () => {
        invalidate(record.id)
        return detail(record.id, { refresh: true })
      },
      outcomes: () => record.current_outcomes ?? [],
      onDraftChanged: (info) => {
        if (info.savedAt) touched.set(record.id, `草稿存于 ${dateTime(info.savedAt)}`)
        else if (info.hasText) touched.set(record.id, '有还没保存的内容')
      },
      onPublished: (result) => {
        touched.set(record.id, `复盘已发布 · ${dateTime(result.saved_at)}`)
        invalidate(record.id)
        const own = cards.get(record.id)
        if (own) published.set(record.id, own)
        const why = reasonTags.get(record.id)
        if (why) {
          why.className = 'tag'
          why.textContent = REASONS.reviewed
        }
        box.appendChild(
          note(
            'info',
            '这条复盘已经发布，不能再改；要补充就在下面再写一条。',
            h('a.linkbtn', { href: `#/call/${record.id}`, text: '查看这次复盘' }),
          ),
        )
        // 队列跟着变，但不跳到下一条：用户可能还想接着看这一条。
        void load()
      },
    })
    openCards.set(record.id, editor)
    void item
    box.appendChild(editor.node)
    return box
  }

  return () => {
    alive = false
    lane.cancel()
    for (const editor of openCards.values()) {
      void editor.flush().catch(() => undefined)
      editor.dispose()
    }
    openCards.clear()
  }
}

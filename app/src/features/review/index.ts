// 复盘 —— 行情已经走完的判断，回头再看一次。
//
// 这一页是个工作台，不是一叠卡片：左边是还欠着的几条，右边是一次只读一条、
// 一次只写一条的地方。上一版把每条记录都做成一张同样大小的白框、把编辑区塞
// 在框里展开，读的人要在十几张一模一样的框里找自己写到一半的那一张。
//
// 队列完全按后端 /v1/review-queue 分的四个篮子来：待复盘、继续填写、已完成、
// 稍后处理。顺序是后端定的（记录提交时间倒序），前端不另外排名、不加权、不算
// 总分，也不用当前这一页的条数冒充全库的数量。
//
// 换一条之前会先把没发出的那次保存补上（flush），所以左边点来点去不会丢字。

import { ApiError } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import * as reviews from '../../api/reviews'
import type {
  CallDetail,
  QueueItem,
  ReviewBucket,
  ReviewDraftState,
  ReviewReason,
  Uuid,
} from '../../api/types'
import { detail } from '../../data/store'
import { flowOf, fromCallDetail, fromQueueItem } from '../../data/flow'
import { go } from '../../router'
import { dateTime, relative } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { flowBar, flowMini } from '../../ui/flow'
import { tradeSummary } from '../review/trades'
import { reviewImages } from '../../ui/image-picker'
import { stagger } from '../../ui/motion'
import { empty, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { outcomeLine } from './draft'
import { guidedReview, STEP_NAMES } from './guided'

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

export function reviewPage(host: HTMLElement, arg: string): () => void {
  // #/review 是清单，#/review/<id>[/step/N] 是那一条的引导流程。两件事分开：
  // 清单负责挑，流程负责写。
  const parts = arg ? arg.split('/') : []
  if (parts[0]) return guidedReview(host, parts[0] as Uuid, parts[2] ?? '1')

  let alive = true
  let bucket: ReviewBucket = 'needs_review'
  let cursor: string | null = null
  /** 当前在右边摊开的那一条。 */
  let openId: Uuid | null = null
  /** 深链接 #/review/<id>：从记录详情或「今天」点进来，直接落到写字区。 */
  let wanted: Uuid | null = arg ? (arg.split('/')[0] as Uuid) : null
  let items: QueueItem[] = []
  /** 本次会话里存过草稿/发过复盘的记录，用来在队列行上显示一枚小标记。 */
  const touched = new Map<Uuid, string>()
  /** 队列行的节点，发布之后要就地改掉它的原因标签。 */
  const rows = new Map<Uuid, { node: HTMLElement; why: HTMLElement }>()

  const tabs = h('div.rvtabs')
  const tipLine = h('div.tip', { style: 'margin-top:8px;max-width:64ch' })
  const qbody = h('div')
  const qmore = h('div', { style: 'padding:12px 16px;border-top:1px solid var(--rule)' })
  const queue = h('aside.queue', {}, qbody, qmore)
  const pane = h('section.rpane')

  host.append(
    h(
      'div.phead',
      {},
      h(
        'div',
        {},
        h('h1.h1', { text: '复盘' }),
        h('div.tip', {
          style: 'margin-top:6px;max-width:64ch',
          text: '同样的局面再来一次，怎么做更好。复盘只往后追加——当时那句话一个字都不会被改，改了它就不算判断了。',
        }),
      ),
      h('button.btn.sm.ghost', {
        type: 'button',
        text: '长期统计',
        title: '一条一条地复盘之外，把同一套规则下所有判断的下场数一遍。',
        on: { click: () => go('stats') },
      }),
    ),
    tabs,
    tipLine,
    h('div.review', { style: 'margin-top:18px' }, queue, pane),
  )

  paintTabs()
  qbody.appendChild(queueSkeleton())
  pane.appendChild(spinner('正在读这份清单…'))
  if (wanted) { const target = wanted; wanted = null; select(target) }
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
              paintTabs()
              clear(qbody)
              clear(qmore)
              qbody.appendChild(queueSkeleton())
              void load()
            },
          },
        }),
      )
    }
    tipLine.textContent = BUCKETS.find((b) => b.id === bucket)?.tip ?? ''
  }

  function queueSkeleton(): HTMLElement {
    const box = h('div', { style: 'padding:8px 0' })
    for (let i = 0; i < 5; i += 1) {
      box.appendChild(
        h(
          'div',
          { style: 'display:flex;gap:12px;padding:13px 16px;align-items:center' },
          h('div.sk', { style: 'width:54px;height:40px;border-radius:8px;flex:none' }),
          h(
            'div',
            { style: 'flex:1;display:flex;flex-direction:column;gap:7px' },
            h('div.sk', { style: 'height:11px;width:92%' }),
            h('div.sk', { style: 'height:11px;width:58%' }),
          ),
        ),
      )
    }
    return box
  }

  /** 重新读第一页。正在写的那一条不受影响，编辑区不重建。 */
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
      items = append ? [...items, ...page.items] : page.items
      // 重画队列会动到 DOM，但编辑区在右边，不在里面，光标不会被搬走。
      paintQueue(page.items, append)
      if (!openId) {
        const first = wanted ?? items[0]?.id
        wanted = null
        if (first) select(first)
        else showBlank()
      } else if (wanted) {
        wanted = null
      }
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(qbody)
      clear(qmore)
      qbody.appendChild(
        h(
          'div',
          { style: 'padding:18px 16px' },
          note('warn', error instanceof Error ? error.message : '这份清单没有读出来。'),
          h('button.btn.sm', {
            style: 'margin-top:10px',
            text: '重试',
            on: { click: () => void load() },
          }),
        ),
      )
      if (!openId) {
        clear(pane)
        pane.appendChild(
          empty({ title: '清单读不出来，右边先空着', tip: '左边重试一次。' }),
        )
      }
    }
  }

  function showBlank(): void {
    const blank = BUCKETS.find((b) => b.id === bucket)
    clear(pane)
    pane.appendChild(
      empty({
        title: blank?.blank ?? '这里现在是空的',
        tip:
          bucket === 'needs_review'
            ? '写下一条判断，等行情走完，它会自己排到这里来。'
            : '换一个篮子看看，或者先去写一条判断。',
        action: h('a.btn.sm.ghost', { href: '#/find', text: '去看全部记录' }),
      }),
    )
  }

  function paintQueue(fresh: QueueItem[], append: boolean): void {
    if (!append) {
      clear(qbody)
      rows.clear()
    }
    clear(qmore)
    if (!items.length) {
      qbody.appendChild(
        h('div', { style: 'padding:20px 16px' }, h('div.tip', { text: '这个篮子里现在没有记录。' })),
      )
      return
    }
    const head = h(
      'div.gh',
      {},
      h('span', { text: BUCKETS.find((b) => b.id === bucket)?.label ?? '' }),
      h('span.n', { text: `${items.length}${cursor ? '+' : ''}` }),
    )
    if (!append) qbody.appendChild(head)
    const made = fresh.map((item) => queueRow(item))
    for (const row of made) qbody.appendChild(row)
    stagger(made)
    if (cursor) {
      qmore.appendChild(
        h('button.btn.sm.ghost', {
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

  function queueRow(item: QueueItem): HTMLElement {
    const why = h('span.tag', { class: reasonTone(item.reason), text: REASONS[item.reason] })
    // 队列行里没有现场图的附件编号，为一列缩略图逐条再请求一次不值得；这里改
    // 用真实的流程进度当行首标记，比二十个一模一样的灰方块有用。
    const node = h(
      'button.qitem',
      {
        class: item.id === openId ? 'on' : '',
        type: 'button',
        on: { click: () => select(item.id) },
      },
      h(
        'div',
        { style: 'flex:1;min-width:0' },
        // 原话是用户输入，按纯文本渲染。
        h('div.q', { text: item.original_text }),
        h(
          'div.m',
          {},
          why,
          h('span', { text: relative(item.submitted_at) }),
          item.instrument ? h('span', { text: item.instrument }) : null,
          item.timeframe ? h('span', { text: item.timeframe }) : null,
        ),
        markOf(item) ? h('div.m', {}, h('span', { text: markOf(item) })) : null,
        flowMini(flowOf(fromQueueItem(item))),
      ),
    )
    rows.set(item.id, { node, why })
    // 写之前先把当时那一段行情走一遍，比对着回忆写要准。
    return h(
      'div.qcell',
      {},
      node,
      h('a.qrelive', { href: `#/relive/${item.id}/1`, text: '先重温再写' }),
    )
  }

  function reasonTone(reason: ReviewReason): string {
    return reason === 'new_outcome' ? 'warm' : ''
  }

  function markOf(item: QueueItem): string {
    const own = touched.get(item.id)
    if (own) return own
    if (item.draft_saved_at) return `草稿存于 ${dateTime(item.draft_saved_at)}`
    if (item.reviewed_at) return `上一条复盘发布于 ${dateTime(item.reviewed_at)}`
    return ''
  }

  /** 换一条：先把上一条没发出的保存补上，再读新的。 */
  function select(id: Uuid): void {
    if (id === openId) return
    for (const [key, row] of rows) row.node.classList.toggle('on', key === id)
    openId = id
    clear(pane)
    pane.appendChild(spinner('正在读这条记录…'))
    const asked = id
    void Promise.all([
      detail(id),
      // 草稿读不出来不该挡住整页；读不到就是「不知道有没有」，不冒充「没有」。
      reviews.draft(id).catch(() => undefined),
    ])
      .then(([record, saved]) => {
        if (!alive || openId !== asked) return
        clear(pane)
        pane.appendChild(workspace(record, saved, items.find((i) => i.id === asked) ?? null))
      })
      .catch((error) => {
        if (!alive || openId !== asked) return
        clear(pane)
        pane.appendChild(
          note('warn', error instanceof Error ? error.message : '这条记录读不出来。'),
        )
      })
  }

  /** 右边这一整块：先读，再写。读的部分在上面，写的部分在下面。 */
  function workspace(
    record: CallDetail,
    saved: ReviewDraftState | null | undefined,
    item: QueueItem | null,
  ): HTMLElement {
    const box = h('div.stack', { style: 'gap:16px' })
    const flow = flowOf(fromCallDetail(record, saved))

    box.appendChild(
      h(
        'div.sheet.pad',
        {},
        h(
          'div.line',
          {},
          h('span.tag', { text: record.body.instrument ?? '未标合约' }),
          record.body.timeframe ? h('span', { text: record.body.timeframe }) : null,
          h('span', { text: `${dateTime(record.submitted_at)} 记下` }),
          h('span.faint', { text: relative(record.submitted_at) }),
          h('a.btn.sm.ghost', {
            href: `#/call/${record.id}`,
            text: '打开完整记录',
            style: 'margin-left:auto',
          }),
        ),
        // 当时那句话是这一页的主角，用大一号的正文排。
        h('div.quote', { style: 'margin-top:12px', text: record.body.original_text }),
        flowBar(flow),
      ),
    )

    const scenes = record.attachments.filter(a => a.kind === 'scene').map(a => a.id)
    const originalImages = reviewImages(scenes, '记录判断时的截图')
    if (originalImages) box.appendChild(originalImages)
    for (const review of record.reviews) {
      box.appendChild(tradeSummary(review.body.trades, review.body.trade_snapshots))
      const shots = reviewImages(review.body.attachment_ids, `${dateTime(review.created_at)} 复盘时的后续走势`)
      if (shots) box.appendChild(shots)
    }

    if (record.current_outcomes?.length) {
      box.appendChild(
        h(
          'div.sheet.pad.douts',
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

    if (record.voided) {
      box.appendChild(note('warn', '这条记录已经作废，不再接受新的复盘。'))
      return box
    }

    // 到这儿为止都是「读」。写的部分不在这一页上——它被拆成四步，一步一页，
    // 各自是自己的网址。摊在同一屏里的十几个输入框，看的人不知道从哪儿下笔。
    box.appendChild(
      h(
        'div.sheet.pad.rvstart',
        {},
        h('div.dlabel', { text: record.reviews.length ? '再写一条复盘' : '开始复盘' }),
        h('div.tip', {
          text: '分四步走：先回到当时，再看市场的答案，然后写你现在怎么看，最后写下次怎么做。每一步单独一页，写到一半可以走开，草稿存在服务器上，回来接着写。',
        }),
        h(
          'div.rvsteps',
          {},
          ...STEP_NAMES.map((name, i) =>
            h('span.rvstep', {}, h('i', { text: String(i + 1) }), h('span', { text: name })),
          ),
        ),
        h('a.btn.primary', {
          href: `#/review/${record.id}/step/1`,
          text: saved?.draft ? '接着写' : '开始复盘',
        }),
      ),
    )

    if (record.reviews.length) {
      box.appendChild(
        h('div.tip', {
          text: `这条已经有 ${record.reviews.length} 条正式复盘。以前写的不会被改，这次写的会作为新的一条追加上去。`,
        }),
      )
    }

    if (item) box.appendChild(snoozeRow(item))
    return box
  }

  /** 「稍后再说」：到时间自己回到待复盘，没有系统推送，所以这里也不承诺提醒。 */
  function snoozeRow(item: QueueItem): HTMLElement {
    const action = new WriteAction()
    const line = h('div.rvsnooze', { style: 'opacity:1;margin-top:0' })
    const state = h('span.faint', {
      text: item.snoozed_until
        ? `推迟到 ${dateTime(item.snoozed_until)}，到时候自己回到待复盘。`
        : '',
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
                const result = await reviews.remind(item.id, payload, action.keyFor(payload))
                if (!alive) return
                action.reset()
                item.preference_revision = result.revision
                item.snoozed_until = result.snoozed_until
                state.textContent = result.snoozed_until
                  ? `推迟到 ${dateTime(result.snoozed_until)}，到时候自己回到待复盘。`
                  : '已经放回待复盘。'
                toast(
                  result.snoozed_until ? '这条先放一放，到时间它会自己回来。' : '已经放回待复盘。',
                )
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

  return () => {
    alive = false
    lane.cancel()
  }
}

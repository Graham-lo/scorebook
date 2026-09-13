// 复盘 —— 三个筐，各一个列表。
//
//   等市场   写过「怎么算对」、市场还没走到期限的。行里写还差多久。
//   判对错   市场已经走到、还没有结果的：没写标准的那些，和算不出来的那些。
//             行内直接三个小按钮。
//   写复盘   已经有结果、还没写复盘的，以及写到一半的草稿。
//
// 队列接口只给记录的壳（没有方向、把握、标准），列表行要的那几样在详情里，所以
// 拿到 id 之后过一道窄闸补齐。分筐只按事实分：待判的判分任务、结果版本的状态、
// 有没有草稿、有没有复盘，前端不另算。

import { ApiError } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import { judge } from '../../api/calls'
import * as reviews from '../../api/reviews'
import type { QueueItem, Uuid } from '../../api/types'
import { Gate, detail, invalidate } from '../../data/store'
import { classifyReviewTask, type ReviewBox, type ReviewTask as Task } from '../../data/review-task'
import { dateTime } from '../../data/time'
import { invalidateArchive } from '../archive'
import { head } from '../../data/outcome'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { recordRow } from '../../ui/record-row'
import { empty, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { guidedReview } from './guided'
import { reviewQueue } from './queue'

const gate = new Gate(3)

type Box = ReviewBox | 'snoozed'

const SNOOZE: { label: string; hours: number }[] = [
  { label: '明天', hours: 24 },
  { label: '三天后', hours: 72 },
  { label: '下周', hours: 24 * 7 },
]

const JUDGES: { label: string; state: 'realized' | 'unrealized' | 'not_triggered'; cls: string }[] = [
  { label: '对', state: 'realized', cls: 'up' },
  { label: '错', state: 'unrealized', cls: 'down' },
  { label: '不算', state: 'not_triggered', cls: 'flat' },
]

const BOXES: [ReviewBox, string, string][] = [
  ['waiting', '等市场', '期限还没到'],
  ['verdict', '判对错', '期限到了，还没判'],
  ['write', '写复盘', '判了，还没写'],
]

const EMPTY: Record<Box, string> = { waiting: '没有在等答案的', verdict: '没有要判的', write: '没有要写的', snoozed: '没有暂缓的复盘' }

export function reviewPage(host: HTMLElement, arg: string, query: URLSearchParams): () => void {
  // #/review 是清单，#/review/<id>[/step/N] 是那一条的引导流程。
  const parts = arg ? arg.split('/') : []
  if (parts[0]) return guidedReview(host, parts[0] as Uuid, parts[2] ?? '1')

  let alive = true
  const lane = new Latest()
  const offs: (() => void)[] = []
  const box = boxOf(query.get('box'))
  const list = h('div')
  const boxes = h('div.boxes')
  const counts: Record<ReviewBox, HTMLElement> = { waiting: h('div.n', { text: '–' }), verdict: h('div.n', { text: '–' }), write: h('div.n', { text: '–' }) }
  for (const [key, label, hint] of BOXES) {
    boxes.appendChild(h('a.card.box', { href: `#/review?box=${key}`, class: box === key ? 'on' : '' },
      h('div.k', { text: label }), counts[key], h('div.d', { text: hint })))
  }
  const snooze = h('div.row.snooze', {},
    h('a.btn.sm.ghost', {
      href: box === 'snoozed' ? '#/review' : '#/review?box=snoozed',
      text: box === 'snoozed' ? '回复盘清单' : '稍后再看',
    }))
  host.append(
    h('div.spread', {},
      h('div.lead', {}, boxes, snooze),
      h('div.bulk', {}, list),
    ),
  )
  list.appendChild(spinner('正在加载'))

  void load()

  async function load(): Promise<void> {
    const signal = lane.begin()
    for (const off of offs.splice(0)) off()
    clear(list)
    list.appendChild(spinner('正在加载'))
    let items: QueueItem[]
    try {
      items = await reviewQueue(signal, box === 'snoozed')
    } catch (error) {
      if (Latest.aborted(error) || signal.aborted || !alive) return
      clear(list)
      list.appendChild(note('warn', '没读出来'))
      list.appendChild(
        h('div', { style: 'margin-top:10px' },
          h('button.btn.sm', { type: 'button', text: '重试', on: { click: () => { clear(list); list.appendChild(spinner('正在加载')); void load() } } })),
      )
      return
    }
    if (!alive || signal.aborted) return

    const records = await Promise.allSettled(
      items.map((item) => gate.run(() => {
        signal.throwIfAborted()
        return detail(item.id)
      })),
    )
    if (!alive || signal.aborted) return
    const tasks: Task[] = []
    items.forEach((item, at) => {
      const result = records[at]
      if (result?.status !== 'fulfilled') return
      const record = result.value
      if (record.voided) return
      tasks.push(classifyReviewTask(item, record))
    })
    if (box !== 'snoozed') {
      for (const key of ['waiting', 'verdict', 'write'] as ReviewBox[]) counts[key].textContent = String(tasks.filter((t) => t.box === key).length)
    }
    paint(tasks.filter((t) => box === 'snoozed' || t.box === box), records.filter((r) => r.status === 'rejected').length, signal)
  }

  function paint(tasks: Task[], failed: number, signal: AbortSignal): void {
    clear(list)
    if (failed) {
      list.appendChild(note('warn', `${failed} 条记录没读出来，清单还不完整`,
        h('button.linkbtn', { text: '重试', on: { click: () => void load() } })))
    }
    if (!tasks.length) {
      if (!failed) list.appendChild(empty({ title: EMPTY[box] }))
      return
    }
    const sheet = h('div.sheet')
    const rows = tasks.map((task) => row(task, () => alive && !signal.aborted))
    for (const node of rows) sheet.appendChild(node)
    list.appendChild(sheet)
    stagger(rows)
  }

  function row(task: Task, current: () => boolean): HTMLElement {
    return recordRow(task.record, {
      density: 'task',
      alive: current,
      outcome: head(task.record),
      note: box === 'snoozed' && task.item.snoozed_until ? `${dateTime(task.item.snoozed_until)} 回到清单` : task.note,
      action: () => actionsFor(task, current),
    })
  }

  function actionsFor(task: Task, current: () => boolean): Node {
    const slot = document.createDocumentFragment()
    if (box === 'snoozed') {
      const action = new WriteAction()
      const restore = h('button.btn.sm', { text: '移回复盘清单', on: { click: async () => {
        if (!current()) return
        restore.disabled = true
        const payload = { expected_revision: task.item.preference_revision ?? 0, until: null }
        try {
          await reviews.remind(task.item.id, payload, action.keyFor(payload))
          if (current()) { toast('已回到复盘清单'); void load() }
        } catch (error) {
          if (!current()) return
          problem(error instanceof ApiError && error.code === 'review_preference_conflict'
            ? '这条刚在别处改过，正在重新读清单' : '没恢复上，再试一次')
          restore.disabled = false
          if (error instanceof ApiError && error.code === 'review_preference_conflict') void load()
        }
      } } }) as HTMLButtonElement
      slot.appendChild(restore)
      return slot
    }
    if (task.box === 'verdict') {
      for (const judgement of JUDGES) {
        slot.appendChild(
          h('button.btn.sm', {
            class: judgement.cls,
            type: 'button',
            text: judgement.label,
            on: { click: (e) => void setVerdict(task, judgement.state, e.currentTarget as HTMLButtonElement, current) },
          }),
        )
      }
    } else if (task.box === 'write') {
      if (task.draft) slot.appendChild(h('span.tag', { text: '草稿' }))
      slot.appendChild(
        h('a.btn.sm.gold', { href: `#/review/${task.record.id}/step/1`, text: task.draft ? '继续复盘' : '写复盘' }),
      )
    } else {
      slot.appendChild(h('a.btn.sm.ghost', { href: `#/call/${task.record.id}`, text: '看走势' }))
    }
    slot.appendChild(snoozeButton(task, current))
    return slot
  }

  /** 稍后：行内一颗按钮，点开三个时间。到时候它自己回来，没有推送。 */
  function snoozeButton(task: Task, current: () => boolean): HTMLElement {
    const action = new WriteAction()
    let busy = false
    const menu = h('div.menu')
    for (const choice of SNOOZE) {
      menu.appendChild(
        h('button.menu-i', {
          type: 'button',
          text: choice.label,
          on: {
            click: async () => {
              if (busy || !current()) return
              busy = true
              pop.hidden = true
              button.disabled = true
              const until = new Date(Date.now() + choice.hours * 3_600_000).toISOString()
              const payload = { expected_revision: task.item.preference_revision ?? 0, until }
              try {
                const done = await reviews.remind(task.item.id, payload, action.keyFor(payload))
                if (!current()) return
                action.reset()
                task.item.preference_revision = done.revision
                toast('记下了')
                void load()
              } catch (error) {
                if (!current()) return
                if (error instanceof ApiError && error.code === 'review_preference_conflict') {
                  problem('这条刚在别处改过，正在重新读清单')
                  void load()
                } else {
                  problem('没保存上，再试一次')
                }
              } finally {
                busy = false
                button.disabled = false
              }
            },
          },
        }),
      )
    }
    const pop = h('div.pop.right', { hidden: true, style: 'min-width:150px' }, menu)
    const button = h('button.btn.sm.ghost', {
      type: 'button',
      text: '稍后',
      on: { click: () => { pop.hidden = !pop.hidden } },
    }) as HTMLButtonElement
    const wrap = h('div.popwrap', {}, button, pop)
    const away = (e: MouseEvent) => {
      if (!wrap.contains(e.target as Node)) pop.hidden = true
    }
    document.addEventListener('click', away)
    offs.push(() => document.removeEventListener('click', away))
    return wrap
  }

  async function setVerdict(
    task: Task,
    state: 'realized' | 'unrealized' | 'not_triggered',
    button: HTMLButtonElement,
    current: () => boolean,
  ): Promise<void> {
    if (!current()) return
    const buttons = Array.from(button.closest('.tk-act')?.querySelectorAll<HTMLButtonElement>('button') ?? [button])
    for (const control of buttons) control.disabled = true
    const action = new WriteAction()
    const payload = { state, expected_revision: task.record.revision }
    try {
      await judge(task.record.id, payload, action.keyFor(payload))
      invalidate(task.record.id)
      invalidateArchive()
      if (!current()) return
      toast('记下了')
      void load()
    } catch (error) {
      if (!current()) return
      const status = error instanceof ApiError ? error.status : 0
      problem(status === 404 || status === 405 ? '本机后端还没有这个接口' : '没保存上，再试一次')
      for (const control of buttons) control.disabled = false
    }
  }

  return () => {
    alive = false
    lane.cancel()
    for (const off of offs.splice(0)) off()
  }
}

function boxOf(raw: string | null): Box {
  return raw === 'verdict' || raw === 'write' || raw === 'snoozed' ? raw : 'waiting'
}

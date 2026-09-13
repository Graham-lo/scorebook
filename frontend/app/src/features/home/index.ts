// 今天 —— 打开这个产品第一眼看到的地方。
//
// 左边一句日期、三个数、一条「记一笔」的入口；右边一扇夜窗，放判对率的圆环。
// 下面两列：等答案（市场还没开口的那几条）、该复盘（答案到了但还没判、还没写）。
// 最后是最近记下的几条。
//
// 哪条记录走到了哪一步、该进哪一列，由 data/review-task.ts 统一决定，这一页不
// 自己猜。队列行不带方向和「怎么算对」，所以取到 id 之后按记录详情补一遍，补不
// 到的那条就不进这一列——不拿半张卡片凑数。判对率来自 data/scorecard.ts，和
// 「经验」页用的是同一份底稿。

import { ApiError } from '../../api/errors'
import { WriteAction } from '../../api/http'
import * as calls from '../../api/calls'
import { judge } from '../../api/calls'
import type { CallDetail } from '../../api/types'
import { PATHS, primary, sentence } from '../../data/criteria'
import { head } from '../../data/outcome'
import { classifyReviewTask, type ReviewTask } from '../../data/review-task'
import { forgetScorecard, hitRate, scorecard, type Scored } from '../../data/scorecard'
import { Gate, detail, invalidate } from '../../data/store'
import { shortDate } from '../../data/time'
import { stanceBadge } from '../../ui/bits'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { countUp, prefersReducedMotion, stagger } from '../../ui/motion'
import { recordRow } from '../../ui/record-row'
import { empty, ledgerSkeleton } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { invalidateArchive } from '../archive'
import { greeting, sundial } from '../../ui/decor'
import { openCapture } from '../capture'
import { reviewQueue } from '../review/queue'

const gate = new Gate(3)
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const RING = 2 * Math.PI * 66

const JUDGES: { label: string; state: 'realized' | 'unrealized' | 'not_triggered'; cls: string }[] = [
  { label: '对', state: 'realized', cls: 'up' },
  { label: '错', state: 'unrealized', cls: 'down' },
  { label: '不算', state: 'not_triggered', cls: 'flat' },
]

export function homePage(host: HTMLElement): () => void {
  let alive = true
  const isAlive = () => alive
  const controller = new AbortController()
  const now = new Date()

  // ---------- 左：日期、三个数、记一笔 ----------
  const waitCount = h('b', { text: '0' })
  const todoCount = h('b', { text: '0' })
  const allCount = h('b', { text: '0' })
  const quick = h('div.quick', { role: 'button', tabIndex: 0, title: '记一笔（⌃⇧S）', on: {
    click: () => openCapture(),
    keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCapture() } },
  } },
    h('span.ph-text', {}, '此刻看到什么？', h('b', { text: '一句话，记下判断' })),
    h('kbd.kbd', { text: '⌃⇧S' }),
    h('button.btn.gold.sm', { text: '记一笔', tabIndex: -1 }),
  )
  const dial = sundial()
  const hero = h('section.today-hero', {},
    h('div.hero-l', {},
      h('div.date.greet', {},
        h('span.g', { text: greeting(now.getHours()) }),
        h('span.d', { text: `${shortDate(now.toISOString())} · ${WEEKDAYS[now.getDay()]}` }),
      ),
      h('div.line', {},
        h('a', { href: '#/review?box=waiting' }, waitCount, '等答案'),
        h('a', { href: '#/review?box=verdict' }, todoCount, '该复盘'),
        h('a', { href: '#/find' }, allCount, '条记录'),
      ),
      quick,
    ),
    dial.node,
  )
  // 日晷上的时刻每分钟对一次表。
  const minute = window.setInterval(() => dial.tick(), 60_000)

  // ---------- 右：夜窗，判对率 ----------
  const score = h('section.score', {}, h('div.k', { text: '判对率' }), h('div.none', { text: '正在数' }))

  // ---------- 两列 + 最近 ----------
  const waiting = h('div.wait-list')
  const todo = h('div.verdict-list')
  const recent = h('div.list')
  const blockWait = section('等答案', '市场还没开口', waiting, h('a.more', { href: '#/review?box=waiting' }, '全部', icon('chev')))
  const blockTodo = section('该复盘', '答案已经到了', todo, h('a.more', { href: '#/review?box=verdict' }, '全部', icon('chev')))
  const blockRecent = section('最近', null, recent, h('a.more', { href: '#/find' }, '全部记录', icon('chev')))
  blockRecent.classList.add('recent-sec')

  host.append(h('div.today', {}, hero, score), h('div.today-cols', {}, blockWait, blockTodo, blockRecent))
  waiting.appendChild(ledgerSkeleton(2))
  todo.appendChild(ledgerSkeleton(2))
  recent.appendChild(ledgerSkeleton(3))

  void loadQueue()
  void loadScore()
  void loadRecent()

  /** 队列一起读，再按流程分成「等答案」和「该复盘」。草稿写到一半的也算该复盘。 */
  async function loadQueue(): Promise<void> {
    try {
      const queue = await reviewQueue(controller.signal)
      const loaded = await Promise.all(queue.map(item => gate.run(async () => {
        const record = await detail(item.id)
        return record.voided ? null : classifyReviewTask(item, record)
      })))
      if (!isAlive()) return
      const tasks = loaded.filter((task): task is ReviewTask => task !== null)
      const wait = tasks.filter(task => task.box === 'waiting')
      const write = tasks.filter(task => task.box !== 'waiting')
      countUp(waitCount, wait.length)
      countUp(todoCount, write.length)
      paintWaiting(wait)
      paintTodo(write)
    } catch {
      if (!isAlive()) return
      clear(waiting)
      clear(todo)
      waitCount.textContent = '—'
      todoCount.textContent = '—'
      for (const box of [waiting, todo]) box.appendChild(empty({ title: '清单没读出来', action: h('button.btn.sm', { text: '重试', on: { click: () => void loadQueue() } }) }))
    }
  }

  /** 判对率：和「经验」页同一份底稿。没判过就只写还没有数。 */
  async function loadScore(): Promise<void> {
    try {
      const all = await scorecard({ signal: controller.signal })
      if (!isAlive()) return
      countUp(allCount, all.length)
      paintScore(all)
    } catch {
      if (!isAlive()) return
      allCount.textContent = '—'
      clear(score)
      score.append(h('div.k', { text: '判对率' }),
        h('div.none', {}, '没数出来', h('small', {}, h('button.linkbtn', { text: '重试', on: { click: () => void loadScore() } }))))
    }
  }

  function paintScore(all: Scored[]): void {
    clear(score)
    const judged = all.filter(s => s.verdict === 'right' || s.verdict === 'wrong')
    const right = all.filter(s => s.verdict === 'right').length
    const wrong = all.filter(s => s.verdict === 'wrong').length
    const skipped = all.filter(s => s.verdict === 'void').length
    const waitingN = all.length - right - wrong - skipped
    const rate = hitRate(all)
    score.appendChild(h('div.k', { text: '判对率' }))
    if (rate === null) {
      score.appendChild(h('div.none', {}, all.length ? '还没有判过对错的记录。' : '还没有记录。',
        h('small', { text: all.length ? '市场给了答案再判，这里就有数。' : '记下第一笔判断，等市场给答案。' })))
      score.appendChild(h('div.foot', {}, h('a', { href: '#/stats' }, '看全部战绩')))
      return
    }
    const num = h('b', { text: '0' })
    const ring = h('div.ring', { style: `--c:${RING.toFixed(1)};--p:${(rate / 100).toFixed(3)}` },
      svgRing(),
      h('div.num', {}, h('b', {}, num, h('small', { text: '%' })), h('span', { text: `${judged.length} 次已判` })))
    if (prefersReducedMotion()) num.textContent = String(rate)
    else countUp(num, rate, 1200)
    const total = Math.max(1, all.length)
    const facts = h('div.facts', {},
      h('div.f.ok', {}, h('i'), h('b', { text: String(right) }), '对'),
      h('div.f.no', {}, h('i'), h('b', { text: String(wrong) }), '错'),
      h('div.f.wait', {}, h('i'), h('b', { text: String(waitingN) }), '等答案'),
      h('div.bar', {},
        h('i.ok', { style: `--w:${(right * 100 / total).toFixed(1)}%;--i:0` }),
        h('i.no', { style: `--w:${(wrong * 100 / total).toFixed(1)}%;--i:1` }),
        h('i.wait', { style: `--w:${(waitingN * 100 / total).toFixed(1)}%;--i:2` })),
    )
    score.appendChild(h('div.body', {}, ring, facts))
    const chart = hitRate(all.filter(s => s.item.body.path === 'chart_first'))
    const idea = hitRate(all.filter(s => s.item.body.path === 'thought_first'))
    const foot = h('div.foot')
    if (chart !== null) foot.appendChild(h('span', { text: `${PATHS['chart_first']} ${chart}%` }))
    if (idea !== null) foot.appendChild(h('span', { text: `${PATHS['thought_first']} ${idea}%` }))
    foot.appendChild(h('a', { href: '#/stats' }, '看全部战绩'))
    score.appendChild(foot)
  }

  function paintWaiting(rows: ReviewTask[]): void {
    clear(waiting)
    if (!rows.length) {
      waiting.appendChild(empty({ title: '今天没有等答案的判断', action: h('button.btn.gold.sm', { text: '记一笔', on: { click: () => openCapture() } }) }))
      return
    }
    const made = rows.slice(0, 4).map(({ record: d }) => waitCard(d))
    for (const node of made) waiting.appendChild(node)
    stagger(made)
  }

  function waitCard(d: CallDetail): HTMLElement {
    const body = d.body
    const rule = sentence(primary(body.criteria))
    const pending = (d.current_outcomes ?? []).find(o => o.result.state === 'pending' && o.result.end_at)
    const hours = pending?.result.end_at ? Math.max(1, Math.ceil((Date.parse(pending.result.end_at) - Date.now()) / 3_600_000)) : null
    const top = h('div.top', {}, h('b', { text: d.instrument ?? body.instrument ?? '—' }), stanceBadge(body.stance))
    if (body.confidence != null) top.appendChild(h('span.conf', { text: `${body.confidence}%` }))
    const tf = d.timeframe ?? body.timeframe
    const path = PATHS[body.path]
    if (tf || path) top.appendChild(h('span.chip.tag', { text: [tf, path].filter(Boolean).join(' · ') }))
    const card = h('a.wait-card', { href: `#/call/${d.id}` },
      top,
      h('div.q', { text: d.original_text || body.original_text }),
      hours === null
        ? h('div.countdown', {}, h('b', { text: '—' }), h('span', { text: '没写时限' }))
        : h('div.countdown', {}, h('b', { text: String(hours) }), h('span', { text: '小时到期限' })),
    )
    if (rule) card.appendChild(h('div.rule', {}, '怎么算对 ', h('span', { text: rule })))
    return card
  }

  function paintTodo(rows: ReviewTask[]): void {
    clear(todo)
    if (!rows.length) {
      todo.appendChild(empty({ title: '暂时没有该复盘的' }))
      return
    }
    const made = rows.slice(0, 5).map((task) =>
      recordRow(task.record, {
        density: 'task',
        alive: isAlive,
        outcome: head(task.record),
        action: () => actionsFor(task),
      }),
    )
    for (const node of made) todo.appendChild(node)
    stagger(made)
    const judgeN = rows.filter(task => task.box === 'verdict').length
    const writeN = rows.length - judgeN
    const links = h('div.row', { style: 'gap:16px;margin-top:10px' })
    if (judgeN) links.appendChild(h('a.more', { href: '#/review?box=verdict', text: `判对错 ${judgeN} 条` }))
    if (writeN) links.appendChild(h('a.more', { href: '#/review?box=write', text: `写复盘 ${writeN} 条` }))
    todo.appendChild(links)
  }

  function actionsFor(task: ReviewTask): Node {
    const slot = document.createDocumentFragment()
    if (task.box === 'verdict') {
      for (const j of JUDGES) {
        slot.appendChild(h('button.btn.sm', { class: j.cls, type: 'button', text: j.label,
          on: { click: (e) => void setVerdict(task, j.state, e.currentTarget as HTMLButtonElement) } }))
      }
    } else {
      if (task.draft) slot.appendChild(h('span.tag', { text: '草稿' }))
      slot.appendChild(h('a.btn.sm.gold', { href: `#/review/${task.record.id}/step/1`, text: task.draft ? '继续复盘' : '写复盘' }))
    }
    return slot
  }

  /** 行内判对错：和复盘页同一个接口、同一句提示。判完清单和判对率一起重数。 */
  async function setVerdict(task: ReviewTask, state: 'realized' | 'unrealized' | 'not_triggered', button: HTMLButtonElement): Promise<void> {
    if (!isAlive()) return
    const buttons = Array.from(button.closest('.tk-act')?.querySelectorAll<HTMLButtonElement>('button') ?? [button])
    for (const control of buttons) control.disabled = true
    const action = new WriteAction()
    const payload = { state, expected_revision: task.record.revision }
    try {
      await judge(task.record.id, payload, action.keyFor(payload))
      invalidate(task.record.id)
      invalidateArchive()
      forgetScorecard()
      if (!isAlive()) return
      toast('记下了')
      void loadQueue()
      void loadScore()
    } catch (error) {
      if (!isAlive()) return
      const status = error instanceof ApiError ? error.status : 0
      problem(status === 404 || status === 405 ? '本机后端还没有这个接口' : '没保存上，再试一次')
      for (const control of buttons) control.disabled = false
    }
  }

  async function loadRecent(): Promise<void> {
    try {
      const page = await calls.list({ limit: 6 })
      if (!isAlive()) return
      clear(recent)
      if (!page.items.length) {
        recent.appendChild(empty({ title: '还没有记录', action: h('button.btn.gold.sm', { text: '记一笔', on: { click: () => openCapture() } }) }))
        return
      }
      const made = page.items.map((item) => recordRow(item, { density: 'compact', alive: isAlive }))
      for (const node of made) recent.appendChild(node)
      stagger(made)
    } catch {
      if (!isAlive()) return
      clear(recent)
      recent.appendChild(empty({ title: '记录没读出来', action: h('button.btn.sm', { text: '重试', on: { click: () => void loadRecent() } }) }))
    }
  }

  return () => {
    alive = false
    controller.abort()
    window.clearInterval(minute)
  }
}

function section(title: string, small: string | null, body: HTMLElement, more: HTMLElement | null): HTMLElement {
  const heading = h('h2', { text: title })
  if (small) heading.appendChild(h('small', { text: small }))
  return h('section.sec', {}, h('div.sec-h', {}, heading, more), body)
}

function svgRing(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 150 150')
  for (const cls of ['track', 'val']) {
    const c = document.createElementNS(ns, 'circle')
    c.setAttribute('class', cls)
    c.setAttribute('cx', '75'); c.setAttribute('cy', '75'); c.setAttribute('r', '66')
    svg.appendChild(c)
  }
  return svg
}

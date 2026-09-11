// 今天 —— 打开这个产品第一眼看到的地方。
//
// 它只回答一个问题：接着上次，现在该做哪一件事。上面是记分簿的前提（交易先有
// 判断、市场后给答案、这里只存答案揭晓之前的那一半），下面就是今天真正等着你
// 的那几条记录：写了一半的复盘、结果已经出来可以回头对一次的、还在观察期里的。
//
// 这里出现的每一条、每一个数字都来自真实请求：任务来自 GET /v1/review-queue 的
// 两个桶，最近的判断来自 GET /v1/calls，本周条数和局面类别数各自数出来。哪条记
// 录走到了哪个环节、下一步是什么，由 data/flow.ts 统一决定，这一页不自己猜。
// 能力没开的时候不摆一排点不开的卡片，只给一句实话和一个设置入口。

import * as calls from '../../api/calls'
import * as knowledge from '../../api/knowledge'
import * as reviews from '../../api/reviews'
import type { CallListItem, QueueItem } from '../../api/types'
import { flowOf, fromQueueItem, STAGES, type Flow } from '../../data/flow'
import { capabilityGap, isLive } from '../../data/session'
import { relative } from '../../data/time'
import { go } from '../../router'
import { stanceBadge, thumb } from '../../ui/bits'
import { clear, h } from '../../ui/dom'
import { flowMini } from '../../ui/flow'
import { icon } from '../../ui/icons'
import { countUp, prefersReducedMotion, stagger } from '../../ui/motion'
import { empty } from '../../ui/states'
import { openCapture } from '../capture'

const WEEK_MS = 7 * 24 * 3_600_000

export function homePage(host: HTMLElement): () => void {
  let alive = true
  const isAlive = () => alive

  const week = bigNumber('本周记下的判断')
  const due = bigNumber('还等着回头对一次')
  const tagged = bigNumber('你分出来的局面类别')

  const hero = buildHero(week.node, due.node, tagged.node)
  const today = h('div.tlist')
  const recent = h('div.hrecent')

  host.appendChild(hero)
  host.appendChild(
    h(
      'section.tsec',
      {},
      h(
        'div.tsh',
        {},
        h('span.eyebrow', { text: '今天' }),
        h('span.why', { text: '接着上次的地方继续。这里只放真的等着你的那几条，没有的时候就是没有。' }),
        h('a.more', { href: '#/review' }, '全部复盘队列', icon('chev')),
      ),
      today,
    ),
  )
  host.appendChild(
    h(
      'section.hsec',
      {},
      h(
        'div.hsh',
        {},
        h('span.eyebrow', { text: '最近记下的判断' }),
        h('span.why', { text: '点开任意一条，看到的是当时那张图和当时那句话，一个字都没动过。' }),
        h('a.more', { href: '#/find' }, '全部记录', icon('chev')),
      ),
      recent,
    ),
  )
  const gaps = gapNote()
  if (gaps) host.appendChild(gaps)

  today.appendChild(waitRow())
  today.appendChild(waitRow())
  recent.appendChild(h('div.hrec.wait', {}, h('span.sk.line', { style: 'width:40%' })))

  void loadToday()
  void loadNumbers()
  void loadRecent()

  // 顶上那块深色板子上的光跟着指针走一点点，幅度很小，只是让它不像一张贴纸。
  const track = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || prefersReducedMotion()) return
    const box = hero.getBoundingClientRect()
    hero.style.setProperty('--mx', `${((e.clientX - box.left) / box.width) * 100}%`)
    hero.style.setProperty('--my', `${((e.clientY - box.top) / box.height) * 100}%`)
  }
  if (!prefersReducedMotion()) hero.addEventListener('pointermove', track)

  /**
   * 两个桶分开读，筛选交给后端：写了一半的在 in_progress，还没写过的在
   * needs_review——后者既有结果已经出来的，也有还在观察期里的，按流程环节分开。
   */
  async function loadToday(): Promise<void> {
    try {
      const [drafts, fresh] = await Promise.all([
        reviews.queue({ bucket: 'in_progress', limit: 10 }),
        reviews.queue({ bucket: 'needs_review', limit: 40 }),
      ])
      if (!isAlive()) return
      const rows = [...drafts.items, ...fresh.items].map((item) => ({
        item,
        flow: flowOf(fromQueueItem(item)),
      }))
      const editing = rows.filter((r) => r.flow.next.kind === 'continue')
      const ready = rows.filter((r) => r.flow.next.kind === 'write' || r.flow.next.kind === 'recheck')
      const watching = rows.filter((r) => r.flow.next.kind === 'observe' || r.flow.next.kind === 'result')

      clear(today)
      if (!editing.length && !ready.length && !watching.length) {
        today.appendChild(clearDay())
        return
      }
      const made: HTMLElement[] = []
      const put = (title: string, why: string, list: typeof rows, max: number) => {
        if (!list.length) return
        today.appendChild(groupLine(title, why, list.length, max))
        for (const row of list.slice(0, max)) {
          const node = taskRow(row.item, row.flow)
          today.appendChild(node)
          made.push(node)
        }
      }
      put('接着写完', '上次写到一半的复盘草稿还在，原样留着。', editing, 3)
      put('可以回头对一次了', '市场已经给出答案，趁着还记得写下来。', ready, 4)
      put('还在观察里', '到期以前不判对错。想先看看现在走到哪了，从这儿进去。', watching, 3)
      stagger(made)
      for (const node of made) node.classList.add('in')
    } catch {
      if (!isAlive()) return
      clear(today)
      today.appendChild(
        empty({
          title: '今天要做的事没读出来',
          tip: '确认本机后端在 127.0.0.1:8787 运行，然后在这儿再试一次。',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void loadToday() } }),
        }),
      )
    }
  }

  async function loadNumbers(): Promise<void> {
    try {
      const page = await calls.list({ limit: 100 })
      if (!isAlive()) return
      const since = Date.now() - WEEK_MS
      let count = 0
      let capped = true
      for (const item of page.items) {
        if (new Date(item.submitted_at).getTime() < since) {
          capped = false
          break
        }
        count += 1
      }
      week.set(count, capped && Boolean(page.next_cursor))
    } catch {
      if (isAlive()) week.fail()
    }

    try {
      const page = await reviews.queue({ bucket: 'needs_review', limit: 20 })
      if (!isAlive()) return
      due.set(page.items.length, Boolean(page.next_cursor))
      if (page.items.length) due.node.classList.add('hot')
    } catch {
      if (isAlive()) due.fail()
    }

    try {
      const page = await knowledge.tags(null)
      if (!isAlive()) return
      tagged.set(page.items.length, Boolean(page.next_cursor))
    } catch {
      if (isAlive()) tagged.fail()
    }
  }

  async function loadRecent(): Promise<void> {
    try {
      const page = await calls.list({ limit: 4 })
      if (!isAlive()) return
      clear(recent)
      if (!page.items.length) {
        recent.appendChild(
          empty({
            title: '还没有第一条判断',
            tip: '下一次开口之前先记一条，往后这里就是你最近说过的话，也是记分的第一笔。',
            action: h('button.btn.sm', { text: '记录判断', on: { click: () => openCapture() } }),
          }),
        )
        return
      }
      const made = page.items.map((item) => recentRow(item))
      for (const row of made) recent.appendChild(row)
      stagger(made)
    } catch {
      if (!isAlive()) return
      clear(recent)
      recent.appendChild(
        empty({
          title: '最近的判断没读出来',
          tip: '确认本机后端在运行，然后在这儿再试一次。',
          action: h('button.btn.sm', { text: '再试一次', on: { click: () => void loadRecent() } }),
        }),
      )
    }
  }

  return () => {
    alive = false
    hero.removeEventListener('pointermove', track)
  }
}

/**
 * 顶上的记分牌：一句话说清这个产品的前提，底下五步就是一条记录真实的走法，
 * 和四个主入口对得上。
 */
function buildHero(...tiles: HTMLElement[]): HTMLElement {
  return h(
    'section.hero',
    {},
    h('div.hero-grid'),
    h('div.hero-scan'),
    h(
      'div.hero-in',
      {},
      h('span.eyebrow.noline.hero-eb', { text: '记分簿 · Scorebook' }),
      h(
        'h1.hero-t',
        {},
        h('span.ln', {}, h('i', { text: '让你的交易直觉' })),
        h('span.ln', {}, h('i', { text: '越用越准。' })),
      ),
      h('p.hero-s', {
        text:
          '直觉是主观交易者最值钱的东西，也是最说不清的东西：反馈快的品种上它是真本事，反馈慢的品种上它可能只是错觉，而两者的体感一模一样。' +
          '记分簿把你在市场开口之前说出的每一句判断，连同当时那张图一起钉住，等行情走完，由市场来打分。' +
          '它不替你判断，也不怀疑你的直觉——只是让直觉自己长出能被数出来的证据。',
      }),
      h(
        'div.hero-flow',
        {},
        ...STAGES.map((stage, i) =>
          h(
            'div.hstep',
            {},
            h('span.n', { text: String(i + 1).padStart(2, '0') }),
            h('span.t', { text: stage.title }),
            h('span.l', { text: stage.line }),
          ),
        ),
      ),
      h(
        'div.hero-acts',
        {},
        h('button.btn.primary.lg', { on: { click: () => openCapture() } }, icon('plus'), '记下这一刻的判断'),
        h('a.btn.lg.onboard', { href: '#/search' }, icon('img'), '用现在的走势找过去'),
      ),
      h('div.hero-nums', {}, ...tiles),
    ),
  )
}

function groupLine(title: string, why: string, total: number, max: number): HTMLElement {
  const more = total > max ? `　还有 ${total - max} 条` : ''
  return h(
    'div.tgh',
    {},
    h('span.t', { text: title }),
    h('span.n', { text: String(total) }),
    h('span.w', { text: why + more }),
  )
}

/** 一条今天要做的事：说清是哪条记录、走到哪儿了、下一步做什么。 */
function taskRow(item: QueueItem, flow: Flow): HTMLElement {
  const href = flow.next.href ?? `#/call/${item.id}`
  return h(
    'a.ttask',
    {
      href,
      on: {
        click: (e: MouseEvent) => {
          e.preventDefault()
          go(href.replace(/^#\//, ''))
        },
      },
    },
    h('span.ic', {}, icon(flow.next.iconName)),
    h(
      'div.c',
      {},
      h(
        'div.r1',
        {},
        h('span.sym', { text: item.instrument ?? '没写品种' }),
        item.timeframe ? h('span', { text: item.timeframe }) : null,
        h('span', { text: relative(item.submitted_at) }),
        flowMini(flow),
      ),
      h('div.q', { text: item.original_text }),
      h('div.r2', { text: flow.summary }),
    ),
    h('span.go', {}, h('span', { text: flow.next.label }), icon('chev')),
  )
}

function waitRow(): HTMLElement {
  return h(
    'div.ttask.wait',
    {},
    h('span.ic', {}, h('span.sk', { style: 'width:20px;height:20px;border-radius:7px' })),
    h(
      'div.c',
      {},
      h('div.sk.line', { style: 'width:26%' }),
      h('div.sk.line', { style: 'width:72%' }),
    ),
  )
}

/** 今天没有待办：不摆一排空卡片，给一句话和一个动作。 */
function clearDay(): HTMLElement {
  return h(
    'div.tclear',
    {},
    h('span.ic', {}, icon('check')),
    h(
      'div.b',
      {},
      h('b', { text: '今天没有等着你的记录' }),
      h('span', {
        text: '写了一半的、结果已经出来的、还在观察里的，现在都没有。下一次开口之前记一条，它会自己排到这里来。',
      }),
    ),
    h('button.btn.primary', { on: { click: () => openCapture() } }, icon('plus'), '记录判断'),
  )
}

/**
 * 没接上的能力，一句实话加一个设置入口。
 *
 * 「后端没做」和「后端做了、这台机器没配」是两件事：交易所账户在 v4 里适配器
 * 已经实现，缺的只是本机凭证；Chat 同理。上一版把这两种情况都写成「后端还没有
 * 做这部分」，这里按 /v1/capabilities 的真实形态分开说。
 */
function gapNote(): HTMLElement | null {
  const watch: { name: string; label: string }[] = [
    { name: 'chat_generation', label: '问过去的自己' },
    { name: 'exchange_accounts', label: '交易所账户' },
    { name: 'encrypted_backup', label: '加密备份' },
    { name: 'knowledge_index', label: '按意思找' },
  ]
  const missing = watch.filter((w) => !isLive(w.name))
  if (!missing.length) return null

  const configure = missing.filter((w) => capabilityGap(w.name) === 'not_configured')
  const absent = missing.filter((w) => capabilityGap(w.name) !== 'not_configured')
  const lines: string[] = []
  if (configure.length) {
    lines.push(`${configure.map((w) => w.label).join('、')}：后端已经做好了，这台机器上还没配它要的那一份东西。`)
  }
  if (absent.length) {
    lines.push(`${absent.map((w) => w.label).join('、')}：本机后端现在没有报告这项能力。`)
  }

  return h(
    'section.tsec',
    {},
    h(
      'div.gapnote',
      {},
      h('span.ic', {}, icon('gear')),
      h(
        'div.b',
        {},
        h('b', { text: '有几项现在用不了' }),
        ...lines.map((text) => h('span', { text })),
      ),
      h('a.btn.sm', { href: '#/settings' }, '去设置里看', icon('chev')),
    ),
  )
}

function recentRow(item: CallListItem): HTMLElement {
  const body = item.body
  return h(
    'a.hrec',
    { href: `#/call/${item.id}`, on: { click: () => go(`call/${item.id}`) } },
    thumb(body.attachments?.[0] ?? null, `${body.instrument ?? '未标品种'} 现场图`, 'sm'),
    h(
      'div.c',
      {},
      h(
        'div.r1',
        {},
        stanceBadge(body.stance),
        h('span.sym', { text: body.instrument ?? '品种待确认' }),
        h('span.when', { text: relative(item.submitted_at) }),
      ),
      h('div.q', { text: body.original_text }),
    ),
    icon('chev'),
  )
}

function bigNumber(label: string) {
  const value = h('span.v', { text: '—' })
  const node = h('div.hnum', {}, value, h('span.k', { text: label }))
  return {
    node,
    set(n: number, atLeast: boolean) {
      value.replaceChildren()
      const number = h('span', { text: '0' })
      value.append(number, h('small', { text: atLeast ? '条以上' : '条' }))
      countUp(number, n)
    },
    fail() {
      value.replaceChildren(h('small', { text: '没读出来' }))
    },
  }
}

// 首页 —— 打开这个产品第一眼看到的地方。
//
// 它要让人一眼想用：先说清这套东西替交易员解决什么（直觉分不清真假、记忆会被现在的
// 观点改写、同类局面看不出有没有进步），再说它怎么做到——交易先有判断，市场后给答案，
// 这里只存答案揭晓之前的那一半，行情走完再由市场给它记分。分组照这条时间线走：
// 市场开口之前 —— 别让记忆改写它 —— 下次同样的局面。每一组下面才是具体入口。
//
// 这里出现的每个数字都来自真实请求：本周的条数是从 GET /v1/calls 走一页数出来
// 的，待复盘来自 GET /v1/review-queue，标签数来自 GET /v1/tags。没有一处是编
// 出来充场面的。功能卡片是否可点，由后端 /v1/capabilities 说了算：后端还没做的
// 能力照实写成「还没开放」，不做成看起来能用的空壳。

import * as calls from '../../api/calls'
import * as knowledge from '../../api/knowledge'
import * as reviews from '../../api/reviews'
import type { CallListItem } from '../../api/types'
import { go } from '../../router'
import { isLive } from '../../data/session'
import { relative } from '../../data/time'
import { stanceBadge, thumb } from '../../ui/bits'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { countUp, prefersReducedMotion, stagger } from '../../ui/motion'
import { empty } from '../../ui/states'
import { openCapture } from '../capture'

const WEEK_MS = 7 * 24 * 3_600_000

interface Entry {
  iconName: string
  title: string
  line: string
  href?: string
  onClick?: () => void
  /** 这张卡片下面那句动作，写具体一点，六张卡不要都写「进去看看」。 */
  act: string
  /** 后端能力名；留空表示这条一直可用。 */
  needs?: string
  /** 用不了的时候，如实说一句为什么。 */
  closed?: string
}

export function homePage(host: HTMLElement): () => void {
  let alive = true
  const isAlive = () => alive

  const week = bigNumber('本周记下的判断')
  const due = bigNumber('还等着回头对一次')
  const tagged = bigNumber('你分出来的局面类别')

  const hero = buildHero(week.node, due.node, tagged.node)
  const recent = h('div.hrecent')

  const blocks: (HTMLElement | null)[] = [
    hero,
    group(
      '市场开口之前',
      '这一刻你还在盘上，脑子里刚闪过的那句话是最值钱的东西，也是最容易丢的东西。记下来只要一行、十几秒，它以后会变成能被数出来的证据。心里冒出「这种画面我见过」的时候，去问样本，别问记忆。',
      [
        {
          iconName: 'plus',
          title: '记录判断',
          line: '一行记完：当时那张图、你说出口的那句话、这个想法从哪来。方向、周期、算对的标准都可以空着——判断的那一刻你在交易，不该被表格拖住。原话存下就不再改，往后谁也篡改不了它。',
          act: '十几秒记一条',
          onClick: () => openCapture(),
          needs: 'records',
          closed: '本机后端还没有开放写入。',
        },
        {
          iconName: 'img',
          title: '按图找同类局面',
          line: '把眼前这张图丢进来，立刻翻出你自己记过的、画面最像的那几条：当时你怎么说的，后来市场怎么答的。这种局面到底见过几次，不用再靠印象猜。',
          act: '传一张图去比',
          href: '#/search',
          needs: 'image_structure_search',
          closed: '本机还没有准备好比图用的数据。',
        },
      ],
    ),
    group(
      '别让记忆改写它',
      '经验最大的敌人不是忘记，是被改写：每回想一次，记忆就朝你现在的观点修一点，几年下来分不清哪部分是真的。这里翻出来的永远是市场揭晓之前的那一版，一个字都没动过。',
      [
        {
          iconName: 'search',
          title: '我的记录',
          line: '按当时的原话、品种、周期、标签往回翻。看到的是判断时刻写下的原文；事后补的结果单独放，永远不会混进当时那句话里。',
          act: '翻回当时那一版',
          href: '#/find',
        },
        {
          iconName: 'wave',
          title: '一段一段的行情',
          line: '同一段行情里的几次判断串成一条线：你的看法在哪根 K 线上转的、理由变没变，一眼看完自己当时的思路是怎么走的。',
          act: '看想法怎么变的',
          href: '#/episode',
        },
        {
          iconName: 'tag',
          title: '局面类别',
          line: '你自己给同类局面起的名字。点进去就是这一类的全部样本——这种局面你到底见过多少次，从这里开始有答案。',
          act: '按类看样本',
          href: '#/archive',
        },
      ],
    ),
    group(
      '下次同样的局面',
      '同类局面会反复出现，多数人只是又经历一次。事后回看不是拿来批判当时的局限的，它只回答一个问题：同样的局面再来一次，有没有更好的打法、比上一次进步在哪里——让直觉的成长第一次看得见。',
      [
        {
          iconName: 'review',
          title: '复盘',
          line: '行情走完再写：当时那句话哪一半站住了、哪一半是错觉，同样的局面下次怎么做更好，和上一次比变在哪里。写过的复盘不会被改，只会一层层叠上去。',
          act: '写一条复盘',
          href: '#/review',
          needs: 'reviews',
          closed: '本机后端还没有开放复盘。',
        },
        {
          iconName: 'play',
          title: '我的做法',
          line: '把一类局面的打法定下来，和支撑它的那几条记录绑在一起；改一次留一版，你的策略是怎么长起来的，自己会显出来。',
          act: '看做法怎么变的',
          href: '#/playbook',
        },
        {
          iconName: 'gear',
          title: '这台机器现在能做什么',
          line: '每一项能力是开着还是关着，照实列在这一页。没做完的绝不摆成能用的样子，免得你把它当成真的。',
          act: '看能力清单',
          href: '#/settings',
        },
      ],
    ),
    closedGroup(),
    h(
      'section.hsec',
      {},
      h(
        'div.hsh',
        {},
        h('span.eyebrow', { text: '最近记下的判断' }),
        h('span.why', { text: '点开任意一条，看到的是当时那张图和当时那句话。' }),
        h('a.more', { href: '#/find' }, '全部记录', icon('chev')),
      ),
      recent,
    ),
  ]
  for (const block of blocks) if (block) host.appendChild(block)

  recent.appendChild(h('div.hrec.wait', {}, h('span.sk.line', { style: 'width:40%' })))

  void loadNumbers()
  void loadRecent()

  // 顶部记分牌上的光跟着指针走一点点，幅度很小，只是让这块深色板子不像贴纸。
  const track = (e: PointerEvent) => {
    const box = hero.getBoundingClientRect()
    hero.style.setProperty('--mx', `${((e.clientX - box.left) / box.width) * 100}%`)
    hero.style.setProperty('--my', `${((e.clientY - box.top) / box.height) * 100}%`)
  }
  if (!prefersReducedMotion()) hero.addEventListener('pointermove', track)

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
            art: 'search',
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
        empty({ art: 'info', title: '最近的判断没读出来', tip: '确认本机后端在运行，然后刷新页面。' }),
      )
    }
  }

  return () => {
    alive = false
    hero.removeEventListener('pointermove', track)
  }
}

/**
 * 顶上的记分牌：一句话说清这个产品的前提。
 * 底下的三步不是装饰，它就是一次判断真实的时间顺序：说在前、市场作答、下次更好。
 */
function buildHero(...tiles: HTMLElement[]): HTMLElement {
  const steps: [string, string, string][] = [
    ['01', '市场开口前', '一句话钉住判断，十几秒，不打断盘面'],
    ['02', '市场给答案', '走势走完，对错由行情说，不由记忆补'],
    ['03', '下次同样局面', '翻出上次怎么做的，这次好在哪里'],
  ]

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
          '它不替你判断，也不怀疑你的直觉——只是让直觉自己长出能被数出来的证据。用得越久，你越清楚自己在哪类局面上真的有优势。',
      }),
      h(
        'div.hero-flow',
        {},
        ...steps.map(([n, title, line]) =>
          h(
            'div.hstep',
            {},
            h('span.n', { text: n }),
            h('span.t', { text: title }),
            h('span.l', { text: line }),
          ),
        ),
      ),
      h(
        'div.hero-acts',
        {},
        h('button.btn.primary.lg', { on: { click: () => openCapture() } }, icon('plus'), '记下这一刻的判断'),
        h('a.btn.lg.onboard', { href: '#/find' }, icon('search'), '翻我说过的话'),
      ),
      h('div.hero-nums', {}, ...tiles),
    ),
  )
}

function group(title: string, why: string, entries: Entry[]): HTMLElement {
  const cards = entries.map(card)
  const node = h(
    'section.hsec',
    {},
    h('div.hsh', {}, h('span.eyebrow', { text: title }), h('span.why', { text: why })),
    h('div', { class: ['hcards', entries.length === 2 ? 'lead' : ''] }, ...cards),
  )
  stagger(cards)
  return node
}

/**
 * 后端还没做完的能力单独放一组，写清楚现在用不了，而不是先摆一个能点开的空壳。
 * 已经开放的能力在这里不出现——它们各自有真的入口。
 */
function closedGroup(): HTMLElement | null {
  const planned: Entry[] = [
    {
      iconName: 'q',
      title: '问过去的自己',
      line: '一句话问回去：这种局面我以前是怎么说的、说中了几次、什么时候不灵，让过去的自己回答现在的自己。',
      act: '',
      needs: 'chat_generation',
      closed: '本机还没有接模型，问不了。',
    },
    {
      iconName: 'link',
      title: '交易所账户',
      line: '把真实成交自动对回当时那条判断，说到有没有做到、做到有没有做对，全部自动对上，不再靠事后手填。',
      act: '',
      needs: 'exchange_accounts',
      closed: '后端还没有做这部分。',
    },
    {
      iconName: 'scale',
      title: '直觉的记分板',
      line: '同一类局面见过多少次、按你说的走了多少次、在什么情况下失效——直觉的成绩单。',
      act: '',
      needs: 'formal_statistics',
      closed: '口径还没定下来，先不给数字，免得看着像真的。',
    },
  ].filter((entry) => !isLive(entry.needs ?? ''))

  if (!planned.length) return null
  const cards = planned.map(card)
  const node = h(
    'section.hsec',
    {},
    h(
      'div.hsh',
      {},
      h('span.eyebrow', { text: '还没开放' }),
      h('span.why', {
        text: '记分要有说得清的口径，口径没定下来就不给数字，免得看着像真的。以下这些后端还没做完，如实标在这里。',
      }),
    ),
    h('div.hcards', {}, ...cards),
  )
  stagger(cards)
  return node
}

function card(entry: Entry): HTMLElement {
  const open = !entry.needs || isLive(entry.needs)
  const head = h(
    'div.hc-top',
    {},
    h('span.ic', {}, icon(entry.iconName)),
    h('span.t', { text: entry.title }),
  )
  const line = h('p.l', { text: entry.line })

  if (!open) {
    return h(
      'div.hcard.off',
      {},
      head,
      line,
      h('span.go', {}, h('span.tag.cold', { text: '还没开放' }), h('span.faint', { text: entry.closed ?? '' })),
    )
  }

  const go2 = h('span.go', {}, h('span', { text: entry.act }), icon('chev'))
  if (entry.href) {
    return h('a.hcard', { href: entry.href }, head, line, go2)
  }
  return h('button.hcard', { on: { click: () => entry.onClick?.() } }, head, line, go2)
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

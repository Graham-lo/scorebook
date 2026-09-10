// Application shell: masthead, routing table and the global shortcuts.
//
// 顶栏分两条：上面一条是这个产品的主线（今天 / 记录 / 复盘 / 经验 / 找过去），
// 下面一条是当前这一格内部的几页。没有页被删掉，每一页仍然是自己的地址，
// 老链接照样打开同一屏。

import { loadCapabilities } from './data/session'
import { register, route, start } from './router'
import { h, clear } from './ui/dom'
import { orderPage, pressFeedback } from './ui/motion'
import { icon } from './ui/icons'
import { problem } from './ui/toast'
import { homePage } from './features/home'
import { findPage } from './features/find'
import { capturePage, openCapture } from './features/capture'
import { callPage } from './features/call'
import { relivePage } from './features/relive'
import { searchPage } from './features/search'
import { historyPage } from './features/history'
import { reviewPage } from './features/review'
import { archivePage } from './features/archive'
import { tradesPage } from './features/trades'
import { cyclePage } from './features/cycle'
import { playbookPage } from './features/playbook'
import { episodePage } from './features/episode'
import { settingsPage } from './features/settings'
import { statsPage } from './features/stats'
import { recallPage } from './features/recall'
import { chatPage } from './features/chat'

/**
 * 这个产品只有一条主线，导航就照那条主线排。
 *
 * 主线写在 data/flow.ts 里，一条记录真实的走法是：
 *   记录判断 → 持续观察 → 查看结果 → 完成复盘 → 沉淀做法。
 * 前三步都发生在同一条记录身上，所以合成一个「记录」；第四步是「复盘」；
 * 第五步攒出来的东西是「经验」。「找过去」不在主线上——它是横着穿过所有
 * 记录的四种找法，所以单独一格，不再散落在「更多」里。
 *
 * 每一格底下的那几页是这一格内部的分工，跟着这一格一起出现，离开就收起来。
 * 上一版把这十一个入口平摊在顶栏和一个「更多」菜单里，看不出谁属于谁，也
 * 看不出先后。
 */
interface Part {
  id: string
  label: string
  why: string
  /** 这一页的详情页，高亮时算同一格。 */
  also?: string[]
}

interface Section {
  id: string
  label: string
  iconName: string
  /** 这一格在整条主线里回答哪个问题。窄屏上不显示。 */
  line: string
  parts: Part[]
}

const SECTIONS: Section[] = [
  {
    id: 'home',
    label: '今天',
    iconName: 'home',
    line: '接着上次，现在该做哪一件事',
    parts: [],
  },
  {
    id: 'find',
    label: '记录',
    iconName: 'search',
    line: '市场开口之前，你说过什么',
    parts: [
      { id: 'find', label: '我的记录', why: '每一次判断的原话和当时那张图', also: ['call', 'new', 'relive'] },
      { id: 'episode', label: '同一段行情', why: '同一个品种上前后连着的几次判断' },
      { id: 'trades', label: '实盘账本', why: '钱实际怎么进出的，和想法分开记', also: ['cycle'] },
    ],
  },
  {
    id: 'review',
    label: '复盘',
    iconName: 'review',
    line: '市场开口之后，回头给当时打分',
    parts: [],
  },
  {
    id: 'stats',
    label: '经验',
    iconName: 'chart',
    line: '一条条记录攒下来，剩下的是这些',
    parts: [
      { id: 'stats', label: '长期统计', why: '同一口径下，你的判断兑现了多少' },
      { id: 'archive', label: '局面类别', why: '给反复出现的同一类局面起个名字' },
      { id: 'playbook', label: '我的做法', why: '一类局面下的打法，和它改过几版' },
    ],
  },
  {
    id: 'recall',
    label: '找过去',
    iconName: 'q',
    line: '四种找法，找回你说过和写过的东西',
    parts: [
      { id: 'recall', label: '按意思找', why: '用一句话找回相关的原话和复盘' },
      { id: 'search', label: '按图找', why: '拿一张走势图找同类局面' },
      { id: 'history', label: '公开历史', why: '按图搜索能搜到哪几段公开行情' },
      { id: 'chat', label: '问过去的自己', why: '让模型读你的记录来回答' },
    ],
  },
]

/** 每一页属于哪一格，以及在那一格的条里高亮哪一项。 */
const HOME_OF = new Map<string, { section: Section; part: Part | null }>()
for (const section of SECTIONS) {
  HOME_OF.set(section.id, { section, part: section.parts.find((p) => p.id === section.id) ?? null })
  for (const part of section.parts) {
    HOME_OF.set(part.id, { section, part })
    for (const extra of part.also ?? []) HOME_OF.set(extra, { section, part })
  }
}

function paintMasthead(): void {
  const focus = document.getElementById('btnFocusSearch')
  focus?.firstElementChild?.replaceWith(icon('search'))
  const capture = document.getElementById('btnCapture')
  capture?.firstElementChild?.replaceWith(icon('plus'))
  const settings = document.getElementById('navSettings')
  settings?.firstElementChild?.replaceWith(icon('gear'))

  focus?.addEventListener('click', focusSearch)
  capture?.addEventListener('click', () => openCapture())
}

function paintNav(current: string): void {
  const nav = document.getElementById('nav')
  if (!nav) return
  const here = HOME_OF.get(current)?.section ?? null
  clear(nav)
  for (const section of SECTIONS) {
    nav.appendChild(
      h(
        'a',
        { href: `#/${section.id}`, class: here === section ? 'active' : '' },
        icon(section.iconName),
        h('span.t', { text: section.label }),
      ),
    )
  }
  document.getElementById('navSettings')?.classList.toggle('active', current === 'settings')
  navIndicator()
  paintSub(current)
}

/**
 * 第二条：这一格里面分了哪几页。
 *
 * 只有真的分了页的格子才出现这条，「今天」和「复盘」各自就是一页，不摆一条
 * 只有一个按钮的假导航。设置不属于任何一格，它一直在右上角那颗齿轮上。
 */
function paintSub(current: string): void {
  const bar = document.getElementById('subnav')
  if (!bar) return
  const at = HOME_OF.get(current)
  clear(bar)
  if (!at || at.section.parts.length < 2) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  const inner = h('div.subin')
  inner.appendChild(h('span.subline', { text: at.section.line }))
  const list = h('nav.subtabs')
  for (const part of at.section.parts) {
    list.appendChild(
      h(
        'a',
        {
          href: `#/${part.id}`,
          class: at.part === part ? 'on' : '',
          title: part.why,
        },
        h('span.l', { text: part.label }),
        h('span.w', { text: part.why }),
      ),
    )
  }
  inner.appendChild(list)
  bar.appendChild(inner)
}

/** The teal pill that slides under the active tab. */
function navIndicator(): void {
  const bar = document.getElementById('nav')
  if (!bar) return
  const active = bar.querySelector<HTMLElement>('a.active')
  if (!active) {
    bar.style.setProperty('--io', '0')
    return
  }
  const box = bar.getBoundingClientRect()
  const at = active.getBoundingClientRect()
  bar.style.setProperty('--ix', `${Math.round(at.left - box.left)}px`)
  bar.style.setProperty('--iw', `${Math.round(at.width)}px`)
  bar.style.setProperty('--ih', `${Math.round(at.height)}px`)
  bar.style.setProperty('--iy', `${Math.round(at.top - box.top)}px`)
  bar.style.setProperty('--io', '1')
}

function focusSearch(): void {
  if (route().page !== 'find') location.hash = '#/find'
  window.setTimeout(() => {
    const input = document.getElementById('q') as HTMLInputElement | null
    input?.focus()
    input?.select()
  }, 60)
}

function typing(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  if (!node) return false
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node.isContentEditable
  )
}

function shortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      focusSearch()
      return
    }
    if (e.key === 'S' && e.ctrlKey && e.shiftKey) {
      e.preventDefault()
      openCapture()
      return
    }
    if (e.key === '/' && !typing(e.target) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      focusSearch()
    }
  })
}

register('home', homePage)
register('find', findPage)
register('new', capturePage)
register('call', callPage)
register('relive', relivePage)
register('search', searchPage)
register('history', historyPage)
register('review', reviewPage)
register('stats', statsPage)
register('recall', recallPage)
register('chat', chatPage)
register('archive', archivePage)
register('trades', tradesPage)
register('cycle', cyclePage)
register('playbook', playbookPage)
register('episode', episodePage)
register('settings', settingsPage)

/**
 * 网页字体按屏幕挑着取。
 *
 * 拉丁那三款（Newsreader / Archivo / DM Mono）是这套界面的样子，一直要，
 * 但不放在 <head> 里挡着首屏——取不到也先用系统字排出来。
 *
 * 中文两款只在宽屏上取。Google 把 Noto Sans/Serif SC 按字切成一百多个分片，光是
 * 那张样式表就有 11 万字符，一页中文再挨个下载三四十个分片：手机走公网取、解析、
 * 每到一片重排一次，实测是这一页在手机上最贵的一笔。手机上换成系统自带的苹方和
 * 宋体——两版并排截图比过，这个字号下看不出区别，一个字节都不用下。
 */
function webFonts(): void {
  const add = (href: string) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    document.head.appendChild(link)
  }
  add('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..600&family=Archivo:wdth,wght@75..125,400..700&family=DM+Mono:wght@400;500&display=swap')
  if (window.matchMedia('(min-width:900px) and (pointer:fine)').matches) {
    add('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@500;600&family=Noto+Sans+SC:wght@400;500;700&display=swap')
  }
}

webFonts()
paintMasthead()
shortcuts()
pressFeedback()
// iOS Safari 在滚动时收起地址栏也算一次 resize，一路滚一路发。指示器只跟宽度
// 有关，所以宽度没变就不量——不然每一帧都要读两次 getBoundingClientRect，
// 强制同步布局，手机滚起来又卡又烫。
let lastWidth = window.innerWidth
let navPending = false
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth || navPending) return
  navPending = true
  requestAnimationFrame(() => {
    navPending = false
    lastWidth = window.innerWidth
    navIndicator()
  })
}, { passive: true })
void document.fonts.ready.then(navIndicator)

/**
 * What the backend says it can do decides what the pages are allowed to offer,
 * so it is read once before the first page paints. Painting first and letting
 * the answer arrive later showed working features as unavailable for a frame.
 */
async function boot(): Promise<void> {
  try {
    await loadCapabilities()
  } catch {
    problem('连不上本机后端服务，页面里的内容都读不出来。确认后端在 127.0.0.1:8787 运行后刷新。')
  }
  start((current) => {
    paintNav(current.page)
    const page = document.querySelector<HTMLElement>('.page')
    if (page) orderPage(page)
  })
}

void boot()

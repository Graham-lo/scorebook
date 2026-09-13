// Application shell: masthead, routing table and the global shortcuts.
//
// 顶栏五格就是这个产品的主线：今天 / 记录 / 复盘 / 经验 / 找。分了子页的那三格
// 底下再出一条子导航，子页写在地址的 `?` 后面，刷新和后退都回得去。
// 窄屏上顶栏只剩品牌和齿轮，五格搬到底部标签栏，中间凸一颗「记一笔」。

import { applyPrefs, motionOff } from './data/prefs'
import { loadCapabilities } from './data/session'
import { register, route, start, type Route } from './router'
import { h, clear } from './ui/dom'
import { paintDecor } from './ui/decor'
import { orderPage, pressFeedback, prefersReducedMotion } from './ui/motion'
import { icon } from './ui/icons'
import { problem } from './ui/toast'
import { homePage } from './features/home'
import { findPage } from './features/find'
import { capturePage, openCapture } from './features/capture'
import { callPage } from './features/call'
import { relivePage } from './features/relive'
import { searchPage } from './features/search'
import { reviewPage } from './features/review'
import { archivePage } from './features/archive'
import { cyclePage } from './features/find/cycle'
import { settingsPage } from './features/settings'
import { statsPage } from './features/stats'

interface Part {
  label: string
  /** 完整的 hash，子页靠 `?` 后面那一格区分。 */
  href: string
  /** 这一项在当前地址下算不算选中。 */
  on: (route: Route) => boolean
}

interface Section {
  id: string
  label: string
  iconName: string
  href: string
  parts: Part[]
  /** 这一格还认哪些页（详情页跟着它高亮）。 */
  also?: string[]
}

const SECTIONS: Section[] = [
  {
    id: 'home',
    label: '今天',
    iconName: 'home',
    href: '#/',
    parts: [],
  },
  {
    id: 'find',
    label: '记录',
    iconName: 'ledger',
    href: '#/find',
    also: ['call', 'relive', 'cycle', 'new'],
    parts: [
      { label: '全部', href: '#/find', on: (r) => !r.query.get('by') },
      { label: '按品种', href: '#/find?by=symbol', on: (r) => r.query.get('by') === 'symbol' },
      { label: '成交', href: '#/find?by=fills', on: (r) => r.query.get('by') === 'fills' },
    ],
  },
  {
    id: 'review',
    label: '复盘',
    iconName: 'review',
    href: '#/review',
    parts: [
      { label: '等市场', href: '#/review?box=waiting', on: (r) => (r.query.get('box') ?? 'waiting') === 'waiting' },
      { label: '判对错', href: '#/review?box=verdict', on: (r) => r.query.get('box') === 'verdict' },
      { label: '写复盘', href: '#/review?box=write', on: (r) => r.query.get('box') === 'write' },
    ],
  },
  {
    id: 'stats',
    label: '经验',
    iconName: 'chart',
    href: '#/stats',
    also: ['archive'],
    parts: [
      { label: '战绩', href: '#/stats', on: (r) => r.page === 'stats' && r.query.get('view') !== 'runs' },
      { label: '局面', href: '#/archive', on: (r) => r.page === 'archive' },
      { label: '统计', href: '#/stats?view=runs', on: (r) => r.page === 'stats' && r.query.get('view') === 'runs' },
    ],
  },
  {
    id: 'search',
    label: '找',
    iconName: 'search',
    href: '#/search',
    parts: [],
  },
]

/** 每一页属于哪一格。 */
const HOME_OF = new Map<string, Section>()
for (const section of SECTIONS) {
  HOME_OF.set(section.id, section)
  for (const extra of section.also ?? []) HOME_OF.set(extra, section)
}

/** document.title 里的那个页面名，逐字来自文案表。 */
const PAGE_NAME: Record<string, string> = {
  home: '今天',
  find: '记录',
  call: '记录',
  cycle: '成交',
  relive: '重温',
  review: '复盘',
  stats: '经验',
  archive: '局面',
  search: '找',
  new: '记一笔',
  settings: '设置',
}

function paintMasthead(): void {
  const capture = document.getElementById('btnCapture')
  capture?.firstElementChild?.replaceWith(icon('plus'))
  const settings = document.getElementById('navSettings')
  settings?.firstElementChild?.replaceWith(icon('gear'))
  capture?.addEventListener('click', () => openCapture())
}

function paintNav(current: Route): void {
  const nav = document.getElementById('nav')
  const here = HOME_OF.get(current.page) ?? null
  if (nav) {
    clear(nav)
    for (const section of SECTIONS) {
      nav.appendChild(
        h(
          'a',
          { href: section.href, class: here === section ? 'active' : '', attrs: here === section ? { 'aria-current': 'page' } : {} },
          icon(section.iconName),
          h('span.t', { text: section.label }),
        ),
      )
    }
  }
  document.getElementById('navSettings')?.classList.toggle('active', current.page === 'settings')
  const settings = document.getElementById('navSettings')
  if (current.page === 'settings') settings?.setAttribute('aria-current', 'page')
  else settings?.removeAttribute('aria-current')
  paintDecor()
  document.title = `Trader Foresight · ${PAGE_NAME[current.page] ?? '今天'}`
  navIndicator()
  paintSub(current, here)
  paintTabbar(here)
}

/** 第二条：这一格里面分了哪几页。没分页的格子不摆一条假导航。 */
function paintSub(current: Route, here: Section | null): void {
  const bar = document.getElementById('subnav')
  if (!bar) return
  clear(bar)
  if (!here || here.parts.length < 2 || ['call', 'relive', 'cycle', 'new'].includes(current.page) || current.arg) {
    bar.hidden = true
    return
  }
  bar.hidden = false
  const inner = h('div.subin')
  const list = h('nav.subtabs')
  for (const part of here.parts) {
    list.appendChild(
      h('a', { href: part.href, class: part.on(current) ? 'on' : '', attrs: part.on(current) ? { 'aria-current': 'page' } : {} }, h('span.l', { text: part.label })),
    )
  }
  inner.appendChild(list)
  bar.appendChild(inner)
}

/** 窄屏底部的五格 + 中间凸起的记一笔。宽屏上整条不画。 */
function paintTabbar(here: Section | null): void {
  const bar = document.getElementById('tabbar')
  if (!bar) return
  clear(bar)
  const half = Math.ceil(SECTIONS.length / 2)
  const put = (section: Section) => {
    bar.appendChild(
      h(
        'a',
        { href: section.href, class: here === section ? 'on' : '', attrs: here === section ? { 'aria-current': 'page' } : {} },
        icon(section.iconName),
        h('span', { text: section.label }),
      ),
    )
  }
  for (const section of SECTIONS.slice(0, half)) put(section)
  const plus = h('button.tabplus', { type: 'button', title: '记一笔' }, icon('plus'))
  plus.addEventListener('click', () => openCapture())
  bar.appendChild(plus)
  for (const section of SECTIONS.slice(half)) put(section)
  bar.hidden = false
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

/** ⌘K 和 `/`：到「找」页，并把光标放进那个输入框。 */
function focusSearch(): void {
  if (route().page !== 'search') location.hash = '#/search'
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
      return
    }
    // 详情页按 R 直接重温。输入框里不接管。
    if ((e.key === 'r' || e.key === 'R') && !typing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const here = route()
      if (here.page === 'call' && here.arg) {
        e.preventDefault()
        location.hash = `#/relive/${here.arg.split('/')[0]}`
      }
    }
  })
}

register('home', homePage)
register('find', findPage)
register('new', capturePage)
register('call', callPage)
register('relive', relivePage)
register('search', searchPage)
register('review', reviewPage)
register('stats', statsPage)
register('archive', archivePage)
register('cycle', cyclePage)
register('settings', settingsPage)

/** Lightweight Latin fonts load after the first frame; Chinese uses system fonts. */
function webFonts(): void {
  const add = (href: string) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    document.head.appendChild(link)
  }
  add('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=DM+Mono:wght@400;500&display=swap')
  // 中文的衬线和黑体只在宽屏上取：手机用系统字体，省流量也省电。
  if (window.innerWidth > 860) add('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@500;600&family=Noto+Sans+SC:wght@400;500;700&display=swap')
}

/** 天空最底下那一层的星点：静静地闪。减弱动效或关掉动效时只画一次不动。 */
function stars(): void {
  const canvas = document.getElementById('stars') as HTMLCanvasElement | null
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  type Star = { x: number; y: number; r: number; p: number; s: number }
  let list: Star[] = []
  let w = 0
  let h = 0
  const size = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const n = Math.min(160, Math.floor((w * h) / 9000))
    list = Array.from({ length: n }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.4 + Math.random() * 1.1,
      p: Math.random() * Math.PI * 2,
      s: 0.4 + Math.random() * 0.8,
    }))
  }
  const still = () => prefersReducedMotion() || window.innerWidth <= 640
  const paint = (t: number) => {
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#EF8D2B'
    for (const star of list) {
      const a = still() ? 0.55 : 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(star.p + (t / 1000) * star.s))
      ctx.globalAlpha = a
      ctx.beginPath()
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
  let raf = 0
  const loop = (t: number) => {
    paint(t)
    if (!still() && !document.hidden) raf = requestAnimationFrame(loop)
    else raf = 0
  }
  const kick = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    if (still() || document.hidden) paint(0)
    else raf = requestAnimationFrame(loop)
  }
  size()
  kick()
  window.addEventListener('resize', () => {
    size()
    kick()
  }, { passive: true })
  document.addEventListener('visibilitychange', kick)
  window.addEventListener('scorebook:prefs', kick)
}

applyPrefs()
webFonts()
stars()
paintMasthead()
shortcuts()
if (!motionOff()) pressFeedback()
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
    problem('连不上本机服务')
  }
  start((current) => {
    paintNav(current)
    const page = document.querySelector<HTMLElement>('.page')
    if (page) {
      const intros: Record<string, [string, string]> = {
        find: ['交易记录', '每一条都锚在判断发生的那一刻。'],
        review: ['回看你的判断', '市场先给答案，你再给结论。'],
        stats: ['给直觉<em>记分</em>', '哪种感觉靠得住，数字自己会说。'],
        archive: ['反复出现的局面', '同一类局面，看自己的打法有没有进步。'],
        settings: ['偏好与数据', '连接、行情、导出，都在这里。'],
      }
      const intro = !current.arg && intros[current.page]
      if (intro && !page.querySelector('.pagehead')) {
        const head = h('header.pagehead.product-heading', {}, h('div.lead', {}, h('h1'), h('p.sub', { text: intro[1] })))
        const title = head.querySelector('h1')!
        const em = intro[0].match(/^(.*)<em>(.*)<\/em>(.*)$/)
        if (em) {
          title.append(em[1] ?? "", h("em", { text: em[2] ?? "" }), em[3] ?? "")
        } else title.textContent = intro[0]
        // 宽屏上标题跟着筛选一起住在左柱里；窄屏两栏是一列，位置和以前一样。
        const lead = page.querySelector(':scope > .spread > .lead')
        if (lead) lead.prepend(head)
        else page.prepend(head)
      }
      orderPage(page)
    }
  })
}

void boot()

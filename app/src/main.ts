// Application shell: masthead, routing table and the global shortcuts.

import { loadCapabilities } from './data/session'
import { register, route, start } from './router'
import { h, clear } from './ui/dom'
import { orderPage, pressFeedback } from './ui/motion'
import { icon } from './ui/icons'
import { problem } from './ui/toast'
import { homePage } from './features/home'
import { findPage } from './features/find'
import { openCapture } from './features/capture'
import { callPage } from './features/call'
import { searchPage } from './features/search'
import { reviewPage } from './features/review'
import { archivePage } from './features/archive'
import { playbookPage } from './features/playbook'
import { episodePage } from './features/episode'
import { settingsPage } from './features/settings'

interface Tab {
  id: string
  label: string
  iconName: string
  also?: string[]
}

const TABS: Tab[] = [
  { id: 'home', label: '首页', iconName: 'home' },
  { id: 'find', label: '我的记录', iconName: 'search', also: ['call', 'episode'] },
  { id: 'search', label: '按图搜索', iconName: 'img' },
  { id: 'review', label: '复盘', iconName: 'review' },
  { id: 'archive', label: '局面类别', iconName: 'archive' },
  { id: 'playbook', label: '我的做法', iconName: 'play' },
]

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
  clear(nav)
  for (const tab of TABS) {
    const active = current === tab.id || (tab.also?.includes(current) ?? false)
    nav.appendChild(
      h(
        'a',
        { href: `#/${tab.id}`, class: active ? 'active' : '' },
        icon(tab.iconName),
        h('span.t', { text: tab.label }),
      ),
    )
  }
  document.getElementById('navSettings')?.classList.toggle('active', current === 'settings')
  navIndicator()
}

/** The brass bar that slides under the active tab. */
function navIndicator(): void {
  const bar = document.getElementById('nav')
  if (!bar) return
  const active = bar.querySelector<HTMLElement>('a.active')
  if (!active) {
    bar.style.setProperty('--io', '0')
    return
  }
  bar.style.setProperty('--ix', `${active.offsetLeft}px`)
  bar.style.setProperty('--iw', `${active.offsetWidth}px`)
  bar.style.setProperty('--ih', `${active.offsetHeight}px`)
  bar.style.setProperty('--iy', `${active.offsetTop}px`)
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
register('call', callPage)
register('search', searchPage)
register('review', reviewPage)
register('archive', archivePage)
register('playbook', playbookPage)
register('episode', episodePage)
register('settings', settingsPage)

paintMasthead()
shortcuts()
pressFeedback()
window.addEventListener('resize', navIndicator)
void document.fonts?.ready.then(navIndicator)

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

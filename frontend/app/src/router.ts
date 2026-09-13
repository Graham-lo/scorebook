// Hash routing. One page is mounted at a time into a fresh `.page` container,
// so a page never has to clean up after its predecessor's DOM.
//
// Every navigation releases the object URLs held for attachment images: the
// bytes behind protected images stay in memory only as long as the view that
// asked for them.
//
// 地址里带得下参数：`#/find?by=fills&tab=positions`。子页和筛选是地址的一部分，
// 刷新、后退、贴给自己看都得回到同一屏。问号后面的那一段按 URLSearchParams 解，
// 和普通网页一个写法。

import { releaseAll } from './ui/media'

export interface Route {
  page: string
  arg: string
  query: URLSearchParams
}

/** A page mounts into `host` and may return a teardown function. */
export type Page = (host: HTMLElement, arg: string, query: URLSearchParams) => void | (() => void)

const pages = new Map<string, Page>()
let teardown: (() => void) | null = null
let onChange: ((route: Route) => void) | null = null

export function register(name: string, page: Page): void {
  pages.set(name, page)
}

/** 把一个 hash 拆成页、参数和查询串。不读 location，好测。 */
export function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const cut = raw.indexOf('?')
  const path = cut < 0 ? raw : raw.slice(0, cut)
  const search = cut < 0 ? '' : raw.slice(cut + 1)
  const [page = '', ...rest] = path.split('/')
  return { page: page || 'home', arg: rest.join('/'), query: new URLSearchParams(search) }
}

export function route(): Route {
  return parse(location.hash)
}

/**
 * 旧地址一律搬到新地址。
 *
 * 旧页面的代码都删了，可是链接还在收藏夹和聊天记录里。这张表就是那些地址的
 * 去处：进来先查一次，查到就换地址，不再画旧页。
 */
const REDIRECTS: Record<string, (arg: string, query: URLSearchParams) => string | null> = {
  episode: () => '#/find?by=symbol',
  trades: () => '#/find?by=fills',
  // 一轮持仓的详情还在自己的地址上，只有列表那一层搬走了。
  cycle: (arg) => (arg ? null : '#/find?by=fills'),
  recall: (_arg, query) => withQuery('#/search', query, ['q']),
  // 准备 / 订阅 / 归档目录都搬进了设置页的「行情与识图」。
  history: () => '#/settings',
  chat: () => '#/search',
  playbook: (arg) => (arg ? `#/archive/${arg}` : '#/archive'),
}

function withQuery(base: string, query: URLSearchParams, keep: string[]): string {
  const next = new URLSearchParams()
  for (const key of keep) {
    const value = query.get(key)
    if (value) next.set(key, value)
  }
  const tail = next.toString()
  return tail ? `${base}?${tail}` : base
}

/** 这个 hash 该换到哪儿去；不用换就是 null。 */
export function redirectFor(hash: string): string | null {
  const { page, arg, query } = parse(hash)
  const rule = REDIRECTS[page]
  if (!rule) return null
  return rule(arg, query)
}

export function go(hash: string): void {
  const next = hash.startsWith('#') ? hash : `#/${hash.replace(/^\//, '')}`
  if (location.hash === next) render()
  else location.hash = next
}

function render(): void {
  const moved = redirectFor(location.hash)
  if (moved) {
    location.replace(moved)
    return
  }
  const current = route()
  const main = document.getElementById('main')
  if (!main) return

  try {
    teardown?.()
  } catch {
    /* a page failing to tear down must not block the next one */
  }
  teardown = null
  releaseAll()

  const host = document.createElement('div')
  host.className = 'page'
  host.dataset.page = current.page
  main.replaceChildren(host)
  main.tabIndex = -1
  main.focus({ preventScroll: true })

  const page = pages.get(current.page) ?? pages.get('home')
  teardown = (page ? page(host, current.arg, current.query) : null) ?? null

  onChange?.(current)
  window.scrollTo(0, 0)
}

export function start(handler: (route: Route) => void): void {
  onChange = handler
  window.addEventListener('hashchange', render)
  if (!location.hash) location.replace('#/')
  render()
}

/** Re-runs the current page from scratch, e.g. after a write lands. */
export function reload(): void {
  render()
}

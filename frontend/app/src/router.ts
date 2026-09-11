// Hash routing. One page is mounted at a time into a fresh `.page` container,
// so a page never has to clean up after its predecessor's DOM.
//
// Every navigation releases the object URLs held for attachment images: the
// bytes behind protected images stay in memory only as long as the view that
// asked for them.

import { releaseAll } from './ui/media'

export interface Route {
  page: string
  arg: string
}

/** A page mounts into `host` and may return a teardown function. */
export type Page = (host: HTMLElement, arg: string) => void | (() => void)

const pages = new Map<string, Page>()
let teardown: (() => void) | null = null
let onChange: ((route: Route) => void) | null = null

export function register(name: string, page: Page): void {
  pages.set(name, page)
}

export function route(): Route {
  const raw = location.hash.replace(/^#\/?/, '')
  const [page = '', ...rest] = raw.split('/')
  return { page: page || 'home', arg: rest.join('/') }
}

export function go(hash: string): void {
  const next = hash.startsWith('#') ? hash : `#/${hash.replace(/^\//, '')}`
  if (location.hash === next) render()
  else location.hash = next
}

function render(): void {
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
  main.replaceChildren(host)

  const page = pages.get(current.page) ?? pages.get('home')
  teardown = (page ? page(host, current.arg) : null) ?? null

  onChange?.(current)
  window.scrollTo(0, 0)
}

export function start(handler: (route: Route) => void): void {
  onChange = handler
  window.addEventListener('hashchange', render)
  if (!location.hash) location.replace('#/home')
  render()
}

/** Re-runs the current page from scratch, e.g. after a write lands. */
export function reload(): void {
  render()
}

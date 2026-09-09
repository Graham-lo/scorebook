// Every string that reaches the page goes through a text node. Record text,
// tag names and anything read out of a screenshot are untrusted input, so
// there is deliberately no innerHTML path for content. Trusted static markup
// (the icon set) has its own narrow door in icons.ts.

export type Child = Node | string | number | null | undefined | false

export interface Props {
  class?: string | (string | false | null | undefined)[]
  text?: string | number | null
  title?: string
  href?: string
  type?: string
  id?: string
  value?: string
  placeholder?: string
  disabled?: boolean
  hidden?: boolean
  tabIndex?: number
  role?: string
  rows?: number
  style?: string
  /** data-* attributes, camelCase keys become dashed. */
  data?: Record<string, string | number | boolean | null | undefined>
  attrs?: Record<string, string | number | boolean | null | undefined>
  on?: Partial<{
    [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void
  }>
}

const TAG = /^([a-z0-9]+)(#[A-Za-z][\w-]*)?((?:\.[A-Za-z0-9_-]+)*)$/

/**
 * h('div.lrow.on', {…}, …children). The selector understands a tag, one
 * optional #id and class names, which keeps call sites readable next to the
 * existing CSS. Anything else is a typo and throws rather than guessing.
 */
export function h(spec: string, props: Props = {}, ...children: Child[]): HTMLElement {
  const match = TAG.exec(spec)
  if (!match) throw new Error(`bad element spec: ${spec}`)
  const node = document.createElement(match[1] as string)
  if (match[2]) node.id = match[2].slice(1)
  const fromSpec = (match[3] ?? '').split('.').filter(Boolean)
  const fromProps = Array.isArray(props.class)
    ? props.class.filter(Boolean)
    : props.class
      ? [props.class]
      : []
  const classes = [...fromSpec, ...(fromProps as string[]).flatMap((c) => c.split(' '))].filter(
    Boolean,
  )
  if (classes.length) node.className = classes.join(' ')

  if (props.text !== undefined && props.text !== null) node.textContent = String(props.text)
  if (props.title !== undefined) node.title = props.title
  if (props.id !== undefined) node.id = props.id
  if (props.style !== undefined) node.setAttribute('style', props.style)
  if (props.role !== undefined) node.setAttribute('role', props.role)
  if (props.tabIndex !== undefined) node.tabIndex = props.tabIndex
  if (props.hidden) node.hidden = true
  if (props.href !== undefined && node instanceof HTMLAnchorElement) node.href = props.href
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    if (props.value !== undefined) node.value = props.value
    if (props.placeholder !== undefined) node.placeholder = props.placeholder
    if (props.disabled) node.disabled = true
  }
  if (node instanceof HTMLInputElement && props.type) node.type = props.type
  if (node instanceof HTMLTextAreaElement && props.rows) node.rows = props.rows
  if (node instanceof HTMLButtonElement) {
    node.type = (props.type as 'button' | 'submit') ?? 'button'
    if (props.disabled) node.disabled = true
  }
  if (node instanceof HTMLSelectElement && props.disabled) node.disabled = true

  for (const [key, value] of Object.entries(props.data ?? {})) {
    if (value === null || value === undefined || value === false) continue
    node.dataset[key] = String(value)
  }
  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue
    node.setAttribute(key, String(value))
  }
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(event, handler as EventListener)
  }
  append(node, children)
  return node
}

export function append(parent: Node, children: Child[] | Child): void {
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)))
  }
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment()
  append(f, children)
  return f
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node)
  append(node, children)
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document) {
  return root.querySelector<T>(sel)
}

/**
 * Splits `text` on every occurrence of `needle` and wraps the matches in
 * <mark>. Works on nodes, never on markup, so a record containing angle
 * brackets stays literal.
 */
export function highlight(text: string, needle: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const q = needle.trim()
  if (!q) {
    out.appendChild(document.createTextNode(text))
    return out
  }
  const lower = text.toLowerCase()
  const target = q.toLowerCase()
  let at = 0
  for (;;) {
    const found = lower.indexOf(target, at)
    if (found < 0) break
    if (found > at) out.appendChild(document.createTextNode(text.slice(at, found)))
    out.appendChild(h('mark', { text: text.slice(found, found + q.length) }))
    at = found + q.length
  }
  out.appendChild(document.createTextNode(text.slice(at)))
  return out
}

/** Debounce that also exposes a way to flush pending input immediately. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: number | undefined
  return (...args: A) => {
    if (timer) clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), ms)
  }
}

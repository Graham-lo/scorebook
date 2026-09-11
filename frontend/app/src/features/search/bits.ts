import { h } from '../../ui/dom'

/** 一行「名字 —— 值」。检索页上所有的口径都用这一种写法列出来。 */
export function kvRow(label: string, value: string): HTMLElement {
  return h('div.kvrow', {}, h('span.faint', { text: label }), h('span', { text: value }))
}

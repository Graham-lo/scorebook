import { h } from './dom'
import { icon } from './icons'

let timer: number | undefined

/** A single transient confirmation; a second one replaces the first. */
export function toast(message: string, link?: { href: string; text: string }): void {
  document.querySelector('.toast')?.remove()
  const node = h(
    'div.toast',
    { role: 'status' },
    h('span.ok', {}, icon('check')),
    h('span', { text: message }),
    link ? h('a', { href: link.href, text: link.text }) : null,
  )
  document.body.appendChild(node)
  if (timer) clearTimeout(timer)
  timer = window.setTimeout(() => node.remove(), 3600)
}

/** Failures stay until dismissed and carry the retry the caller offers. */
export function problem(message: string, retry?: () => void): void {
  document.querySelector('.toast')?.remove()
  const node = h(
    'div.toast.bad',
    { role: 'alert' },
    h('span', { text: message }),
    retry
      ? h('a', {
          href: '#',
          text: '重试',
          on: {
            click: (e) => {
              e.preventDefault()
              node.remove()
              retry()
            },
          },
        })
      : null,
    h('a', {
      href: '#',
      text: '知道了',
      on: {
        click: (e) => {
          e.preventDefault()
          node.remove()
        },
      },
    }),
  )
  document.body.appendChild(node)
  if (timer) clearTimeout(timer)
}

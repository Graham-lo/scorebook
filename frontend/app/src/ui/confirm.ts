// 一句「真要这么做吗」。系统自带的 window.confirm 长得和这一页毫无关系，还会
// 把整个页面卡住，所以这里自己画一个：Esc 就是取消，关掉之后焦点回到刚才那个
// 按钮，背景点一下也是取消。
//
// 返回的 Promise 只 resolve，不 reject——调用处永远只需要判断真假。

import { h } from './dom'

export interface AskOptions {
  title: string
  detail?: string
  /** 确认那一颗按钮上的字，写清楚它到底会做什么。 */
  confirm: string
  cancel?: string
  /** 会丢东西的操作用 true，按钮画成警示色。 */
  danger?: boolean
}

export function ask(options: AskOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const previous = document.activeElement as HTMLElement | null
    let done = false

    const finish = (answer: boolean) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      box.remove()
      previous?.focus()
      resolve(answer)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(false)
        return
      }
      if (e.key !== 'Tab') return
      // 焦点只在这两颗按钮之间转，不会跑到后面那一页上去。
      e.preventDefault()
      const here = document.activeElement
      ;(here === yes ? no : yes).focus()
    }

    const yes = h('button', {
      class: ['btn', 'sm', options.danger ? 'danger' : 'primary'],
      text: options.confirm,
      on: { click: () => finish(true) },
    }) as HTMLButtonElement
    const no = h('button.btn.sm.ghost', {
      text: options.cancel ?? '算了',
      on: { click: () => finish(false) },
    }) as HTMLButtonElement

    const card = h(
      'div.askcard',
      { role: 'alertdialog' },
      h('div.askt', { text: options.title }),
      options.detail ? h('div.askd', { text: options.detail }) : null,
      h('div.aska', {}, no, yes),
    )
    const box = h('div.askbox', {}, card)
    box.addEventListener('click', (e) => {
      if (e.target === box) finish(false)
    })

    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(box)
    yes.focus()
  })
}

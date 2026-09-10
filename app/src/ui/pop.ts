// The filter chip with a menu under it, exactly as the prototype draws it:
// `.popwrap > .chip + .pop`. A chip that carries a value shows a clear cross;
// an empty one shows a chevron.
//
// Menus that search (the contract catalogue) ask the server on every keystroke
// rather than filtering a list the browser happens to hold.

import { append, clear, debounce, h } from './dom'
import { icon } from './icons'
import { ApiError } from '../api/errors'

export interface PopItem {
  label: string
  value: string
  hint?: string | null
  count?: number | null
  on?: boolean
  header?: string
  sep?: boolean
}

export interface PopConfig {
  label: () => string
  active: () => boolean
  items: (query: string) => Promise<PopItem[]> | PopItem[]
  onPick: (value: string, item: PopItem) => void
  onClear?: () => void
  /** When set, the menu carries a search field with this placeholder. */
  search?: string
  align?: 'right' | ''
  /** Sits under the list, e.g. a note about what the filter actually covers. */
  footer?: () => string | null
}

export interface Pop {
  node: HTMLElement
  close(): void
  refresh(): void
}

const open = new Set<() => void>()

function closeAll(): void {
  for (const close of [...open]) close()
}

document.addEventListener('click', () => closeAll())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAll()
})

/** True while any menu is on screen, so Escape can be spent on it first. */
export function anyPopOpen(): boolean {
  return open.size > 0
}

export function popChip(config: PopConfig): Pop {
  const wrap = h('span.popwrap')
  const chip = h('span.chip', { role: 'button', tabIndex: 0 })
  let menu: HTMLElement | null = null
  let request = 0

  const position = () => {
    if (!menu) return
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const right = left + (viewport?.width ?? window.innerWidth)
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
    menu.style.marginLeft = '0px'
    menu.style.minWidth = `${Math.min(218, right - left - 24)}px`
    menu.style.maxWidth = `${right - left - 24}px`
    const bounds = menu.getBoundingClientRect()
    const shift = Math.max(left + 12 - bounds.left, Math.min(0, right - 12 - bounds.right))
    menu.style.marginLeft = `${shift}px`
    const list = menu.querySelector<HTMLElement>('.pop-list')
    if (list) {
      const top = list.getBoundingClientRect().top
      list.style.maxHeight = `${Math.max(64, Math.min(300, bottom - top - 18))}px`
    }
  }

  const close = () => {
    window.removeEventListener('resize', position)
    window.visualViewport?.removeEventListener('resize', position)
    window.visualViewport?.removeEventListener('scroll', position)
    request += 1
    menu?.remove()
    menu = null
    open.delete(close)
    chip.classList.remove('open')
  }

  const paint = () => {
    clear(chip)
    chip.classList.toggle('on', config.active())
    chip.appendChild(document.createTextNode(config.label()))
    if (config.active() && config.onClear) {
      const x = h('span.x', { title: '清除' }, icon('close'))
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        close()
        config.onClear?.()
      })
      chip.appendChild(x)
    } else {
      chip.appendChild(h('span.chev', {}, icon('chev')))
    }
  }

  const fill = async (list: HTMLElement, query: string) => {
    const mine = ++request
    let items: PopItem[]
    try {
      items = await config.items(query)
    } catch (error) {
      if (mine !== request || !menu) return
      list.replaceChildren(h('div.ph', { text: error instanceof ApiError ? error.message : '暂时没能读到选项，请重试。' }),
        h('button', { text: '重试', on: { click: (e: Event) => { e.stopPropagation(); void fill(list, query) } } }))
      return
    }
    if (mine !== request || !menu) return
    clear(list)
    if (!items.length) {
      list.appendChild(h('div.ph', { text: '没有匹配的选项' }))
    }
    for (const item of items) {
      if (item.sep) {
        list.appendChild(h('div.sep'))
        continue
      }
      if (item.header) {
        list.appendChild(h('div.ph', { text: item.header }))
        continue
      }
      const row = h(
        'button',
        {
          class: item.on ? 'on' : '',
          on: {
            click: (e: Event) => {
              e.stopPropagation()
              close()
              config.onPick(item.value, item)
            },
          },
        },
        h('span.chk', {}, icon('check')),
        item.label,
        item.hint ? h('span.faint', { style: 'margin-left:8px', text: item.hint }) : null,
        item.count !== null && item.count !== undefined
          ? h('span.faint', { style: 'margin-left:auto', text: String(item.count) })
          : null,
      )
      list.appendChild(row)
    }
    const foot = config.footer?.()
    if (foot) append(list, [h('div.sep'), h('div.ph', { text: foot })])
    position()
  }

  const show = () => {
    closeAll()
    menu = h('div', { class: ['pop', config.align ?? ''], on: { click: e => e.stopPropagation() } })
    const list = h('div.pop-list')
    if (config.search) {
      const later = debounce(() => void fill(list, input.value), 220)
      // 中文输入法组字的过程中，每敲一个字母都会来一次 input，框里是拼音而不是
      // 想搜的词。这时候不发请求，等组完字（compositionend）再算一次。
      let composing = false
      const typed = () => {
        request += 1
        list.replaceChildren(h('div.ph', { text: '查找中…' }))
        later()
      }
      const input = h('input.input.pop-search', {
        placeholder: config.search,
        on: {
          click: (e: Event) => e.stopPropagation(),
          compositionstart: () => {
            composing = true
          },
          compositionend: () => {
            composing = false
            typed()
          },
          input: (e: Event) => {
            if (composing || (e as InputEvent).isComposing) return
            typed()
          },
        },
      }) as HTMLInputElement
      menu.appendChild(input)
      window.setTimeout(() => { if (menu?.contains(input)) { input.focus(); position() } }, 0)
    }
    menu.appendChild(list)
    list.appendChild(h('div.ph', { text: '读取中…' }))
    void fill(list, '')
    wrap.appendChild(menu)
    position()
    window.addEventListener('resize', position)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    open.add(close)
    chip.classList.add('open')
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu) close()
    else show()
  })
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (menu) close()
      else show()
    }
  })

  paint()
  wrap.appendChild(chip)
  return { node: wrap, close, refresh: paint }
}

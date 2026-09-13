// The filter chip with a menu under it, exactly as the prototype draws it:
// `.popwrap > .chip + .pop`. A chip that carries a value shows a clear cross;
// an empty one shows a chevron.
//
// Menus that search (the contract catalogue) ask the server on every keystroke
// rather than filtering a list the browser happens to hold.

import { append, clear, debounce, h } from './dom'
import { icon } from './icons'
import { ApiError } from '../api/errors'
import { markPopHosts, unmarkPopHosts, type HostLike, type PopHostMark, type StyleLike } from './stacking'

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

/** 弹层（sheet）在捕获阶段截走 Escape，菜单自己收不到；由弹层调这个把菜单收掉。 */
export function closePops(): void {
  closeAll()
}

export function popChip(config: PopConfig): Pop {
  const wrap = h('span.popwrap')
  const chip = h('span.chip', { role: 'button', tabIndex: 0 })
  let menu: HTMLElement | null = null
  let request = 0
  let hosts: PopHostMark[] = []

  // 菜单开着的这一会儿，把沿途开了层叠上下文的祖先抬到 `.pop` 够得着的层（见
  // ui/stacking.ts）。只在开的时候算一次，关的时候按名单摘掉。
  const lift = () => {
    hosts = markPopHosts(wrap as unknown as HostLike, document.body as unknown as HostLike,
      (node) => getComputedStyle(node as unknown as Element) as unknown as StyleLike)
  }
  const drop = () => {
    unmarkPopHosts(hosts)
    hosts = []
  }

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
      // 菜单默认往下开；全屏底部工具条里用 CSS 让它往上开（菜单底边在触发块之上），
      // 那时可用高度要从菜单底边往上量，否则会按往下开的剩余空间把列表压扁。
      const cap = parseFloat(getComputedStyle(menu).getPropertyValue('--pop-max')) || 300
      const top = viewport?.offsetTop ?? 0
      const rect = list.getBoundingClientRect()
      const upward = bounds.bottom <= wrap.getBoundingClientRect().top + 1
      const room = upward ? rect.bottom - top - 18 : bottom - rect.top - 18
      list.style.maxHeight = `${Math.max(64, Math.min(cap, room))}px`
    }
  }

  const close = () => {
    window.removeEventListener('resize', position)
    window.visualViewport?.removeEventListener('resize', position)
    window.visualViewport?.removeEventListener('scroll', position)
    request += 1
    menu?.remove()
    menu = null
    drop()
    open.delete(close)
    chip.classList.remove('open')
    chip.setAttribute('aria-expanded', 'false')
  }

  const paint = () => {
    clear(chip)
    chip.classList.toggle('on', config.active())
    chip.appendChild(document.createTextNode(config.label()))
    if (config.active() && config.onClear) {
      const x = h('button.x', { type: 'button', title: '清除', attrs: { 'aria-label': `清除${config.label()}` } }, icon('close'))
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
        item.hint ? h('span.faint.hint', { text: item.hint }) : null,
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
    lift()
    position()
    window.addEventListener('resize', position)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    open.add(close)
    chip.classList.add('open')
    chip.setAttribute('aria-expanded', 'true')
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menu) close()
    else show()
  })
  chip.addEventListener('keydown', (e) => {
    if (e.target === chip && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      if (menu) close()
      else show()
    }
  })

  chip.setAttribute('aria-haspopup', 'true')
  chip.setAttribute('aria-expanded', 'false')
  paint()
  wrap.appendChild(chip)
  return { node: wrap, close, refresh: paint }
}

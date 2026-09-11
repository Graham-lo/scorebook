// 账本维护那几张表单共用的零件。表单本身没有聪明的地方——它们只负责把交易员填的
// 东西一字不差地送出去，不替他补、不替他猜。

import { h } from '../../ui/dom'
import type { Child } from '../../ui/dom'

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'div.field',
    {},
    h('label.dlabel', { text: label }),
    control,
    hint ? h('div.tip', { style: 'margin-top:4px', text: hint }) : null,
  )
}

export function input(
  placeholder: string,
  options: { value?: string; type?: string; width?: string } = {},
): HTMLInputElement {
  return h('input.input', {
    placeholder,
    value: options.value ?? '',
    type: options.type ?? 'text',
    style: options.width ? `width:${options.width}` : '',
  }) as HTMLInputElement
}

export function textarea(placeholder: string, rows = 3): HTMLTextAreaElement {
  return h('textarea.textarea', { placeholder, rows }) as HTMLTextAreaElement
}

export function select(options: [string, string][], value?: string): HTMLSelectElement {
  const node = h('select.input') as HTMLSelectElement
  for (const [key, label] of options) {
    const option = document.createElement('option')
    option.value = key
    option.textContent = label
    node.appendChild(option)
  }
  if (value) node.value = value
  return node
}

export function checkbox(label: string, checked = false): { row: HTMLElement; box: HTMLInputElement } {
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement
  box.checked = checked
  const row = h(
    'label.row',
    { style: 'gap:8px;align-items:center;cursor:pointer' },
    box,
    h('span', { text: label }),
  )
  return { row, box }
}

/** 一节：标题、一句为什么，和内容。默认收着，点开才展开。 */
export function panel(title: string, why: string, body: HTMLElement, open = false): HTMLElement {
  const content = h('div', { hidden: !open, style: 'margin-top:14px' }, body)
  const toggle = h('button.btn.sm.ghost', {
    text: open ? '收起' : '展开',
    on: {
      click: () => {
        content.hidden = !content.hidden
        toggle.textContent = content.hidden ? '展开' : '收起'
      },
    },
  })
  return h(
    'div.sheet.pad',
    { style: 'margin-top:14px' },
    h(
      'div.row',
      { style: 'justify-content:space-between;align-items:flex-start;gap:16px' },
      h('div', {}, h('div.h3', { text: title }), h('div.tip', { style: 'margin-top:4px;max-width:60ch', text: why })),
      toggle,
    ),
    content,
  )
}

export function rows(...children: Child[]): HTMLElement {
  return h('div', { style: 'display:flex;flex-direction:column;gap:12px' }, ...children)
}

export function inline(...children: Child[]): HTMLElement {
  return h('div.row', { style: 'gap:10px;flex-wrap:wrap;align-items:flex-end' }, ...children)
}

/** datetime-local 的值换成 UTC 的 RFC3339；空就是空，不拿现在补。 */
export function instantOf(value: string): string | null {
  if (!value) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/** 逗号或空格分开的合约代码。全部大写，去掉空的。 */
export function symbolList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((v) => v.trim().toUpperCase())
    .filter(Boolean)
}

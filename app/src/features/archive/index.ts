// 我的标签 —— the vocabulary this trader keeps for themselves.
//
// A tag is a name plus a written definition; the definition is the point,
// because a tag with no definition drifts. The backend versions tags and has
// no delete or rename route, so this page can create and read them and hang
// links off records, and nothing else. Attaching a tag to a record happens on
// the record's own page, where the revision guard lives.

import { Latest, WriteAction } from '../../api/http'
import * as knowledge from '../../api/knowledge'
import type { TagRecord } from '../../api/types'
import { forgetTags } from '../../data/store'
import { dateOnly } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { empty, ledgerSkeleton, note } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

const lane = new Latest()
const createAction = new WriteAction()

let rows: TagRecord[] = []
let cursor: string | null = null
let loaded = false

export function archivePage(host: HTMLElement): () => void {
  let alive = true

  const head = h(
    'div.sheet.pad',
    {},
    h(
      'div.row',
      { style: 'justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap' },
      h(
        'div',
        {},
        h('h1.h1', { text: '局面类别' }),
        h('div.tip', {
          style: 'margin-top:6px;max-width:56ch',
          text: '同一类局面得有同一个名字，样本才数得准。给反复用到的说法写一句定义，以后按它找出来的才是真正的同一种东西，而不是你今天觉得像的东西。',
        }),
      ),
      h('button.btn.sm.primary', { text: '写一个标签', on: { click: () => toggleForm() } }),
    ),
  )
  const formSlot = h('div', { hidden: true, style: 'margin-top:14px' })
  head.appendChild(formSlot)

  const list = h('div', { style: 'margin-top:18px' })
  const more = h('div', { style: 'margin-top:14px' })
  host.append(head, list, more)

  if (loaded) paint()
  else {
    list.appendChild(ledgerSkeleton(4))
    void load(false)
  }

  async function load(append: boolean): Promise<void> {
    const signal = lane.begin()
    try {
      const page = await knowledge.tags(append ? cursor : null, { signal })
      if (!alive) return
      const seen = new Set(append ? rows.map((row) => row.id) : [])
      const next = append ? rows.slice() : []
      for (const row of page.items) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        next.push(row)
      }
      rows = next
      cursor = page.next_cursor
      loaded = true
      paint()
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(list)
      list.appendChild(
        empty({
          art: 'info',
          title: '标签没有读出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load(false) } }),
        }),
      )
    }
  }

  function paint(): void {
    clear(list)
    clear(more)
    if (!rows.length) {
      list.appendChild(
        empty({
          art: 'tag',
          title: '还没有写过标签',
          tip: '第一个标签可以是你最常说的那句话，比如「等回踩」或者「追高」。',
          action: h('button.btn.sm.primary', { text: '写一个标签', on: { click: () => toggleForm(true) } }),
        }),
      )
      return
    }

    const grid = h('div.tagwall')
    rows.forEach((row, index) => grid.appendChild(tagCard(row, index)))
    list.appendChild(grid)
    stagger(grid.children)

    if (cursor) {
      more.appendChild(
        h('button.btn.ghost', {
          text: '再读一批',
          on: {
            click: (e: Event) => {
              ;(e.currentTarget as HTMLButtonElement).disabled = true
              void load(true)
            },
          },
        }),
      )
    } else if (rows.length > 6) {
      more.appendChild(h('div.tip', { text: '到底了，一共 ' + rows.length + ' 个标签。' }))
    }
  }

  function tagCard(row: TagRecord, index: number): HTMLElement {
    return h(
      'div.tagcard',
      { style: `--i:${index}` },
      h(
        'div.row',
        { style: 'justify-content:space-between;gap:10px;align-items:baseline' },
        h('a.tagname', { href: `#/find/tag/${encodeURIComponent(row.name)}`, text: row.name }),
        h('span.faint', { text: `第 ${row.version} 版` }),
      ),
      // 定义是用户自己写的文字：按纯文本渲染。
      h('div.def', { text: row.definition || '（还没有写定义）' }),
      row.aliases.length
        ? h(
            'div.row',
            { style: 'gap:6px;flex-wrap:wrap;margin-top:8px' },
            ...row.aliases.map((alias) => h('span.tag.cold', { text: alias })),
          )
        : null,
      h(
        'div.line',
        { style: 'margin-top:10px' },
        h('span.faint', { text: dateOnly(row.created_at) }),
        h('a.link', { href: `#/find/tag/${encodeURIComponent(row.name)}`, text: '看用过它的记录' }),
      ),
    )
  }

  function toggleForm(force = false): void {
    if (!force && !formSlot.hidden) {
      formSlot.hidden = true
      clear(formSlot)
      return
    }
    formSlot.hidden = false
    clear(formSlot)
    formSlot.appendChild(createForm())
  }

  function createForm(): HTMLElement {
    const name = h('input.input', {
      placeholder: '标签名，比如「等回踩」',
      attrs: { maxlength: '40' },
    }) as HTMLInputElement
    const definition = h('textarea.textarea', {
      rows: 3,
      placeholder: '一句话说清楚：什么情况算这个标签，什么情况不算。',
    }) as HTMLTextAreaElement
    const aliases = h('input.input', {
      placeholder: '别名，用逗号分开（可以不写）',
    }) as HTMLInputElement

    const save = h('button.btn.sm.primary', { text: '存下来' }) as HTMLButtonElement
    const box = h(
      'div.sheet.pad.stack',
      { style: 'gap:12px' },
      h('div.eyebrow.noline', { text: '新的标签' }),
      name,
      definition,
      aliases,
      h(
        'div.acts',
        {},
        save,
        h('button.btn.sm.ghost', { text: '算了', on: { click: () => toggleForm() } }),
      ),
      note('info', '标签存下来之后可以在记录页面挂到具体的判断上。这里不提供改名和删除，后端也没有这两个动作。'),
    )

    save.addEventListener('click', () => {
      const input = {
        name: name.value.trim(),
        definition: definition.value.trim(),
        aliases: aliases.value
          .split(/[,，]/)
          .map((part) => part.trim())
          .filter(Boolean),
      }
      if (!input.name) {
        problem('先给标签起个名字。')
        name.focus()
        return
      }
      if (!input.definition) {
        problem('写一句定义，不然过几个月你自己也认不出这个标签。')
        definition.focus()
        return
      }
      save.disabled = true
      void knowledge
        .createTag(input, createAction.keyFor(input))
        .then(() => {
          createAction.reset()
          if (!alive) return
          forgetTags()
          loaded = false
          rows = []
          cursor = null
          toggleForm()
          list.replaceChildren(ledgerSkeleton(3))
          toast(`标签「${input.name}」已经存下来。`)
          void load(false)
        })
        .catch((error) => {
          save.disabled = false
          problem(error instanceof Error ? error.message : '这个标签没有存下来。')
        })
    })
    return box
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

/** Kept so other modules can force a re-read after they create a tag. */
export function invalidateArchive(): void {
  loaded = false
  rows = []
  cursor = null
}

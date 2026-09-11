// 我的做法 —— written changes to how this trader plays, and what each cost.
//
// The backend stores every playbook with status `candidate` and has no route
// that adopts, retires or withdraws one, so this page never offers those
// buttons and never dresses a candidate up as a rule in force. What it does
// offer is the honest thing the backend supports: writing a change down with
// the records that prompted it, and reading the chain of what came before.

import * as calls from '../../api/calls'
import { Latest, WriteAction } from '../../api/http'
import * as knowledge from '../../api/knowledge'
import type { CallListItem, PlaybookRecord, Uuid } from '../../api/types'
import { dateOnly } from '../../data/time'
import { clear, debounce, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { empty, ledgerSkeleton, note } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

const lane = new Latest()
const searchLane = new Latest()
const createAction = new WriteAction()

let rows: PlaybookRecord[] = []
let cursor: string | null = null
let loaded = false

export function playbookPage(host: HTMLElement): () => void {
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
        h('h1.h1', { text: '我的做法' }),
        h('div.tip', {
          style: 'margin-top:6px;max-width:58ch',
          text: '每一次「下次我改成这样打」都留成一版，连着让你想改的那几条记录。同一类局面的做法排在一起，你在这类局面上有没有进步，是看得出来的。',
        }),
      ),
      h('button.btn.sm.primary', { text: '写一版新的', on: { click: () => toggleForm(true) } }),
    ),
  )
  const formSlot = h('div', { hidden: true, style: 'margin-top:14px' })
  head.appendChild(formSlot)

  const list = h('div', { style: 'margin-top:18px' })
  const more = h('div', { style: 'margin-top:14px' })
  host.append(head, list, more)

  if (loaded) paint()
  else {
    list.appendChild(ledgerSkeleton(3))
    void load(false)
  }

  async function load(append: boolean): Promise<void> {
    const signal = lane.begin()
    try {
      const page = await knowledge.playbooks(append ? cursor : null, { signal })
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
          title: '这一页没有读出来',
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
          title: '还没有写过做法',
          tip: '等你发现自己一再踩同一个坑的时候，把改法写在这里，比记在心里牢靠。',
          action: h('button.btn.sm.primary', { text: '写一版', on: { click: () => toggleForm(true) } }),
        }),
      )
      return
    }

    const byId = new Map(rows.map((row) => [row.id, row]))
    const stack = h('div.stack', { style: 'gap:16px' })
    rows.forEach((row, index) => stack.appendChild(playCard(row, index, byId)))
    list.appendChild(stack)
    stagger(stack.children)
    list.appendChild(
      note(
        'info',
        '这些都是写下来的做法，还没有一条被系统当成正在执行的规矩。系统不会替你判断哪一版正在执行，也没有「启用」这个动作——它记录你的想法，不替你做决定。',
      ),
    )

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
    }
  }

  function playCard(
    row: PlaybookRecord,
    index: number,
    byId: Map<Uuid, PlaybookRecord>,
  ): HTMLElement {
    const b = row.body
    const parent = row.parent_id ? byId.get(row.parent_id) : null
    const pair = (label: string, text: string) =>
      h(
        'div.pbrow',
        {},
        h('span.eyebrow.noline', { text: label }),
        // 全部是用户自己写的文字：按纯文本渲染。
        h('p', { text: text || '（没写）' }),
      )

    return h(
      'div.sheet.pad.pbcard',
      { style: `--i:${index}` },
      h(
        'div.row',
        { style: 'justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap' },
        h('h2.h2', { text: b.name }),
        h(
          'div.line',
          {},
          h('span.tag.cold', { text: '只是写下来' }),
          h('span.faint', { text: dateOnly(row.created_at) }),
        ),
      ),
      parent ? h('div.faint', { style: 'margin-top:4px', text: `改自「${parent.body.name}」` }) : null,
      h(
        'div.pbgrid',
        {},
        pair('什么时候用', b.applies_to),
        pair('什么时候不用', b.excludes),
        pair('原来怎么做', b.old_play),
        pair('改成怎么做', b.change),
        pair('想换来什么', b.expected_improvement),
        pair('代价是什么', b.cost),
      ),
      b.evidence_call_ids.length
        ? h(
            'div',
            { style: 'margin-top:12px' },
            h('span.eyebrow.noline', { text: '让你想改的记录' }),
            h(
              'div.row',
              { style: 'gap:8px;flex-wrap:wrap;margin-top:6px' },
              ...b.evidence_call_ids.map((id, n) =>
                h('a.btn.sm.ghost', { href: `#/call/${id}`, text: `第 ${n + 1} 条` }),
              ),
            ),
          )
        : null,
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
    const evidence: CallListItem[] = []
    let parentId: Uuid | null = null

    const field = (placeholder: string, rowCount = 2) =>
      h('textarea.textarea', { rows: rowCount, placeholder }) as HTMLTextAreaElement

    const name = h('input.input', {
      placeholder: '给这一版起个名字，比如「不追第三根大阳线」',
    }) as HTMLInputElement
    const appliesTo = field('什么情况下用这个做法？')
    const excludes = field('什么情况下明确不用？')
    const oldPlay = field('以前遇到这种情况，你是怎么做的？')
    const change = field('从现在起改成怎么做？')
    const improvement = field('你希望换来什么？')
    const cost = field('要付出什么代价？慢一点、少赚一段、还是多几次空手？')

    const chips = h('div.row', { style: 'gap:8px;flex-wrap:wrap' })
    const paintChips = () => {
      clear(chips)
      if (!evidence.length) {
        chips.appendChild(h('span.faint', { text: '还没有挑记录。至少挑一条，这一版才有来处。' }))
        return
      }
      for (const item of evidence) {
        chips.appendChild(
          h(
            'span.tag',
            {},
            h('span', { text: snippet(item.body.original_text) }),
            h('button.x', {
              text: '×',
              attrs: { 'aria-label': '去掉这条' },
              on: {
                click: () => {
                  const at = evidence.indexOf(item)
                  if (at >= 0) evidence.splice(at, 1)
                  paintChips()
                },
              },
            }),
          ),
        )
      }
    }
    paintChips()

    const finder = h('input.input', {
      type: 'search',
      placeholder: '搜自己的原话，挑出让你想改的那几条',
      attrs: { autocomplete: 'off' },
    }) as HTMLInputElement
    const hits = h('div.pop-list', { hidden: true })
    const runFind = debounce(() => {
      const q = finder.value.trim()
      if (!q) {
        hits.hidden = true
        return
      }
      const signal = searchLane.begin()
      void calls
        .list({ q, limit: 6 }, { signal })
        .then((page) => {
          if (!alive) return
          clear(hits)
          hits.hidden = false
          if (!page.items.length) {
            hits.appendChild(h('div.tip', { text: '没有找到这样的记录。' }))
            return
          }
          for (const item of page.items) {
            hits.appendChild(
              h('button.popitem', {
                text: `${dateOnly(item.submitted_at)} · ${snippet(item.body.original_text)}`,
                on: {
                  click: () => {
                    if (!evidence.some((e) => e.id === item.id)) evidence.push(item)
                    paintChips()
                    hits.hidden = true
                    finder.value = ''
                  },
                },
              }),
            )
          }
        })
        .catch((error) => {
          if (Latest.aborted(error)) return
          hits.hidden = true
        })
    }, 240)
    finder.addEventListener('input', runFind)

    const parentSelect = h('select.input') as HTMLSelectElement
    parentSelect.appendChild(
      h('option', { text: '不是在改哪一版（新写的）', attrs: { value: '' } }),
    )
    for (const row of rows) {
      parentSelect.appendChild(
        h('option', { text: `改自：${row.body.name}`, attrs: { value: row.id } }),
      )
    }
    parentSelect.addEventListener('change', () => {
      parentId = parentSelect.value ? (parentSelect.value as Uuid) : null
    })

    const save = h('button.btn.sm.primary', { text: '存成一版' }) as HTMLButtonElement
    save.addEventListener('click', () => {
      const input = {
        parent_id: parentId,
        name: name.value.trim(),
        applies_to: appliesTo.value.trim(),
        excludes: excludes.value.trim(),
        old_play: oldPlay.value.trim(),
        change: change.value.trim(),
        evidence_call_ids: evidence.map((item) => item.id),
        expected_improvement: improvement.value.trim(),
        cost: cost.value.trim(),
      }
      const missing = [
        !input.name && '名字',
        !input.applies_to && '什么时候用',
        !input.change && '改成怎么做',
        !input.cost && '代价',
      ].filter(Boolean) as string[]
      if (missing.length) {
        problem(`还差：${missing.join('、')}。`)
        return
      }
      save.disabled = true
      void knowledge
        .createPlaybook(input, createAction.keyFor(input))
        .then(() => {
          createAction.reset()
          if (!alive) return
          loaded = false
          rows = []
          cursor = null
          toggleForm()
          list.replaceChildren(ledgerSkeleton(2))
          toast('这一版做法已经存下来。')
          void load(false)
        })
        .catch((error) => {
          save.disabled = false
          problem(error instanceof Error ? error.message : '这一版没有存下来。')
        })
    })

    return h(
      'div.sheet.pad.stack',
      { style: 'gap:12px' },
      h('div.eyebrow.noline', { text: '新的一版做法' }),
      name,
      parentSelect,
      h('div.pbgrid', {}, wrap('什么时候用', appliesTo), wrap('什么时候不用', excludes)),
      h('div.pbgrid', {}, wrap('原来怎么做', oldPlay), wrap('改成怎么做', change)),
      h('div.pbgrid', {}, wrap('想换来什么', improvement), wrap('代价是什么', cost)),
      h(
        'div',
        {},
        h('span.eyebrow.noline', { text: '让你想改的记录' }),
        h('div', { style: 'margin-top:6px' }, finder, hits),
        h('div', { style: 'margin-top:8px' }, chips),
      ),
      h(
        'div.acts',
        {},
        save,
        h('button.btn.sm.ghost', { text: '算了', on: { click: () => toggleForm() } }),
      ),
      note(
        'info',
        '存下来的只是你写下的一版做法。系统只负责把它和你挑的那几条记录一起保存好，不会替你执行，也不会自动统计它有没有用。',
      ),
    )
  }

  function wrap(label: string, node: HTMLElement): HTMLElement {
    return h('label.pbrow', {}, h('span.eyebrow.noline', { text: label }), node)
  }

  return () => {
    alive = false
    lane.cancel()
    searchLane.cancel()
  }
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 28 ? `${flat.slice(0, 28)}…` : flat || '（只有图）'
}

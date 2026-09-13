// 局面 —— 同一类行情长什么样，遇到它该怎么打。
//
// 一类局面 = 一个名字 + 一句定义。定义是要紧的那一半：没有定义的名字会漂，几个
// 月后按它找出来的就不是同一种东西了。打法挂在局面下面，一版一版往下写，旧版原
// 样留着——「这次和上次比有没有进步」要靠它们对照。
//
// 后端没有改名和删除，标签只能新建；一条打法也只能新建，没有采纳和撤回。

import { Latest, WriteAction } from '../../api/http'
import * as knowledge from '../../api/knowledge'
import type { CallListItem, PlaybookRecord, TagRecord } from '../../api/types'
import { hitRate, forgetScorecard, scorecard, type Scored } from '../../data/scorecard'
import { detail, invalidate, forgetTags } from '../../data/store'
import { inTagGroup, latestTags } from '../../data/tag-groups'
import { go } from '../../router'
import { shortDate } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { recordHead, recordRow } from '../../ui/record-row'
import { empty, ledgerSkeleton } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

const lane = new Latest()
const tagAction = new WriteAction()
const playAction = new WriteAction()

interface Shelf {
  tags: TagRecord[]
  plays: PlaybookRecord[]
  scored: Scored[]
}

let shelf: Shelf | null = null

export function archivePage(host: HTMLElement, arg: string, query = new URLSearchParams()): () => void {
  let alive = true
  const callId = query.get('call')
  const linkAction = new WriteAction()
  let linking = false
  const wrap = h('div')
  host.append(wrap)
  wrap.appendChild(ledgerSkeleton(4))

  void load()

  async function choose(tagId: string): Promise<void> {
    if (!callId || linking) return
    linking = true
    try {
      const record = await detail(callId, { refresh: true })
      if (!alive) return
      if (record.tags.some(tag => tag.id === tagId)) { go(`#/call/${callId}`); return }
      const input = { call_id: callId, tag_id: tagId, expected_revision: record.revision }
      await knowledge.linkTag(input, linkAction.keyFor(input))
      linkAction.reset()
      invalidate(callId)
      invalidateArchive()
      toast('已归类')
      if (alive) go(`#/call/${callId}`)
    } catch (error) {
      if (alive) problem(error instanceof Error ? error.message : '没归类成功，请重试')
    } finally { linking = false }
  }

  async function load(refresh = false): Promise<void> {
    const signal = lane.begin()
    try {
      const loaded = refresh || !shelf ? await read(signal) : shelf
      if (!alive || signal.aborted) return
      shelf = loaded
      clear(wrap)
      if (arg) detailView(wrap, arg, shelf, () => void load(true))
      else listView(wrap, shelf, () => void load(true), callId ? choose : undefined, callId)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      wrap.replaceChildren(
        empty({
          title: '没读出来',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load(true) } }),
        }),
      )
    }
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

async function read(signal: AbortSignal): Promise<Shelf> {
  const [tags, plays, scored] = await Promise.all([
    pageAll((cursor) => knowledge.tags(cursor, { signal })),
    pageAll((cursor) => knowledge.playbooks(cursor, { signal })),
    scorecard({ signal }),
  ])
  return { tags, plays, scored }
}

async function pageAll<T>(
  fetch: (cursor: string | null) => Promise<{ items: T[]; next_cursor: string | null }>,
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  for (;;) {
    const result = await fetch(cursor)
    all.push(...result.items)
    if (!result.next_cursor) break
    if (seen.has(result.next_cursor)) throw new Error('清单没有读全，请重试')
    seen.add(result.next_cursor)
    cursor = result.next_cursor
  }
  return all
}

/** 挂在这一类局面下的打法，从早到晚就是第 1 版到第 n 版。 */
function playsOf(shelf: Shelf, tag: TagRecord): PlaybookRecord[] {
  return shelf.plays
    .filter((p) => p.body.name === tag.name || p.body.applies_to === tag.name)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

function recordsOf(shelf: Shelf, tag: TagRecord): Scored[] {
  return shelf.scored.filter((s) => inTagGroup(s.tags, tag))
}

/* ------------------------------------------------------------ 列表 */

function listView(host: HTMLElement, shelf: Shelf, reload: () => void, choose?: (id: string) => Promise<void>, callId?: string | null): void {
  if (choose) host.append(h('div.crumb', {}, h('a', { href: `#/call/${callId}`, text: '返回记录' })), h('h2.h2', { text: '选择一类局面' }))
  const formSlot = h('div.sheet.pad', { hidden: true, style: 'margin-top:14px' })
  const head = h(
    'div',
    {},
    h(
      'div.row.newact',
      {},
      h('button.btn.sm.gold', {
        type: 'button',
        text: '新建一类局面',
        on: { click: () => toggle() },
      }),
    ),
    formSlot,
  )
  const list = h('div', { style: 'margin-top:18px' })
  host.append(h('div.spread', {}, h('div.lead', {}, head), h('div.bulk', {}, list)))

  function toggle(force = false): void {
    if (!force && !formSlot.hidden) {
      formSlot.hidden = true
      clear(formSlot)
      return
    }
    formSlot.hidden = false
    clear(formSlot)
    formSlot.appendChild(newTagForm(() => toggle(), reload, shelf.tags, choose))
  }

  if (!shelf.tags.length) {
    list.appendChild(
      empty({
        title: '还没有局面',
        action: h('button.btn.sm.gold', {
          type: 'button',
          text: '新建一类局面',
          on: { click: () => toggle(true) },
        }),
      }),
    )
    return
  }

  const grid = h('div.tagwall')
  latestTags(shelf.tags).forEach((tag, index) => {
    const card = tagCard(shelf, tag, index)
    if (choose) {
      card.removeAttribute('href')
      const pick = h('button.btn.sm.primary', { type: 'button', text: '归入这一类' }) as HTMLButtonElement
      pick.addEventListener('click', () => { pick.disabled = true; void choose(tag.id).finally(() => { pick.disabled = false }) })
      card.appendChild(h('div.acts', {}, pick))
    }
    grid.appendChild(card)
  })
  list.appendChild(grid)
  stagger(grid.children)
}

function tagCard(shelf: Shelf, tag: TagRecord, index: number): HTMLElement {
  const mine = recordsOf(shelf, tag)
  const rate = hitRate(mine)
  const plays = playsOf(shelf, tag)
  return h(
    'a.tagcard',
    { href: `#/archive/${tag.id}`, style: `--i:${index}` },
    h('span.tagname', { text: tag.name }),
    h('div.def', { text: tag.definition || '还没写定义' }),
    h(
      'div.line',
      { style: 'margin-top:10px' },
      h('span.faint', {
        text: rate === null ? `${mine.length} 条` : `${mine.length} 条 · 判对率 ${rate}%`,
      }),
      plays.length ? h('span.tag', { text: `打法第 ${plays.length} 版` }) : null,
    ),
  )
}

function newTagForm(close: () => void, reload: () => void, tags: TagRecord[], choose?: (id: string) => Promise<void>): HTMLElement {
  const name = h('input.input', { placeholder: '名字', attrs: { maxlength: '40' } }) as HTMLInputElement
  const definition = h('textarea.textarea', {
    rows: 3,
    placeholder: '一句定义',
  }) as HTMLTextAreaElement
  const save = h('button.btn.sm.primary', { type: 'button', text: '存下来' }) as HTMLButtonElement

  save.addEventListener('click', () => {
    const input = { name: name.value.trim(), definition: definition.value.trim(), aliases: [] }
    if (!input.name) {
      problem('先起个名字')
      name.focus()
      return
    }
    const existing = latestTags(tags).find(tag => tag.name === input.name)
    if (existing) {
      if (choose) void choose(existing.id)
      else go(`#/archive/${existing.id}`)
      return
    }
    if (!input.definition) {
      problem('先写一句定义')
      definition.focus()
      return
    }
    save.disabled = true
    void knowledge
      .createTag(input, tagAction.keyFor(input))
      .then(async (created) => {
        tagAction.reset()
        forgetTags()
        invalidateArchive()
        if (choose) { await choose(created.id); return }
        close()
        toast('记下了')
        reload()
      })
      .catch((error: unknown) => {
        save.disabled = false
        problem(error instanceof Error ? error.message : '没保存上，再试一次')
      })
  })

  return h(
    'div.sheet.pad.stack',
    { style: 'gap:12px' },
    h('div.field', {}, h('label', { text: '名字' }), name),
    h('div.field', {}, h('label', { text: '一句定义' }), definition),
    h('div.acts', {}, save, h('button.btn.sm.ghost', { type: 'button', text: '算了', on: { click: close } })),
  )
}

/* ------------------------------------------------------------ 详情 */

function detailView(host: HTMLElement, arg: string, shelf: Shelf, reload: () => void): void {
  const tag = resolve(shelf, arg)
  if (!tag) {
    host.appendChild(empty({ title: '没有这一类局面' }))
    return
  }
  host.append(
    definitionSheet(tag, reload),
    playSheet(shelf, tag, reload),
    recordsSheet(shelf, tag),
  )
  stagger(Array.from(host.children))
}

/** 地址里可能是局面的编号，也可能是旧「做法」页留下的打法编号。 */
function resolve(shelf: Shelf, arg: string): TagRecord | null {
  const direct = shelf.tags.find((t) => t.id === arg)
  if (direct) return latestTags(shelf.tags).find(t => t.name === direct.name) ?? direct
  const play = shelf.plays.find((p) => p.id === arg)
  if (!play) return null
  return (
    latestTags(shelf.tags).find((t) => t.name === play.body.name || t.name === play.body.applies_to) ?? null
  )
}

function definitionSheet(tag: TagRecord, reload: () => void): HTMLElement {
  const body = h('div', { style: 'padding:2px 18px 18px' })
  const node = h(
    'div.sheet',
    {},
    h('div.sh', {}, h('span.eyebrow.noline', { text: '定义' })),
    body,
  )

  const paint = () => {
    clear(body)
    body.appendChild(h('h2.h2', { text: tag.name }))
    if (tag.definition) {
      body.append(h('div.sentence', { style: 'margin-top:8px', text: tag.definition }), h('button.btn.sm.ghost', { text: '修改定义', style: 'margin-top:12px', on: { click: write } }))
      return
    }
    body.appendChild(
      h(
        'div',
        { style: 'margin-top:8px' },
        empty({
          title: '还没写定义',
          action: h('button.btn.sm.primary', {
            type: 'button',
            text: '写一句',
            on: { click: () => write() },
          }),
        }),
      ),
    )
  }

  const write = () => {
    clear(body)
    body.appendChild(h('h2.h2', { text: tag.name }))
    const field = h('textarea.textarea', {
      rows: 3,
      placeholder: '一句定义',
    }) as HTMLTextAreaElement
    field.value = tag.definition
    const save = h('button.btn.sm.primary', { type: 'button', text: '存下来' }) as HTMLButtonElement
    save.addEventListener('click', () => {
      const input = { name: tag.name, definition: field.value.trim(), aliases: tag.aliases }
      if (!input.definition) {
        field.focus()
        return
      }
      save.disabled = true
      void knowledge
        .createTag(input, tagAction.keyFor(input))
        .then(() => {
          tagAction.reset()
          forgetTags()
          toast('记下了')
          reload()
        })
        .catch((error: unknown) => {
          save.disabled = false
          problem(error instanceof Error ? error.message : '没保存上，再试一次')
        })
    })
    body.append(
      h('div', { style: 'margin-top:10px' }, field),
      h('div.acts', { style: 'margin-top:10px' }, save, h('button.btn.sm.ghost', { type: 'button', text: '算了', on: { click: paint } })),
    )
    field.focus()
  }

  paint()
  return node
}

function playSheet(shelf: Shelf, tag: TagRecord, reload: () => void): HTMLElement {
  const body = h('div', { style: 'padding:2px 18px 18px' })
  const plays = playsOf(shelf, tag)
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '打法' })),
    body,
  )

  const paint = () => {
    clear(body)
    if (!plays.length) {
      body.appendChild(
        empty({
          title: '还没写打法',
          action: h('button.btn.sm.primary', {
            type: 'button',
            text: '写第 1 版',
            on: { click: () => write() },
          }),
        }),
      )
      return
    }
    const line = h('div.vtimeline')
    plays
      .slice()
      .reverse()
      .forEach((play, index) => line.appendChild(playCard(play, plays.length - index)))
    body.appendChild(line)
    body.appendChild(
      h(
        'div.acts',
        { style: 'margin-top:14px' },
        h('button.btn.sm.primary', {
          type: 'button',
          text: '写新一版打法',
          on: { click: () => write() },
        }),
      ),
    )
    stagger(line.children)
  }

  const write = () => {
    clear(body)
    body.appendChild(playForm(tag, plays.at(-1) ?? null, recordsOf(shelf, tag), paint, reload))
  }

  paint()
  return node
}

function playCard(play: PlaybookRecord, version: number): HTMLElement {
  const b = play.body
  const facts: [string, string][] = [
    ['适用', b.applies_to],
    ['不适用', b.excludes],
    ['原来怎么打', b.old_play],
    ['想换来什么', b.expected_improvement],
    ['代价', b.cost],
  ]
  const grid = h('div.body')
  for (const [key, value] of facts) {
    if (!value) continue
    grid.appendChild(h('div.wide', {}, h('span', { text: key }), value))
  }
  return h(
    'div.vcard',
    {},
    h(
      'div.vh',
      {},
      h('span.h3', { text: `第 ${version} 版` }),
      h('span.d', { text: shortDate(play.created_at) }),
    ),
    b.change ? h('div.sentence', { text: b.change }) : null,
    grid.children.length ? grid : null,
    b.evidence_call_ids.length ? h('div.row', { style: 'gap:12px;flex-wrap:wrap;margin-top:10px' }, ...b.evidence_call_ids.map((id, index) => h('a.linkbtn', { href: `#/call/${id}`, text: `依据 ${index + 1}` }))) : null,
  )
}

function playForm(
  tag: TagRecord,
  parent: PlaybookRecord | null,
  records: Scored[],
  close: () => void,
  reload: () => void,
): HTMLElement {
  const change = h('textarea.textarea', { rows: 4, placeholder: '这一版怎么打' }) as HTMLTextAreaElement
  const field = (label: string, placeholder: string) => {
    const input = h('input.input', { placeholder }) as HTMLInputElement
    return { input, node: h('div.field', { style: 'margin-top:10px' }, h('label', { text: label }), input) }
  }
  const applies = field('适用', tag.name)
  const excludes = field('不适用', '')
  const old = field('原来怎么打', '')
  const gain = field('想换来什么', '')
  const cost = field('代价', '')
  const selected = new Set<string>(parent?.body.evidence_call_ids ?? [])
  const evidence = h('fieldset.field', { style: 'margin-top:14px;border:0;padding:0' }, h('legend', { text: '依据哪些记录' }))
  if (!records.length) evidence.append(h('span.faint', { text: '先把记录归入这一类，再选择依据' }))
  for (const { item } of records) {
    const check = h('input', { type: 'checkbox', attrs: selected.has(item.id) ? { checked: '' } : {}, on: { change: () => {
      if ((check as HTMLInputElement).checked) selected.add(item.id); else selected.delete(item.id)
    } } })
    evidence.append(h('label.row', { style: 'gap:8px;margin-top:8px' }, check,
      h('span', { text: `${shortDate(item.submitted_at)} · ${item.body.instrument ?? '未写品种'} · ${item.body.original_text || '没有文字'}` })))
  }
  const save = h('button.btn.sm.primary', { type: 'button', text: '存下来' }) as HTMLButtonElement

  save.addEventListener('click', () => {
    if (!change.value.trim()) {
      change.focus()
      return
    }
    const input = {
      parent_id: parent?.id ?? null,
      name: tag.name,
      applies_to: applies.input.value.trim() || tag.name,
      excludes: excludes.input.value.trim(),
      old_play: old.input.value.trim(),
      change: change.value.trim(),
      evidence_call_ids: [...selected],
      expected_improvement: gain.input.value.trim(),
      cost: cost.input.value.trim(),
    }
    save.disabled = true
    void knowledge
      .createPlaybook(input, playAction.keyFor(input))
      .then(() => {
        playAction.reset()
        toast('记下了')
        reload()
      })
      .catch((error: unknown) => {
        save.disabled = false
        problem(error instanceof Error ? error.message : '没保存上，再试一次')
      })
  })

  return h(
    'div.stack',
    { style: 'gap:0' },
    h('div.field', {}, h('label', { text: '这一版怎么打' }), change),
    applies.node,
    excludes.node,
    old.node,
    gain.node,
    cost.node,
    evidence,
    h(
      'div.acts',
      { style: 'margin-top:12px' },
      save,
      h('button.btn.sm.ghost', { type: 'button', text: '算了', on: { click: close } }),
    ),
  )
}

function recordsSheet(shelf: Shelf, tag: TagRecord): HTMLElement {
  const body = h('div', { style: 'padding:2px 18px 18px' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '这类局面的记录' })),
    body,
  )
  const mine = recordsOf(shelf, tag)
    .map((s) => s.item)
    .sort((a: CallListItem, b: CallListItem) => b.submitted_at.localeCompare(a.submitted_at))
  if (!mine.length) {
    body.appendChild(empty({ title: '还没有记录' }))
    return node
  }
  const table = h('div.rtable', {}, recordHead())
  for (const item of mine) table.appendChild(recordRow(item, { density: 'full' }))
  body.appendChild(table)
  return node
}

/** 别处写过东西之后，让这一页下次重新读。 */
export function invalidateArchive(): void {
  shelf = null
  forgetScorecard()
}

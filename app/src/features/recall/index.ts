// 在记下来的所有东西里找 —— `/v1/knowledge/search`。
//
// 「我的记录」搜的是当时说出口的那句话，搜的是字面。这一页不一样：后端把每一类
// 记录都收成了可检索的文本——当时的判断、后来的复盘、系统给的结论、局面类别、
// 我的做法、一段行情、实盘小结、统计和裁决——然后把字面命中和意思相近的命中各排
// 一遍，再合成一个顺序（后端把这套办法叫 `lexical-dense-rrf-v1`）。
//
// 有三句话这一页必须一直说清楚：
//
//   一、这是「翻出来给你看」的顺序，不是相关度打分。后端自己写明
//       `retrieval_order_not_probability`，所以这里不显示分数、不画进度条、
//       也不排「最相关」。
//   二、看到的是片段，不是全文。要判断一句话什么意思，得展开原文读。
//   三、改过还没重新收进来的来源，这一次搜不到。这不是「没有这回事」，页面照实
//       说有多少条待收，并且可以就地让后端收一遍。
//
// 这里不做摘要、不做归纳、不替人下结论。找出来的是原文，怎么理解是人的事。

import { ApiError } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import * as jobs from '../../api/jobs'
import {
  SOURCE_KINDS,
  reindex,
  search,
  type KnowledgeCoverage,
  type KnowledgeHit,
  type KnowledgeResult,
} from '../../api/knowledge'
import { capabilityState } from '../../data/session'
import { dateTime, relative } from '../../data/time'
import { go } from '../../router'
import { clear, h, highlight } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { stagger } from '../../ui/motion'
import { empty, note, spinner, unavailable } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { kindLook, routeFor } from './kinds'
import { sourcePane } from './source'

const lane = new Latest()
const indexAction = new WriteAction()

/** 后端把条数夹在 1 到 30 之间。这三档够用，不给人调一个没意义的数字。 */
const SIZES = [10, 20, 30]

export function recallPage(host: HTMLElement, arg: string): () => void {
  let alive = true
  const live = { alive: () => alive }

  let kind: string | null = null
  let size = 10
  let before: string | null = null

  const box = h('input#q', {
    type: 'search',
    placeholder: '用你自己的话问，比如「回踩不破前低我就进」',
    value: arg ? decodeURIComponent(arg) : '',
    attrs: { autocomplete: 'off', 'aria-label': '在所有记录里找' },
  }) as HTMLInputElement

  const results = h('div', { style: 'margin-top:14px' })
  const coverage = h('div')

  const bar = h(
    'div',
    { class: 'searchbar has', style: 'margin-top:2px' },
    icon('search'),
    box,
    h('span.kbd', { text: '↵' }),
  )

  box.addEventListener('keydown', (e) => {
    const key = e as KeyboardEvent
    // 中文输入法里那下回车是在选词，不是在按「搜」。组字没结束就当没按过。
    if (key.isComposing) return
    if (key.key === 'Enter') void run()
  })

  const kindPicker = pickKind((value) => {
    kind = value
    if (box.value.trim()) void run()
  })

  const sizePicker = h(
    'div.seg',
    {},
    ...SIZES.map((n) =>
      h('button', {
        class: n === size ? 'on' : '',
        type: 'button',
        text: `${n} 条`,
        on: {
          click: (e: Event) => {
            size = n
            for (const node of sizePicker.querySelectorAll('button')) node.classList.remove('on')
            ;(e.currentTarget as HTMLElement).classList.add('on')
            if (box.value.trim()) void run()
          },
        },
      }),
    ),
  )

  const beforeInput = h('input.input', {
    type: 'date',
    style: 'max-width:170px',
    attrs: { 'aria-label': '只看这一天之前的' },
    on: {
      change: (e: Event) => {
        const value = (e.currentTarget as HTMLInputElement).value
        before = value ? new Date(`${value}T00:00:00Z`).toISOString() : null
        if (box.value.trim()) void run()
      },
    },
  })

  async function run(): Promise<void> {
    const query = box.value.trim()
    if (!query) {
      clear(results)
      results.appendChild(hint())
      return
    }
    clear(results)
    results.appendChild(spinner('正在翻…'))
    try {
      const signal = lane.begin()
      const result = await search({ query, source_kind: kind, before, limit: size }, { signal })
      if (!alive) return
      paintCoverage(result.coverage)
      paintResults(result, query)
    } catch (error) {
      if (!alive || Latest.aborted(error)) return
      clear(results)
      results.appendChild(trouble(error))
    }
  }

  function paintResults(result: KnowledgeResult, query: string): void {
    clear(results)
    if (!result.items.length) {
      results.appendChild(
        empty({
          title: '这句话在你记下来的东西里没找到对应的地方',
          tip: '换一种说法再试，或者把类别放宽到「不限」。还有改过没收进来的来源的话，它们这次也搜不到。',
        }),
      )
      return
    }
    results.appendChild(
      h('div.tip', {
        style: 'margin-bottom:10px',
        text: `${result.items.length} 条。上下顺序是翻出来的先后，不是「谁更准」——每条都要自己读了才算数。`,
      }),
    )
    stagger(result.items.map((hit) => results.appendChild(hitRow(hit, query, live))))
  }

  function paintCoverage(cov: KnowledgeCoverage): void {
    clear(coverage)
    const pending = cov.pending_sources ?? 0
    const done = cov.indexed_sources ?? 0
    coverage.appendChild(
      h('div.tip', {
        text: `已经收进来 ${done} 条来源${cov.watermark?.last_success_at ? `，上一次收是${relative(cov.watermark.last_success_at)}` : ''}。`,
      }),
    )
    if (!pending) return
    const oldest = cov.oldest_pending_at
    coverage.appendChild(
      note(
        'warn',
        h(
          'div',
          {},
          h('div', {
            text: `另有 ${pending} 条改过或者新加的来源还没重新收进来${oldest ? `，最早的一条是${relative(oldest)}的` : ''}。它们这一次搜不到。`,
          }),
          h('div', { style: 'margin-top:8px' }, reindexButton()),
        ),
      ),
    )
  }

  function reindexButton(): HTMLElement {
    const btn = h('button.btn.sm', {
      type: 'button',
      text: '现在收一遍',
      title: '让后端把改过的来源重新读一遍。收完之前它们仍然搜不到。',
      on: {
        click: async () => {
          const node = btn as HTMLButtonElement
          node.disabled = true
          node.textContent = '正在收…'
          try {
            const started = await reindex(indexAction.keyFor({ reindex: true }))
            const job = await jobs.waitFor(started.job_id, () => {}, { timeoutMs: 120000 })
            indexAction.reset()
            if (!alive) return
            if (jobs.needsPerson(job)) {
              node.disabled = false
              node.textContent = '现在收一遍'
              problem('这次没收完，后端停下来等人处理了。')
              return
            }
            toast('收完了，再搜一次就能找到它们。')
            void run()
          } catch (error) {
            if (!alive) return
            node.disabled = false
            node.textContent = '现在收一遍'
            problem(error instanceof ApiError ? error.message : '这次没能让后端收。')
          }
        },
      },
    })
    return btn
  }

  function trouble(error: unknown): HTMLElement {
    const api = error instanceof ApiError ? error : null
    if (api?.code === 'text_encoder_not_configured') {
      return unavailable(
        '本机读文字的模型没有启动',
        '这一页要靠它把你的问法和记下来的话对上。按部署说明把它开起来再回来搜；在那之前，「我的记录」里按原话搜照常能用。',
      )
    }
    return note('warn', api ? api.message : '这次没搜出来，稍后再试。')
  }

  host.append(
    h(
      'div.phead',
      {},
      h(
        'div',
        {},
        h('h1.h1', {}, '按意思找', h('span.lat', { text: 'Recall' })),
        h('div.sub', {
          text: '不只是当时说的那句话：后来的复盘、系统给的结论、局面类别、我的做法、实盘小结、统计和裁决，都在里面一起找。找出来的是原文片段，怎么理解还是你自己的事。',
        }),
      ),
      h('button.btn.sm.ghost', {
        type: 'button',
        text: '按原话搜',
        style: 'margin-left:auto',
        title: '只在自己说过的话里按字面搜，回到「我的记录」。',
        on: { click: () => go('find') },
      }),
    ),
    h(
      'div.sheet.pad',
      {},
      bar,
      h(
        'div.filters',
        { style: 'margin-top:12px' },
        kindPicker,
        h('label.field', {}, h('span', { text: '一次给几条' }), sizePicker),
        h('label.field', {}, h('span', { text: '只看这一天之前的' }), beforeInput),
      ),
      h('div', { style: 'margin-top:12px' }, coverage),
    ),
    results,
  )

  results.appendChild(hint())
  if (capabilityState('knowledge_index') === 'needs_setup') {
    clear(results)
    results.appendChild(
      unavailable(
        '本机读文字的模型还没配',
        '后端说这台机器上负责把文字变成向量的那一块没有配好，所以现在搜不了意思相近的话。「我的记录」里按原话搜不受影响。',
      ),
    )
  } else if (box.value.trim()) {
    void run()
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

function hint(): HTMLElement {
  return empty({
    title: '想起一件事，但记不清在哪儿写过',
    tip: '把它当时大概的意思写下来就行——不用记得原话。找到的是片段，点开能读原文。',
  })
}

function pickKind(onPick: (kind: string | null) => void): HTMLElement {
  const options: [string, string][] = [['', '不限']]
  for (const k of SOURCE_KINDS) options.push([k, kindLook(k).label])
  const node = h('select.input', {
    style: 'max-width:200px',
    attrs: { 'aria-label': '只在这一类里找' },
    on: {
      change: (e: Event) => onPick((e.currentTarget as HTMLSelectElement).value || null),
    },
  }) as HTMLSelectElement
  for (const [value, label] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    node.appendChild(option)
  }
  return h('label.field', {}, h('span', { text: '只在这一类里找' }), node)
}

function hitRow(hit: KnowledgeHit, query: string, live: { alive(): boolean }): HTMLElement {
  const look = kindLook(hit.source_kind)
  const route = routeFor(hit.source_kind, hit.source_id)
  const holder = h('div')

  const open = h('button.btn.sm.ghost', {
    type: 'button',
    text: '读原文',
    title: '片段只是原文里的一段。展开的是这条来源当时存下来的样子。',
    on: {
      click: () => {
        if (holder.firstChild) {
          clear(holder)
          open.textContent = '读原文'
          return
        }
        open.textContent = '收起原文'
        holder.appendChild(sourcePane(hit, live))
      },
    },
  })

  return h(
    'div.hit',
    {},
    h(
      'div',
      {},
      h('span.tag', { text: look.label }),
      h('div.tip', { style: 'margin-top:6px', text: dateTime(hit.occurred_at) }),
      h('div.faint', { style: 'margin-top:2px', text: handText(look.hand) }),
    ),
    h(
      'div',
      {},
      h('div.words', {}, highlight(hit.excerpt, query)),
      h(
        'div.line',
        { style: 'margin-top:8px' },
        h('span', { text: `原文第 ${hit.start_byte}–${hit.end_byte} 字节的一段` }),
        open,
        route
          ? h('button.btn.sm.ghost', {
              type: 'button',
              text: '打开这条',
              on: { click: () => go(route) },
            })
          : null,
      ),
      holder,
    ),
  )
}

function handText(hand: 'mine' | 'system' | 'market'): string {
  if (hand === 'mine') return '你自己写下的'
  if (hand === 'market') return '实盘或行情那边来的'
  return '系统按规则算出来的'
}

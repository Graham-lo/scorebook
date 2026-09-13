// 待你定 —— 某一组攒够 20 条新的明确结论时，后端提醒一句：该回头看一眼了。
//
// 它只是一个计数到点的提醒，不带任何倾向，也不会自己决定什么。认不认这一组算得
// 上证据，是人按下去的事：后端把这次裁决记成 `explicit_user_decision`，理由是必
// 填的——一次裁决没有写下当时怎么想，过几个月就没法复查了。
//
// 模型可以在别处给建议，但建议永远只是建议，不会自己变成裁决，也不会自己去改一
// 个打法的状态。

import { ApiError } from '../../api/errors'
import { Pager, WriteAction } from '../../api/http'
import {
  decideVerdict,
  members,
  verdictRequests,
  type VerdictInput,
  type VerdictRequest,
} from '../../api/statistics'
import { sentence, summary } from '../../data/criteria'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { empty, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { shortSignature, type Live } from './shared'

const decideAction = new WriteAction()

const DECISIONS: { id: VerdictInput['decision']; label: string; tip: string }[] = [
  {
    id: 'evidence',
    label: '认它是证据',
    tip: '这一组的记录够多、够干净，可以拿来支撑一个说法。',
  },
  { id: 'observe', label: '继续观察', tip: '还看不出什么，再攒一些。' },
  { id: 'drop', label: '不再当回事', tip: '这一组不值得再跟了。' },
]

export function verdictSheet(live: Live): HTMLElement {
  const rows = h('div', { style: 'padding:6px 18px 16px' })
  const right = h('span.faint', { style: 'margin-left:auto' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '待你定' }), right),
    rows,
  )

  const pager = new Pager<VerdictRequest>((cursor, signal) =>
    verdictRequests({ status: 'pending', cursor: cursor ?? undefined }, { signal }),
  )
  const footer = h('div.acts', { style: 'margin-top:10px' })
  const seen = new Set<string>()
  let busy = false
  let generation = 0
  node.appendChild(footer)

  function pagination(): void {
    clear(footer)
    right.textContent = seen.size ? `已读 ${seen.size} 条` : ''
    if (pager.more) footer.appendChild(h('button.btn.sm', {
      text: busy ? '正在加载' : '加载更多', disabled: busy, on: { click: () => void load() },
    }))
  }
  function remove(id: string): void {
    seen.delete(id)
    pagination()
    if (!seen.size && pager.exhausted) rows.appendChild(empty({ title: '没有待你定的' }))
  }
  async function load(): Promise<void> {
    if (busy || !live.alive()) return
    busy = true
    const round = generation
    if (!pager.loaded) rows.replaceChildren(spinner('正在加载'))
    pagination()
    try {
      const page = await pager.next()
      if (!live.alive() || round !== generation) return
      if (!seen.size) clear(rows)
      const added: HTMLElement[] = []
      for (const request of page) {
        if (seen.has(request.id)) continue
        seen.add(request.id)
        const refresh = () => { generation += 1; pager.reset(); seen.clear(); busy = false; void load() }
        added.push(rows.appendChild(card(request, live, refresh, () => remove(request.id))))
      }
      stagger(added)
      if (!seen.size && pager.exhausted) rows.appendChild(empty({ title: '没有待你定的' }))
      busy = false
      pagination()
    } catch (error) {
      if (!live.alive() || round !== generation) return
      busy = false
      if (!pager.loaded) clear(rows)
      footer.replaceChildren(
        note('warn', error instanceof Error ? error.message : '没读出来'),
        h('button.btn.sm', { text: '重试', on: { click: () => void load() } }),
      )
    }
  }

  void load()
  return node
}

function card(request: VerdictRequest, live: Live, reload: () => void, decided: () => void): HTMLElement {
  const rule = h('div', { style: 'margin-top:6px' })
  const evidence = h('textarea.textarea', {
    rows: 3,
    placeholder: '为什么这么判',
  }) as HTMLTextAreaElement
  const acts = h('div.acts', { style: 'margin-top:10px' })
  const box = h(
    'div.vcard',
    { style: 'margin-top:10px' },
    h(
      'div',
      { style: 'display:flex;gap:9px;align-items:center;flex-wrap:wrap' },
      h('span.mono', { text: `规则 #${shortSignature(request.signature)}` }),
      h('span.faint', { text: `有结论 ${request.explicit_count} 条` }),
      h('span.faint', { text: dateTime(request.created_at) }),
    ),
    rule,
    h('div', { style: 'margin-top:10px' }, evidence),
    acts,
  )

  void members(request.run_id, { group_signature: request.signature, representative: true })
    .then((page) => {
      if (!live.alive()) return
      const first = page.items[0]
      if (!first) return
      const what = summary(first.body.criteria)
      clear(rule)
      rule.appendChild(
        h('div.h3', {
          text: `${first.body.instrument ?? '没写'} · ${what.main}${what.sub ? ` · ${what.sub}` : ''}`,
        }),
      )
      rule.appendChild(
        h('div.sentence', { style: 'margin-top:4px', text: sentence(first.body.criteria) }),
      )
    })
    .catch(() => {
      if (!live.alive()) return
      clear(rule)
      rule.appendChild(
        h('div.tip', { text: '没读出来' }),
      )
    })

  for (const choice of DECISIONS) {
    const button = h('button.btn.sm', {
      type: 'button',
      text: choice.label,
      title: choice.tip,
      on: {
        click: () => {
          const text = evidence.value.trim()
          if (!text) {
            problem('先写为什么')
            evidence.focus()
            return
          }
          const input: VerdictInput = {
            request_id: request.id,
            expected_revision: request.revision,
            decision: choice.id,
            evidence: text,
          }
          for (const node of acts.children) (node as HTMLButtonElement).disabled = true
          void decideVerdict(input, decideAction.keyFor(input))
            .then(() => {
              decideAction.reset()
              if (!live.alive()) return
              box.remove()
              decided()
              toast('记下了')
            })
            .catch((error: unknown) => {
              if (!live.alive()) return
              for (const node of acts.children) (node as HTMLButtonElement).disabled = false
              if (error instanceof ApiError && error.code === 'verdict_request_changed') {
                problem('这条刚在别处改过，再试一次')
                reload()
                return
              }
              problem(error instanceof Error ? error.message : '没保存上，再试一次')
            })
        },
      },
    })
    acts.appendChild(button)
  }
  return box
}

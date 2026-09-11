// 待裁决 —— 某一组攒够 20 条新的明确结论时，后端提醒一句：该回头看一眼了。
//
// 它只是一个计数到点的提醒，不带任何倾向，也不会自己决定什么。认不认这一组算得
// 上证据，是人按下去的事：后端把这次裁决记成 `explicit_user_decision`，理由是必
// 填的——一次裁决没有写下当时怎么想，过几个月就没法复查了。
//
// 模型可以在别处给建议，但建议永远只是建议，不会自己变成裁决，也不会自己去改一
// 个打法的状态。

import { ApiError } from '../../api/errors'
import { WriteAction } from '../../api/http'
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
    h('div.sh', {}, h('span.eyebrow.noline', { text: '等你裁决' }), right),
    rows,
  )

  async function load(): Promise<void> {
    clear(rows)
    rows.appendChild(spinner('正在看有没有攒够的组…'))
    try {
      const page = await verdictRequests({ status: 'pending' })
      if (!live.alive()) return
      clear(rows)
      right.textContent = page.items.length ? `${page.items.length} 条` : ''
      if (!page.items.length) {
        rows.appendChild(
          empty({
            title: '现在没有等你裁决的',
            tip: '某一组比上次裁决时多出 20 条明确结论，后端才会在这里提醒一句。它不会替你决定什么。',
          }),
        )
        return
      }
      rows.appendChild(
        h('div.tip', {
          style: 'margin-bottom:8px',
          text: '下面每一条都只是「攒够了，该看一眼」。要不要认，认成什么，是你自己按下去的，理由会跟着这次裁决一起存下来。',
        }),
      )
      stagger(page.items.map((request) => rows.appendChild(card(request, live, load))))
      if (page.next_cursor) {
        rows.appendChild(
          h('div.tip', { style: 'margin-top:8px', text: '还有更多，处理完这一批会接着列。' }),
        )
      }
    } catch (error) {
      if (!live.alive()) return
      clear(rows)
      rows.appendChild(note('warn', error instanceof Error ? error.message : '读不到待裁决。'))
    }
  }

  void load()
  return node
}

function card(request: VerdictRequest, live: Live, reload: () => void): HTMLElement {
  const rule = h('div', { style: 'margin-top:6px' })
  const evidence = h('textarea.textarea', {
    rows: 3,
    placeholder: '写下这次为什么这么判——过几个月要靠它复查。',
  }) as HTMLTextAreaElement
  const acts = h('div.acts', { style: 'margin-top:10px' })
  const box = h(
    'div.vcard',
    { style: 'margin-top:10px' },
    h(
      'div',
      { style: 'display:flex;gap:9px;align-items:center;flex-wrap:wrap' },
      h('span.mono', { text: `规则 #${shortSignature(request.signature)}` }),
      h('span.faint', {
        text: `有结论的已经攒到 ${request.explicit_count} 条，比上次裁决时多了 ${request.explicit_count - request.threshold + 20} 条`,
      }),
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
          text: `${first.body.instrument ?? '没写品种'} · ${what.main}${what.sub ? ` · ${what.sub}` : ''}`,
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
        h('div.tip', { text: '这一组的规则读不出来，先按编号认。' }),
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
            problem('先写下这次为什么这么判，理由是必填的。')
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
              toast(`记下了：${choice.label}。这是你按下去的，来源写着「明确的人工决定」。`)
            })
            .catch((error: unknown) => {
              if (!live.alive()) return
              for (const node of acts.children) (node as HTMLButtonElement).disabled = false
              if (error instanceof ApiError && error.code === 'verdict_request_changed') {
                problem('这条刚刚被改过或者已经裁过了，先读回最新的再决定。')
                reload()
                return
              }
              problem(error instanceof Error ? error.message : '这次裁决没有存上。')
            })
        },
      },
    })
    acts.appendChild(button)
  }
  return box
}

// 「模型想替你写点东西」这件事长什么样。
//
// 后端在这里不含糊：会写入的三个工具，只要没有一条对得上的确认，它就不执行，
// 只退回一份提案——哪个操作、参数是什么、参数的哈希是多少。所以这张卡片要做
// 的是把这份提案原样摊开给人看，然后等一个明确的动作。
//
// 三条不能违反：
//   一、参数照抄，不省略。看不见的东西不能被确认。
//   二、哈希原样带回后端，不是前端重新算一遍——重新算就等于自己给自己盖章。
//   三、意图是用户自己写的。这里不预填、不代填，空着就不许提交。

import type { ApprovedAction, ToolProposal } from '../../api/chat'
import { h } from '../../ui/dom'
import { note } from '../../ui/states'
import { problem } from '../../ui/toast'
import { ARGUMENT_LABELS, MUTATION_MEANING, argumentValue, toolLabel } from './tools'

export function proposalCard(
  proposal: ToolProposal,
  onConfirm: (approved: ApprovedAction) => void,
): HTMLElement {
  const intent = h('textarea.textarea', {
    rows: 2,
    placeholder: '用你自己的话写下你要它做什么——这句话会和这次操作一起存下来。',
  }) as HTMLTextAreaElement

  const rows = h('div', { style: 'margin-top:10px' })
  for (const [field, value] of Object.entries(proposal.arguments ?? {})) {
    rows.appendChild(
      h(
        'div',
        { style: 'display:flex;gap:10px;align-items:baseline;padding:3px 0' },
        h('span.faint', { style: 'min-width:9em', text: ARGUMENT_LABELS[field] ?? field }),
        h('span', { style: 'white-space:pre-wrap', text: argumentValue(field, value) }),
      ),
    )
  }

  const raw = h('pre.mono', {
    hidden: true,
    style: 'margin-top:10px;padding:10px;overflow:auto;max-height:280px;white-space:pre-wrap',
    text: JSON.stringify(proposal.arguments ?? {}, null, 2),
  })

  const confirm = h('button.btn.sm.primary', {
    type: 'button',
    text: '确认，并且带着这条批准重新问一次',
    on: {
      click: () => {
        const text = intent.value.trim()
        if (!text) {
          problem('先用你自己的话写下你要它做什么，这一句不能替你填。')
          intent.focus()
          return
        }
        onConfirm({
          tool: proposal.tool,
          // 后端算好的那一串，原样带回去。
          arguments_sha256: proposal.arguments_sha256,
          user_intent: text,
        })
      },
    },
  })

  return h(
    'div.vcard',
    { style: 'margin-top:12px' },
    h('span.eyebrow.noline', { text: '等你确认' }),
    h('div.h3', { style: 'margin-top:6px', text: toolLabel(proposal.tool) }),
    h('div.tip', {
      style: 'margin-top:4px',
      text: MUTATION_MEANING[proposal.tool] ?? '这一步会写进你的记录里。',
    }),
    rows,
    h(
      'div.acts',
      { style: 'margin-top:8px' },
      h('button.btn.sm.ghost', {
        type: 'button',
        text: '看原样的参数',
        on: {
          click: (e: Event) => {
            raw.hidden = !raw.hidden
            ;(e.currentTarget as HTMLButtonElement).textContent = raw.hidden
              ? '看原样的参数'
              : '收起原样的参数'
          },
        },
      }),
      h('span.faint.mono', {
        title: proposal.arguments_sha256,
        text: `参数指纹 ${proposal.arguments_sha256.slice(0, 12)}…`,
      }),
    ),
    raw,
    h('div', { style: 'margin-top:10px' }, intent),
    h('div.acts', { style: 'margin-top:8px' }, confirm),
    note(
      'info',
      '确认之后不是直接执行：它会带着这条批准和这一串参数指纹重新问一次。只有模型再给出一模一样的操作和参数，后端才会真的写进去；对不上就还是不写。',
    ),
  )
}

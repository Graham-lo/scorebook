// 把实际成交关联到这条记录上 —— 事后的关联，不是入场前的依据。
//
// 这件事只能事后做：成交发生在写下判断之后，关联又发生在成交之后。后端在回执里
// 记的也是 `retrospective_link_not_prior_adoption`，所以界面上绝不能让一条事后
// 补上的关联看起来像是入场之前就有的证据。
//
// 挑成交这一段不在这里实现：全站只有 `find/fill-pick.ts` 那一份。

import { WriteAction } from '../../api/http'
import * as trades from '../../api/trades'
import type { CallDetail, Uuid } from '../../api/types'
import { h } from '../../ui/dom'
import { problem, toast } from '../../ui/toast'
import { fillPicker } from '../find/fill-pick'

type Relation = 'executed' | 'rejected' | 'related'

const RELATIONS: { value: Relation; label: string; why: string }[] = [
  { value: 'executed', label: '照做了', why: '这几笔成交就是按这条记录进出的' },
  { value: 'rejected', label: '没照做', why: '这条当时没执行，这几笔是同一段时间里实际做的' },
  { value: 'related', label: '有关', why: '两边有关系，但不是按这条进出的' },
]

const linkAction = new WriteAction()

export function executionSection(d: CallDetail): HTMLElement {
  const relation: { value: Relation } = { value: 'executed' }
  /** 这一次会话里刚写下的那条，改口的时候要指着它。 */
  let head: Uuid | null = null

  const picker = fillPicker({
    mode: 'fills',
    symbol: d.instrument,
    from: d.submitted_at.slice(0, 10),
  })
  const evidence = h('textarea.textarea', {
    rows: 2,
    placeholder: '为什么是这几笔',
  }) as HTMLTextAreaElement
  const seg = h('span.seg')
  const done = h('div.faint', { style: 'margin-top:10px' })

  function paintSeg(): void {
    seg.replaceChildren(
      ...RELATIONS.map((item) =>
        h('button', {
          class: relation.value === item.value ? 'on' : '',
          title: item.why,
          text: item.label,
          on: {
            click: () => {
              relation.value = item.value
              paintSeg()
            },
          },
        }),
      ),
    )
  }
  paintSeg()

  const save = h('button.btn.sm', { text: '关联这几笔' }) as HTMLButtonElement
  save.addEventListener('click', () => {
    const text = evidence.value.trim()
    const ids = picker.picked()
    const connectionId = picker.connectionId()
    if (!connectionId || !ids.length) {
      problem('先选几笔成交')
      return
    }
    if (!text) {
      problem('写一句为什么')
      return
    }
    const payload: trades.ExecutionLink = {
      connection_id: connectionId,
      trade_ids: ids,
      call_id: d.id,
      relation: relation.value,
      evidence: text,
      supersedes: head,
    }
    save.disabled = true
    save.classList.add('busy')
    void trades
      .linkExecution(payload, linkAction.keyFor(payload))
      .then((result) => {
        linkAction.reset()
        head = result.execution_link_id
        toast('记下了')
        done.textContent = `已关联 ${payload.trade_ids.length} 笔`
      })
      .catch(() => {
        problem('没保存上，再试一次')
      })
      .finally(() => {
        save.disabled = false
        save.classList.remove('busy')
        save.textContent = head ? '重新关联' : '关联这几笔'
      })
  })

  return h(
    'div.sec',
    {},
    h('div.sh', {}, h('span.eyebrow.noline', { text: '实际成交' })),
    picker.node,
    h('div.dlabel', { style: 'margin-top:14px', text: '关系' }),
    seg,
    evidence,
    h('div.acts', {}, save),
    done,
  )
}

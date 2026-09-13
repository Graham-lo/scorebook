import type { AnswerBlock } from '../../api/chat'
import { source, type SourceRef } from '../../api/knowledge'
import { h } from '../../ui/dom'
import { sheet } from '../../ui/sheet'

const LABELS: Record<string, string> = { call: '原始判断', review: '复盘', outcome: '结果', tag: '局面', playbook: '打法', attachment: '截图', episode: '相关判断', statistics: '统计', verdict: '判定' }
const FIELDS: Record<string, string> = { original_text: '原话', note: '复盘', better_play: '下次怎么做', name: '名称', definition: '定义', applies_to: '适用情况', excludes: '不适用', old_play: '原来的做法', change: '改进', expected_improvement: '预期改善', cost: '代价', text: '内容' }

export function sourceButton(ref: SourceRef): HTMLElement {
  return h('button.linkbtn', { text: `查看${LABELS[ref.source_kind] ?? '来源'}`, on: { click: () => openSource(ref) } })
}

function openSource(ref: SourceRef): void {
  const content = h('div', {}, h('p', { text: '正在读取' }))
  const controller = new AbortController()
  sheet(LABELS[ref.source_kind] ?? '来源', content, () => controller.abort())
  void source(ref, { signal: controller.signal }).then(result => {
    if (controller.signal.aborted) return
    content.replaceChildren()
    let found = false
    const append = (body: Record<string, unknown>) => {
      for (const [key, label] of Object.entries(FIELDS)) {
        const value = body[key]
        if (typeof value !== 'string' || !value.trim()) continue
        found = true
        content.append(h('p', {}, h('b', { text: label }), h('div', { text: value, style: 'white-space:pre-wrap;overflow-wrap:anywhere' })))
      }
    }
    append(result.body)
    if (result.body.body && typeof result.body.body === 'object') append(result.body.body as Record<string, unknown>)
    const call = ref.source_kind === 'call' ? ref.source_id : result.body.call_id
    if (typeof call === 'string') content.append(h('a.btn.sm', { text: '看这条记录', href: `#/call/${encodeURIComponent(call)}` }))
    if (!found) content.append(h('p', { text: '这份来源没有文字说明' }))
  }).catch(() => {
    if (!controller.signal.aborted) content.replaceChildren(h('p', { text: '这份来源已更新或暂时无法读取' }))
  })
}

export function answerBlocks(blocks: AnswerBlock[]): HTMLElement {
  return h('div.fsum', {}, ...blocks.map(block => h('div', {},
    block.inference ? h('span.tag', { text: '推断' }) : null,
    h('p', { text: block.text, style: 'white-space:pre-wrap' }),
    h('div.acts', {}, ...block.citations.map(sourceButton)),
  )))
}

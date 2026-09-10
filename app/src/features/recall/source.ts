// 读全文。
//
// 检索给的是一段，不是全文——命中的那几行前后还有别的话，只看片段很容易把意思
// 读反。所以每一条都能就地展开原文，一段一段往下读。
//
// 三件事必须守住：
//
//   同一版      每次取都带着命中里的 `source_version`。后端读到别的版本会直接
//               拒绝（`source_version_changed`），这正是要的：宁可停下来说一句
//               「这份来源变了」，也不能把新旧两版的文字接在一起读。
//   字节游标    往下翻用后端给的 `next_offset_byte`，是 UTF-8 字节数，不是字数。
//               自己按字符去算会切在半个汉字上，后端会拒绝（`invalid_source_slice`）。
//   原样        全文是这条记录存下来的样子，连同它的字段名。这里不改写、不润色，
//               看到的就是取证时会看到的东西。

import { ApiError } from '../../api/errors'
import { sourceSlice, type SourceSlice } from '../../api/knowledge'
import type { Instant, Uuid } from '../../api/types'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { note, spinner } from '../../ui/states'

export interface Live {
  alive(): boolean
}

/**
 * 要读的那一份来源。检索命中天然就是这个形状；答案里的一条引用也是——它只是
 * 没有片段位置，因为它指的是整份来源，不是其中的一段。
 */
export interface SourceTarget {
  source_kind: string
  source_id: Uuid
  source_version: string
  occurred_at?: Instant | null
  start_byte?: number | null
  end_byte?: number | null
}

/** 一次读多少字节。后端只收 256 到 16000 之间的数。 */
const CHUNK = 8000

export function sourcePane(hit: SourceTarget, live: Live): HTMLElement {
  const body = h('div', { style: 'margin-top:10px' })
  const pane = h('div.inset', { style: 'margin-top:10px' }, body)

  /** `version` 传 null 就是「按现在这一版重新取一次证」，是人明确按下去的。 */
  let version: string | null = hit.source_version
  let offset = 0
  let text = ''
  let total = 0
  let next: number | null = null

  const readout = h('div.tip', { style: 'margin-bottom:8px' })
  const words = h('div', {
    style:
      'white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--mono);font-size:12px;line-height:1.7;color:var(--ink2);max-height:420px;overflow:auto',
  })
  const foot = h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap' })

  function paint(): void {
    clear(body)
    const changed = version !== hit.source_version
    const excerpt =
      hit.start_byte !== undefined && hit.start_byte !== null && hit.end_byte !== undefined && hit.end_byte !== null
        ? `片段在第 ${hit.start_byte}–${hit.end_byte} 字节。`
        : ''
    const when = hit.occurred_at ? `${dateTime(hit.occurred_at)} 记下的那一条` : '现在这一条'
    readout.textContent = changed
      ? `这是这份来源现在的样子（${when}）。你看到的那一段来自旧的一版，两者已经对不上。`
      : `已经读到第 ${offset} 字节，一共 ${total} 字节。${excerpt}`
    words.textContent = text
    clear(foot)
    if (next !== null) {
      foot.appendChild(
        h('button.btn.sm.ghost', {
          type: 'button',
          text: '接着往下读',
          on: { click: () => void load(next) },
        }),
      )
    } else if (total) {
      foot.appendChild(h('span.faint', { text: '到底了。' }))
    }
    body.append(readout, words, foot)
  }

  async function load(from: number | null): Promise<void> {
    const start = from ?? 0
    if (start === 0) text = ''
    clear(body)
    body.appendChild(spinner(start ? '正在往下读…' : '正在取原文…'))
    try {
      const slice: SourceSlice = await sourceSlice({
        source_kind: hit.source_kind,
        source_id: hit.source_id,
        source_version: version,
        offset_byte: start,
        limit_bytes: CHUNK,
      })
      if (!live.alive()) return
      text += slice.text
      offset = slice.next_offset_byte ?? slice.total_bytes
      total = slice.total_bytes
      next = slice.next_offset_byte
      version = slice.source_version
      paint()
    } catch (error) {
      if (!live.alive()) return
      clear(body)
      body.appendChild(trouble(error))
    }
  }

  function trouble(error: unknown): HTMLElement {
    const api = error instanceof ApiError ? error : null
    if (api?.code === 'source_version_changed') {
      return h(
        'div',
        {},
        note(
          'warn',
          '这份来源在你看到它之后被改过了。你看到的是旧的一版，接着往下读会把两版文字接在一起，所以先停在这里。',
        ),
        h(
          'div',
          { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
          h('button.btn.sm', {
            type: 'button',
            text: '按现在这一版重新取',
            title: '重新取证：丢掉旧片段，从现在这一版的开头读起。',
            on: {
              click: () => {
                version = null
                offset = 0
                next = null
                void load(0)
              },
            },
          }),
          h('span.faint', { text: '重新检索一次，命中的片段也会跟着更新。' }),
        ),
      )
    }
    if (api?.status === 404) {
      return note('warn', '这份来源已经不在了。检索结果里还留着它，是因为索引还没跟上。')
    }
    return note('warn', api ? api.message : '原文这次没读出来，稍后再试。')
  }

  void load(0)
  return pane
}

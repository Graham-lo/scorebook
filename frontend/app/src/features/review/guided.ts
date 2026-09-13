// 引导式复盘 —— 一步一页，先重看，再动笔。
//
// 上一版把「当时说了什么」「市场怎么答的」「你怎么看」「下次怎么做」全部摊在
// 同一屏上，看的人要自己决定从哪儿开始，写的人一眼看到十几个输入框。这一版按
// 事情本来的顺序分成四步：
//
//   一 回到当时     当时那句话、当时那张图、当时凭什么。全部只读。
//   二 市场的答案   行情后来怎么走的，顺手把后续走势的截图补上。
//   三 你现在怎么看 哪一半站住了，哪一半是错觉。
//   四 下次怎么做   改哪儿，和实盘对上，然后发布。
//
// 每一步都是自己的网址（#/review/<id>/step/2），所以手机的返回手势、刷新、
// 「写到一半明天接着写」这三件事都成立。草稿仍然是整份自动保存的：分开摆不等
// 于分开存，第三步写下的字在第四步照样在。
//
// 编辑区活得比一次翻页长。翻页时 router 会拆掉整页，这里靠一个模块级的挂起位
// 把它接住——不然每翻一页都要重读一次草稿，正在飞的那次保存还会被打断。

import type { CallDetail, Outcome, Uuid } from '../../api/types'
import { PATHS, STANCES, sentence } from '../../data/criteria'
import { detail, invalidate } from '../../data/store'
import { dateTime } from '../../data/time'
import { go, reload, route } from '../../router'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { reviewImages } from '../../ui/image-picker'
import { stanceBadge } from '../../ui/bits'
import { stile } from '../../ui/stile'
import { stagger } from '../../ui/motion'
import { empty, note, spinner } from '../../ui/states'
import { problem } from '../../ui/toast'
import { draftEditor, outcomeLine, type DraftEditor } from './draft'
import { inMainViewer } from '../call/scene'

interface Step {
  n: number
  title: string
  lead: string
  /** 底下那颗按钮上的话。 */
  next: string
}

const STEPS: Step[] = [
  { n: 1, title: '当时', lead: '先看当时的图和话，再往下写', next: '下一步' },
  { n: 2, title: '市场的答案', lead: '补一张之后的图，和当时那张放一起', next: '下一步' },
  { n: 3, title: '现在怎么看', lead: '', next: '下一步' },
  { n: 4, title: '下次怎么做', lead: '', next: '发布' },
]

/** 这四步的名字。清单页和记录页上先给人看一眼要走几步，再让人按。 */
export const STEP_NAMES = STEPS.map((s) => s.title)

/** 翻页时接住编辑区，免得每一步都重读一次草稿。 */
interface HeldReview { id: Uuid; editor: DraftEditor; active: boolean; version: number }
let held: HeldReview | null = null
// 保存失败时保留整份编辑器（包括尚未传上的图片），返回同一条复盘继续重试。
const retained = new Map<Uuid, HeldReview>()

function releaseHeld(): void {
  if (!held) return
  const entry = held
  held = null
  entry.active = false
  const version = ++entry.version
  if (entry.editor.dispose()) {
    retained.delete(entry.id)
    return
  }
  void entry.editor.flush().then(() => {
    // 离开后的保存尚未完成就返回了，不能拆掉重新接上的编辑器。
    if (entry.active || entry.version !== version) return
    if (entry.editor.dispose()) retained.delete(entry.id)
    else problem('复盘还没保存，已保留在当前标签页。返回这条复盘可以重试，请勿刷新或关闭。')
  }).catch(() => {
    if (!entry.active && entry.version === version) problem('复盘还没保存，请返回这条复盘重试。内容仍在当前标签页。')
  })
}

export function guidedReview(host: HTMLElement, callId: Uuid, stepArg: string): () => void {
  let alive = true
  const at = STEPS.find((s) => String(s.n) === stepArg) ?? STEPS[0]!
  const done = stepArg === 'done'

  const crumb = h(
    'div.crumb',
    {},
    h('a', { href: '#/review', text: '复盘' }),
    h('span.sep', { text: '›' }),
    h('span', { text: done ? '这一轮走完了' : at.title }),
  )
  const shell = h('div.wiz')
  host.append(crumb, shell)
  shell.appendChild(spinner('正在加载'))

  void start()

  async function start(): Promise<void> {
    let record: CallDetail
    try {
      record = await detail(callId)
    } catch (error) {
      if (!alive) return
      clear(shell)
      shell.classList.remove('wide')
      shell.appendChild(
        empty({
          title: '没读出来',
          action: h('a.btn.sm', { href: '#/review', text: '回复盘' }),
        }),
      )
      return
    }
    if (!alive) return

    if (held && held.id !== callId) releaseHeld()
    if (!held) {
      held = retained.get(callId) ?? {
        id: callId,
        active: true,
        version: 0,
        editor: draftEditor({
          callId,
          instrument: record.body.instrument,
          lead: '',
          reread: async () => {
            invalidate(callId)
            return detail(callId, { refresh: true })
          },
          outcomes: () => record.current_outcomes ?? [],
          onPublished: () => {
            invalidate(callId)
            go(`review/${callId}/step/done`)
          },
        }),
      }
      held.active = true
      held.version += 1
      retained.set(callId, held)
    }
    const editor = held.editor

    if (record.voided) {
      clear(shell)
      shell.classList.remove('wide')
      shell.appendChild(note('warn', '作废后不再复盘，内容保留'))
      return
    }
    if (done && !record.reviews.length) {
      // 没发布过就没有「走完一整轮」这回事，把人放回第一步。
      go(`review/${callId}/step/1`)
      return
    }
    if (done) {
      clear(shell)
      shell.classList.remove('wide')
      shell.appendChild(finished(record))
      stagger([...shell.children])
      return
    }

    // 第一步只是重看，不碰草稿，马上就能画。从第二步起页面上摆的是编辑区的
    // 零件，草稿没读回来之前摆出去就是一组空框。
    if (at.n > 1) {
      try {
        await editor.opened
      } catch (error) {
        if (!alive) return
        clear(shell)
        shell.classList.remove('wide')
        shell.appendChild(
          note('warn', '没读出来'),
        )
        shell.appendChild(
          h('div.wizfoot', {}, h('button.btn.sm', {
            type: 'button',
            text: '重试',
            on: { click: () => { releaseHeld(); reload() } },
          })),
        )
        return
      }
      if (!alive) return
    }

    clear(shell)
    // 宽屏上左柱放这一条的摘要，向导本身一步不改地住在右边；窄屏 .wizmain 是
    // display:contents，页面结构和以前完全一样。
    shell.classList.add('wide')
    shell.append(
      aside(record),
      h('div.wizmain', {}, rail(), heading(record), editor.parts.banner, editor.parts.status, stepBody(record, editor), foot(editor)),
    )
    stagger([...shell.querySelectorAll('.wizbody > *')])
  }

  /* ------------------------------------------------------------ 骨架 */

  /** 顶上那条：四步走到哪儿了。走过的可以点回去，没到的点不了。 */
  function rail(): HTMLElement {
    const bar = h('div.wizrail')
    for (const step of STEPS) {
      const state = step.n < at.n ? 'done' : step.n === at.n ? 'now' : 'todo'
      const node =
        state === 'todo'
          ? h('span.wstep', { attrs: { 'data-state': state } })
          : h('a.wstep', {
              href: `#/review/${callId}/step/${step.n}`,
              attrs: { 'data-state': state },
            })
      node.append(
        h('span.wn', { text: state === 'done' ? '✓' : String(step.n) }),
        h('span.wt', { text: step.title }),
      )
      bar.appendChild(node)
    }
    return bar
  }

  /** 左柱：这一条的摘要。全是记录页上已经有的东西，只是搬过来陪着写。 */
  function aside(record: CallDetail): HTMLElement {
    const scene = record.attachments.find((a) => a.kind === 'scene' && inMainViewer(a))
    return h(
      'aside.wizside',
      {},
      h('div.wsym', { text: record.body.instrument ?? '没写' }),
      stanceBadge(record.body.stance),
      record.original_text ? h('p.quote', { text: record.original_text }) : null,
      h('div.wmeta', { text: dateTime(record.submitted_at) }),
      scene ? stile({ id: scene.id, compact: true, label: '当时', alt: '当时' }) : null,
    )
  }

  function heading(record: CallDetail): HTMLElement {
    return h(
      'header.wizhead',
      {},
      h(
        'div.wizwho',
        {},
        h('span.sym', { text: record.body.instrument ?? '没写' }),
        record.body.timeframe ? h('span', { text: record.body.timeframe }) : null,
        h('span.faint', { text: dateTime(record.submitted_at) }),
        h('a.btn.sm.ghost', { href: `#/call/${record.id}`, text: '看这条记录' }),
      ),
      h('h1.wizt', {}, h('span.k', { text: `第 ${at.n} 步` }), at.title),
      at.lead ? h('p.wizl', { text: at.lead }) : null,
    )
  }

  function stepBody(record: CallDetail, editor: DraftEditor): HTMLElement {
    const box = h('div.wizbody')
    if (at.n === 1) {
      const scenes = record.attachments.filter((a) => a.kind === 'scene' && inMainViewer(a)).map((a) => a.id)
      const shots = reviewImages(scenes, '当时')
      if (shots) box.appendChild(shots)
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '原话' })),
          h('div.quote.lg', { text: record.body.original_text || '没写' }),
        ),
      )
      box.appendChild(momentFacts(record))
      const claim = record.body.criteria[0] ?? null
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '怎么算对' })),
          h('div.sentence', { text: sentence(claim) }),
        ),
      )
      return box
    }

    if (at.n === 2) {
      const outs = record.current_outcomes ?? []
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '市场的答案' })),
          ...(outs.length
            ? outs.map((o: Outcome) => outcomeLine(o))
            : [h('div.tip', { text: '没写怎么算对' })]),
        ),
      )
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '走势' })),
          editor.parts.pictures,
        ),
      )
      return box
    }

    if (at.n === 3) {
      const scenes = record.attachments.filter((a) => a.kind === 'scene' && inMainViewer(a)).map((a) => a.id)
      box.appendChild(
        h(
          'div.sec.recall',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '原话' })),
          h('div.quote', { text: record.body.original_text || '没写' }),
          reviewImages(scenes, '当时'),
        ),
      )
      box.appendChild(h('div.sec', {}, editor.parts.note))
      box.appendChild(h('div.sec', {}, editor.parts.vsLast))
      return box
    }

    // 这一格里的小标题是编辑区自己带的，外面不再套一个一模一样的。
    box.appendChild(h('div.sec', {}, editor.parts.better))
    box.appendChild(
      h(
        'div.sec',
        {},
        h('div.sh', {}, h('span.eyebrow.noline', { text: '实际成交' })),
        editor.parts.trades,
      ),
    )
    return box
  }

  /** 底下那条：上一步、下一步，以及最后一步的发布。 */
  function foot(editor: DraftEditor): HTMLElement {
    const bar = h('div.wizfoot')
    if (at.n > 1) {
      bar.appendChild(
        h('a.btn.ghost', {
          href: `#/review/${callId}/step/${at.n - 1}`,
          text: '上一步',
        }),
      )
    } else {
      bar.appendChild(h('a.btn.ghost', { href: '#/review', text: '回复盘' }))
    }
    if (at.n < 4) {
      bar.appendChild(
        h(
          'a.btn.primary.next',
          { href: `#/review/${callId}/step/${at.n + 1}` },
          at.next,
          icon('go'),
        ),
      )
    } else {
      bar.appendChild(editor.parts.foot)
    }
    return bar
  }

  /* ---------------------------------------------------------- 写完了 */

  function finished(record: CallDetail): HTMLElement {
    const box = h('div.wizdone')
    box.appendChild(
      h(
        'div.donetop',
        {},
        h('span.ic', {}, icon('check')),
        h('h1.wizt', { text: '这一轮走完了' }),
      ),
    )
    box.appendChild(
      h(
        'div.wizfoot',
        {},
        h('a.btn.primary', { href: `#/call/${record.id}`, text: '看这条记录' }),
        h('a.btn', { href: `#/archive?call=${record.id}`, text: '归到一类局面' }),
        h('a.btn.ghost', { href: '#/review', text: '回复盘' }),
      ),
    )
    return box
  }

  return () => {
    alive = false
    // 还在这条记录的引导流程里就把编辑区留着；离开了才收，收之前先把没发出的
    // 那次保存补上。
    const next = route()
    const staying = next.page === 'review' && next.arg.split('/')[0] === callId
    if (!staying) releaseHeld()
  }
}

/** 当时那四格事实。 */
function momentFacts(d: CallDetail): HTMLElement {
  const rows: { k: string; v: string }[] = [
    { k: '方向', v: STANCES[d.body.stance] ?? '没写' },
    { k: '触发', v: PATHS[d.body.path] ?? '没写' },
    {
      k: '把握',
      v: d.body.confidence === null || d.body.confidence === undefined ? '没写' : `${d.body.confidence}%`,
    },
    { k: '周期', v: d.timeframe ?? '没写' },
  ]
  const grid = h('div.momentgrid')
  for (const row of rows) {
    grid.appendChild(h('div.mf', {}, h('span.k', { text: row.k }), h('span.v', { text: row.v })))
  }
  return h('div.sec', {}, grid)
}

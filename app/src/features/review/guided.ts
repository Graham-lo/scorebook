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
import { stateLook } from '../../data/outcome'
import { detail, invalidate } from '../../data/store'
import { dateTime, elapsed, horizon, relative } from '../../data/time'
import { go, reload, route } from '../../router'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { reviewImages } from '../../ui/image-picker'
import { stagger } from '../../ui/motion'
import { empty, note, spinner } from '../../ui/states'
import { draftEditor, outcomeLine, type DraftEditor } from './draft'

interface Step {
  n: number
  title: string
  lead: string
  /** 底下那颗按钮上的话。 */
  next: string
}

const STEPS: Step[] = [
  {
    n: 1,
    title: '回到当时',
    lead: '先把当时那句话和那张图重新看一遍。不先看当时，复盘就变成了事后诸葛——现在你已经知道答案了，很容易把「我早就觉得」当成当时真的想过。',
    next: '看看市场怎么答的',
  },
  {
    n: 2,
    title: '市场的答案',
    lead: '行情后来怎么走的。这一格由市场填，你能做的是把后续走势的截图补上，和当时那张放在一起看。',
    next: '写下我现在怎么看',
  },
  {
    n: 3,
    title: '你现在怎么看',
    lead: '当时那句话，哪一半站住了，哪一半是错觉。这是整件事里唯一只有你能写的部分。',
    next: '再想想下次怎么做',
  },
  {
    n: 4,
    title: '下次怎么做',
    lead: '同样的局面再来一次，改哪儿。写完发布，这条复盘就不能再改了——要补充只能再写一条。',
    next: '发布这条复盘',
  },
]

/** 这四步的名字。清单页和记录页上先给人看一眼要走几步，再让人按。 */
export const STEP_NAMES = STEPS.map((s) => s.title)

/** 翻页时接住编辑区，免得每一步都重读一次草稿。 */
let held: { id: Uuid; editor: DraftEditor } | null = null

function releaseHeld(): void {
  if (!held) return
  const editor = held.editor
  held = null
  void editor.flush().catch(() => undefined)
  editor.dispose()
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
    h('span', { text: done ? '写完了' : `第 ${at.n} 步 · ${at.title}` }),
  )
  const shell = h('div.wiz')
  host.append(crumb, shell)
  shell.appendChild(spinner('正在读这条记录…'))

  void start()

  async function start(): Promise<void> {
    let record: CallDetail
    try {
      record = await detail(callId)
    } catch (error) {
      if (!alive) return
      clear(shell)
      shell.appendChild(
        empty({
          title: '这条记录读不出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('a.btn.sm', { href: '#/review', text: '回到复盘清单' }),
        }),
      )
      return
    }
    if (!alive) return

    if (held && held.id !== callId) releaseHeld()
    if (!held) {
      held = {
        id: callId,
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
    }
    const editor = held.editor

    if (record.voided) {
      clear(shell)
      shell.appendChild(note('warn', '这条记录已经作废，不再接受新的复盘。'))
      return
    }
    if (done && !record.reviews.length) {
      // 没发布过就没有「走完一整轮」这回事，把人放回第一步。
      go(`review/${callId}/step/1`)
      return
    }
    if (done) {
      clear(shell)
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
        shell.appendChild(
          note('warn', error instanceof Error ? error.message : '这条的草稿读不出来。'),
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
    shell.append(rail(), heading(record), stepBody(record, editor), foot(editor))
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

  function heading(record: CallDetail): HTMLElement {
    return h(
      'header.wizhead',
      {},
      h(
        'div.wizwho',
        {},
        h('span.sym', { text: record.body.instrument ?? '未标品种' }),
        record.body.timeframe ? h('span', { text: record.body.timeframe }) : null,
        h('span.faint', { text: `${dateTime(record.submitted_at)} 记下 · ${relative(record.submitted_at)}` }),
        h('a.btn.sm.ghost', { href: `#/call/${record.id}`, text: '打开完整记录' }),
      ),
      h('h1.wizt', {}, h('span.k', { text: `第 ${at.n} 步` }), at.title),
      h('p.wizl', { text: at.lead }),
    )
  }

  function stepBody(record: CallDetail, editor: DraftEditor): HTMLElement {
    const box = h('div.wizbody')
    if (at.n === 1) {
      const scenes = record.attachments.filter((a) => a.kind === 'scene').map((a) => a.id)
      const shots = reviewImages(scenes, '当时那张图')
      if (shots) box.appendChild(shots)
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '当时说的那句话' })),
          h('div.quote.lg', { text: record.body.original_text || '（这条没有文字，只有图。）' }),
        ),
      )
      box.appendChild(momentFacts(record))
      const claim = record.body.criteria[0] ?? null
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '当时定下的标准' })),
          h('div.sentence', { text: sentence(claim) }),
          h('div.tip', {
            text: claim
              ? `观察 ${horizon(claim.horizon_hours)}。这条标准在记下那一刻就定死了，不会因为行情走成什么样而改。`
              : '这条当时没写算对错的标准，所以没有自动结果。用文字复盘一样算数。',
          }),
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
          h('div.sh', {}, h('span.eyebrow.noline', { text: '市场给的答案' })),
          ...(outs.length
            ? outs.map((o: Outcome) => outcomeLine(o))
            : [h('div.tip', { text: '这条没有写算对的标准，所以没有自动结果。下面的话和图一样算数。' })]),
          waitLine(record, outs),
        ),
      )
      box.appendChild(
        h(
          'div.sec',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '补上后来的走势' })),
          editor.parts.pictures,
        ),
      )
      return box
    }

    if (at.n === 3) {
      const scenes = record.attachments.filter((a) => a.kind === 'scene').map((a) => a.id)
      box.appendChild(
        h(
          'div.sec.recall',
          {},
          h('div.sh', {}, h('span.eyebrow.noline', { text: '当时那句话' })),
          h('div.quote', { text: record.body.original_text || '（这条没有文字，只有图。）' }),
          reviewImages(scenes, '当时那张图'),
        ),
      )
      box.appendChild(
        h('div.sec', {}, h('div.sh', {}, h('span.eyebrow.noline', { text: '你现在怎么看' })), editor.parts.note),
      )
      box.appendChild(h('div.sec', {}, editor.parts.vsLast))
      return box
    }

    // 这一格里的小标题是编辑区自己带的，外面不再套一个一模一样的。
    box.appendChild(h('div.sec', {}, editor.parts.better))
    box.appendChild(
      h(
        'div.sec',
        {},
        h('div.sh', {}, h('span.eyebrow.noline', { text: '这次实际做了没有' })),
        h('div.tip', { text: '想法和成交是两件事。对上之后才看得出差在执行还是差在判断。' }),
        editor.parts.trades,
      ),
    )
    box.appendChild(editor.parts.banner)
    return box
  }

  /** 底下那条：上一步、下一步，以及最后一步的发布。 */
  function foot(editor: DraftEditor): HTMLElement {
    const bar = h('div.wizfoot')
    if (at.n > 1) {
      bar.appendChild(
        h('a.btn.ghost', {
          href: `#/review/${callId}/step/${at.n - 1}`,
          text: `上一步 · ${STEPS[at.n - 2]!.title}`,
        }),
      )
    } else {
      bar.appendChild(h('a.btn.ghost', { href: '#/review', text: '回到清单' }))
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
    const latest = record.reviews.length ? record.reviews[record.reviews.length - 1]! : null
    const now = record.current_outcomes?.[0] ?? null
    const box = h('div.wizdone')
    box.appendChild(
      h(
        'div.donetop',
        {},
        h('span.ic', {}, icon('check')),
        h('h1.wizt', { text: '这一次，你走完了一整轮' }),
        h('p.wizl', {
          text: '从市场开口之前说出那句话，到市场给出答案，再到你回头给它打分。下面是这一整轮的样子——往后同样的局面再来，就有得比了。',
        }),
      ),
    )
    const line = (k: string, v: string) => h('div.dl', {}, h('span.k', { text: k }), h('span.v', { text: v }))
    box.appendChild(
      h(
        'div.sec',
        {},
        line('当时说的', record.body.original_text || '（只有图）'),
        line('市场答的', now ? stateLook(now.result.state).label : '这条不判对错'),
        line('你写下的', latest?.body.note || '（这次没写文字）'),
        latest?.body.better_play ? line('下次改法', latest.body.better_play) : null,
      ),
    )
    box.appendChild(
      h(
        'div.wizfoot',
        {},
        h('a.btn.ghost', { href: '#/review', text: '回到复盘清单' }),
        h('a.btn.primary', { href: `#/call/${record.id}`, text: '重看这一整条' }),
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

function waitLine(record: CallDetail, outs: Outcome[]): HTMLElement | null {
  const answered = outs[0]?.created_at ?? null
  const gap = elapsed(record.body.original_claimed_at ?? record.submitted_at, answered)
  if (!gap || gap === '几乎同时') return null
  return h('div.tip', { text: `从你说出那句话到市场给出答案，中间隔了 ${gap}。` })
}

/** 当时凭什么这么想——记录那一刻真正被记下来的几件事。 */
function momentFacts(d: CallDetail): HTMLElement {
  const rows: { k: string; v: string; w: string }[] = [
    { k: '方向', v: STANCES[d.body.stance] ?? '没写', w: '方向来自你自己按下的那个按钮，系统不从中文里猜。' },
    { k: '谁先触发谁', v: PATHS[d.body.path] ?? '没记顺序', w: '先看到结构才有想法，还是先有想法再去找证据。' },
    {
      k: '当时的把握',
      v: d.body.confidence === null || d.body.confidence === undefined ? '没写' : `${d.body.confidence} 分`,
      w: '当时自己给的分，事后不许改。',
    },
    { k: '周期', v: d.timeframe ?? '未标周期', w: '看的是哪一张图上的结构。' },
  ]
  const grid = h('div.momentgrid')
  for (const row of rows) {
    grid.appendChild(
      h('div.mf', { title: row.w }, h('span.k', { text: row.k }), h('span.v', { text: row.v }), h('span.w', { text: row.w })),
    )
  }
  return h('div.sec', {}, h('div.sh', {}, h('span.eyebrow.noline', { text: '当时凭什么' })), grid)
}

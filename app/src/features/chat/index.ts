// 问过去的自己 —— `POST /v1/chat/runs` 起一次问答，再用 SSE 看着它跑完。
//
// 这一页最容易做坏的地方不是界面，是分寸。所以四条规矩写在最前面：
//
//   一、一次提问就是一次 run。中间断线了，带着 `Last-Event-ID` 从上次的序号接
//       着读同一个 run；绝不因为断线就再发起一次——那是让模型把整件事重跑一遍，
//       也可能把同一件事做两遍。
//   二、模型说要写东西（发布复盘、下裁决、订阅历史），后端不会替你做。它退回一
//       份提案：哪个操作、参数是什么、参数指纹是多少。页面把它原样摊开，等你自
//       己确认，再带着原样的指纹和你自己写下的意图重新问一次。模型的建议永远不
//       会自己变成动作。
//   三、答案是一段一段的，每一段自己带引用，还标着这一段是不是推断。这里不合并、
//       不改写、不给没有出处的段落补出处，也不把「相似」说成「概率」。
//   四、本机没接模型的时候后端会明说 `chat_model_not_configured`。那不是网络问
//       题：页面照实讲一句，不给一个编出来的答案。
//
// 还有一件要说在明处的事：后端不把两次提问接成一段对话，每一次问答都是独立的，
// 模型不会记得你上一句问了什么。页面就照这个样子呈现，不假装它有记性。

import * as attachmentsApi from '../../api/attachments'
import * as chat from '../../api/chat'
import { ApiError, explain } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import type { Uuid } from '../../api/types'
import { capabilityDetail, capabilityState } from '../../data/session'
import { dateTime } from '../../data/time'
import { go } from '../../router'
import { clear, h, type Child } from '../../ui/dom'
import { attachmentImage } from '../../ui/media'
import { openFileDialog } from '../../ui/pick'
import { empty, note, spinner, unavailable } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { kindLook } from '../recall/kinds'
import { sourcePane } from '../recall/source'
import { proposalCard } from './proposal'
import { toolEffect, toolLabel } from './tools'

/** 后端一次最多收四张图。 */
const MAX_IMAGES = 4

/** 断线之后接着读的次数上限。到顶就停下说一句，不无限重连。 */
const RECONNECTS = 6

interface Live {
  alive(): boolean
}

export function chatPage(host: HTMLElement, arg: string): () => void {
  let alive = true
  const live: Live = { alive: () => alive }
  const streams = new AbortController()
  const askAction = new WriteAction()
  const uploadAction = new WriteAction()

  const picked: Uuid[] = []

  const box = h('textarea#ask.textarea', {
    rows: 3,
    placeholder: '按你平时说话的样子问，比如「这种破位回踩我以前一般怎么说、后来对过几次」',
  }) as HTMLTextAreaElement

  const strip = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' })
  const transcript = h('div', { style: 'margin-top:18px' })

  const send = h('button.btn.primary', {
    type: 'button',
    text: '问',
    on: { click: () => void submit() },
  }) as HTMLButtonElement

  box.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  })

  async function submit(): Promise<void> {
    const message = box.value.trim()
    if (!message) {
      problem('先写下你想问的事。')
      box.focus()
      return
    }
    const sent = await start({ message, attachment_ids: [...picked], approved_actions: [] })
    // 没问出去就把原话留在框里。重打一遍是白费力气，何况刚才那一句才是他想问的。
    if (!sent) return
    box.value = ''
    picked.length = 0
    paintStrip()
  }

  /** 起一次问答。确认写入提案时走的也是这里，只是多带一条批准。 */
  async function start(input: chat.ChatAsk): Promise<boolean> {
    send.disabled = true
    try {
      // 同一次动作重试要复用这把钥匙，所以失败时不清掉它。
      const created = await chat.ask(input, askAction.keyFor(input))
      askAction.reset()
      if (!alive) return false
      const card = exchange(input, created)
      transcript.prepend(card.node)
      void follow(created.chat_run_id, card, input)
      return true
    } catch (error) {
      if (!alive) return false
      problem(askTrouble(error))
      return false
    } finally {
      send.disabled = false
    }
  }

  /**
   * 一次问答的框。它自己知道该往哪儿放什么，跟着它的那段流只管往里写。
   */
  function exchange(input: chat.ChatAsk, created: chat.ChatCreated) {
    const statusBox = h('div', { style: 'margin-top:10px' })
    const stepBox = h('div.inset', { style: 'margin-top:10px' })
    const answerBox = h('div', { style: 'margin-top:12px' })
    const proposalBox = h('div')
    const stopBox = h('div.acts', { style: 'margin-top:10px' })
    let steps = 0

    const node = h(
      'div.sheet.pad',
      { style: 'margin-top:14px' },
      h(
        'div',
        { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap' },
        h('span.eyebrow.noline', { text: '你问的' }),
        h('span.faint', { text: dateTime(new Date().toISOString()) }),
        input.approved_actions?.length
          ? h('span.tag', { text: '带着你的确认重问了一次' })
          : null,
      ),
      h('div', { style: 'margin-top:6px;white-space:pre-wrap;line-height:1.7', text: input.message }),
      input.attachment_ids?.length
        ? h(
            'div',
            { style: 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap' },
            ...input.attachment_ids.map((id) => attachmentImage(id, { alt: '带上的图', className: 'thumb', maxWidth: 180 })),
          )
        : null,
      statusBox,
      stepBox,
      answerBox,
      proposalBox,
      stopBox,
      h('div.faint', {
        style: 'margin-top:10px',
        text: `这次用的是 ${created.model_id}；后端给它的上限是 ${created.budgets.turns} 步、${created.budgets.seconds} 秒。`,
      }),
    )

    stepBox.appendChild(h('div.tip', { text: '它做了什么，都记在这儿：' }))

    return {
      node,
      status(...children: Child[]): void {
        clear(statusBox)
        for (const child of children) if (child) statusBox.append(child as Node | string)
      },
      step(text: string): void {
        steps += 1
        stepBox.appendChild(
          h(
            'div.line',
            { style: 'margin-top:6px' },
            h('span.faint.mono', { text: String(steps).padStart(2, '0') }),
            h('span', { text }),
          ),
        )
      },
      answer(blocks: chat.AnswerBlock[], modelId: string): void {
        clear(answerBox)
        answerBox.appendChild(answerView(blocks, modelId, live))
      },
      addProposal(card: HTMLElement): void {
        proposalBox.appendChild(card)
      },
      stop(button: HTMLElement | null): void {
        clear(stopBox)
        if (button) stopBox.appendChild(button)
      },
    }
  }

  type Card = ReturnType<typeof exchange>

  /** 跟着一次问答读到底。断线只补读，永远不重开一次问答。 */
  async function follow(runId: Uuid, card: Card, input: chat.ChatAsk): Promise<void> {
    let after = 0
    let tries = 0
    const seen = new Set<string>()
    card.status(spinner('排上队了，正在开始…'))
    card.stop(stopButton(runId, card))

    const onEvent = (row: chat.ChatEventRow): void => {
      if (row.sequence >= 0) {
        after = row.sequence
        tries = 0
      }
      handle(row, card, runId, input, seen)
    }

    for (;;) {
      try {
        await chat.stream(runId, after, onEvent, streams.signal)
      } catch (error) {
        if (!alive || Latest.aborted(error)) return
        tries += 1
        if (tries > RECONNECTS) {
          card.status(
            note('warn', '这条连接一直接不上。这次问答还在后端跑着，刷新页面之后可以从这条问答的地址接着看。'),
          )
          card.stop(null)
          return
        }
        card.status(spinner(`连接断了，正在从第 ${after} 条接着读…`))
        await pause(1500)
        if (!alive) return
        continue
      }
      if (!alive) return

      // 流结束不等于事情结束：以 GET 回来的状态为准。
      let state: chat.ChatRun | null = null
      try {
        state = await chat.run(runId, { signal: streams.signal })
      } catch (error) {
        if (!alive || Latest.aborted(error)) return
        card.status(note('warn', error instanceof ApiError ? error.message : '读不到这次问答的状态。'))
        card.stop(null)
        return
      }
      if (state.status === 'queued' || state.status === 'running') {
        tries += 1
        if (tries > RECONNECTS) {
          card.status(note('warn', '它还在跑，但这条连接读不下去了。稍后回到这一页接着看。'))
          card.stop(null)
          return
        }
        continue
      }
      finish(state, card)
      return
    }
  }

  function handle(
    row: chat.ChatEventRow,
    card: Card,
    runId: Uuid,
    input: chat.ChatAsk,
    seen: Set<string>,
  ): void {
    const data = row.data as Record<string, unknown>
    switch (row.type) {
      case 'created':
        card.step('开始了。')
        break
      case 'model_turn': {
        const turn = Number(data.turn ?? 0) + 1
        const count = Number(data.tool_count ?? 0)
        card.status(spinner(count ? `第 ${turn} 步：正在查 ${count} 处记录…` : `第 ${turn} 步：正在写答案…`))
        break
      }
      case 'tool_completed': {
        const name = String(data.name ?? '')
        const failed = data.has_error === true
        card.step(`${toolLabel(name)}${failed ? '——这一处没查成' : ''}`)
        const id = String(data.tool_call_id ?? '')
        if (!failed && toolEffect(name) === 'mutation' && id && !seen.has(id)) {
          seen.add(id)
          void showProposal(runId, id, card, input)
        }
        break
      }
      case 'answer':
        card.status(null)
        card.stop(null)
        card.answer((data.blocks as chat.AnswerBlock[]) ?? [], String(data.model_id ?? ''))
        break
      case 'budget_exhausted':
        card.status(
          note(
            'warn',
            `${explain(String(data.reason ?? ''))}已经查到的东西都留着了，把问题问得更具体一点再问一次。`,
          ),
        )
        card.stop(null)
        break
      case 'cancelled':
        card.status(note('info', '这次问答被你叫停了。'))
        card.stop(null)
        break
      case 'run_state':
        finish(data as unknown as chat.ChatRun, card)
        break
      case 'error':
        card.status(note('warn', explain(String(data.code ?? ''))))
        card.stop(null)
        break
      default:
        break
    }
  }

  /** 模型想写东西的时候，把它原样摊开，等一个明确的确认。 */
  async function showProposal(
    runId: Uuid,
    toolCallId: string,
    card: Card,
    input: chat.ChatAsk,
  ): Promise<void> {
    try {
      const proposal = await chat.proposalOf(runId, toolCallId, { signal: streams.signal })
      if (!alive || !proposal) return
      card.addProposal(
        proposalCard(proposal, (approved) => {
          void start({
            message: input.message,
            attachment_ids: input.attachment_ids ?? [],
            approved_actions: [...(input.approved_actions ?? []), approved],
          })
          toast('已经带着你的确认重新问了一次。')
        }),
      )
    } catch (error) {
      if (!alive || Latest.aborted(error)) return
      card.step('这一步想写点东西，但它的正文这次读不出来，所以没法给你确认。')
    }
  }

  function finish(state: chat.ChatRun, card: Card): void {
    card.stop(null)
    if (state.answer?.length) {
      card.status(null)
      card.answer(state.answer, state.model_id)
      return
    }
    if (state.error_code === 'chat_model_not_configured') {
      card.status(
        unavailable(
          '本机还没接问答用的模型',
          '这台机器上还没有配好回答问题的模型，所以这次问不出结果。这不是网络问题，也不会给你一个编出来的答案。按部署说明把它配上再来问。',
        ),
      )
      return
    }
    if (state.error_code) {
      card.status(note('warn', explain(state.error_code)))
      return
    }
    if (state.status === 'cancelled') {
      card.status(note('info', '这次问答被你叫停了。'))
      return
    }
    if (state.status === 'source_removed') {
      card.status(note('warn', '这次问答引到的一份来源已经不在了，所以它没有接着答下去。'))
      return
    }
    card.status(note('warn', '这次没有答案回来。已经查到的东西都留着了，可以换个问法再问一次。'))
  }

  function stopButton(runId: Uuid, card: Card): HTMLElement {
    const action = new WriteAction()
    const button = h('button.btn.sm.ghost', {
      type: 'button',
      text: '不用问了',
      title: '停在这里。已经查到的东西不会丢。',
      on: {
        click: async () => {
          ;(button as HTMLButtonElement).disabled = true
          try {
            const state = await chat.run(runId)
            await chat.cancel(
              runId,
              state.generation,
              action.keyFor({ runId, generation: state.generation }),
            )
            action.reset()
            if (!alive) return
            card.status(note('info', '停下了。已经查到的东西都留着。'))
            card.stop(null)
          } catch (error) {
            if (!alive) return
            ;(button as HTMLButtonElement).disabled = false
            if (error instanceof ApiError && error.code === 'chat_run_changed') {
              problem('它刚刚已经有进展了，先看一眼现在的状态再决定。')
              return
            }
            problem(error instanceof ApiError ? error.message : '这次没停下来。')
          }
        },
      },
    })
    return button
  }

  function paintStrip(): void {
    clear(strip)
    if (!picked.length) return
    for (const id of picked) {
      strip.appendChild(
        h(
          'div',
          { style: 'position:relative' },
          attachmentImage(id, { alt: '要带上的图', className: 'thumb', maxWidth: 180 }),
          h('button.btn.sm.ghost', {
            type: 'button',
            text: '不带了',
            on: {
              click: () => {
                const at = picked.indexOf(id)
                if (at >= 0) picked.splice(at, 1)
                paintStrip()
              },
            },
          }),
        ),
      )
    }
  }

  const attach = h('button.btn.sm.ghost', {
    type: 'button',
    text: '带一张图',
    title: '带上的是你自己传的截图。系统自己画的行情图不会进到问答里。',
    on: {
      click: () => {
        if (picked.length >= MAX_IMAGES) {
          problem(`一次最多带 ${MAX_IMAGES} 张。`)
          return
        }
        openFileDialog({
          onPick: (file) => void upload(file),
          onReject: (why) => problem(why),
        })
      },
    },
  })

  async function upload(file: File): Promise<void> {
    const key = uploadAction.keyFor({ name: file.name, size: file.size, at: file.lastModified })
    try {
      const record = await attachmentsApi.upload(file, 'query', key, { filename: file.name })
      uploadAction.reset()
      if (!alive) return
      picked.push(record.id)
      paintStrip()
    } catch (error) {
      if (!alive) return
      problem(error instanceof ApiError ? error.message : '这张图没传上去。')
    }
  }

  const ready = capabilityState('chat_generation') === 'ready'

  const composer = h(
    'div.sheet.pad',
    {},
    box,
    h(
      'div',
      { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px' },
      send,
      attach,
      h('span.faint', { text: '⌘/Ctrl + Enter 也能问。' }),
    ),
    h('div', { style: 'margin-top:10px' }, strip),
    note(
      'info',
      '它只用你自己记下来的东西回答：当时的判断、后来的复盘、系统给的结论、实盘和统计。答案里每一段都会标出处，推断的那几段会写明是推断。每次提问都是单独一次，它不记得你上一句问过什么。',
    ),
  )

  host.append(
    h(
      'div.phead',
      {},
      h(
        'div',
        {},
        h('h1.h1', {}, '问过去的自己', h('span.lat', { text: 'Ask' })),
        h('div.sub', {
          text: '把问题问回去：这种局面我以前是怎么说的、后来对过几次、什么时候不灵。回答它的不是一个懂行情的模型，是你自己攒下来的那些记录。',
        }),
      ),
      h('button.btn.sm.ghost', {
        type: 'button',
        text: '按意思找',
        style: 'margin-left:auto',
        title: '不想让它替你读，就自己去翻：同一批记录，按意思检索，看到的是原文片段。',
        on: { click: () => go('recall') },
      }),
    ),
    ready ? composer : gate(),
    transcript,
  )

  if (ready) {
    transcript.appendChild(
      empty({
        title: '问一句试试',
        tip: '问得越具体越好用：说清是哪种局面、哪个品种、大概什么时候，它才知道该去翻哪一批记录。',
      }),
    )
    const first = transcript.firstElementChild
    box.addEventListener('input', () => first?.remove(), { once: true })
  }

  if (arg) void resume(arg)

  /** 地址里带着一次问答的编号，就接着看那一次，而不是重新问一遍。 */
  async function resume(runId: string): Promise<void> {
    try {
      const state = await chat.run(runId, { signal: streams.signal })
      if (!alive) return
      const card = exchange(
        { message: '（这是之前问的那一次，问题原文没有存在这台浏览器里。）' },
        {
          chat_run_id: state.chat_run_id,
          job_id: state.chat_run_id,
          status: state.status,
          model_id: state.model_id,
          events_url: '',
          budgets: { turns: 12, parallel_reads: 4, seconds: 90 },
        },
      )
      transcript.prepend(card.node)
      if (state.status === 'queued' || state.status === 'running') {
        void follow(state.chat_run_id, card, { message: '' })
      } else {
        finish(state, card)
      }
    } catch (error) {
      if (!alive || Latest.aborted(error)) return
      problem(error instanceof ApiError ? error.message : '这次问答读不出来。')
    }
  }

  return () => {
    alive = false
    streams.abort()
  }
}

/**
 * 问不出去的原因要说准。这台机器上的后端如果根本没有问答这条接口（比如还是旧
 * 一版），那是部署没跟上，不是这一页写错了，也不是他问法不对——照实说，免得他
 * 去改问题、改浏览器，白费半天工夫。
 */
function askTrouble(error: unknown): string {
  const api = error instanceof ApiError ? error : null
  if (api?.status === 404) {
    return '这台机器上的后端没有问答这条接口，多半是它还是旧的一版。按部署说明把新的后端起起来再问。'
  }
  return api ? api.message : '这次没问出去，稍后再试。'
}

function gate(): HTMLElement {
  return unavailable(
    '本机还没接问答用的模型',
    '后端说这台机器上还没有配好回答问题的模型，所以这一页现在问不了。配置好了它自己就开了；在那之前，「按意思找」可以自己去翻同一批记录。',
  )
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 一段一段地摆答案。每一段自己带出处，推断的那几段自己标着。这里不合并段落，
 * 也不给没有出处的段落补出处——没有就是没有，这件事本身就要让人看见。
 */
function answerView(blocks: chat.AnswerBlock[], modelId: string, live: Live): HTMLElement {
  const node = h('div', {})
  node.appendChild(h('span.eyebrow.noline', { text: '它的回答' }))
  if (!blocks.length) {
    node.appendChild(note('warn', '这次没有答案回来。'))
    return node
  }
  for (const block of blocks) {
    const holder = h('div')
    const marks = h('div.line', { style: 'margin-top:8px;flex-wrap:wrap' })
    if (block.inference) {
      marks.appendChild(h('span.tag', { text: '这一段是推断' }))
    }
    if (!block.citations?.length) {
      marks.appendChild(
        h('span.faint', {
          text: block.inference ? '推断，没有直接的出处。' : '这一段没有给出处。',
        }),
      )
    }
    for (const cite of block.citations ?? []) {
      marks.appendChild(citationChip(cite, holder, live))
    }
    node.appendChild(
      h(
        'div',
        { style: 'margin-top:12px' },
        h('div', { style: 'white-space:pre-wrap;line-height:1.8', text: block.text }),
        marks,
        holder,
      ),
    )
  }
  node.appendChild(
    h('div.faint', { style: 'margin-top:12px', text: `以上由 ${modelId} 写成，出处都能自己点开核对。` }),
  )
  return node
}

function citationChip(cite: chat.Citation, holder: HTMLElement, live: Live): HTMLElement {
  const look = kindLook(cite.source_kind)
  const chip = h('button.btn.sm.ghost', {
    type: 'button',
    text: `出处：${look.label}`,
    title: '打开它引的那份来源，按当时那一版读原文。',
    on: {
      click: () => {
        if (holder.firstChild) {
          clear(holder)
          return
        }
        holder.appendChild(
          sourcePane(
            {
              source_kind: cite.source_kind,
              source_id: cite.source_id,
              source_version: cite.source_version,
            },
            live,
          ),
        )
      },
    },
  })
  return chip
}

export interface ChatPanel {
  node: HTMLElement
  /** 后端真的能回答问题了才是 true。 */
  live: boolean
}

/** 设置页里的那一小块：这台机器现在能不能问，能问就给个入口。 */
export function chatPanel(): ChatPanel {
  const ready = capabilityState('chat_generation') === 'ready'
  if (!ready) {
    return {
      live: false,
      node: panel(
        '还不能对着记录提问',
        '「这种行情我以前一般怎么说」这类问题，要等这台机器配上回答用的模型才能问。现在不给你一个编出来的答案。',
        null,
      ),
    }
  }
  return {
    live: true,
    node: panel(
      '可以对着自己的记录提问了',
      `这台机器用的是 ${capabilityDetail('chat_generation') ?? '本机配置的模型'}。它只用你记下来的东西回答，每一段都标出处；要写进记录的操作一律先问过你。`,
      h('button.btn.sm', { type: 'button', text: '去问一句', on: { click: () => go('chat') } }),
    ),
  }
}

function panel(title: string, why: string, action: HTMLElement | null): HTMLElement {
  return h(
    'div.sheet.pad.futurebox',
    {},
    h('div.h3', { text: title }),
    h('div.tip', { style: 'max-width:48ch', text: why }),
    action ? h('div', { style: 'margin-top:12px' }, action) : null,
  )
}

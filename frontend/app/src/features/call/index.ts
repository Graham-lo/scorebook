// 一条记录 —— one record, in full.
//
// Everything on this page comes from GET /v1/calls/{id}: the immutable body,
// the pictures with their identity, the settlements, the reviews, the tags and
// the episode links. Nothing is re-derived — the criteria sentence is read out
// of the stored criteria, and the verdict is whatever the backend last
// evaluated, never a number computed here.
//
// Every write on this page is an append guarded by `expected_revision`, and
// each one carries its own idempotency key, so a dropped connection replays
// instead of writing twice. After a write the record is re-read from the
// server rather than patched in place.

import { uploadWithProgress } from '../../api/attachments'
import { correct, supplement, voidCall } from '../../api/calls'
import { ApiError, NetworkError } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import { createTag, episode as fetchEpisode, linkEpisode, linkTag } from '../../api/knowledge'
import { chartSvg } from '../../api/market'
import * as reviews from '../../api/reviews'
import type {
  Attachment,
  AttachmentKind,
  CallDetail,
  Criteria,
  EpisodeLinkRecord,
  Outcome,
  ReviewDraftState,
  ReviewRecord,
  Uuid,
} from '../../api/types'
import { PATHS, STANCES, ruleRows, sentence } from '../../data/criteria'
import { flowOf, fromCallDetail } from '../../data/flow'
import { figures, head as headOutcome, original, pendingState, whyLine } from '../../data/outcome'
import { INTERVALS, INTERVAL_SECONDS, MARKET_LABELS } from '../../data/session'
import { Gate, detail, invalidate, knownTags, tagIndex } from '../../data/store'
import { dateTime, elapsed, horizon, relative } from '../../data/time'
import { go } from '../../router'
import {
  ATTACHMENT_IDENTITY,
  critHL,
  identityLabel,
  stamp,
  stanceBadge,
  tagChip,
} from '../../ui/bits'
import { append, clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { lightbox } from '../../ui/lightbox'
import { ChartView, attachmentImage } from '../../ui/media'
import { flowBar, nextUp } from '../../ui/flow'
import { stagger } from '../../ui/motion'
import { openFileDialog } from '../../ui/pick'
import { popChip } from '../../ui/pop'
import { empty, note as noteBox, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { invalidateLedger } from '../find'
import { displayId } from '../find/row'
import { locatePanel } from '../relive/locate'
import { REVIEW_ACTIONS } from '../review/draft'
import { tradeSummary } from '../review/trades'
import { searchLike } from '../search'
import { reviewImages } from '../../ui/image-picker'
import { executionSection } from './execution'

const CORRECTIONS: { value: 'metadata_evidence' | 'parser_error' | 'annotation'; label: string }[] =
  [
    { value: 'metadata_evidence', label: '品种、周期或截图信息写错了' },
    { value: 'parser_error', label: '按写法解析出来的结果不对' },
    { value: 'annotation', label: '补一条说明' },
  ]

export function callPage(host: HTMLElement, arg: string): () => void {
  const id = arg.split('/')[0] ?? ''
  const focusSection = arg.split('/')[1]
  let alive = true
  let data: CallDetail | null = null
  /** 草稿状态只用来判断这条走到哪一步了；正文还是由复盘编辑区自己读写。 */
  let draftState: ReviewDraftState | null | undefined

  const chart = new ChartView()
  const chartLane = new Latest()
  let chartFor: string | null = null

  const supplementAction = new WriteAction()
  const tagAction = new WriteAction()
  const correctAction = new WriteAction()
  const voidAction = new WriteAction()
  const episodeAction = new WriteAction()

  /** 复盘编辑区活得比一次重绘长，写到一半重画页面不会把它清掉。 */

  const crumb = h(
    'div.crumb',
    {},
    h('a', { href: '#/find', text: '我的记录' }),
    h('span.sep', { text: '›' }),
    h('span', { text: '这次判断' }),
  )
  const head = h('div.callhead')
  const grid = h('div.detail')
  host.append(crumb, head, grid)

  if (!id) {
    grid.replaceChildren(empty({ title: '没有指定记录', tip: '回到我的记录，从列表里打开一条。' }))
    return () => {
      alive = false
    }
  }

  grid.replaceChildren(spinner('正在读这条记录…'))
  void load()

  async function load(refresh = false): Promise<void> {
    try {
      const [fresh, saved] = await Promise.all([
        detail(id, { refresh }),
        // 草稿读不出来不该挡住整页；读不到就是「不知道有没有」，不冒充「没有」。
        reviews.draft(id).catch(() => undefined),
      ])
      if (!alive) return
      data = fresh
      draftState = saved
      render()
    } catch (error) {
      if (!alive) return
      grid.replaceChildren(
        empty({
          title: error instanceof ApiError && error.status === 404 ? '没有这条记录' : '这条读不出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('a.btn.sm', { href: '#/find', text: '回到我的记录' }),
        }),
      )
    }
  }

  /** Re-reads after a write so nothing on screen is a guess. */
  async function afterWrite(options: { ledger?: boolean } = {}): Promise<void> {
    invalidate(id)
    if (options.ledger) invalidateLedger()
    await load(true)
  }

  function render(): void {
    if (!data) return
    const d = data
    const body = d.body
    const claim = body.criteria[0] ?? null
    const now = headOutcome(d)
    const first = original(d.outcomes, 0)
    const flow = flowOf(fromCallDetail(d, draftState))

    clear(crumb)
    append(crumb, [
      h('a', { href: '#/find', text: '我的记录' }),
      h('span.sep', { text: '›' }),
      h('span.mono', { text: displayId({ id: d.id, submitted_at: d.submitted_at }) }),
    ])

    clear(head)
    append(head, [
      h(
        'div.ttl',
        {},
        stanceBadge(body.stance),
        h(
          'h1.h1',
          {},
          d.instrument ?? '未标品种',
          d.market ? h('span.lat', { text: MARKET_LABELS[d.market] }) : null,
        ),
        d.voided ? h('span.stamp.flat', { text: '已作废' }) : stamp(now ? now.result.state : pendingState(Boolean(claim))),
      ),
      h(
        'div.meta',
        {},
        h('span', { text: `${dateTime(d.submitted_at)} 记录` }),
        h('span.dot'),
        h('span', { text: d.timeframe ? `${d.timeframe} 周期` : '未标周期' }),
        h('span.dot'),
        h('span', { text: PATHS[body.path] ?? '顺序未记录' }),
        h('span.dot'),
        h('span', { text: `第 ${d.revision} 版` }),
      ),
      actionsRow(d, flow),
    ])
    head.appendChild(flowBar(flow, { lines: false }))
    if (!d.voided) head.appendChild(
      nextUp(flow, { why: false }, (href) => {
        // 「去写复盘」交给引导流程，那边一步一页。
        if (href.startsWith('#/review/')) {
          writeReview(d.id)
          return
        }
        const section = flow.next.kind === 'distill' ? 'distill' : 'result'
        document.getElementById(`call-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }),
    )

    // 这一页是把一次判断从头到尾重放一遍，不是把功能摊成一张仪表盘。
    // 顺序就是事情发生的顺序，中间隔了多久也照实写出来。
    const story = h('div.relive')
    const claimed = d.body.original_claimed_at ?? d.submitted_at
    const answered = now?.created_at ?? null
    const reviewed = d.reviews.length ? d.reviews[d.reviews.length - 1]!.created_at : null

    story.appendChild(
      chapter({
        n: 1,
        state: 'done',
        title: '当时',
        when: dateTime(claimed),
        parts: [viewer(d, ['scene', 'reference'], '这条没留图'), wordsSection(d), momentFacts(d)],
      }),
    )

    if (claim) {
      story.appendChild(
        chapter({
          n: 2,
          state: 'done',
          title: '定下的标准',
          when: `观察 ${horizon(claim.horizon_hours)}`,
          parts: [criteriaSection(d, claim)],
        }),
      )
    } else {
      story.appendChild(
        chapter({
          n: 2,
          state: 'skipped',
          title: '没有定标准',
          when: '不判对错',
          parts: [],
        }),
      )
    }

    // 没写标准的记录没有「等答案」这回事，别硬造一段等待出来。
    const wait = claim ? elapsed(claimed, answered ?? new Date().toISOString()) : null
    if (wait && wait !== '几乎同时') {
      story.appendChild(
        waitMark(
          answered ? `等了 ${wait}，市场给出答案` : `到现在过去了 ${wait}，还在等`,
          Boolean(answered),
        ),
      )
    }

    const answerParts = [resultSection(d, now, first)]
    const later = viewer(d, ['supplement'], null)
    if (later) answerParts.push(later)
    if (d.instrument && d.market) answerParts.push(chartSection(d))
    story.appendChild(
      chapter({
        n: 3,
        state: claim ? (answered ? 'done' : 'now') : 'skipped',
        title: '市场的答案',
        when: claim ? (answered ? dateTime(answered) : '还没有结果') : '没有对错可算',
        parts: answerParts,
      }),
    )

    const think = reviewed ? elapsed(answered ?? claimed, reviewed) : null
    if (think) story.appendChild(waitMark(`${think}之后，你回头看了一次`, true))

    story.appendChild(
      chapter({
        n: 4,
        state: d.reviews.length ? 'done' : answered ? 'now' : 'todo',
        title: '你的复盘',
        when: reviewed ? dateTime(reviewed) : '还没有写',
        parts: [reviewSection(d)],
      }),
    )

    story.appendChild(
      chapter({
        n: 5,
        state: d.episode_links.length || d.adoptions.length ? 'done' : 'todo',
        title: '这一条接到哪儿',
        when: linkFacts(d),
        parts: [episodeSection(d), executionSection(d)],
      }),
    )

    story.appendChild(
      h(
        'details.aboutrec',
        {},
        h('summary', {}, '这条记录本身：编号、校验、更正与作废'),
        h('div.stack', {}, factsSection(d), maintenanceSection(d)),
      ),
    )

    grid.replaceChildren(story)
    stagger([...story.children])
    if (focusSection === 'distill' || focusSection === 'result') {
      requestAnimationFrame(() => { if (alive) document.getElementById(`call-${focusSection}`)?.scrollIntoView({ block: 'center' }) })
    }
  }

  /* --------------------------------------------------------- 重放的骨架 */

  interface ChapterSpec {
    n: number
    state: 'done' | 'now' | 'todo' | 'skipped'
    title: string
    when: string
    parts: (HTMLElement | null)[]
  }

  /** 一段。左边是编号和那根竖线，右边是这一段里真正发生的事。 */
  function chapter(spec: ChapterSpec): HTMLElement {
    const body = h('div.chap-in')
    body.appendChild(
      h(
        'header.chap-h',
        {},
        h('span.chap-when', { text: spec.when }),
        h('h2.chap-t', { text: spec.title }),
      ),
    )
    for (const part of spec.parts) if (part) body.appendChild(part)
    return h(
      'article.chap',
      { attrs: { 'data-state': spec.state } },
      h('div.chap-rail', {}, h('span.n', { text: String(spec.n).padStart(2, '0') })),
      body,
    )
  }

  /** 两段之间的那段时间。重放的分量有一半在这儿。 */
  function waitMark(text: string, done: boolean): HTMLElement {
    return h('div.chap-wait', { class: done ? 'done' : '' }, h('span.d'), h('span.t', { text }))
  }

  /** 第五段的小字：连上了几段、几条做法。没连上就直说。 */
  function linkFacts(d: CallDetail): string {
    const bits: string[] = []
    if (d.episode_links.length) bits.push(`${d.episode_links.length} 段行情`)
    if (d.adoptions.length) bits.push(`${d.adoptions.length} 条做法`)
    return bits.length ? bits.join(' · ') : '还没有连上'
  }

  /** 当时凭什么这么想——记录那一刻真正被记下来的几件事。 */
  function momentFacts(d: CallDetail): HTMLElement {
    const rows: { k: string; v: string; why: string }[] = [
      {
        k: '方向',
        v: STANCES[d.body.stance] ?? '没写',
        why: '方向永远来自你自己按下的那个按钮，系统不从中文里猜。',
      },
      {
        k: '谁先触发谁',
        v: PATHS[d.body.path] ?? '没记顺序',
        why: '先看到图上的结构才有想法，还是先有想法再去图上找证据——这两种在你身上的可靠性要分开看。',
      },
      {
        k: '当时的把握',
        v: d.body.confidence === null || d.body.confidence === undefined ? '没写' : `${d.body.confidence} 分`,
        why: '当时自己给的分，事后不许改。它和结果对起来，才知道你的把握准不准。',
      },
      {
        k: '周期',
        v: d.timeframe ?? '未标周期',
        why: '看的是哪一张图上的结构。',
      },
    ]
    const box = h('div.sec', {}, h('div.sh', {}, h('span.eyebrow.noline', { text: '当时凭什么' })))
    const grid2 = h('div.momentgrid')
    for (const row of rows) {
      grid2.appendChild(
        h(
          'div.mf',
          { title: row.why },
          h('span.k', { text: row.k }),
          h('span.v', { text: row.v }),
        ),
      )
    }
    box.appendChild(grid2)
    return box
  }

  /* --------------------------------------------------------- 头部动作 */

  /** 写复盘不在这一页上，去那四步里写。 */
  function writeReview(id: Uuid): void {
    go(`review/${id}/step/1`)
  }

  /**
   * 主行动交给上面那一条流程说了算，这一行只留随时可做的几件事——不再摆一排
   * 同样重的按钮让人挑。
   */
  function actionsRow(d: CallDetail, flow: ReturnType<typeof flowOf>): HTMLElement {
    const row = h('div.actions-row')
    // 有图才有得重温：一张图都没有就没法把这条记录定位到某一段真实行情上。
    if (d.attachments.length) {
      row.appendChild(
        h('button.btn.primary', {
          text: '重温一遍',
          on: { click: () => go(`relive/${d.id}/1`) },
        }),
      )
    }
    if (!d.voided) {
      if (flow.next.kind !== 'write' && flow.next.kind !== 'continue' && d.reviews.length) {
        row.appendChild(
          h('button.btn.ghost', {
            text: '再写一条复盘',
            on: { click: () => writeReview(d.id) },
          }),
        )
      }
      row.appendChild(tagPicker(d).node)
      row.appendChild(
        h('button.btn.ghost', {
          text: '补后续走势',
          on: { click: () => addPicture(d, 'supplement') },
        }),
      )
      row.appendChild(
        h('button.btn.ghost', {
          text: '加参考图',
          on: { click: () => addPicture(d, 'reference') },
        }),
      )
    }
    return row
  }

  function tagPicker(d: CallDetail): { node: HTMLElement } {
    const linked = new Set(d.tags.map((t) => t.id))
    return popChip({
      label: () => '加标签',
      active: () => false,
      search: '搜标签，或直接输入新名字',
      items: async (query) => {
        await tagIndex()
        const q = query.trim()
        const rows = knownTags()
          .filter((t) => !linked.has(t.id))
          .filter((t) => !q || t.name.includes(q) || t.aliases.some((a) => a.includes(q)))
          .slice(0, 30)
          .map((t) => ({ label: `#${t.name}`, value: t.id, hint: t.definition || null }))
        const exact = knownTags().some((t) => t.name === q)
        if (q && !exact) {
          rows.unshift({ label: `新建标签「${q}」`, value: `new:${q}`, hint: null })
        }
        return rows.length ? rows : [{ label: '还没有标签', value: '', hint: null }]
      },
      onPick: (value) => {
        if (!value) return
        void attachTag(d, value)
      },
      footer: () => '标签存在记录上，可以在「我的记录」里按标签筛选。',
    })
  }

  async function attachTag(d: CallDetail, value: string): Promise<void> {
    try {
      let tagId = value
      if (value.startsWith('new:')) {
        const name = value.slice(4)
        const made = await createTag(
          { name, definition: '', aliases: [] },
          new WriteAction().keyFor({ name }),
        )
        tagId = made.id
        await tagIndex({ refresh: true })
      }
      const payload = { call_id: d.id, tag_id: tagId, expected_revision: d.revision }
      await linkTag(payload, tagAction.keyFor(payload))
      tagAction.reset()
      toast('标签已经挂上了。')
      await afterWrite({ ledger: true })
    } catch (error) {
      writeFailed(error, '标签没有挂上。', () => void attachTag(d, value))
    }
  }

  async function addPicture(d: CallDetail, kind: Extract<AttachmentKind, 'supplement' | 'reference'>): Promise<void> {
    openFileDialog({
      onReject: (why) => problem(why),
      onPick: (file) => {
        const bar = h('div.progress', {}, h('i'))
        host.prepend(bar)
        const fill = bar.firstElementChild as HTMLElement
        const key = supplementAction.keyFor({ name: file.name, size: file.size, at: file.lastModified })
        void (async () => {
          try {
            const uploaded = await uploadWithProgress(file, kind, key, {
              filename: file.name,
              capturedAt: file.lastModified && file.lastModified < Date.now() ? new Date(file.lastModified) : undefined,
              onProgress: (fraction) => {
                fill.style.width = `${Math.round(fraction * 100)}%`
              },
            })
            const payload = { attachment_id: uploaded.id, expected_revision: d.revision }
            await supplement(d.id, payload, new WriteAction().keyFor(payload))
            supplementAction.reset()
            bar.remove()
            toast(kind === 'supplement' ? '后续走势已经挂上，当时那张没有被改动。' : '参考图已经挂上。')
            await afterWrite()
          } catch (error) {
            bar.remove()
            writeFailed(error, '这张图没有挂上。')
          }
        })()
      },
    })
  }

  function writeFailed(error: unknown, fallback: string, retry?: () => void): void {
    if (error instanceof ApiError && error.isConflict) {
      problem('这条记录刚刚被改过，页面已经重新读取，请再试一次。')
      void afterWrite()
      return
    }
    const again = error instanceof NetworkError || (error instanceof ApiError && error.canRetry)
    problem(error instanceof Error ? error.message : fallback, again ? retry : undefined)
  }

  /* ------------------------------------------------------------- 左栏 */

  /**
   * 图看的时候要分开：当时那张是证据，后来那张是答案，它们属于这一页的两段。
   * `kinds` 说这一格放哪几种；一张都没有时，`emptyLine` 有话就摆一句，
   * 没话就整格不出现（后续走势本来就可以没有）。
   */
  function viewer(d: CallDetail, kinds: Attachment['kind'][], emptyLine: string | null): HTMLElement | null {
    const shots = [...d.attachments].filter((a) => kinds.includes(a.kind)).sort(order)
    if (!shots.length) {
      if (!emptyLine) return null
      return h(
        'div.viewer',
        {},
        h('div.bar', {}, h('span.eyebrow.noline', { text: '现场' })),
        h(
          'div.stage.paper',
          {},
          h('div.tip', { style: 'padding:34px 20px;text-align:center', text: emptyLine }),
        ),
      )
    }

    let index = 0
    const bar = h('div.bar')
    const stage = h('div.stage')
    const foot = h('div.foot')
    const pinBox = h('div.viewer-pin', { hidden: true })
    const box = h('div.viewer', {}, bar, stage, pinBox, foot)

    const paint = () => {
      const shot = shots[index] as Attachment
      clear(bar)
      if (shots.length > 1) {
        const seg = h('span.seg')
        shots.forEach((item, at) => {
          seg.appendChild(
            h('button', {
              class: at === index ? 'on' : '',
              text: identityLabel(item),
              on: {
                click: () => {
                  index = at
                  paint()
                },
              },
            }),
          )
        })
        bar.appendChild(seg)
      } else {
        bar.appendChild(h('span.eyebrow.noline', { text: identityLabel(shot) }))
      }
      bar.appendChild(
        h('span.meta', {
          text: `${shot.width}×${shot.height} · ${Math.round(shot.size / 1024)} KB`,
        }),
      )
      bar.appendChild(pinButton(d, shot, pinBox))
      const like = likeButton(d, shot)
      if (like) bar.appendChild(like)
      clear(pinBox)
      pinBox.hidden = true

      clear(stage)
      const image = attachmentImage(shot.id, {
        alt: `${d.instrument ?? '未标品种'} ${identityLabel(shot)}`,
        ratio: { width: shot.width, height: shot.height },
        // 这一张是证据本身，按原尺寸取；它也是这一页的主角，不等滚动。
        lazy: false,
        onReady: (url, node) => {
          node.addEventListener('click', () => lightbox(url, `${identityLabel(shot)} · ${dateTime(shot.uploaded_at)}`))
        },
      })
      stage.append(image, h('span.lb', { text: identityLabel(shot) }))
      if (shot.captured_at) {
        stage.appendChild(h('span.cap', { text: `截图时间 ${dateTime(shot.captured_at)}` }))
      }

      clear(foot)
      const identity = ATTACHMENT_IDENTITY[shot.kind]
      append(foot, [
        icon('info'),
        h('span', {
          text: shot.captured_at
            ? `${identity?.tip ?? ''}截图时间是你上传时声明的，系统没有办法证明。`
            : (identity?.tip ?? '') + `上传于 ${dateTime(shot.uploaded_at)}。`,
        }),
      ])
    }

    paint()
    return box
  }

  /**
   * 把这张图钉到真实行情的哪一段上。钉过一次就长期存着，以后重温直接读它，
   * 不再按图找，所以这里的按钮在钉过之后只报事实。
   */
  function pinButton(d: CallDetail, shot: Attachment, host: HTMLElement): HTMLElement {
    const pinned = shot.location ?? null
    const button = h('button.btn.sm.ghost', {
      text: pinned ? `已钉到 ${pinned.symbol} · ${pinned.interval}` : '钉到真实行情',
      on: {
        click: () => {
          if (!host.hidden) {
            host.hidden = true
            clear(host)
            return
          }
          host.hidden = false
          const panel = locatePanel({
            call: d,
            attachment: shot,
            onChange: () => void afterWrite(),
            // 身份改了，这一页上这张图的名字和排序都要跟着变。
            onKind: () => void afterWrite(),
          })
          host.replaceChildren(panel.node)
          if (!pinned) panel.start()
        },
      },
    })
    // 这一段是后端自动匹配上的，不是人确认的：把这件事标在按钮上。
    if (pinned?.matched_by === 'auto') button.appendChild(h('span.rlv-lauto', { text: '自动' }))
    return button
  }

  /**
   * 「这种画面以前在哪儿见过」——把这一张直接送进按图找，不用人再翻出来传一遍。
   *
   * 只有「当时」和「参考图」挂这个按钮：它们是人做判断时看的那个画面，比的就是
   * 这个。「后来」那张是答案不是局面，拿结果去找相似的开头，问的不是同一件事，
   * 所以那一格不出现这个按钮。
   *
   * 周期和市场是这条记录自己写过的，跟着带过去，省掉一次「明明就写在这儿」的
   * 手填；品种不带——默认先在任意品种里找，要盯住某一个是人自己去筛选里挑。
   */
  function likeButton(d: CallDetail, shot: Attachment): HTMLElement | null {
    if (shot.kind !== 'scene' && shot.kind !== 'reference') return null
    return h('button.btn.sm.ghost', {
      text: '找同类局面',
      on: {
        click: () =>
          searchLike(shot.id, {
            interval: d.timeframe,
            market: d.market,
            name: shot.kind === 'scene' ? '这条记录的现场图' : '这条记录的参考图',
          }),
      },
    })
  }

  function wordsSection(d: CallDetail): HTMLElement {
    const tags = h('div.row', { style: 'flex-wrap:wrap' })
    if (d.tags.length) {
      for (const tag of d.tags) {
        const chip = tagChip(tag.name)
        chip.classList.add('link')
        chip.setAttribute('role', 'button')
        chip.title = tag.definition || '在我的记录里按这个标签筛选'
        chip.addEventListener('click', () => go(`find/tag/${encodeURIComponent(tag.name)}`))
        tags.appendChild(chip)
      }
    } else {
      tags.appendChild(h('span.faint', { text: '没有标签' }))
    }

    return h(
      'div.sec',
      {},
      h(
        'div.sh',
        {},
        h('span.eyebrow.noline', { text: '原话' }),
        h('span.faint', { text: `${[...d.original_text].length} 字` }),
      ),
      // 原话是用户输入，按纯文本渲染。
      h('div.quote.lg', { text: d.original_text || '这条没有文字' }),
      tags,
    )
  }

  function criteriaSection(d: CallDetail, claim: Criteria | null): HTMLElement {
    const rules = h('div.rule-list')
    for (const row of ruleRows(claim)) {
      rules.appendChild(h('div.r', {}, h('span', { text: row.key }), h('span', { text: row.value })))
    }
    const extra = d.body.criteria.length > 1
      ? h('div.faint', { text: `共 ${d.body.criteria.length} 条标准，这里是第一条` })
      : null
    return h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '算对的标准' }), critHL(claim)),
      h('div.sentence', { text: sentence(claim) }),
      claim ? rules : null,
      extra,
    )
  }

  function reviewSection(d: CallDetail): HTMLElement {
    // 详情里只带最近 20 条，更早的按游标一页页取。这一节从旧读到新，所以
    // 「更早的」按钮在最上面，取回来的那一页也补在它下面。
    let cursor = d.history_pages?.reviews?.next_cursor ?? null
    let shown = d.reviews.length
    const count = h('span.faint', {
      text: shown ? `${shown} 条${cursor ? '（还有更早的）' : ''}` : '还没有复盘',
    })
    const box = h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '复盘' }), count),
    )

    const older = h('button.linkbtn', {
      type: 'button',
      text: '再看更早的 20 条',
      on: { click: () => void loadOlderReviews() },
    }) as HTMLButtonElement
    const olderRow = h('div', { style: 'margin-bottom:-4px' }, older)
    if (cursor) box.appendChild(olderRow)

    async function loadOlderReviews(): Promise<void> {
      if (!cursor) return
      older.disabled = true
      const label = older.textContent ?? ''
      older.textContent = '正在读…'
      try {
        const page = await reviews.history<ReviewRecord>(d.id, { kind: 'reviews', cursor, limit: 20 })
        if (!alive) return
        cursor = page.next_cursor
        shown += page.items.length
        // 这一页是从新到旧发回来的，插进来之前要倒过来，整节才还是从旧到新。
        const rows = [...page.items].reverse().map(reviewRow)
        olderRow.after(...rows)
        stagger(rows)
        count.textContent = `${shown} 条${cursor ? '（还有更早的）' : ''}`
        if (!cursor) olderRow.remove()
      } catch (error) {
        problem(error instanceof Error ? error.message : '更早的复盘没有读出来。', () => {
          void loadOlderReviews()
        })
      } finally {
        older.disabled = false
        if (older.textContent === '正在读…') older.textContent = label
      }
    }

    for (const item of [...d.reviews].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      box.appendChild(reviewRow(item))
    }
    if (d.voided) return box
    // 这一页是重看，不是写字的地方。写复盘在引导流程里，这里只放一个入口，
    // 怎么写、分几步，到了那边再说。
    box.appendChild(
      h(
        'div.rvstart',
        { style: 'margin-top:4px' },
        h('a.btn.primary', {
          href: `#/review/${d.id}/step/1`,
          text: d.reviews.length ? '再写一条复盘' : '开始复盘',
        }),
      ),
    )
    return box
  }

  function reviewRow(item: ReviewRecord): HTMLElement {
    const action = REVIEW_ACTIONS.find((a) => a.value === item.body.vs_last)
    return h(
      'div.inset',
      {},
      h(
        'div.row',
        { style: 'justify-content:space-between' },
        h('span.opt.on', {
          style: 'height:26px;font-size:12.5px;padding:0 12px',
          text: action?.label ?? item.body.vs_last,
        }),
        h('span.faint', { text: `${dateTime(item.created_at)} · ${relative(item.created_at)}` }),
      ),
      item.body.note ? h('div.quote.sm', { text: item.body.note }) : null,
      reviewImages(item.body.attachment_ids),
      tradeSummary(item.body.trades, item.body.trade_snapshots),
      item.body.better_play
        ? h(
            'div',
            {},
            h('div.faint', { style: 'margin-bottom:4px', text: '写下的改法' }),
            h('div.quote.sm', { text: item.body.better_play }),
          )
        : null,
    )
  }

  function chartSection(d: CallDetail): HTMLElement {
    const interval = d.timeframe && INTERVALS.includes(d.timeframe as never) ? d.timeframe : '1h'
    const seconds = INTERVAL_SECONDS[interval as keyof typeof INTERVAL_SECONDS] ?? 3600
    const submitted = new Date(d.submitted_at).getTime()
    const start = new Date(submitted - 120 * seconds * 1000)
    const end = new Date(Math.min(Date.now(), submitted + 60 * seconds * 1000))
    const request = {
      symbol: d.instrument as string,
      market: d.market as 'usd_m' | 'coin_m',
      interval,
      start_at: start.toISOString(),
      end_at: (end.getTime() > start.getTime() ? end : new Date(submitted + seconds * 1000)).toISOString(),
    }
    const key = JSON.stringify(request)
    if (chartFor !== key) {
      chartFor = key
      void chart.show((signal) => chartSvg(request, { signal: mergeSignal(signal) }))
    }
    return h(
      'div.sec',
      {},
      h(
        'div.sh',
        {},
        h('span.eyebrow.noline', { text: '这段行情' }),
        h('span.faint', { text: `系统图 · ${request.interval} · ${dateTime(request.start_at)} 起` }),
      ),
      chart.node,
    )
  }

  function mergeSignal(signal: AbortSignal): AbortSignal {
    const controller = new AbortController()
    const stop = () => controller.abort()
    signal.addEventListener('abort', stop)
    chartLane.begin().addEventListener('abort', stop)
    return controller.signal
  }

  /* ------------------------------------------------------------- 右栏 */

  function resultSection(d: CallDetail, now: Outcome | null, first: Outcome | null): HTMLElement {
    const box = h(
      'div.sec',
      { id: 'call-result' },
      h(
        'div.sh',
        {},
        h('span.eyebrow.noline', { text: '市场的答案' }),
        h('span.faint', { text: now ? `${dateTime(now.created_at)} 出结果` : '还没有算过对错' }),
      ),
      h(
        'div.verdict-line',
        {},
        stamp(now ? now.result.state : pendingState(Boolean(d.body.criteria[0])), true),
        h('span.why', { text: whyLine(now?.result ?? null) }),
      ),
    )

    const stats = figures(now?.result ?? null)
    if (stats.length) {
      const grid2 = h('div.stats')
      for (const row of stats) {
        grid2.appendChild(
          h('div.stat', {}, h('div.v', { text: row.value }), h('div.k', { text: row.key })),
        )
      }
      box.appendChild(grid2)
    }

    box.appendChild(pastResults(d, now, first))
    return box
  }

  /**
   * 同一条记录上，这个结果之前算成什么样。
   *
   * 结果不是改出来的，是重算出来的：数据补齐、规则重放都会新写一行，旧的一行原样
   * 留着。这里从新到旧列出来，最早那一次带一个标记——判断有没有进步，看的是当时
   * 那一次，不是后来重算的那一次。
   */
  function pastResults(d: CallDetail, now: Outcome | null, first: Outcome | null): HTMLElement {
    let cursor = d.history_pages?.outcomes?.next_cursor ?? null
    const past = d.outcomes
      .filter((o) => o.claim_no === 0 && o.id !== now?.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
    const wrap = h('details.disc')
    if (!past.length && !cursor) {
      wrap.hidden = true
      return wrap
    }
    const summary = h(
      'summary',
      {},
      icon('tri'),
      first && now && first.id !== now.id ? '这个结果重算过' : '之前算过的结果',
    )
    wrap.appendChild(summary)
    for (const row of past) wrap.appendChild(pastResultRow(row))

    const older = h('button.linkbtn', {
      type: 'button',
      text: '再看更早的 20 条',
      on: { click: () => void loadOlder() },
    }) as HTMLButtonElement
    const olderRow = h('div', {}, older)
    if (cursor) wrap.appendChild(olderRow)

    async function loadOlder(): Promise<void> {
      if (!cursor) return
      older.disabled = true
      older.textContent = '正在读…'
      try {
        const page = await reviews.history<Outcome>(d.id, { kind: 'outcomes', cursor, limit: 20 })
        if (!alive) return
        cursor = page.next_cursor
        // 这一页本来就是从新到旧，跟这一节的顺序一致，按原样接在按钮上面。
        const rows = page.items.filter((o) => o.claim_no === 0).map(pastResultRow)
        for (const row of rows) olderRow.before(row)
        stagger(rows)
        if (!cursor) olderRow.remove()
        else older.textContent = '再看更早的 20 条'
      } catch (error) {
        older.textContent = '再看更早的 20 条'
        problem(error instanceof Error ? error.message : '更早的结果没有读出来。', () => {
          void loadOlder()
        })
      } finally {
        older.disabled = false
      }
    }

    return wrap
  }

  /** 重算的来由用人话写；后端的 kind 是内部标识，不往外露。 */
  const OUTCOME_KIND: Record<Outcome['kind'], string> = {
    original: '第一次算的',
    data_revision: '行情数据补齐后重算',
    rule_replay: '按标准重新算了一次',
  }

  function pastResultRow(row: Outcome): HTMLElement {
    return h(
      'div.inset',
      {},
      h(
        'div.row',
        { style: 'justify-content:space-between' },
        h('span.faint', { text: OUTCOME_KIND[row.kind] ?? '重算了一次' }),
        h('span.faint', { text: dateTime(row.created_at) }),
      ),
      h(
        'div.verdict-line',
        {},
        stamp(row.result.state),
        h('span.why', { text: whyLine(row.result) }),
      ),
    )
  }

  function episodeSection(d: CallDetail): HTMLElement {
    const box = h('div.sec', { id: 'call-distill' }, h('div.sh', {}, h('span.eyebrow.noline', { text: '同一段行情' })))
    const link = d.episode_links[0] ?? null
    if (!link) {
      box.appendChild(
        h('div.faint', { text: '还没有连成一段行情' }),
      )
      return box
    }
    const chain = h('div.chain')
    chain.appendChild(h('div.tip', { text: '正在读这一段里的其它记录…' }))
    box.appendChild(chain)
    if (link.status === 'suggested' && !d.voided) {
      box.appendChild(
        h(
          'div.acts',
          {},
          h('button.btn.sm.primary', {
            text: '确认归入',
            on: { click: () => void setLink(d, link, 'confirmed') },
          }),
          h('button.btn.sm.ghost', {
            text: '不是一段',
            on: { click: () => void setLink(d, link, 'rejected') },
          }),
        ),
      )
    }
    box.appendChild(
      h('a', {
        href: `#/episode/${link.episode_id}`,
        style: 'font-size:12.5px',
        text: '看整段 →',
      }),
    )
    void fillChain(chain, d, link)
    return box
  }

  const chainGate = new Gate(3)
  /**
   * 一段行情在 120 小时的窗口里可以攒下几十条记录。整段的样子归「看整段」那一页，
   * 这里只要够看出前后文就行：取这条前后各几条，其余的用一句话说清楚还有多少。
   * 顺带也不用为整段每一条都去读一次详情。
   */
  const CHAIN_MAX = 8

  async function fillChain(chain: HTMLElement, d: CallDetail, link: EpisodeLinkRecord): Promise<void> {
    try {
      const found = await fetchEpisode(link.episode_id)
      if (!alive) return
      const kept = found.links
        .filter((l) => l.status !== 'rejected')
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      const near = around(kept, d.id, CHAIN_MAX)
      const members = await Promise.all(
        near.map((l) =>
          chainGate.run(async () => {
            try {
              return { link: l, call: await detail(l.call_id) }
            } catch {
              return null
            }
          }),
        ),
      )
      if (!alive) return
      const rows = members
        .filter((m): m is { link: EpisodeLinkRecord; call: CallDetail } => m !== null)
        .sort((a, b) => a.call.submitted_at.localeCompare(b.call.submitted_at))
      clear(chain)
      if (kept.length > near.length) {
        chain.appendChild(
          h('div.faint', {
            style: 'margin-bottom:6px',
            text: `这一段里一共 ${kept.length} 条，下面是这一条前后的 ${near.length} 条。`,
          }),
        )
      }
      for (const row of rows) {
        const isThis = row.call.id === d.id
        const words = row.call.original_text.trim() || '（只有图）'
        chain.appendChild(
          h(
            'div',
            { class: ['it', isThis ? 'cur' : '', row.link.status === 'suggested' ? 'sugg' : ''] },
            h('span.ln', {}, h('i')),
            h(
              'div.t',
              {},
              h('a', {
                href: `#/call/${row.call.id}`,
                text: words.length > 34 ? `${words.slice(0, 34)}…` : words,
              }),
              h('div.w', {
                text: `${dateTime(row.call.submitted_at)}${row.link.status === 'suggested' ? ' · 建议归入，待确认' : ''}`,
              }),
            ),
            stamp(
              headOutcome(row.call)?.result.state ??
                pendingState(Boolean(row.call.body.criteria[0])),
            ),
          ),
        )
      }
      chain.appendChild(
        h('div.faint', {
          style: 'margin-top:6px',
          text: `${found.episode.instrument} · ${dateTime(found.episode.anchor_at)} 起，窗口到 ${dateTime(found.episode.end_at)}`,
        }),
      )
    } catch {
      if (alive) chain.replaceChildren(h('div.tip', { text: '这一段暂时读不出来。' }))
    }
  }

  /** 以这条为中心截一段出来；它要是不在里面（理论上不会），就取最前面几条。 */
  function around(links: EpisodeLinkRecord[], callId: Uuid, max: number): EpisodeLinkRecord[] {
    if (links.length <= max) return links
    const here = links.findIndex((l) => l.call_id === callId)
    if (here < 0) return links.slice(0, max)
    const start = Math.max(0, Math.min(here - Math.floor(max / 2), links.length - max))
    return links.slice(start, start + max)
  }

  async function setLink(
    d: CallDetail,
    link: EpisodeLinkRecord,
    status: 'confirmed' | 'rejected',
  ): Promise<void> {
    const payload = {
      call_id: d.id,
      episode_id: link.episode_id,
      status,
      expected_revision: d.revision,
    }
    try {
      await linkEpisode(payload, episodeAction.keyFor(payload))
      episodeAction.reset()
      toast(status === 'confirmed' ? '已经归入这一段。' : '已经标记为不属于这一段。')
      await afterWrite()
    } catch (error) {
      writeFailed(error, '这次归组没有存下来。', () => void setLink(d, link, status))
    }
  }

  function factsSection(d: CallDetail): HTMLElement {
    const rows: [string, string][] = [
      ['记录编号', displayId({ id: d.id, submitted_at: d.submitted_at })],
      ['品种', d.instrument ?? '未标'],
      ['市场', d.market ? MARKET_LABELS[d.market] : '未标'],
      ['周期', d.timeframe ?? '未标'],
      ['记录时间', dateTime(d.submitted_at)],
      [
        '原话时间',
        d.body.original_claimed_at
          ? `${dateTime(d.body.original_claimed_at)}（你填写的，未经证明）`
          : '就是记录时间',
      ],
      ['把握程度', d.body.confidence === null || d.body.confidence === undefined ? '没有填' : `${d.body.confidence} / 100`],
      ['图文顺序', PATHS[d.body.path] ?? '顺序未记录'],
      ['来源入口', d.body.source_entry],
      ['当前版本', `第 ${d.revision} 版`],
    ]
    const list = h('dl.kv')
    for (const [key, value] of rows) {
      list.append(h('dt', { text: key }), h('dd', { text: value }))
    }
    const box = h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '这条记录本身' })),
      list,
    )
    if (d.adoptions.length) {
      box.appendChild(
        h('div.tip', {
          text: `这条记录标记了 ${d.adoptions.length} 条做法：${d.adoptions
            .map((a) => (a.executed === 'yes' ? '照做了' : a.executed === 'no' ? '没照做' : '没写是否照做'))
            .join('、')}。`,
        }),
      )
    }
    box.appendChild(
      h(
        'details.disc',
        {},
        h('summary', {}, icon('tri'), '技术细节'),
        h(
          'dl.kv',
          {},
          h('dt', { text: '记录 ID' }),
          h('dd.mono', { text: d.id }),
          h('dt', { text: '内容摘要' }),
          h('dd.mono', { text: d.digest.slice(0, 24) }),
          h('dt', { text: '标准版本' }),
          h('dd', { text: d.body.criteria[0]?.version ?? '没写标准' }),
        ),
      ),
    )
    return box
  }

  /* ------------------------------------------------- 更正 / 作废 */

  function maintenanceSection(d: CallDetail): HTMLElement | null {
    if (d.voided) return null

    let category: (typeof CORRECTIONS)[number]['value'] = 'metadata_evidence'
    const seg = h('span.seg')
    const paintSeg = () => {
      clear(seg)
      for (const item of CORRECTIONS) {
        seg.appendChild(
          h('button', {
            class: category === item.value ? 'on' : '',
            text: item.label,
            on: {
              click: () => {
                category = item.value
                paintSeg()
              },
            },
          }),
        )
      }
    }
    paintSeg()
    const explain = h('textarea.textarea', {
      rows: 2,
      placeholder: '写清楚哪里不对、正确的是什么。',
    }) as HTMLTextAreaElement

    const reason = h('textarea.textarea', {
      rows: 2,
      placeholder: '为什么要作废这条？',
    }) as HTMLTextAreaElement

    return h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '更正与作废' })),
      h(
        'details.disc',
        {},
        h('summary', {}, icon('tri'), '提交一条更正'),
        seg,
        explain,
        h(
          'div.acts',
          {},
          h('button.btn.sm', {
            text: '提交更正',
            on: {
              click: () => {
                const text = explain.value.trim()
                if (!text) {
                  problem('先写一句更正的内容。')
                  return
                }
                void submitCorrection(d, category, text, explain)
              },
            },
          }),
          h('span.faint', { text: '更正只是补一句说明，不会重新算对错。' }),
        ),
      ),
      h(
        'details.disc',
        {},
        h('summary', {}, icon('tri'), '作废这条记录'),
        noteBox('warn', '作废之后这条不再参与复盘，但内容一个字都不会被删掉。'),
        reason,
        h(
          'div.acts',
          {},
          h('button.btn.sm.danger', {
            text: '确认作废',
            on: {
              click: () => {
                const text = reason.value.trim()
                if (!text) {
                  problem('作废需要写一句原因。')
                  return
                }
                void submitVoid(d, text)
              },
            },
          }),
        ),
      ),
    )
  }

  async function submitCorrection(
    d: CallDetail,
    category: (typeof CORRECTIONS)[number]['value'],
    explanation: string,
    field: HTMLTextAreaElement,
  ): Promise<void> {
    const payload = { expected_revision: d.revision, category, explanation }
    try {
      const result = await correct(d.id, payload, correctAction.keyFor(payload))
      correctAction.reset()
      field.value = ''
      toast(result.automatic_rescore ? '更正已记录，会重新算一次对错。' : '更正已记录，结果不会因此改变。')
      await afterWrite()
    } catch (error) {
      writeFailed(error, '这条更正没有存下来。', () =>
        void submitCorrection(d, category, explanation, field),
      )
    }
  }

  async function submitVoid(d: CallDetail, reason: string): Promise<void> {
    const payload = { reason, expected_revision: d.revision }
    try {
      await voidCall(d.id, payload, voidAction.keyFor(payload))
      voidAction.reset()
      toast('这条已经标记为作废。')
      await afterWrite({ ledger: true })
    } catch (error) {
      writeFailed(error, '作废没有生效。', () => void submitVoid(d, reason))
    }
  }

  return () => {
    alive = false
    chart.cancel()
    chartLane.cancel()
  }
}

/** Scene shots come first; everything added later keeps its upload order. */
function order(a: Attachment, b: Attachment): number {
  const rank = (kind: AttachmentKind) => (kind === 'scene' ? 0 : kind === 'supplement' ? 1 : 2)
  return rank(a.kind) - rank(b.kind) || a.uploaded_at.localeCompare(b.uploaded_at)
}

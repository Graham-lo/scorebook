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
  ReviewRecord,
} from '../../api/types'
import { PATHS, ruleRows, sentence } from '../../data/criteria'
import { figures, head as headOutcome, original, pendingState, whyLine } from '../../data/outcome'
import { INTERVALS, MARKET_LABELS } from '../../data/session'
import { Gate, detail, invalidate, knownTags, tagIndex } from '../../data/store'
import { dateTime, relative } from '../../data/time'
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
import { stagger } from '../../ui/motion'
import { openFileDialog } from '../../ui/pick'
import { popChip } from '../../ui/pop'
import { empty, note as noteBox, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { invalidateLedger } from '../find'
import { displayId } from '../find/row'
import { draftEditor, REVIEW_ACTIONS, type DraftEditor } from '../review/draft'

/** The system chart is drawn from the same intervals the backend accepts. */
const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
}

const CORRECTIONS: { value: 'metadata_evidence' | 'parser_error' | 'annotation'; label: string }[] =
  [
    { value: 'metadata_evidence', label: '品种、周期或截图信息写错了' },
    { value: 'parser_error', label: '按写法解析出来的结果不对' },
    { value: 'annotation', label: '补一条说明' },
  ]

export function callPage(host: HTMLElement, arg: string): () => void {
  const id = arg.split('/')[0] ?? ''
  let alive = true
  let data: CallDetail | null = null

  const chart = new ChartView()
  const chartLane = new Latest()
  let chartFor: string | null = null

  const supplementAction = new WriteAction()
  const tagAction = new WriteAction()
  const correctAction = new WriteAction()
  const voidAction = new WriteAction()
  const episodeAction = new WriteAction()

  /** 复盘编辑区活得比一次重绘长，写到一半重画页面不会把它清掉。 */
  let form: DraftEditor | null = null

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
    grid.replaceChildren(empty({ art: 'info', title: '没有指定记录', tip: '回到我的记录，从列表里打开一条。' }))
    return () => {
      alive = false
    }
  }

  grid.replaceChildren(spinner('正在读这条记录…'))
  void load()

  async function load(refresh = false): Promise<void> {
    try {
      const fresh = await detail(id, { refresh })
      if (!alive) return
      data = fresh
      render()
    } catch (error) {
      if (!alive) return
      grid.replaceChildren(
        empty({
          art: 'info',
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
      actionsRow(d),
    ])

    const left = h('div.stack')
    const right = h('div.stack')
    append(left, [viewer(d), wordsSection(d), criteriaSection(d, claim), reviewSection(d)])
    append(right, [
      resultSection(d, now, first),
      episodeSection(d),
      factsSection(d),
      maintenanceSection(d),
    ])
    if (d.instrument && d.market) left.appendChild(chartSection(d))

    grid.replaceChildren(left, right)
    stagger([...left.children, ...right.children])
  }

  /* --------------------------------------------------------- 头部动作 */

  function actionsRow(d: CallDetail): HTMLElement {
    const row = h('div.actions-row')
    if (!d.voided) {
      row.appendChild(
        h('button.btn.primary', {
          text: d.reviews.length ? '再写一条复盘' : '复盘这条',
          on: {
            click: () => {
              document.querySelector('.rvform')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              document.querySelector<HTMLTextAreaElement>('.rvform textarea')?.focus()
            },
          },
        }),
      )
      row.appendChild(tagPicker(d).node)
      row.appendChild(
        h('button.btn.ghost', {
          text: '补图',
          on: { click: () => addPicture(d, 'supplement') },
        }),
      )
      row.appendChild(
        h('button.btn.ghost', {
          text: '加参考图',
          on: { click: () => addPicture(d, 'reference') },
        }),
      )
    } else {
      row.appendChild(
        h('span.faint', { text: '这条已经作废，只能查看；作废不会删除任何内容。' }),
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
            toast(kind === 'supplement' ? '补图已经挂上，原图没有被改动。' : '参考图已经挂上。')
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

  function viewer(d: CallDetail): HTMLElement {
    const shots = [...d.attachments].sort(order)
    if (!shots.length) {
      return h(
        'div.viewer',
        {},
        h('div.bar', {}, h('span.eyebrow.noline', { text: '现场' })),
        h(
          'div.stage.paper',
          {},
          h('div.tip', { style: 'padding:34px 20px;text-align:center', text: '这条只有话，没有留下图。' }),
        ),
      )
    }

    let index = 0
    const bar = h('div.bar')
    const stage = h('div.stage')
    const foot = h('div.foot')
    const box = h('div.viewer', {}, bar, stage, foot)

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

      clear(stage)
      const image = attachmentImage(shot.id, {
        alt: `${d.instrument ?? '未标品种'} ${identityLabel(shot)}`,
        ratio: { width: shot.width, height: shot.height },
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
        h('span.faint', { text: `${[...d.original_text].length} 字 · 记下来就不再改动` }),
      ),
      // 原话是用户输入，按纯文本渲染。
      h('div.quote.lg', { text: d.original_text || '（这条没有文字，只有图。）' }),
      tags,
    )
  }

  function criteriaSection(d: CallDetail, claim: Criteria | null): HTMLElement {
    const rules = h('div.rule-list')
    for (const row of ruleRows(claim)) {
      rules.appendChild(h('div.r', {}, h('span', { text: row.key }), h('span', { text: row.value })))
    }
    const extra = d.body.criteria.length > 1
      ? h('div.tip', { text: `这条记录写了 ${d.body.criteria.length} 条标准，下面显示的是第一条。` })
      : null
    return h(
      'div.sec',
      {},
      h('div.sh', {}, h('span.eyebrow.noline', { text: '算对的标准' }), critHL(claim)),
      h('div.sentence', { text: sentence(claim) }),
      claim ? rules : null,
      extra,
      h('div.tip', {
        text: claim
          ? '标准在记录那一刻就定下来了，之后不会因为行情变化而改动。'
          : '没写标准的记录不判对错，它只保留你当时说的话和看到的画面。',
      }),
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
    if (d.voided) {
      box.appendChild(h('div.tip', { text: '已作废的记录不再接受新的复盘。' }))
      return box
    }
    if (!form) {
      form = draftEditor({
        callId: d.id,
        lead: d.reviews.length
          ? '再看一次：这次和上一条复盘相比，判断变了没有？'
          : '行情已经走完了，现在你怎么看当时那句话？',
        reread: async () => detail(d.id, { refresh: true }),
        outcomes: () => d.current_outcomes ?? [],
        onPublished: () => {
          void afterWrite()
        },
      })
    }
    box.appendChild(form.node)
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
    const seconds = INTERVAL_SECONDS[interval] ?? 3600
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
        h('span.faint', { text: `${request.interval} · ${dateTime(request.start_at)} 起` }),
      ),
      chart.node,
      h('div.tip', {
        text: '系统图按行情源的标准参数临时绘制，只在这个页面里存在，不代表你当时看到的画面。',
      }),
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
      {},
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

    if (!now && d.body.criteria[0]) {
      box.appendChild(
        h('div.tip', {
          text: '到期后按你当时写下的标准自动算一次，算完出现在这里。这一格只由市场填，你填不了。',
        }),
      )
    }
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
    wrap.appendChild(
      h('div.tip', {
        text: '重算不会覆盖旧的一行，每一次算成什么样都留着，随时能对回去。',
      }),
    )

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
    const box = h('div.sec', {}, h('div.sh', {}, h('span.eyebrow.noline', { text: '同一段行情' })))
    const link = d.episode_links[0] ?? null
    if (!link) {
      box.appendChild(
        h('div.tip', {
          text: '这条还没有和别的记录连成一段行情。写下品种后，同品种 120 小时内的记录会自动连在一起。',
        }),
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
          h('span.faint', { text: '这是系统的建议，没有确认之前不算数。' }),
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

  async function fillChain(chain: HTMLElement, d: CallDetail, link: EpisodeLinkRecord): Promise<void> {
    try {
      const found = await fetchEpisode(link.episode_id)
      if (!alive) return
      const members = await Promise.all(
        found.links
          .filter((l) => l.status !== 'rejected')
          .map((l) =>
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

  function maintenanceSection(d: CallDetail): HTMLElement {
    if (d.voided) {
      return h(
        'div.sec',
        {},
        h('div.sh', {}, h('span.eyebrow.noline', { text: '已作废' })),
        h('div.tip', {
          text: '作废只是标记，原话、图片和已经算出来的结果都还在，随时可以查阅。',
        }),
      )
    }

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
      h('div.tip', {
        text: '原话不能修改——能改的判断就不算判断了。写错的信息用更正追加说明；看法变了就另记一条，两条都留着，正好看出你是在哪一步改的主意。',
      }),
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
    // 离开这一页之前把最后一次草稿补存掉，写到一半切走不算丢。
    void form?.flush().catch(() => undefined)
    form?.dispose()
    chart.cancel()
    chartLane.cancel()
  }
}

/** Scene shots come first; everything added later keeps its upload order. */
function order(a: Attachment, b: Attachment): number {
  const rank = (kind: AttachmentKind) => (kind === 'scene' ? 0 : kind === 'supplement' ? 1 : 2)
  return rank(a.kind) - rank(b.kind) || a.uploaded_at.localeCompare(b.uploaded_at)
}

// 一段行情 —— several judgements about the same stretch of one instrument.
//
// The backend groups calls into episodes and marks each link `suggested`,
// `confirmed`, `explicit` or `rejected`. A suggestion is the machine's guess,
// and this page says so: only the trader turns a suggestion into a confirmed
// link, and rejecting one is a normal, reversible thing to do. Confirming
// matters beyond tidiness — 按图搜索 keeps only the closest record per
// confirmed episode, so a confirmed chain stops the same trade crowding out
// everything else in a result list.

import { Latest, WriteAction } from '../../api/http'
import * as knowledge from '../../api/knowledge'
import type { CallDetail, Episode, EpisodeLinkRecord, Uuid } from '../../api/types'
import { MARKET_LABELS } from '../../data/session'
import { Gate, detail, invalidate } from '../../data/store'
import { dateTime, range as dateRange, relative } from '../../data/time'
import { head, pendingState } from '../../data/outcome'
import { stanceBadge, stamp } from '../../ui/bits'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { empty, ledgerSkeleton, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'

const lane = new Latest()
const gate = new Gate(3)
const linkAction = new WriteAction()

const STATUS: Record<EpisodeLinkRecord['status'], { label: string; tone: string; help: string }> = {
  suggested: { label: '待你确认', tone: 'wait', help: '系统看时间和品种觉得它们是同一段，还没有经过你。' },
  confirmed: { label: '你确认过', tone: 'ready', help: '你确认过这条属于这一段。' },
  explicit: { label: '你直接归入', tone: 'ready', help: '记录的时候你就写明了它属于这一段。' },
  rejected: { label: '你说不是', tone: 'no', help: '你说过它不属于这一段。' },
}

export function episodePage(host: HTMLElement, arg: string): () => void {
  let alive = true

  if (arg) void one(arg)
  else void many()

  /* ---------------------------------------------------------- 一段详情 */

  async function one(id: Uuid): Promise<void> {
    host.appendChild(ledgerSkeleton(3))
    const signal = lane.begin()
    try {
      const found = await knowledge.episode(id, { signal })
      if (!alive) return
      paintOne(found.episode, found.links)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(host)
      host.appendChild(
        empty({
          title: '这一段没有读出来',
          tip: error instanceof Error ? error.message : '也可能这一段已经不在了。',
          action: h('a.btn.sm.ghost', { href: '#/find', text: '回到我的记录' }),
        }),
      )
    }
  }

  function paintOne(episode: Episode, links: EpisodeLinkRecord[]): void {
    clear(host)
    host.appendChild(
      h(
        'div.crumb',
        {},
        h('a', { href: '#/find', text: '我的记录' }),
        h('span', { text: '›' }),
        h('span', { text: '一段行情' }),
      ),
    )
    host.appendChild(
      h(
        'div.sheet.pad',
        {},
        h(
          'div.row',
          { style: 'justify-content:space-between;gap:12px;align-items:baseline;flex-wrap:wrap' },
          h('h1.h1', { text: episode.instrument }),
          h('span.lat', { text: MARKET_LABELS[episode.market] }),
        ),
        h('div.line', { style: 'margin-top:6px' }, h('span', { text: dateRange(episode.anchor_at, episode.end_at) }), h('span.faint', { text: relative(episode.anchor_at) })),
      ),
    )

    const ordered = links
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    const chain = h('div.chain', { style: 'margin-top:18px' })
    ordered.forEach((link, index) => chain.appendChild(linkRow(link, index, episode)))
    host.appendChild(h('div.sheet.pad', { style: 'margin-top:18px' }, chain))
    stagger(chain.children)

    const waiting = ordered.filter((link) => link.status === 'suggested').length
    host.appendChild(
      note(
        'info',
        waiting
          ? `其中 ${waiting} 条还等着你确认。确认之后，按图搜索时这一段只会出现最接近的一条，不会刷屏。`
          : '这一段里的每一条你都表过态了。',
      ),
    )
  }

  /**
   * One record in the chain, drawn with the same chain markup the judgement
   * card uses so a trader sees one visual language in both places.
   */
  function linkRow(link: EpisodeLinkRecord, index: number, episode: Episode): HTMLElement {
    const meta = STATUS[link.status]
    const t = h('div.t', {}, h('div.sk.line', { style: 'width:58%' }))
    const row = h(
      'div',
      {
        class: [
          'it',
          link.status === 'suggested' ? 'sugg' : '',
          link.status === 'rejected' ? 'off' : '',
        ],
        style: `--i:${index}`,
      },
      h('span.ln', {}, h('i')),
      t,
    )

    void gate
      .run(() => detail(link.call_id))
      .then((record) => {
        if (alive) fill(record)
      })
      .catch(() => {
        if (alive) t.replaceChildren(h('div.w', { text: '这条记录读不出来。' }))
      })

    function fill(record: CallDetail): void {
      const words = record.original_text.trim() || '（只有图）'
      const head2 = h(
        'div.row',
        { style: 'gap:8px;flex-wrap:wrap' },
        h('a', {
          href: `#/call/${record.id}`,
          text: words.length > 40 ? `${words.slice(0, 40)}…` : words,
        }),
        stanceBadge(record.body.stance, true),
        verdict(record),
      )
      const under = h('div.w', {
        text: `${dateTime(link.created_at)} · ${meta.label}${record.timeframe ? ` · ${record.timeframe}` : ''}`,
        title: meta.help,
      })
      t.replaceChildren(head2, under)

      if (link.status !== 'suggested') return
      t.appendChild(
        h(
          'div.acts',
          { style: 'margin:8px 0 0' },
          decide(record, 'confirmed', '就是这一段'),
          decide(record, 'rejected', '不是这一段'),
        ),
      )
    }

    /** The frozen verdict if there is one, otherwise the state it waits in. */
    function verdict(record: CallDetail): HTMLElement {
      const now = head(record)
      return stamp(now?.result.state ?? pendingState(Boolean(record.body.criteria[0])))
    }

    function decide(record: CallDetail, status: 'confirmed' | 'rejected', label: string) {
      return h('button.btn.sm.ghost', {
        text: label,
        on: {
          click: (e: Event) => {
            const button = e.currentTarget as HTMLButtonElement
            button.disabled = true
            const input = {
              call_id: record.id,
              episode_id: episode.id,
              status,
              expected_revision: record.revision,
            }
            void knowledge
              .linkEpisode(input, linkAction.keyFor(input))
              .then(() => {
                linkAction.reset()
                invalidate(record.id)
                if (!alive) return
                toast(status === 'confirmed' ? '已经归入这一段。' : '已经记为不属于这一段。')
                void one(episode.id)
              })
              .catch((error) => {
                button.disabled = false
                problem(
                  error instanceof Error ? error.message : '这次没有存下来，再试一次。',
                )
              })
          },
        },
      })
    }

    return row
  }

  /* ------------------------------------------------------------ 全部段 */

  async function many(): Promise<void> {
    host.appendChild(
      h(
        'div.sheet.pad',
        {},
        h('h1.h1', { text: '一段一段的行情' }),
      ),
    )
    const list = h('div', { style: 'margin-top:18px' })
    host.appendChild(list)
    list.appendChild(spinner('正在读…'))

    const signal = lane.begin()
    try {
      const page = await knowledge.episodes(null, { signal })
      if (!alive) return
      clear(list)
      if (!page.items.length) {
        list.appendChild(
          empty({
            title: '还没有成段的行情',
            tip: '同一个品种上短时间里写下两三条判断，它们就会被拢成一段。',
            action: h('a.btn.sm.ghost', { href: '#/find', text: '去看全部记录' }),
          }),
        )
        return
      }
      const grid = h('div.tagwall')
      page.items.forEach((episode, index) =>
        grid.appendChild(
          h(
            'a.tagcard',
            { href: `#/episode/${episode.id}`, style: `--i:${index}` },
            h(
              'div.row',
              { style: 'justify-content:space-between;gap:10px;align-items:baseline' },
              h('span.tagname', { text: episode.instrument }),
              h('span.faint', { text: MARKET_LABELS[episode.market] }),
            ),
            h('div.def', { text: dateRange(episode.anchor_at, episode.end_at) }),
            h('div.faint', { style: 'margin-top:8px', text: relative(episode.anchor_at) }),
          ),
        ),
      )
      list.appendChild(grid)
      stagger(grid.children)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      clear(list)
      list.appendChild(
        empty({
          title: '没有读出来',
          tip: error instanceof Error ? error.message : '稍后再试一次。',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void many() } }),
        }),
      )
    }
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

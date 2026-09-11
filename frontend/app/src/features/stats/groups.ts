// 分组 —— 同一条规则、同一个品种算一组。价位不一样就是两组，后端不会替你把
// 「差不多的位置」合并；这是口径里最要紧的一条，也是这一页能被信任的原因。
//
// 一组展开之后是它的成员：这一组到底由哪几条记录组成，哪几条不算数、为什么不算
// 数。比例的分母摆在成员表里，点开就能对。

import { groups as fetchGroups, members, type GroupMetric, type Member } from '../../api/statistics'
import type { OutcomeState, Uuid } from '../../api/types'
import { percent } from '../../data/decimal'
import { summary, sentence } from '../../data/criteria'
import { stateLook } from '../../data/outcome'
import { dateTime, shortDate } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { stagger } from '../../ui/motion'
import { note, spinner } from '../../ui/states'
import type { RunView } from './index'
import { exclusionText, kv, share, shortSignature, type Live } from './shared'

export function groupsSheet(live: Live): {
  node: HTMLElement
  paint: (view: RunView) => void
} {
  const rows = h('div', { style: 'padding:6px 18px 0' })
  const foot = h('div', { style: 'padding:10px 18px 16px' })
  const right = h('span.faint', { style: 'margin-left:auto' })
  const node = h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '一组一组地看' }), right),
    rows,
    foot,
  )

  let shownRun: Uuid | null = null

  function paint(view: RunView): void {
    const run = view.run
    if (!run || run.status !== 'ready' || !run.stats) {
      if (shownRun !== null) {
        shownRun = null
        clear(rows)
        clear(foot)
      }
      right.textContent = ''
      if (!rows.firstChild) {
        rows.appendChild(h('div.tip', { text: '数完之后，这里按规则一组一组地列出来。' }))
      }
      return
    }
    if (shownRun === run.id) return
    shownRun = run.id
    clear(rows)
    clear(foot)
    const stats = run.stats
    right.textContent = `${stats.group_count} 组`
    if (!stats.groups.length) {
      rows.appendChild(
        h('div.tip', {
          text: '这一份里没有任何一组：符合条件的记录要么都不算数，要么还没有结论。上面的「不算数的」写着为什么。',
        }),
      )
      return
    }
    stagger(stats.groups.map((group) => rows.appendChild(groupRow(run.id, group, live))))

    let cursor = stats.groups_complete ? null : (stats.groups.at(-1)?.signature ?? null)
    if (cursor) {
      const more = h('button.btn.sm.ghost', {
        type: 'button',
        text: '再列一些',
        on: {
          click: () => {
            more.disabled = true
            void fetchGroups(run.id, cursor)
              .then((page) => {
                if (!live.alive()) return
                stagger(page.items.map((g) => rows.appendChild(groupRow(run.id, g, live))))
                cursor = page.next_cursor
                if (!cursor) more.remove()
              })
              .catch((error: unknown) => {
                foot.appendChild(
                  note('warn', error instanceof Error ? error.message : '这一页读不到。'),
                )
              })
              .finally(() => {
                more.disabled = false
              })
          },
        },
      }) as HTMLButtonElement
      foot.appendChild(more)
    }
    foot.appendChild(
      h('div.tip', {
        style: 'margin-top:8px',
        text: '分母是「有结论的条数」，也就是兑现加未兑现。观察中、未触发、没写标准、数据不足都不进分母，也不算失败。',
      }),
    )
  }

  return { node, paint }
}

function groupRow(runId: Uuid, group: GroupMetric, live: Live): HTMLElement {
  const rate = share(group.realization_rate)
  const head = h(
    'div.lrow',
    { role: 'button', tabIndex: 0 },
    h('div.body', {}, headLine(group), h('div.tip', { style: 'margin-top:3px' }, subLine(group))),
    h(
      'div.side',
      {},
      h('div.mono', { text: rate ?? '—' }),
      h('div.faint', { style: 'font-size:11px', text: `${group.numerator}/${group.denominator}` }),
    ),
  )
  const pane = h('div', { hidden: true, style: 'padding:4px 0 14px' })
  let loaded = false

  const toggle = () => {
    pane.hidden = !pane.hidden
    head.classList.toggle('on', !pane.hidden)
    if (!pane.hidden && !loaded) {
      loaded = true
      void loadMembers(runId, group, pane, live)
    }
  }
  head.addEventListener('click', toggle)
  head.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })
  return h('div', {}, head, pane)
}

function headLine(group: GroupMetric): HTMLElement {
  const line = h('div', { style: 'display:flex;gap:9px;align-items:center;flex-wrap:wrap' })
  line.appendChild(h('span.mono', { text: `规则 #${shortSignature(group.signature)}` }))
  line.appendChild(h('span.faint', { text: `${group.representative_count} 条代表` }))
  if (group.recheck) {
    line.appendChild(
      h('span.tag.warn', {
        text: '最近变差了',
        title: '最近十条的兑现比例，比这一组整体低 20 个百分点以上。这是提醒你再看一眼，不是结论。',
      }),
    )
  }
  return line
}

function subLine(group: GroupMetric): string {
  const bits: string[] = []
  const recent = share(group.recent_rate)
  if (recent && group.recent_explicit_count) {
    bits.push(`最近 ${group.recent_explicit_count} 条 ${recent}`)
  }
  const mfe = percent(group.mfe_median)
  const mae = percent(group.mae_median)
  if (mfe) bits.push(`最有利中位数 ${mfe}`)
  if (mae) bits.push(`最不利中位数 ${mae}`)
  const days = group.trigger_day_distribution
  if (days.length) {
    const first = days[0]
    const last = days.at(-1)
    bits.push(
      `触发落在 ${days.length} 天里（${shortDate(first?.day ?? null)} — ${shortDate(last?.day ?? null)}）`,
    )
  }
  return bits.length ? bits.join(' · ') : '这一组还没有可算的结论。'
}

async function loadMembers(
  runId: Uuid,
  group: GroupMetric,
  pane: HTMLElement,
  live: Live,
): Promise<void> {
  clear(pane)
  pane.appendChild(spinner('正在把这一组的成员读出来…'))
  let cursor: number | null = null
  let described = false
  const list = h('div')
  const foot = h('div', { style: 'margin-top:10px' })

  const step = async (): Promise<void> => {
    const page = await members(runId, {
      group_signature: group.signature,
      cursor: cursor ?? undefined,
    })
    if (!live.alive()) return
    if (!described) {
      clear(pane)
      const first = page.items[0]
      if (first) pane.appendChild(ruleCard(first, group))
      pane.appendChild(list)
      pane.appendChild(foot)
      described = true
    }
    stagger(page.items.map((member) => list.appendChild(memberRow(member))))
    cursor = page.next_cursor
    clear(foot)
    if (cursor !== null) {
      const more = h('button.btn.sm.ghost', {
        type: 'button',
        text: '再看一些成员',
        on: {
          click: () => {
            more.disabled = true
            void step().catch((error: unknown) => {
              foot.appendChild(note('warn', error instanceof Error ? error.message : '读不到。'))
            })
          },
        },
      }) as HTMLButtonElement
      foot.appendChild(more)
    }
  }

  try {
    await step()
  } catch (error) {
    if (!live.alive()) return
    clear(pane)
    pane.appendChild(
      note(
        'warn',
        error instanceof Error ? error.message : '这一组的成员读不出来，稍后再试。',
      ),
    )
  }
}

/** 这一组到底是哪一条规则。名字是从成员身上读出来的，不是从哈希猜的。 */
function ruleCard(member: Member, group: GroupMetric): HTMLElement {
  const c = member.body.criteria
  const what = summary(c)
  const rows: (readonly [string, string])[] = [
    ['品种', member.body.instrument ?? '没写'] as const,
    ['市场', member.body.market ?? '没写'] as const,
  ]
  if (member.body.timeframe) rows.push(['周期', member.body.timeframe] as const)
  rows.push(['有结论的', `${group.denominator} 条，其中兑现 ${group.numerator} 条`] as const)
  return h(
    'div.inset',
    { style: 'margin-bottom:12px' },
    h('div.h3', { text: `${what.main}${what.sub ? ` · ${what.sub}` : ''}` }),
    h('div.sentence', { style: 'margin-top:6px', text: sentence(c) }),
    h('div', { style: 'margin-top:10px' }, kv(rows)),
  )
}

function memberRow(member: Member): HTMLElement {
  const look = stateLook(member.state as OutcomeState)
  const marks = h('div', { style: 'display:flex;gap:7px;align-items:center;flex-wrap:wrap' })
  marks.appendChild(h('span', { class: `stamp flat ${look.stamp}`, text: look.label }))
  if (member.representative) {
    marks.appendChild(
      h('span.tag', { text: '代表', title: '同一段行情、同一条规则里，进分母的就是这一条。' }),
    )
  }
  if (!member.eligible) {
    marks.appendChild(h('span.tag.warn', { text: '不算数' }))
  } else if (!member.selected) {
    marks.appendChild(h('span.tag', { text: '被下场筛掉' }))
  }
  const why = member.eligible ? '' : exclusionText(member.exclusion_reason)
  return h(
    'div.member',
    {},
    h('div.d', { text: shortDate(member.submitted_at) }),
    h(
      'div.q',
      {},
      marks,
      why ? h('div.tip', { style: 'margin-top:4px', text: why }) : null,
      member.processing_state && member.processing_state !== 'absent'
        ? h('div.tip', {
            style: 'margin-top:4px',
            text: `结论还没落定，停在「${member.processing_state}」。`,
          })
        : null,
    ),
    h('div.d', { text: `#${member.ordinal}`, title: `记录于 ${dateTime(member.submitted_at)}` }),
  )
}

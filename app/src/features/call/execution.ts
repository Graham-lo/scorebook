// 把实际成交关联到这条记录上 —— 事后的关联，不是入场前的依据。
//
// 这件事只能事后做：成交发生在写下判断之后，关联又发生在成交之后。界面上因此从头
// 到尾这么说，绝不能让一条事后补上的关联看起来像是入场之前就有的证据。后端自己也
// 在回执里写着 `retrospective_link_not_prior_adoption`，这一页把它照实说给人听。
//
// 还有一条要如实说的：v4 只有写入这一条路，没有把已有关联读回来的接口。所以这一页
// 只能显示你刚刚写下的那条；以前写过的在这里看不到——那是接口还没有，不是没写成功。
// 与其编一个看起来完整的列表，不如把这句话说明白。

import { Latest, WriteAction } from '../../api/http'
import * as trades from '../../api/trades'
import type { CallDetail, ExchangeConnection, FillRow, Uuid } from '../../api/types'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { icon } from '../../ui/icons'
import { note as noteBox, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { figure, money, positionSideLabel, sideLabel } from '../trades/bits'

type Relation = 'executed' | 'rejected' | 'related'

const RELATIONS: { value: Relation; label: string; why: string }[] = [
  { value: 'executed', label: '照这条做了', why: '这几笔成交就是按这条记录进出的' },
  {
    value: 'rejected',
    label: '看了没照做',
    why: '这条当时没执行；选中的成交是同一段时间里你实际做的，用来说明当时做了什么',
  },
  { value: 'related', label: '有关，但不是照着做的', why: '两边有关系，但不是按这条进出的' },
]

const lane = new Latest()
const linkAction = new WriteAction()

export function executionSection(d: CallDetail): HTMLElement {
  const relation: { value: Relation } = { value: 'executed' }
  const picked = new Set<Uuid>()
  let connections: ExchangeConnection[] = []
  let rows: FillRow[] = []
  /** 这一次会话里刚写下的那条，改口的时候要指着它。 */
  let head: Uuid | null = null

  const account = h('select.input', { style: 'max-width:280px' }) as HTMLSelectElement
  const symbol = h('input.input', {
    style: 'width:180px',
    value: d.instrument ?? '',
    placeholder: '合约，例如 BTCUSDT',
  }) as HTMLInputElement
  const from = h('input.input', { type: 'date', value: dayOf(d.submitted_at) }) as HTMLInputElement
  const to = h('input.input', { type: 'date' }) as HTMLInputElement
  const list = h('div', { style: 'margin-top:12px' })
  const evidence = h('textarea.textarea', {
    rows: 2,
    placeholder: '为什么说这几笔和这条记录有关：当时怎么下的、按的是哪一句。',
  }) as HTMLTextAreaElement
  const seg = h('span.seg')
  const done = h('div', { style: 'margin-top:12px' })

  function paintSeg(): void {
    clear(seg)
    for (const item of RELATIONS) {
      seg.appendChild(
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
      )
    }
  }
  paintSeg()

  async function loadAccounts(): Promise<void> {
    if (connections.length) return
    try {
      const page = await trades.connections({}, { signal: lane.begin() })
      connections = page.items
      clear(account)
      for (const c of connections) {
        const option = document.createElement('option')
        option.value = c.id
        option.textContent = `${c.name} · ${c.account_label}${c.disabled_at ? '（已断开）' : ''}`
        account.appendChild(option)
      }
      if (!connections.length) {
        clear(list)
        list.appendChild(
          noteBox('info', '还没有登记过交易账户，所以没有成交可以关联。到「实盘 · 账本维护」先登记一个。'),
        )
      }
    } catch (error) {
      if (Latest.aborted(error)) return
      clear(list)
      list.appendChild(
        noteBox('warn', error instanceof Error ? error.message : '账户列表没有读出来。'),
      )
    }
  }

  async function search(): Promise<void> {
    const connectionId = account.value
    if (!connectionId) {
      problem('先选一个账户。')
      return
    }
    picked.clear()
    clear(list)
    list.appendChild(spinner('正在找这一段的成交…'))
    try {
      const page = await trades.fills(
        {
          connection_id: connectionId,
          symbol: symbol.value.trim().toUpperCase() || undefined,
          start_at: dayStart(from.value),
          end_at: dayEnd(to.value),
        },
        { signal: lane.begin() },
      )
      rows = page.items
      clear(list)
      if (!rows.length) {
        list.appendChild(
          h('div.faint', { text: '这一段没有成交。换个时间范围，或者先把这一段的账导进来。' }),
        )
        return
      }
      const box = h('div.ledger')
      for (const row of rows) box.appendChild(fillPick(row))
      list.append(box)
      if (page.next_cursor) {
        list.appendChild(
          h('div.tip', {
            style: 'margin-top:8px',
            text: '这一段的成交还没列完。把时间范围缩小一点，好把要关联的那几笔都摆出来。',
          }),
        )
      }
    } catch (error) {
      if (Latest.aborted(error)) return
      clear(list)
      list.appendChild(
        noteBox('warn', error instanceof Error ? error.message : '这一段的成交没有读出来。'),
      )
    }
  }

  function fillPick(row: FillRow): HTMLElement {
    const f = row.fill
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement
    box.addEventListener('change', () => {
      if (box.checked) picked.add(row.id)
      else picked.delete(row.id)
    })
    return h(
      'label.lrow',
      { style: 'cursor:pointer' },
      h(
        'div.body',
        { style: 'display:flex;gap:12px;align-items:flex-start' },
        box,
        h(
          'div',
          { style: 'min-width:0' },
          h(
            'div.row',
            { style: 'gap:8px;align-items:center;flex-wrap:wrap' },
            h('span.h3', { text: f.symbol }),
            h('span.tag', { text: sideLabel(f.side) }),
            h('span.faint', { text: positionSideLabel(f.position_side) }),
            f.liquidation ? h('span.tag.warn', { text: '强平' }) : null,
          ),
          h('div.faint', { style: 'margin-top:4px', text: dateTime(f.traded_at) }),
          h(
            'div.row',
            { style: 'gap:14px;margin-top:6px;flex-wrap:wrap' },
            figure(f.price),
            figure(f.quantity),
            money(f.commission, f.commission_asset),
          ),
        ),
      ),
    )
  }

  const save = h('button.btn.sm', { text: '关联这几笔' }) as HTMLButtonElement
  save.addEventListener('click', () => {
    const text = evidence.value.trim()
    if (!picked.size) {
      problem('至少要选一笔成交。关联指的是具体哪几笔，不是一段时间。')
      return
    }
    if (!text) {
      problem('写一句：这几笔和这条记录是什么关系。以后回头看，只有这句话说得清当时的情况。')
      return
    }
    const payload: trades.ExecutionLink = {
      connection_id: account.value,
      trade_ids: [...picked],
      call_id: d.id,
      relation: relation.value,
      evidence: text,
      supersedes: head,
    }
    save.disabled = true
    save.textContent = '正在关联…'
    void trades
      .linkExecution(payload, linkAction.keyFor(payload))
      .then((result) => {
        linkAction.reset()
        head = result.execution_link_id
        toast(payload.supersedes ? '改写好了，旧的那条留着。' : '关联好了。')
        clear(done)
        done.append(
          noteBox(
            'info',
            `已经把 ${payload.trade_ids.length} 笔成交按「${
              RELATIONS.find((r) => r.value === payload.relation)?.label ?? payload.relation
            }」关联到这条记录上。${
              result.timing === 'retrospective_link_not_prior_adoption'
                ? '后端记下来的是一条事后关联——它不会被当成你入场之前就有的依据。'
                : ''
            }`,
          ),
          h('div.tip', {
            style: 'margin-top:8px',
            text: '关联错了就改选几笔、重写一句再提交一次：新的一条会指向刚才那条，旧的原样留着，看得出你是在哪一步改的。',
          }),
        )
      })
      .catch((error) => {
        problem(error instanceof Error ? error.message : '没有关联成功。')
      })
      .finally(() => {
        save.disabled = false
        save.textContent = head ? '改写这一条' : '关联这几笔'
      })
  })

  const disclosure = h(
    'details.disc',
    {},
    h('summary', {}, icon('tri'), '把实际成交关联上来'),
    h(
      'div.filters',
      { style: 'margin-top:12px' },
      account,
      symbol,
      from,
      to,
      h('button.btn.sm.ghost', { text: '找出这一段的成交', on: { click: () => void search() } }),
    ),
    list,
    h('div.dlabel', { style: 'margin-top:14px', text: '这几笔和这条记录是什么关系' }),
    seg,
    evidence,
    h('div.acts', {}, save),
    done,
  )
  disclosure.addEventListener('toggle', () => {
    if ((disclosure as HTMLDetailsElement).open) void loadAccounts()
  })

  return h(
    'div.sec',
    {},
    h('div.sh', {}, h('span.eyebrow.noline', { text: '实际成交' })),
    disclosure,
  )
}

function dayOf(iso: string): string {
  return iso.slice(0, 10)
}

/** `<input type=date>` 给的是本地的一天，换成 UTC 的起止时刻再送出去。 */
function dayStart(value: string): string | undefined {
  if (!value) return undefined
  const at = new Date(`${value}T00:00`)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

function dayEnd(value: string): string | undefined {
  if (!value) return undefined
  const at = new Date(`${value}T00:00`)
  if (Number.isNaN(at.getTime())) return undefined
  at.setDate(at.getDate() + 1)
  return at.toISOString()
}

// 战绩 —— 给直觉记分的那一屏。
//
// 这里的每一个数都是从记录本身数出来的：拉一遍记录列表，再把每条记录当前的结果
// 读回来，对 / 错 / 不算各归各的。它不依赖正式统计那一套冻结样本，所以不用先去
// 「新建统计」也能看。分母只算判过对错的（对 + 错），不算 / 还没判 / 没写标准
// 都不进分母。

import { Latest } from '../../api/http'
import { scorecard, type Scored } from '../../data/scorecard'
import { DASH } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { countUp, stagger } from '../../ui/motion'
import { empty, spinner } from '../../ui/states'

const lane = new Latest()

interface Cell {
  name: string
  n: number
  right: number
  wrong: number
  none: number
  conf: number[]
}

type TableKind = 'symbol' | 'tag' | 'timeframe'

const TABS: { id: TableKind; label: string }[] = [
  { id: 'symbol', label: '按品种' },
  { id: 'tag', label: '按局面' },
  { id: 'timeframe', label: '按周期' },
]

const BUCKETS = [50, 60, 70, 80, 90]

export function recordView(host: HTMLElement): () => void {
  let alive = true
  const wrap = h('div')
  host.append(h('div.spread', {}, h('div.lead'), h('div.bulk', {}, wrap)))
  wrap.appendChild(spinner('正在加载'))

  void load()

  async function load(): Promise<void> {
    const signal = lane.begin()
    try {
      const scored = await scorecard({ signal })
      if (!alive) return
      paint(scored)
    } catch (error) {
      if (Latest.aborted(error) || !alive) return
      wrap.replaceChildren(
        empty({
          title: '没读出来',
          action: h('button.btn.sm', { text: '重试', on: { click: () => void load() } }),
        }),
      )
    }
  }

  function paint(scored: Scored[]): void {
    if (!scored.some((s) => s.verdict === 'right' || s.verdict === 'wrong')) {
      wrap.replaceChildren(
        h('div.sheet.pad', {}, empty({ title: '判过对错的记录还不够，先记几笔' })),
      )
      return
    }
    clear(wrap)
    wrap.append(bigNumbers(scored), tables(scored), confidenceChart(scored))
    stagger(Array.from(wrap.children))
  }

  return () => {
    alive = false
    lane.cancel()
  }
}

/* ------------------------------------------------------- 四个大数字 */

function bigNumbers(scored: Scored[]): HTMLElement {
  const box = h('div.bigs')
  box.appendChild(bigCount('记录', scored.length))
  box.appendChild(bigRate('判对率', scored))
  box.appendChild(bigRate('图在先判对率', scored.filter((s) => s.item.body.path === 'chart_first')))
  box.appendChild(
    bigRate('想法在先判对率', scored.filter((s) => s.item.body.path === 'thought_first')),
  )
  return box
}

function bigCount(label: string, n: number): HTMLElement {
  const value = h('div.v')
  const node = h('div.big', {}, h('div.k', { text: label }), value)
  countUp(value, n)
  return node
}

function bigRate(label: string, group: Scored[]): HTMLElement {
  const right = group.filter((s) => s.verdict === 'right').length
  const wrong = group.filter((s) => s.verdict === 'wrong').length
  const value = h('div.v')
  const node = h(
    'div.big',
    {},
    h('div.k', { text: label }),
    value,
    h('div.u', { text: `${right + wrong} 条` }),
  )
  if (right + wrong === 0) {
    value.textContent = DASH
    return node
  }
  const number = h('span')
  value.append(number, h('small', { text: '%' }))
  countUp(number, Math.round((right * 100) / (right + wrong)))
  return node
}

/* ------------------------------------------------------------ 三张表 */

function tables(scored: Scored[]): HTMLElement {
  const body = h('div', { style: 'padding:2px 18px 16px' })
  const seg = h('div.seg')
  const node = h('div.sheet', { style: 'margin-top:18px' }, h('div.sh', {}, seg), body)
  let kind: TableKind = 'symbol'

  const paint = () => {
    clear(seg)
    for (const tab of TABS) {
      seg.appendChild(
        h('button', {
          type: 'button',
          class: kind === tab.id ? 'on' : '',
          text: tab.label,
          on: {
            click: () => {
              kind = tab.id
              paint()
            },
          },
        }),
      )
    }
    clear(body)
    body.appendChild(table(rowsFor(scored, kind)))
  }
  paint()
  return node
}

function rowsFor(scored: Scored[], kind: TableKind): Cell[] {
  const cells = new Map<string, Cell>()
  const put = (name: string, s: Scored) => {
    let cell = cells.get(name)
    if (!cell) {
      cell = { name, n: 0, right: 0, wrong: 0, none: 0, conf: [] }
      cells.set(name, cell)
    }
    cell.n += 1
    if (s.verdict === 'right') cell.right += 1
    else if (s.verdict === 'wrong') cell.wrong += 1
    else if (s.verdict === 'void') cell.none += 1
    const c = s.item.body.confidence
    if (typeof c === 'number') cell.conf.push(c)
  }
  for (const s of scored) {
    if (kind === 'symbol') put(s.item.body.instrument ?? '没写', s)
    else if (kind === 'timeframe') put(s.item.body.timeframe ?? '没写', s)
    else {
      const names = new Set(s.tags.map((tag) => tag.name))
      if (!names.size) put('没归类', s)
      else for (const name of names) put(name, s)
    }
  }
  return [...cells.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
}

function table(rows: Cell[]): HTMLElement {
  const box = h('div.sctable')
  box.appendChild(
    h(
      'div.schead',
      {},
      h('span'),
      h('span', { text: '次数' }),
      h('span', { text: '对' }),
      h('span', { text: '错' }),
      h('span', { text: '不算' }),
      h('span', { text: '判对率' }),
      h('span', { text: '平均把握' }),
    ),
  )
  for (const cell of rows) {
    const judged = cell.right + cell.wrong
    const rate = judged ? `${Math.round((cell.right * 100) / judged)}%` : DASH
    const conf = cell.conf.length
      ? `${Math.round(cell.conf.reduce((a, b) => a + b, 0) / cell.conf.length)}%`
      : '没写'
    box.appendChild(
      h(
        'div.scrow',
        {},
        h('span.nm', { text: cell.name }),
        h('span', { text: String(cell.n), data: { label: '次数' } }),
        h('span', { text: String(cell.right), data: { label: '对' } }),
        h('span', { text: String(cell.wrong), data: { label: '错' } }),
        h('span', { text: String(cell.none), data: { label: '不算' } }),
        h('span.rt', { text: rate, data: { label: '判对率' } }),
        h('span', { text: conf, data: { label: '平均把握' } }),
      ),
    )
  }
  return box
}

/* ------------------------------------------------------- 把握 vs 结果 */

function confidenceChart(scored: Scored[]): HTMLElement {
  const bars = h('div.confbars')
  const counts = BUCKETS.map(() => ({ right: 0, wrong: 0 }))
  for (const s of scored) {
    const c = s.item.body.confidence
    if (typeof c !== 'number') continue
    if (s.verdict !== 'right' && s.verdict !== 'wrong') continue
    const step = Math.max(50, Math.min(90, Math.floor(c / 10) * 10))
    const slot = counts[BUCKETS.indexOf(step)]
    if (!slot) continue
    if (s.verdict === 'right') slot.right += 1
    else slot.wrong += 1
  }
  BUCKETS.forEach((bucket, index) => {
    const slot = counts[index] ?? { right: 0, wrong: 0 }
    const judged = slot.right + slot.wrong
    const rate = judged ? Math.round((slot.right * 100) / judged) : null
    bars.appendChild(
      h(
        'div.confbar',
        { style: `--i:${index}` },
        h('span.v', { text: rate === null ? DASH : `${rate}%` }),
        h('span.col', {}, h('i', { style: `height:${rate ?? 0}%` })),
        h('span.x', { text: String(bucket) }),
      ),
    )
  })
  return h(
    'div.sheet',
    { style: 'margin-top:18px' },
    h('div.sh', {}, h('span.eyebrow.noline', { text: '把握 vs 结果' })),
    h(
      'div.confchart',
      {},
      h('span.yaxis', { text: '判对率' }),
      bars,
      h('span.xaxis', { text: '把握' }),
    ),
  )
}

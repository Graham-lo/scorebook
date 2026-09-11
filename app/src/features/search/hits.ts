// 一条命中长什么样。
//
// 两种来源两种读法：公开历史给的是一段行情，主角是那张图；自己的记录给的是当
// 时那条判断，主角是现场截图和它背后的那句话。
//
// 「之后的走势」只是画出来给人看的，不参与召回、评分和排序：画图的请求只把
// end_at 往后延，原来的收尾时刻照原样放在 match_end_at 里发回去，后端据此在图
// 上划出那条分界线。公开行情的 K 线和画出来的图只在内存里活到这次查看结束。

import { INTERVAL_SECONDS, MARKET_LABELS } from '../../data/session'
import { chartSvg } from '../../api/market'
import { isHistoryCandidate, type HistoryCandidate, type PrivateCandidate, type SearchCandidate } from '../../api/chart'
import { utcRange } from '../../data/time'
import { h } from '../../ui/dom'
import { attachmentImage } from '../../ui/media'
import { stagger } from '../../ui/motion'
import { foldout } from '../../ui/states'
import { go } from '../../router'
import { kvRow } from './bits'
import type { SearchCtx } from './state'

/** 之后的走势默认画多少根。 */
const FOLLOWING = [32, 64, 128]
const FOLLOWING_DEFAULT = 64

export function hitList(ctx: SearchCtx, items: SearchCandidate[], ranked: boolean): HTMLElement {
  const list = h('div.hits')
  items.forEach((item, index) => {
    list.appendChild(
      isHistoryCandidate(item) ? historyHit(ctx, item, index, ranked) : privateHit(ctx, item, index, ranked),
    )
  })
  stagger(list.children)
  return list
}

/* ------------------------------------------------ 一条公开历史的片段 */

function historyHit(ctx: SearchCtx, item: HistoryCandidate, index: number, ranked: boolean): HTMLElement {
  const view = ctx.chart()
  const drawn = h('div', { hidden: true }, view.node)

  const request = item.chart_request
  let following = FOLLOWING_DEFAULT
  const afterChoice = h('span.seg')
  for (const n of FOLLOWING) {
    afterChoice.appendChild(
      h('button', {
        text: `后 ${n} 根`,
        class: n === following ? 'on' : '',
        on: {
          click: () => {
            following = n
            for (const b of afterChoice.querySelectorAll('button')) {
              b.classList.toggle('on', b.textContent === `后 ${n} 根`)
            }
            showFollowthrough()
          },
        },
      }),
    )
  }
  function showFollowthrough(): void {
    if (!request) return
    const seconds = INTERVAL_SECONDS[request.interval as keyof typeof INTERVAL_SECONDS]
    if (!seconds) return
    const boundary = Date.parse(request.end_at)
    const lastClosed = Math.floor(Date.now() / (seconds * 1000)) * seconds * 1000
    const end = Math.min(boundary + following * seconds * 1000, lastClosed)
    drawn.hidden = false
    void view.show((signal) =>
      chartSvg(
        { ...request, end_at: new Date(Math.max(boundary, end)).toISOString(), match_end_at: request.end_at },
        { signal },
      ),
    )
  }
  const draw = h('button.btn.sm.ghost', {
    text: '重新读取走势',
    disabled: !request,
    title: request ? '' : '这条候选还没有配套的行情来源，画不出它那一段。',
    on: {
      click: (e: Event) => {
        if (!request) return
        const button = e.currentTarget as HTMLButtonElement
        button.disabled = true
        drawn.hidden = false
        showFollowthrough()
        button.disabled = false
      },
    },
  })

  // 排的顺序就是读的顺序：先知道这是哪一段，再看走势，最后才是它凭什么排在
  // 这儿。图是主角，所以它紧跟在标题下面，不排在一串参数后面。
  const body = h(
    'div',
    {},
    h(
      'div.hithead',
      {},
      ranked ? h('span.rank', { text: `#${index + 1}` }) : h('span.badge.wait', { text: '候选' }),
      h('span.hitsym', { text: item.symbol }),
      h(
        'div.line',
        { style: 'margin-left:auto' },
        h('span', { text: MARKET_LABELS[item.market] }),
        h('span', { text: item.interval }),
        h('span', { text: `${item.bars_count} 根` }),
        h('span.faint', { text: sourceLabel(item.market_source) }),
      ),
    ),
    // 日期按 UTC 写，跟下面那张图的横轴对得上；后面缀一个 UTC，免得当成本地时间。
    h(
      'div.hitwhen',
      {},
      h('span', { text: utcRange(item.start_at, item.end_at) }),
      h('span.faint', { text: 'UTC' }),
    ),
    drawn,
    chartLegend(),
    h('div.acts', { style: 'margin-top:10px' }, afterChoice, draw),
    matchLine(item),
  )
  if (ranked && request) showFollowthrough()
  return h('div.hit.wide', { style: `--i:${index}` }, body)
}

/**
 * 图上那条虚线两边分别是什么。色块用的就是后端画进 SVG 里的那两种底色——香槟
 * 色那一段是参与匹配的，右边没有底色的是当时接下来发生的事。
 */
function chartLegend(): HTMLElement {
  return h(
    'div.clegend',
    {},
    h('span', {}, h('i.a'), '参与匹配的片段'),
    h('span.div', { text: '｜' }),
    h('span', {}, h('i.b'), '之后的走势 · 不参与召回、评分和排序'),
  )
}

function sourceLabel(source: string): string {
  if (source === 'monthly_archive') return '来自月度归档'
  if (source === 'rest') return '来自交易所接口'
  return source
}

/* -------------------------------------------------- 一条自己的记录 */

function privateHit(_ctx: SearchCtx, item: PrivateCandidate, index: number, ranked: boolean): HTMLElement {
  // 84px 高的一格，按显示尺寸解一张小的；要看清楚点进那条记录。
  const shot = attachmentImage(item.attachment_id, { alt: '这条记录的现场图', maxWidth: 320 })
  shot.style.height = '84px'
  shot.style.cursor = 'pointer'
  shot.addEventListener('click', () => go(`call/${item.call_id}`))

  const right = h(
    'div',
    {},
    h(
      'div.line',
      {},
      ranked ? h('span.rank', { text: `#${index + 1}` }) : h('span.badge.wait', { text: '候选' }),
      h('span.faint', { text: '我写过的一条记录' }),
      // 不限周期时命中的可能是别的周期，这条自己是哪个周期得写在脸上。
      h('span', { text: item.interval ?? '未注明周期' }),
    ),
    matchLine(item),
    h(
      'div.acts',
      { style: 'margin-top:8px' },
      h('a.btn.sm.ghost', { href: `#/call/${item.call_id}`, text: '打开这条' }),
    ),
  )
  return h('div.hit', { style: `--i:${index}` }, shot, right)
}

/**
 * 接近程度。后端自己把口径写在 `match.meaning` 里：结构相似，不是概率。方向对不
 * 上的时候也照实说——那是一段反着走的行情。
 */
function matchLine(item: SearchCandidate): HTMLElement {
  const match = item.match
  if (!match) {
    return h('div.line', {}, h('span.faint', { text: '这一条还没有精排，暂时没有接近程度。' }))
  }
  const width = Math.max(0, Math.min(1, match.score))
  const line = h(
    'div.near',
    { title: '1 表示结构上完全对得上，越小越不像。它不是胜率，也不是上涨概率。' },
    h('span.faint', { text: '结构接近程度' }),
    h('span.track', {}, h('i', { style: `width:${(width * 100).toFixed(1)}%` })),
    h('span.num', { text: match.score.toFixed(3) }),
  )
  // 方向对不对得上是读图的人要知道的，留在外面；对齐代价是内部量纲，只在要
  // 追查这条为什么排在这儿的时候才有用，收起来。
  const extra = h(
    'div.line',
    { style: 'margin-top:4px' },
    h('span.faint', { text: match.direction_consistent ? '方向一致' : '方向相反' }),
    match.reverse ? h('span.faint', { text: '这是翻转之后比出来的' }) : null,
  )
  const detail = foldout(
    '这条为什么排在这儿',
    h('div.kv', {}, kvRow('对齐代价', match.alignment_cost.toFixed(3)), kvRow('后端口径', match.meaning)),
  )
  return h('div', {}, line, extra, h('div', { style: 'margin-top:8px' }, detail))
}

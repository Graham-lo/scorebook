// 按下去会得到什么：配色、周期、开始搜索。
//
// 主路径只有三样。配色留在外面是因为选错了整张图的方向就反了；周期留在外面是
// 因为不选就搜不了；剩下的（认图、筛品种、上下翻转）收进折叠区，要用的时候
// 才展开。口径那一句紧跟着按钮，不放到页面末尾。

import type { Market } from '../../api/types'
import { INTERVALS, MARKET_LABELS, capabilityState, findInstruments, qualityAccepted } from '../../data/session'
import { h } from '../../ui/dom'
import { foldout, note } from '../../ui/states'
import { popChip, type PopItem } from '../../ui/pop'
import { analysisSection } from './analysis'
import { HIT_CHOICES, MAX_HITS, forgetAnalysis, period, state, moving, type SearchCtx } from './state'

export function controls(ctx: SearchCtx): HTMLElement {
  const box = h('div.stack', { style: 'gap:14px' })

  box.appendChild(colourPicker(ctx))
  box.appendChild(periodRow(ctx))

  const ocr = capabilityState('screenshot_ocr')
  const visual = capabilityState('image_visual_search')
  const blocked =
    ocr !== 'ready' || (state.scope === 'private' && visual !== 'ready') || !state.queryId || !period.value || state.submitting || Boolean(state.runId && (!state.run || moving(state.run.status)))

  const run = h('button.btn.primary.lg', {
    text: state.scope === 'private' ? '在我的记录里找' : '在公开历史里找',
    disabled: blocked,
    on: { click: () => ctx.runSearch() },
  })
  box.appendChild(
    h(
      'div.acts',
      {},
      run,
      h('span.faint', {
        text: period.value ? `只比较 ${period.value} K 线，不跨周期。` : '先确认截图的 K 线周期，再开始搜索。',
      }),
    ),
  )
  if (!state.queryId) box.appendChild(h('div.tip', { text: '先放一张图，才能开始检索。' }))
  box.appendChild(
    h('div.tip', {
      text: '排序是画面结构上的接近程度，不是胜率，也不是上涨概率。这套比法还没有用真实截图做过盲测验收。',
    }),
  )
  // 能力没配好、质量没验收，这些是限制不是解释，任何时候都摆在外面。
  for (const line of missingCapabilities()) box.appendChild(note('warn', line))

  box.appendChild(
    foldout('认图、筛选品种、上下翻转', analysisSection(ctx), filterRow(ctx), directionRow(ctx)),
  )
  return box
}

/** 能力没配好要说清楚是哪一块没配，而不是让按钮无声地按不动。 */
function missingCapabilities(): string[] {
  const lines: string[] = []
  const ocr = capabilityState('screenshot_ocr')
  if (ocr !== 'ready') {
    lines.push(
      ocr === 'needs_setup'
        ? '这台机器上的识字服务没有配好。认图和检索都要先读图上的字，所以现在两样都做不了。'
        : '还没读到这台机器的能力清单，先确认后端在运行。',
    )
  }
  if (state.scope === 'private') {
    const visual = capabilityState('image_visual_search')
    if (visual === 'needs_setup') {
      lines.push('本机的视觉模型没有启动。比自己的截图这一路要用它，先把它开起来。')
    } else if (visual === 'unknown') {
      lines.push('还没读到视觉模型的状态，先确认后端在运行。')
    }
  }
  if (!qualityAccepted('image_structure_search')) {
    // 后端自己明说这一项没有验收结论，界面上不能把「接上了」说成「验过了」。
    lines.push('后端自报：按图索骥的真实图片质量尚未验收。结果按候选看，不要当成结论。')
  }
  return lines
}

function colourPicker(ctx: SearchCtx): HTMLElement {
  const seg = h('span.seg')
  const options: { on: boolean; label: string }[] = [
    { on: false, label: '绿涨红跌' },
    { on: true, label: '红涨绿跌' },
  ]
  for (const option of options) {
    seg.appendChild(
      h('button', {
        class: state.redUp === option.on ? 'on' : '',
        text: option.label,
        on: {
          click: () => {
            if (state.redUp === option.on) return
            state.redUp = option.on
            forgetAnalysis()
            ctx.repaintQuery()
          },
        },
      }),
    )
  }
  return h(
    'div',
    {},
    h('div.sh', { style: 'margin-bottom:9px' }, h('span.eyebrow.noline', { text: '这张图的涨跌配色' })),
    seg,
    h('div.tip', { text: '认错配色，K 线的方向会整个反过来。按你截图那个软件的实际配色选。' }),
  )
}

function periodRow(ctx: SearchCtx): HTMLElement {
  const repaint = (): void => {
    ctx.repaintQuery()
    ctx.repaintResults()
  }
  const chip = popChip({
    label: () => period.value ?? '请选择周期',
    active: () => Boolean(period.value),
    items: () => INTERVALS.map((value) => ({ label: value, value, on: period.value === value })),
    onPick: (value) => {
      period.select(value)
      repaint()
    },
    onClear: () => {
      period.reset()
      repaint()
    },
  })
  const suggested = period.suggestion(state.analysis?.recognized.interval)
  const line = period.value
    ? `本次只查找 ${period.value} 的走势。${state.scope === 'private' ? '未注明周期的记录不参与匹配。' : ''}`
    : suggested
      ? `图上识别到 ${suggested}，请确认后再搜索。`
      : '截图周期尚未确定，请按图上显示的周期选择。不会从走势形状猜周期。'
  return h(
    'div',
    {},
    h('div.sh', { style: 'margin-bottom:9px' }, h('span.eyebrow.noline', { text: '截图周期 · 必选' })),
    h(
      'div.acts',
      {},
      chip.node,
      suggested && !period.value
        ? h('button.btn.sm', {
            text: `使用识别的 ${suggested}`,
            on: {
              click: () => {
                period.select(suggested)
                repaint()
              },
            },
          })
        : null,
    ),
    h('div.tip', { text: line }),
  )
}

function filterRow(ctx: SearchCtx): HTMLElement {
  const row = h('div.filters')
  const isPrivate = state.scope === 'private'

  row.appendChild(
    popChip({
      label: () => state.symbol ?? '不限品种',
      active: () => Boolean(state.symbol),
      search: '搜合约，比如 BTCUSDT',
      items: async (query) => {
        const found = await findInstruments(query, { market: state.market ?? undefined })
        const rows: PopItem[] = found.map((item) => ({
          label: item.symbol,
          value: item.symbol,
          hint: MARKET_LABELS[item.market],
        }))
        return rows.length ? rows : [{ label: '没有匹配的合约', value: '' }]
      },
      onPick: (value) => {
        if (!value) return
        state.symbol = value
        ctx.repaintQuery()
      },
      onClear: () => {
        state.symbol = null
        ctx.repaintQuery()
      },
      footer: () =>
        isPrivate
          ? '按记录上写的品种筛选，没写品种的记录不会出现。'
          : '公开历史里不填品种，就是在所有已发布的范围里比。',
    }).node,
  )

  row.appendChild(
    popChip({
      label: () => (state.market ? MARKET_LABELS[state.market] : '不限市场'),
      active: () => Boolean(state.market),
      items: () => [
        { label: MARKET_LABELS.usd_m, value: 'usd_m', on: state.market === 'usd_m' },
        { label: MARKET_LABELS.coin_m, value: 'coin_m', on: state.market === 'coin_m' },
      ],
      onPick: (value) => {
        state.market = value as Market
        ctx.repaintQuery()
      },
      onClear: () => {
        state.market = null
        ctx.repaintQuery()
      },
    }).node,
  )

  row.appendChild(
    popChip({
      label: () => `最多 ${state.limit} 条`,
      active: () => state.limit !== 3,
      items: () =>
        HIT_CHOICES.map((n) => ({ label: `最多 ${n} 条`, value: String(n), on: state.limit === n })),
      onPick: (value) => {
        state.limit = Math.min(MAX_HITS, Number(value))
        ctx.repaintQuery()
      },
      footer: () =>
        state.scope === 'binance_history'
          ? '每个品种只展示最接近的一个历史片段。'
          : '只看最接近的几条记录。',
    }).node,
  )
  return row
}

function directionRow(ctx: SearchCtx): HTMLElement {
  const toggle = h('button', {
    class: ['opt', state.reverse ? 'on' : ''],
    text: '把走势翻过来比',
    on: {
      click: () => {
        state.reverse = !state.reverse
        ctx.repaintQuery()
      },
    },
  })
  return h(
    'div',
    {},
    h('div.sh', { style: 'margin-bottom:9px' }, h('span.eyebrow.noline', { text: '方向' })),
    h('div.opts', {}, toggle),
    h('div.tip', {
      text: state.reverse
        ? '现在会去找上下翻转之后接近的片段——那是一段方向相反的行情，别当成同一件事。'
        : '默认保持走势方向：涨的去找涨的。要找镜像的形态，得你自己按上面这个。',
    }),
  )
}

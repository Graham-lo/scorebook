// 先认一下这张图：数出多少根 K 线、间距匀不匀、图上的字认出了什么。
//
// 认图说的是这张截图本身，不是这次要搜的范围。所以图上认出 ETH 也不会替人把
// 检索限制在 ETH 上——那是两件事，跨品种比较是一条正常的路。

import { analyze } from '../../api/chart'
import { h, clear } from '../../ui/dom'
import { note, spinner } from '../../ui/states'
import { capabilityState } from '../../data/session'
import { kvRow } from './bits'
import { analyzeAction, state, type SearchCtx } from './state'

export function analysisSection(ctx: SearchCtx): HTMLElement {
  const box = h('div')
  const button = h('button.btn.sm', {
    text: state.analysis ? '重新认一次' : '先认一下这张图',
    disabled: !state.queryId || capabilityState('screenshot_ocr') !== 'ready',
    on: { click: () => void analyseNow() },
  })
  paint()
  return h(
    'div',
    {},
    h('div.sh', { style: 'margin-bottom:9px' }, h('span.eyebrow.noline', { text: '这张图上有什么' })),
    h('div.acts', {}, button, h('span.faint', { text: '数 K 线、看间距、读图上的字。' })),
    box,
  )

  async function analyseNow(): Promise<void> {
    if (!state.queryId) return
    box.replaceChildren(spinner('正在认这张图…'))
    const input = {
      attachment_id: state.queryId,
      ...(state.region ? { region: state.region } : {}),
      red_up: state.redUp,
    }
    try {
      const result = await analyze(input, analyzeAction.keyFor(input))
      analyzeAction.reset()
      const currentInput = {
        attachment_id: state.queryId,
        ...(state.region ? { region: state.region } : {}),
        red_up: state.redUp,
      }
      if (!ctx.alive() || JSON.stringify(currentInput) !== JSON.stringify(input)) return
      state.analysis = result
      state.analysisFor = JSON.stringify(input)
      // Recognition describes the source screenshot. Search filters express the
      // user's intent and must not silently narrow cross-contract structure search.
      ctx.repaintQuery()
    } catch (error) {
      if (!ctx.alive()) return
      box.replaceChildren(note('warn', error instanceof Error ? error.message : '这张图没有认出来。'))
    }
  }

  function paint(): void {
    clear(box)
    const found = state.analysis
    if (!found) {
      box.appendChild(
        h('div.tip', { text: '认图不是必须的一步，但它能告诉你这张图上能读出什么、读不出什么。' }),
      )
      return
    }
    const g = found.geometry
    const kv = h('div.kv', { style: 'margin-top:10px' })
    kv.appendChild(kvRow('数出来的 K 线', `${g.detected_candles} 根`))
    kv.appendChild(kvRow('间距一致性', g.spacing_consistency.toFixed(3)))
    kv.appendChild(kvRow('图上认出的品种', found.recognized.symbol ?? '未识别；仍可跨品种搜索'))
    kv.appendChild(kvRow('图上认出的周期', found.recognized.interval ?? '没认出来 —— 得你自己选'))
    box.appendChild(kv)

    if (!found.recognized.symbol || !found.recognized.interval) {
      box.appendChild(
        note('info', '周期必须确认，未识别时请手动选择；品种可以不限，继续跨品种比较。'),
      )
    }
    if (g.limitations.length) {
      const list = h('div.tip', { style: 'margin-top:8px' })
      list.appendChild(h('div', { text: '后端自己划出的边界：' }))
      for (const line of g.limitations) list.appendChild(h('div', { text: `· ${limitation(line)}` }))
      box.appendChild(list)
    }
    if (!g.supported) {
      box.appendChild(
        note('warn', '这张图的 K 线结构不成立，比出来的东西没有意义。框一块规整的 K 线区域再试。'),
      )
    }
  }
}

/** 后端用标识符列边界，这里翻成人话，但不改它的意思。 */
function limitation(code: string): string {
  switch (code) {
    case 'ordinary_red_green_candles_only':
      return '只认普通的红绿 K 线图。'
    case 'heikin_ashi_cannot_be_excluded_from_pixels_alone':
      return '光看像素排除不掉平均K线（Heikin Ashi），如果你截的是那种图，比出来的东西对不上。'
    case 'symbol_and_interval_require_visible_text':
      return '品种和周期必须在图上有可见的字，才读得出来。'
    case 'semantic_quality_not_yet_validated':
      return '这套认法的语义质量还没有验收过。'
    default:
      return code
  }
}

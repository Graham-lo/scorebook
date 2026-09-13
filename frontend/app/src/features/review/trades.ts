import type { ManualReviewTrade, ReviewTrade, ReviewTradeSnapshot } from '../../api/types'
import { dateTime } from '../../data/time'
import { h } from '../../ui/dom'
import { fillPicker, type FillPicker } from '../find/fill-pick'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const direction = (v: string | null | undefined) => v === 'long' ? '看多' : v === 'short' ? '看空' : '没填'
const display = (v: unknown) => typeof v === 'string' && /^-?\d+\.\d+$/.test(v) ? v.replace(/0+$/, '').replace(/\.$/, '') : String(v)
const localTime = (v: string | null | undefined) => {
  if (!v) return ''
  const d = new Date(v)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const instant = (v: string) => v ? new Date(v).toISOString() : null

export function tradeSummary(trades: ReviewTrade[] = [], snapshots: ReviewTradeSnapshot[] = []): HTMLElement {
  return h('div.review-trade-list', {}, ...trades.map((trade, i) => {
    const snapshot = snapshots.find(s => trade.source === 'exchange' && s.cycle_id === trade.cycle_id) ?? snapshots[i]
    const t = trade.source === 'manual' ? trade : null
    const c = snapshot?.cycle
    const rows: [string, unknown][] = t ? [
      ['开仓', t.opened_at ? dateTime(t.opened_at) : null], ['平仓', t.closed_at ? dateTime(t.closed_at) : '没填'],
      ['仓位', t.quantity ? `${t.quantity} ${t.quantity_unit ?? ''}` : null], ['杠杆', t.leverage ? `${t.leverage}×` : null],
      ['开仓价', t.entry_price], ['平仓价', t.exit_price], ['已实现盈亏', t.realized_pnl ? `${t.realized_pnl} ${t.settlement_asset ?? ''}` : null],
      ['手续费', t.fees], ['保证金', t.margin_mode === 'cross' ? '全仓' : t.margin_mode === 'isolated' ? '逐仓' : null], ['备注', t.note],
    ] : [
      ['账户', snapshot?.account_name], ['开仓', c?.opened_at ? dateTime(c.opened_at) : '不知道'],
      ['平仓', c?.closed_at ? dateTime(c.closed_at) : '持仓中'], ['累计开仓数量', snapshot?.totals?.opened_quantity],
      ['剩余数量', c?.remaining_quantity], ['开仓均价', c?.entry_price], ['平仓均价', snapshot?.totals?.exit_price],
      ['已实现盈亏', c?.computed_realized_pnl != null ? `${c.computed_realized_pnl} ${c.settlement_asset}` : null],
      ['手续费', c ? Object.entries(c.commissions).map(([asset, amount]) => `${amount} ${asset}`).join(' / ') : null],
      ['杠杆', trade.leverage ? `${trade.leverage}×` : '不知道'], ['备注', trade.note],
    ]
    return h('div.review-trade-card', {},
      h('div.dlabel', { text: `${t ? '自己填的' : '一轮持仓'} · ${t?.symbol || c?.symbol || '一轮持仓'} · ${direction(t?.direction ?? c?.direction)}` }),
      h('dl.review-trade-values', {}, ...rows.filter(([,v]) => v !== null && v !== undefined && v !== '').flatMap(([k,v]) => [h('dt', {text:k}), h('dd', {text:display(v)})])))
  }))
}

export function tradeEditor(symbol: string | null | undefined, changed: () => void, enabled: () => boolean) {
  let values: ReviewTrade[] = []
  let snapshots: ReviewTradeSnapshot[] = []
  const root = h('details.review-trades') as HTMLDetailsElement
  const list = h('div.review-trade-list')
  const picker = h('div.review-trade-picker', {hidden:true})
  const count = h('span.faint')
  const controls = h('fieldset.review-trade-controls') as HTMLFieldSetElement
  const manual = h('button.btn.sm', {text:'自己填', on:{click:()=>{
    if (!enabled() || values.length >= 20) return
    values.push({source:'manual',symbol:symbol ?? '',direction:null,opened_at:null,closed_at:null,quantity:null,quantity_unit:null,leverage:null,entry_price:null,exit_price:null,realized_pnl:null,settlement_asset:null,fees:null,margin_mode:null,note:null})
    render(); changed()
  }}})
  const choose = h('button.btn.sm', {text:'挑一轮持仓', on:{click:()=>{
    if (!enabled()) return
    picker.hidden = !picker.hidden
    if (!picker.hidden) openPicker()
  }}})
  controls.append(h('div.review-trade-actions', {}, manual, choose), list, picker)
  root.append(h('summary', {}, '成交', count), controls)

  /** 挑成交那一份组件，全站只有一个实现；第一次点开才建。 */
  let picking: FillPicker | null = null
  function openPicker(): void {
    if (picking) { picking.refresh(); return }
    picking = fillPicker({
      mode: 'positions',
      symbol,
      enabled,
      isPicked: (id) => values.some(v => v.source === 'exchange' && v.cycle_id === id),
      onPick: (row, accountName) => {
        if (values.length >= 20) return
        values.push({source:'exchange',connection_id:row.connection_id,cycle_id:row.id,leverage:null,note:null})
        snapshots.push({source:'exchange_ledger',cycle_id:row.id,cycle:row.cycle,account_name:accountName ?? undefined})
        render(); changed()
      },
    })
    picker.replaceChildren(picking.node)
  }

  function field(label: string, value: string, update: (v:string)=>void, type='text', choices?: [string,string][]) {
    const input = choices
      ? h('select.input', {}, ...choices.map(([v,text])=>h('option',{value:v,attrs:{value:v},text}))) as HTMLSelectElement
      : h('input.input', {type}) as HTMLInputElement
    input.setAttribute('aria-label', label)
    input.value = value
    if (type === 'text' && /数量|倍数|价格|盈亏|手续费/.test(label)) input.setAttribute('inputmode','decimal')
    input.addEventListener('input',()=>{ if(enabled()) { update(input.value); changed() } })
    return h('label.review-trade-field', {}, h('span.faint', {text:label}), input)
  }
  function render() {
    count.textContent = values.length ? ` · ${values.length} 笔` : ''
    list.replaceChildren()
    values.forEach((trade,i)=>{
      const remove = h('button.linkbtn', {text:'移除',on:{click:()=>{if(enabled()){values.splice(i,1); render();changed()}}}})
      const card = h('div.review-trade-card', {}, h('div.review-trade-actions', {}, h('span.dlabel',{text:`${trade.source==='manual'?'手动仓位':'一轮持仓'} ${i+1}`}), remove))
      if(trade.source==='manual') {
        const textField = (key: keyof ManualReviewTrade,label:string,type='text',choices?:[string,string][]) => field(label,type==='datetime-local'?localTime(trade[key]):trade[key] ?? '',v=>{
          Object.assign(trade,{[key]:type==='datetime-local'?instant(v):v.trim() || (key==='symbol'?'':null)})
        },type,choices)
        card.append(h('div.review-trade-grid', {},
          textField('symbol','品种 *'), textField('direction','方向 *','text',[['','请选择'],['long','看多'],['short','看空']]),
          textField('opened_at','开仓时间 *','datetime-local'), textField('closed_at','平仓时间','datetime-local'),
          textField('quantity','数量 *'),textField('quantity_unit','单位 *'),
          textField('leverage','杠杆'),textField('margin_mode','保证金模式','text',[['','未填写'],['cross','全仓'],['isolated','逐仓']]),
          textField('entry_price','开仓价格'),textField('exit_price','平仓价格'),textField('realized_pnl','已实现盈亏'),
          textField('settlement_asset','结算币种'),textField('fees','手续费'),textField('note','备注')))
      } else {
        card.append(tradeSummary([trade],snapshots), h('div.review-trade-grid', {},
          field('杠杆',trade.leverage ?? '',v=>{trade.leverage=v.trim()||null}),
          field('备注',trade.note ?? '',v=>{trade.note=v.trim()||null})))
      }
      list.append(card)
    })
    picking?.refresh()
    lock()
  }
  function lock() { controls.disabled = !enabled() }
  return {
    node:root, read:()=>copy(values), lock,
    hasContent:()=>values.length>0,
    valid:()=>values.every(t=>t.source!=='manual'||Boolean(t.symbol.trim()&&t.direction&&t.opened_at&&t.quantity&&t.quantity_unit)),
    restore(trades:ReviewTrade[]=[],saved:ReviewTradeSnapshot[]=[]){ values=copy(trades);snapshots=copy(saved);render();root.open=values.length>0 },
    dispose(){picking?.dispose()},
  }
}

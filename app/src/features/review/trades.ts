import * as api from '../../api/trades'
import * as jobs from '../../api/jobs'
import { WriteAction } from '../../api/http'
import type { CycleRow, ManualReviewTrade, ReviewTrade, ReviewTradeSnapshot } from '../../api/types'
import { capabilityState } from '../../data/session'
import { dateTime } from '../../data/time'
import { h } from '../../ui/dom'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const direction = (v: string | null | undefined) => v === 'long' ? '多' : v === 'short' ? '空' : '未填方向'
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
      ['开仓', t.opened_at ? dateTime(t.opened_at) : null], ['平仓', t.closed_at ? dateTime(t.closed_at) : '尚未填写'],
      ['仓位', t.quantity ? `${t.quantity} ${t.quantity_unit ?? ''}` : null], ['杠杆', t.leverage ? `${t.leverage}×` : null],
      ['开仓价', t.entry_price], ['平仓价', t.exit_price], ['已实现盈亏', t.realized_pnl ? `${t.realized_pnl} ${t.settlement_asset ?? ''}` : null],
      ['手续费', t.fees], ['保证金', t.margin_mode === 'cross' ? '全仓' : t.margin_mode === 'isolated' ? '逐仓' : null], ['备注', t.note],
    ] : [
      ['账户', snapshot?.account_name], ['开仓', c?.opened_at ? dateTime(c.opened_at) : '期初未知'],
      ['平仓', c?.closed_at ? dateTime(c.closed_at) : '未平仓'], ['累计开仓数量', snapshot?.totals?.opened_quantity],
      ['剩余数量', c?.remaining_quantity], ['开仓均价', c?.entry_price], ['平仓均价', snapshot?.totals?.exit_price],
      ['已实现盈亏', c?.computed_realized_pnl != null ? `${c.computed_realized_pnl} ${c.settlement_asset}` : null],
      ['手续费', c ? Object.entries(c.commissions).map(([asset, amount]) => `${amount} ${asset}`).join(' / ') : null],
      ['杠杆（手动补充）', trade.leverage ? `${trade.leverage}×` : '交易历史未提供'], ['备注', trade.note],
    ]
    return h('div.review-trade-card', {},
      h('div.dlabel', { text: `${t ? '手动记录' : '历史仓位'} · ${t?.symbol || c?.symbol || '已选仓位'} · ${direction(t?.direction ?? c?.direction)}` }),
      h('dl.review-trade-values', {}, ...rows.filter(([,v]) => v !== null && v !== undefined && v !== '').flatMap(([k,v]) => [h('dt', {text:k}), h('dd', {text:display(v)})])))
  }))
}

export function tradeEditor(symbol: string | null | undefined, changed: () => void, enabled: () => boolean) {
  let values: ReviewTrade[] = []
  let snapshots: ReviewTradeSnapshot[] = []
  let alive = true
  const controller = new AbortController()
  const opts = { signal: controller.signal }
  const root = h('details.review-trades') as HTMLDetailsElement
  const list = h('div.review-trade-list')
  const picker = h('div.review-trade-picker', {hidden:true})
  const count = h('span.faint')
  const controls = h('fieldset.review-trade-controls') as HTMLFieldSetElement
  const manual = h('button.btn.sm', {text:'手动输入', on:{click:()=>{
    if (!enabled() || values.length >= 20) return
    values.push({source:'manual',symbol:symbol ?? '',direction:null,opened_at:null,closed_at:null,quantity:null,quantity_unit:null,leverage:null,entry_price:null,exit_price:null,realized_pnl:null,settlement_asset:null,fees:null,margin_mode:null,note:null})
    render(); changed()
  }}})
  const choose = h('button.btn.sm', {text:'选择历史仓位', on:{click:()=>{
    if (!enabled()) return
    picker.hidden = !picker.hidden
    if (!picker.hidden && !picker.childNodes.length) void openPicker()
  }}})
  controls.append(h('div.review-trade-actions', {}, manual, choose), list, picker)
  root.append(h('summary', {}, '交易信息（可选）', count), controls)

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
      const card = h('div.review-trade-card', {}, h('div.review-trade-actions', {}, h('span.dlabel',{text:`${trade.source==='manual'?'手动仓位':'历史仓位'} ${i+1}`}), remove))
      if(trade.source==='manual') {
        const textField = (key: keyof ManualReviewTrade,label:string,type='text',choices?:[string,string][]) => field(label,type==='datetime-local'?localTime(trade[key]):trade[key] ?? '',v=>{
          Object.assign(trade,{[key]:type==='datetime-local'?instant(v):v.trim() || (key==='symbol'?'':null)})
        },type,choices)
        card.append(h('div.review-trade-grid', {},
          textField('symbol','品种 *'), textField('direction','方向 *','text',[['','请选择'],['long','做多'],['short','做空']]),
          textField('opened_at','开仓时间 *','datetime-local'), textField('closed_at','平仓时间（未平可留空）','datetime-local'),
          textField('quantity','仓位数量 *'),textField('quantity_unit','数量单位 *（如 BTC、张）'),
          textField('leverage','杠杆倍数'),textField('margin_mode','保证金模式','text',[['','未填写'],['cross','全仓'],['isolated','逐仓']]),
          textField('entry_price','开仓价格'),textField('exit_price','平仓价格'),textField('realized_pnl','已实现盈亏'),
          textField('settlement_asset','结算币种'),textField('fees','手续费'),textField('note','备注')), h('div.tip',{text:'带 * 的信息在发布前填写；其他信息可留空。时间按当前设备时区输入。'}))
      } else {
        card.append(tradeSummary([trade],snapshots), h('div.review-trade-grid', {},
          field('杠杆倍数（可手动补充）',trade.leverage ?? '',v=>{trade.leverage=v.trim()||null}),
          field('备注',trade.note ?? '',v=>{trade.note=v.trim()||null})))
      }
      list.append(card)
    })
    for (const button of picker.querySelectorAll<HTMLButtonElement>('[data-cycle-id]')) {
      const selected = values.some(v => v.source === 'exchange' && v.cycle_id === button.dataset.cycleId)
      button.disabled = selected
      button.textContent = selected ? '已加入' : '加入本次复盘'
    }
    lock()
  }
  function lock() { controls.disabled = !enabled() }
  async function openPicker() {
    picker.textContent='正在读取账户…'
    try {
      const accounts = [] as Awaited<ReturnType<typeof api.connections>>['items']
      let accountCursor: string | undefined
      do { const page=await api.connections({cursor:accountCursor},opts); accounts.push(...page.items); accountCursor=page.next_cursor ?? undefined } while(accountCursor && alive)
      if(!alive) return
      if(!accounts.length) {
        picker.replaceChildren(h('p.tip',{text:'还没有交易账户。连接交易所 API 或导入账单后，就可以按品种和时间选择历史仓位。'}),h('a.linkbtn',{href:'#/trades',text:'管理交易账户'})); return
      }
      const account=h('select.input',{},h('option',{attrs:{value:''},text:'全部账户'}),...accounts.map(a=>h('option',{attrs:{value:a.id},text:a.name}))) as HTMLSelectElement
      const search=h('input.input',{value:symbol ?? '',placeholder:'品种，如 BTCUSDT'}) as HTMLInputElement
      const from=h('input.input',{type:'datetime-local'}) as HTMLInputElement
      const to=h('input.input',{type:'datetime-local'}) as HTMLInputElement
      const side=h('select.input',{},...([['','全部方向'],['long','做多'],['short','做空']].map(([value,text])=>h('option',{attrs:{value},text})))) as HTMLSelectElement
      const status=h('select.input',{},...([['','全部状态'],['open','未平仓'],['closed','已平仓'],['opening_unknown','期初未知']].map(([value,text])=>h('option',{attrs:{value},text})))) as HTMLSelectElement
      const results=h('div.review-trade-list')
      const message=h('div.tip')
      const more=h('button.linkbtn',{text:'加载更多',hidden:true,on:{click:()=>void load(true)}}) as HTMLButtonElement
      let cursor: string | undefined
      let query: api.TradeFilter = {}
      let request=0
      let busy=false
      const filters=()=>({connection_id:account.value||undefined,symbol:search.value.trim().toUpperCase()||undefined,start_at:instant(from.value)||undefined,end_at:instant(to.value)||undefined,direction:side.value as api.TradeFilter['direction']||undefined,status:status.value as api.TradeFilter['status']||undefined})
      async function load(next=false) {
        const mine=++request
        try {
          if(!next) { query=filters();results.replaceChildren();cursor=undefined }
          if(query.start_at && query.end_at && query.start_at>=query.end_at) throw Error('结束时间要晚于开始时间。')
          message.textContent='正在查找…'; more.hidden=true
          const page=await api.cycles({...query,cursor},opts)
          if(!alive || mine!==request) return
          for(const row of page.items) renderRow(row)
          cursor=page.next_cursor||undefined;more.hidden=!cursor
          message.textContent=results.childNodes.length?'按持仓与所选时间范围重叠筛选；每一项是一轮持仓，点击后才会加入复盘。':'这个范围没有历史仓位，可调整筛选条件或先同步交易记录。'
        } catch(e) {if(alive && mine===request) message.textContent=e instanceof Error?e.message:'读取失败，请重试。'}
      }
      function renderRow(row: CycleRow) {
        const c=row.cycle
        const button=h('button.btn.sm',{data:{cycleId:row.id},text:values.some(v=>v.source==='exchange'&&v.cycle_id===row.id)?'已加入':'加入本次复盘'}) as HTMLButtonElement
        button.disabled=values.some(v=>v.source==='exchange'&&v.cycle_id===row.id)
        button.addEventListener('click',()=>{
          if(!enabled() || values.length>=20 || values.some(v=>v.source==='exchange'&&v.cycle_id===row.id)) return
          values.push({source:'exchange',connection_id:row.connection_id,cycle_id:row.id,leverage:null,note:null})
          snapshots.push({source:'exchange_ledger',cycle_id:row.id,cycle:c,account_name:accounts.find(a=>a.id===row.connection_id)?.name})
          render();changed();button.disabled=true;button.textContent='已加入'
        })
        results.append(h('div.review-trade-card',{},h('div.dlabel',{text:`${c.symbol} · ${direction(c.direction)} · ${c.status==='closed'?'已平仓':c.status==='open'?'未平仓':'期初未知'}`}),h('div.tip',{text:`${c.opened_at?dateTime(c.opened_at):'期初未知'} → ${c.closed_at?dateTime(c.closed_at):'未平仓'} · ${accounts.find(a=>a.id===row.connection_id)?.name ?? ''}`}),row.stale?h('div.tip',{text:'账户有新数据，这一轮来自先前计算的账本。'}):null,button))
      }
      const syncAction=new WriteAction()
      const sync=h('button.btn.sm',{text:'从交易所同步此范围',on:{click:()=>void synchronize()}}) as HTMLButtonElement
      async function synchronize() {
        if(busy || !enabled()) return
        try {
          const f=filters()
          if(!f.connection_id || !f.symbol || !f.start_at || !f.end_at) throw Error('同步前请选择一个账户，并填写品种、开始和结束时间。')
          if(f.start_at>=f.end_at) throw Error('结束时间要晚于开始时间。')
          busy=true;sync.disabled=true;message.textContent='正在从交易所同步…'
          const body={connection_id:f.connection_id,symbols:[f.symbol],start_at:f.start_at,end_at:f.end_at}
          const started=await api.sync(body,syncAction.keyFor(body),opts)
          const job=await jobs.waitFor(started.job_id,()=>{},opts)
          if(job.status!=='succeeded') throw Error('同步尚未完成，可在交易账户页面查看进度。')
          const result=job.result as {last_import?:{projection_job_id?:string}} | null
          if(result?.last_import?.projection_job_id) {
            const projection=await jobs.waitFor(result.last_import.projection_job_id,()=>{},opts)
            if(projection.status!=='succeeded') throw Error('成交已同步，仓位仍在计算。稍后点击查找。')
          }
          syncAction.reset();await load()
        }catch(e){if(alive)message.textContent=e instanceof Error?e.message:'同步失败。'}finally{busy=false;sync.disabled=false}
      }
      const label=(text:string,control:HTMLElement)=>h('label.review-trade-field',{},h('span.faint',{text}),control)
      picker.replaceChildren(h('div.review-trade-grid',{},label('账户',account),label('品种',search),label('时间范围从',from),label('时间范围至',to),label('方向',side),label('状态',status)),h('div.review-trade-actions',{},h('button.btn.sm',{text:'查找仓位',on:{click:()=>void load()}}),capabilityState('exchange_accounts')==='ready'?sync:null),message,results,more)
      void load()
    }catch(e){if(alive)picker.replaceChildren(h('div.tip',{text:e instanceof Error?e.message:'读取账户失败。'}),h('button.linkbtn',{text:'重试',on:{click:()=>void openPicker()}}))}
  }
  return {
    node:root, read:()=>copy(values), lock,
    hasContent:()=>values.length>0,
    valid:()=>values.every(t=>t.source!=='manual'||Boolean(t.symbol.trim()&&t.direction&&t.opened_at&&t.quantity&&t.quantity_unit)),
    restore(trades:ReviewTrade[]=[],saved:ReviewTradeSnapshot[]=[]){ values=copy(trades);snapshots=copy(saved);render();root.open=values.length>0 },
    dispose(){alive=false;controller.abort()},
  }
}

// 账本维护 —— 账是怎么进来的，期初是怎么定的，和对账单对不对得上。
//
// 这一屏上的每一个动作都会改账，所以每一个都遵守同一套规矩：
//
//   · 凭证不经过浏览器。登记账户和换钥匙只填本机钥匙串里那个条目的**名字**，
//     API key 和 secret 由本机服务层自己去取，页面上没有地方能填它们。
//   · 同一次动作重试复用同一个 Idempotency-Key，网络抖一下不会变成两笔导入。
//   · 改动带版本号：账户处置带 expected_revision，对不上就把新状态读回来给人看，
//     不覆盖。
//   · 期初不知道就说不知道。填 0 是在说“当时空仓”，那是另一件事。

import { ApiError, explain } from '../../api/errors'
import { Latest, WriteAction } from '../../api/http'
import * as trades from '../../api/trades'
import type { ExchangeConnection, ImportRow, ReconciliationResult } from '../../api/types'
import { dateTime } from '../../data/time'
import { clear, h } from '../../ui/dom'
import { empty, note, spinner } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { money, unknown } from './bits'
import {
  checkbox,
  field,
  inline,
  input,
  instantOf,
  panel,
  rows,
  select,
  symbolList,
  textarea,
} from './form'
import { exchangePanels } from './exchange'

const connectAction = new WriteAction()
const controlAction = new WriteAction()
const seedAction = new WriteAction()
const csvAction = new WriteAction()
const reconcileAction = new WriteAction()
const importsLane = new Latest()

export function bookPanel(
  connection: ExchangeConnection,
  all: ExchangeConnection[],
  onChanged: () => void,
): HTMLElement {
  const host = h('div')
  host.append(
    accountPanel(connection, all, onChanged),
    seedPanel(connection),
    csvPanel(connection),
    reconcilePanel(connection),
  )
  for (const node of exchangePanels(connection)) host.appendChild(node)
  host.appendChild(importsPanel(connection))
  return host
}

// ——— 账户 ———

function accountPanel(
  connection: ExchangeConnection,
  all: ExchangeConnection[],
  onChanged: () => void,
): HTMLElement {
  const body = h('div')

  const existing = h('div.ledger')
  for (const item of all) {
    existing.appendChild(
      h(
        'div.lrow',
        {},
        h(
          'div.body',
          {},
          h(
            'div.row',
            { style: 'gap:8px;align-items:center;flex-wrap:wrap' },
            h('span.h3', { text: item.name }),
            h('span.faint', { text: item.account_label }),
            h('span.tag', { text: item.market === 'coin_m' ? 'COIN-M' : 'USDⓈ-M' }),
            item.disabled_at ? h('span.tag.warn', { text: '已断开' }) : null,
          ),
          h('div.faint', {
            style: 'margin-top:4px',
            text: `账本版本 ${item.ledger_revision} · 配置版本 ${item.configuration_revision}`,
          }),
        ),
      ),
    )
  }
  body.append(h('div.dlabel', { text: '已登记的账户' }), existing)

  // 登记一个新账户
  const name = input('给它起个名字，例如 主账户')
  const label = input('交易所里的账户标签')
  const market = select(
    [
      ['usd_m', 'USDⓈ-M'],
      ['coin_m', 'COIN-M'],
    ],
    connection.market,
  )
  const keychain = input('scorebook.exchange.<你的账户>.<标签>')
  const create = h('button.btn.sm.primary', { text: '登记' })
  create.addEventListener('click', () => {
    const payload: trades.NewConnection = {
      name: name.value.trim(),
      account_label: label.value.trim(),
      market: market.value as 'usd_m' | 'coin_m',
      keychain_service: keychain.value.trim() || null,
    }
    if (!payload.name || !payload.account_label) {
      problem('名字和账户标签都要填。')
      return
    }
    void submit(create, () => trades.connect(payload, connectAction.keyFor(payload)), (result) => {
      connectAction.reset()
      toast(
        result.api_credentials === 'referenced_not_yet_verified'
          ? '账户登记好了。钥匙串里的名字记下了，还没验过——第一次同步的时候才知道它对不对。'
          : '账户登记好了。还没有接交易所，先用导入的账单也可以。',
      )
      onChanged()
    })
  })

  body.append(
    h('div.hr', { style: 'margin:16px 0' }),
    h('div.dlabel', { text: '登记一个新账户' }),
    rows(
      inline(field('名字', name), field('账户标签', label), field('市场', market)),
      field(
        '钥匙串条目（可以先不填）',
        keychain,
        '这里填的是本机钥匙串里那个条目的名字，不是 API key，也不是 secret。密钥由本机服务层自己去读，永远不经过这个页面。只想导入账单的话，这一栏留空。',
      ),
      inline(create),
    ),
  )

  // 处置：断开、重连、换钥匙
  const target = select(all.map((c) => [c.id, `${c.name} · ${c.account_label}`]), connection.id)
  const action = select([
    ['disconnect', '断开'],
    ['reconnect', '重连'],
    ['rotate_credentials', '换一把钥匙'],
  ])
  const newKeychain = input('scorebook.exchange.<你的账户>.<标签>')
  const apply = h('button.btn.sm', { text: '执行' })
  apply.addEventListener('click', () => {
    const picked = all.find((c) => c.id === target.value)
    if (!picked) return
    const act = action.value as trades.ConnectionAction
    const payload = {
      expected_revision: picked.configuration_revision,
      action: act,
      keychain_service: act === 'disconnect' ? null : newKeychain.value.trim() || null,
    }
    if (act !== 'disconnect' && !payload.keychain_service) {
      problem('重连和换钥匙都要填钥匙串条目的名字。')
      return
    }
    void submit(
      apply,
      () => trades.control(picked.id, payload, controlAction.keyFor([picked.id, payload])),
      () => {
        controlAction.reset()
        toast(
          act === 'disconnect'
            ? '已断开。已经记下来的账原样留着，只是不会再自动同步了。'
            : '配置更新了。之前排着的同步不会自己接着跑，要重新发起一次。',
        )
        onChanged()
      },
    )
  })

  body.append(
    h('div.hr', { style: 'margin:16px 0' }),
    h('div.dlabel', { text: '处置一个账户' }),
    rows(
      inline(field('账户', target), field('要做什么', action)),
      field('新的钥匙串条目', newKeychain, '断开时不用填。断开会把这台机器上对这个账户的凭证引用删掉，账不删。'),
      inline(apply),
    ),
  )

  return panel(
    '账户',
    '一个账户就是一本账。登记它只是给这本账起个名字；要不要让它连交易所，是另一件事。',
    body,
    all.length === 0,
  )
}

// ——— 期初持仓 ———

function seedPanel(connection: ExchangeConnection): HTMLElement {
  const symbol = input('BTCUSDT')
  const side = select([
    ['BOTH', '单向持仓'],
    ['LONG', '双向持仓 · 多'],
    ['SHORT', '双向持仓 · 空'],
  ])
  const at = input('', { type: 'datetime-local' })
  const known = checkbox('这个时点手里有多少，我知道', true)
  const quantity = input('单向持仓可以带正负号')
  const entry = input('开仓均价')
  const multiplier = input('1', { value: '1' })
  const asset = input('USDT')
  const evidence = textarea('从哪儿看到的：哪一天的对账单、哪个页面的截图。后端要求必须写。')

  const numbers = h('div', {}, inline(field('数量', quantity), field('开仓均价', entry)))
  known.box.addEventListener('change', () => {
    numbers.hidden = !known.box.checked
  })

  const save = h('button.btn.sm.primary', { text: '记下期初' })
  save.addEventListener('click', () => {
    const effective = instantOf(at.value)
    if (!effective) {
      problem('要填一个时点：这条期初是从哪一刻开始算的。')
      return
    }
    const payload: trades.PositionSeed = {
      connection_id: connection.id,
      symbol: symbol.value.trim().toUpperCase(),
      position_side: side.value as 'BOTH' | 'LONG' | 'SHORT',
      effective_at: effective,
      quantity: known.box.checked ? quantity.value.trim() || null : null,
      entry_price: known.box.checked ? entry.value.trim() || null : null,
      contract_multiplier: multiplier.value.trim() || '1',
      settlement_asset: asset.value.trim().toUpperCase(),
      evidence: evidence.value.trim(),
    }
    if (!payload.symbol || !payload.settlement_asset || !payload.evidence) {
      problem('合约、结算币种和依据都要填。')
      return
    }
    void submit(save, () => trades.seedPosition(payload, seedAction.keyFor(payload)), () => {
      seedAction.reset()
      toast(
        known.box.checked
          ? '期初记下了，这个品种的账正在重算。'
          : '记下了「期初不知道」。这之后的轮次会一直标着期初不明，盈亏不会替你算出一个数来。',
      )
    })
  })

  return panel(
    '期初持仓',
    '导进来的账如果不是从第一天开始的，那第一笔平仓平的是什么，账本并不知道。在这里把那个时点手里有多少写清楚；确实不知道也可以直说——那些轮次会一直标着「期初不明」，而不是被当成 0。',
    rows(
      inline(field('合约', symbol), field('持仓方向', side), field('时点', at)),
      known.row,
      numbers,
      inline(field('合约乘数', multiplier), field('结算币种', asset)),
      field('依据', evidence),
      inline(save),
    ),
  )
}

// ——— CSV 导入 ———

function csvPanel(connection: ExchangeConnection): HTMLElement {
  const file = h('input', { type: 'file', attrs: { accept: '.csv,text/csv' } }) as HTMLInputElement
  const text = textarea('也可以直接把 CSV 内容贴进来。', 6)
  const from = input('', { type: 'datetime-local' })
  const to = input('', { type: 'datetime-local' })
  const symbols = input('BTCUSDT, ETHUSDT')
  const complete = checkbox('这段时间的成交我确认已经全在里面了', false)
  const save = h('button.btn.sm.primary', { text: '导入' })

  file.addEventListener('change', () => {
    const picked = file.files?.[0]
    if (!picked) return
    void picked.text().then((content) => {
      text.value = content
    })
  })

  save.addEventListener('click', () => {
    const start = instantOf(from.value)
    const end = instantOf(to.value)
    if (!start || !end) {
      problem('要说清楚这份账单覆盖的是哪一段时间。')
      return
    }
    const payload: trades.CsvImport = {
      connection_id: connection.id,
      csv: text.value,
      schema: 'scorebook_fills_v1',
      start_at: start,
      end_at: end,
      symbols: symbolList(symbols.value),
      declared_complete: complete.box.checked,
    }
    if (!payload.csv.trim()) {
      problem('先选一个 CSV 文件，或者把内容贴进来。')
      return
    }
    void submit(save, () => trades.importCsv(payload, csvAction.keyFor(payload)), (result) => {
      csvAction.reset()
      toast(
        `导入完成：新增 ${result.inserted_fills} 笔，重复 ${result.duplicate_fills} 笔已经跳过。账正在重算。`,
      )
    })
  })

  return panel(
    '导入成交（CSV）',
    '表头要用后端认的那几列：trade_id、order_id、symbol、side、position_side、price、quantity、realized_pnl、settlement_asset、commission、commission_asset、traded_at、liquidation。同一笔成交导两次不会变成两笔——后端按成交号认人，重复的直接跳过。',
    rows(
      field('CSV 文件', file),
      field('或者直接贴内容', text),
      inline(field('这份账单从', from), field('到', to)),
      field('涉及的合约', symbols, '逗号分开。留空表示这份账单里出现的都算。'),
      complete.row,
      h('div.tip', {
        text: '只有勾了「已经全在里面了」，对账才会按完整口径来。拿不准就别勾——界面上会一直标着这段可能不全，这比对出一个假的差额要好。',
      }),
      inline(save),
    ),
  )
}

// ——— 对账 ———

function reconcilePanel(connection: ExchangeConnection): HTMLElement {
  const from = input('', { type: 'datetime-local' })
  const to = input('', { type: 'datetime-local' })
  const evidence = textarea('这份对账单是从哪儿来的。')
  const assetRows = h('div', { style: 'display:flex;flex-direction:column;gap:10px' })
  const result = h('div', { style: 'margin-top:14px' })

  function addAsset(asset = ''): void {
    const a = input('USDT', { value: asset, width: '120px' })
    const pnl = input('已实现盈亏', { width: '150px' })
    const commission = input('手续费', { width: '150px' })
    const funding = input('资金费', { width: '150px' })
    const tolerance = input('容差', { value: '0', width: '110px' })
    const row = h(
      'div.row',
      { style: 'gap:8px;flex-wrap:wrap;align-items:flex-end' },
      field('币种', a),
      field('已实现盈亏', pnl),
      field('手续费', commission),
      field('资金费', funding),
      field('容差', tolerance),
      h('button.btn.sm.ghost', { text: '删掉', on: { click: () => row.remove() } }),
    )
    row.dataset.asset = 'row'
    assetRows.appendChild(row)
  }
  addAsset('USDT')

  const check = h('button.btn.sm.primary', { text: '对一下' })
  check.addEventListener('click', () => {
    const start = instantOf(from.value)
    const end = instantOf(to.value)
    if (!start || !end) {
      problem('要说清楚对的是哪一段。')
      return
    }
    const statement: trades.AssetStatement[] = []
    for (const row of Array.from(assetRows.children)) {
      const inputs = Array.from(row.querySelectorAll('input')) as HTMLInputElement[]
      const [a, pnl, commission, funding, tolerance] = inputs
      if (!a?.value.trim()) continue
      statement.push({
        asset: a.value.trim().toUpperCase(),
        realized_pnl: pnl?.value.trim() || '0',
        commission: commission?.value.trim() || '0',
        funding: funding?.value.trim() || '0',
        tolerance: tolerance?.value.trim() || '0',
      })
    }
    if (!statement.length) {
      problem('至少填一个币种的数。')
      return
    }
    const payload: trades.Reconciliation = {
      connection_id: connection.id,
      start_at: start,
      end_at: end,
      statement,
      evidence: evidence.value.trim(),
    }
    if (!payload.evidence) {
      problem('写一句这份对账单是从哪儿来的。')
      return
    }
    void submit(
      check,
      () => trades.reconcile(payload, reconcileAction.keyFor(payload)),
      (outcome) => {
        reconcileAction.reset()
        clear(result)
        result.appendChild(reconciliationView(outcome))
      },
    )
  })

  return panel(
    '和对账单对一下',
    '把交易所对账单上的数字按币种填进来，看看和这里记的账差在哪。差额是后端按十进制算的；有成交缺已实现盈亏的时候，差额会写成「算不出来」，不会写成 0。',
    rows(
      inline(field('从', from), field('到', to)),
      h('div.dlabel', { text: '对账单上的数字' }),
      assetRows,
      inline(h('button.btn.sm.ghost', { text: '再加一个币种', on: { click: () => addAsset() } })),
      field('依据', evidence),
      inline(check),
      result,
    ),
  )
}

const METRIC: Record<string, string> = {
  realized_pnl: '已实现盈亏',
  commission: '手续费',
  funding: '资金费',
}

function reconciliationView(outcome: ReconciliationResult): HTMLElement {
  const host = h('div')

  if (outcome.status === 'unverified_coverage') {
    host.appendChild(
      note(
        'warn',
        '这一段的成交没有被声明为完整，所以这次比对只能算参考。先把缺的那部分导进来，或者在导入时确认这一段已经齐了，再对一次。',
      ),
    )
  } else if (outcome.status === 'matched_declared_range') {
    host.appendChild(note('info', '在你声明完整的这一段里，每个币种都对上了。'))
  } else {
    host.appendChild(note('warn', '有对不上的地方，下面按币种列出来了。'))
  }

  if (outcome.assets_missing_from_statement.length) {
    host.appendChild(
      note(
        'warn',
        `这几个币种这里有账、对账单上没填：${outcome.assets_missing_from_statement.join('、')}。`,
      ),
    )
  }

  for (const asset of outcome.items) {
    const lines = h('div.kv', { style: 'margin-top:8px' })
    for (const item of asset.items) {
      lines.appendChild(
        h(
          'div.kvrow',
          {},
          h('span.dlabel', { text: METRIC[item.metric] ?? item.metric }),
          h(
            'span',
            { style: 'display:inline-flex;gap:14px;flex-wrap:wrap;align-items:center' },
            h('span', {}, h('span.faint', { text: '这里 ' }), item.actual === null || item.actual === undefined
              ? unknown('这一段里有成交没带已实现盈亏，加不出一个可比的总数')
              : money(item.actual, asset.asset)),
            h('span', {}, h('span.faint', { text: '对账单 ' }), money(item.statement, asset.asset)),
            h('span', {}, h('span.faint', { text: '差 ' }), item.difference === null || item.difference === undefined
              ? unknown('缺少已实现盈亏，差额算不出来')
              : money(item.difference, asset.asset)),
            item.within_tolerance
              ? h('span.tag', { text: '在容差内' })
              : h('span.tag.warn', { text: '超出容差' }),
          ),
        ),
      )
    }
    host.appendChild(
      h(
        'div.sheet.pad',
        { style: 'margin-top:12px' },
        h('div.h3', { text: asset.asset }),
        asset.fills_missing_realized_pnl > 0
          ? h('div.tip', {
              style: 'margin-top:4px',
              text: `这一段里有 ${asset.fills_missing_realized_pnl} 笔成交没有带已实现盈亏，所以这个币种的已实现是加不全的。`,
            })
          : null,
        lines,
      ),
    )
  }

  host.appendChild(
    h('div.tip', {
      style: 'margin-top:10px',
      text: '资金费单独记，不和成交盈亏混在一起；也不会把同一笔既算成收入又算成手续费。这次比对只覆盖你指定的这一段，不代表整个账户历史都核对过。',
    }),
  )
  return host
}

// ——— 导入记录 ———

function importsPanel(connection: ExchangeConnection): HTMLElement {
  const list = h('div', {}, spinner('正在读导入记录'))
  const body = h('div', {}, list)

  void (async () => {
    try {
      const page = await trades.imports(
        { connection_id: connection.id },
        { signal: importsLane.begin() },
      )
      clear(list)
      if (!page.items.length) {
        list.appendChild(empty({ title: '还没有导入过', tip: '从上面的 CSV 开始。' }))
        return
      }
      const ledger = h('div.ledger')
      for (const row of page.items) ledger.appendChild(importRow(row))
      list.appendChild(ledger)
    } catch (error) {
      if (Latest.aborted(error)) return
      clear(list)
      list.appendChild(
        note('warn', error instanceof Error ? error.message : '导入记录没有读出来。'),
      )
    }
  })()

  return panel('导入记录', '每一次导入都留着：什么时候、从哪儿来、覆盖哪一段。', body)
}

function importRow(row: ImportRow): HTMLElement {
  const body = (row.body ?? {}) as Record<string, unknown>
  const coverage = (body.coverage ?? {}) as Record<string, unknown>
  const complete = coverage.declared_complete === true || body.declared_complete === true
  const start = (body.start_at ?? coverage.start_at) as string | undefined
  const end = (body.end_at ?? coverage.end_at) as string | undefined
  return h(
    'div.lrow',
    {},
    h(
      'div.body',
      {},
      h(
        'div.row',
        { style: 'gap:8px;align-items:center;flex-wrap:wrap' },
        h('span.h3', { text: sourceLabel(String(row.source ?? body.source ?? '')) }),
        complete
          ? h('span.tag', { text: '声明完整' })
          : h('span.tag.warn', { title: '这一段可能不全，对账时按参考看', text: '未声明完整' }),
      ),
      h('div.faint', {
        style: 'margin-top:4px',
        text: `${dateTime(row.created_at)} 导入${start && end ? ` · 覆盖 ${dateTime(start)} 到 ${dateTime(end)}` : ''}`,
      }),
    ),
  )
}

const SOURCE: Record<string, string> = {
  csv: '手工导入的 CSV',
  account_api: '交易所接口同步',
  historical_export: '交易所账单导出',
}

function sourceLabel(source: string): string {
  return SOURCE[source] ?? source ?? '导入'
}

// ——— 提交 ———

/**
 * 所有写操作走这一个口子：按钮变忙、失败翻译成人话、冲突不重试。
 *
 * 这里刻意不做自动重试。后端已经拿 Idempotency-Key 保证了同一次动作重发不会写第
 * 二遍，但版本冲突是另一回事——那说明底下的东西变了，该做的是把新状态读回来给人
 * 看，而不是再发一遍把别人的改动盖掉。
 */
async function submit<T>(
  button: HTMLElement,
  call: () => Promise<T>,
  done: (result: T) => void,
): Promise<void> {
  const node = button as HTMLButtonElement
  const label = node.textContent ?? ''
  node.disabled = true
  node.textContent = '正在提交…'
  try {
    done(await call())
  } catch (error) {
    if (error instanceof ApiError) {
      problem(error.isConflict ? `${explain(error.code)}（这次没有重发，免得把别处的改动盖掉。）` : error.message)
    } else {
      problem(error instanceof Error ? error.message : '没有提交成功。')
    }
  } finally {
    node.disabled = false
    node.textContent = label
  }
}

export { submit }

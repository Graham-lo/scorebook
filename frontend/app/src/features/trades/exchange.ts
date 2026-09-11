// 直连交易所的两件事：按接口同步一段成交，和让交易所生成一份历史账单。
//
// 这两件事都要用凭证，所以能不能用由后端的能力清单说了算，不由这个页面猜。清单说
// 没配好，这里就直说没配好、该去配什么，而不是摆一个注定失败的按钮，更不会退回去
// 用别的办法假装成功。密钥本身始终留在本机钥匙串里，这个页面只经手条目的名字。
//
// 账单导出还有一条单独的规矩：提交出去却没拿到回执的那一次，后端不会自己再提交一
// 遍——重提要占交易所每月的配额，还会多出一份账单。所以要人去交易所看一眼，把真实
// 的下载编号填回来。这一步没法自动化，界面上就照实这么说。

import { ApiError, explain } from '../../api/errors'
import { WriteAction } from '../../api/http'
import * as jobs from '../../api/jobs'
import * as trades from '../../api/trades'
import type {
  CsvMapping,
  ExchangeConnection,
  ExportRun,
  JobStatus,
  Uuid,
} from '../../api/types'
import { capabilityState } from '../../data/session'
import { clear, h } from '../../ui/dom'
import { note, progressLine } from '../../ui/states'
import { problem, toast } from '../../ui/toast'
import { field, inline, input, instantOf, panel, rows, select, symbolList, textarea } from './form'
import { submit } from './maintain'

const syncAction = new WriteAction()
const exportAction = new WriteAction()
const resolveAction = new WriteAction()
const mappingAction = new WriteAction()
const retryAction = new WriteAction()

/** 上一次发起的账单导出。回到这一页还能接着看它走到哪儿了。 */
let tracking: Uuid | null = null

export function exchangePanels(connection: ExchangeConnection): HTMLElement[] {
  return [syncPanel(connection), exportPanel(connection)]
}

/** 凭证没配好的时候，摆出来的不是一个坏掉的表单，是一句该做什么。 */
function credentialsGate(): HTMLElement | null {
  const state = capabilityState('exchange_accounts')
  if (state === 'ready') return null
  if (state === 'unknown') {
    return note('warn', '读不到后端的能力清单，所以不知道这台机器上配没配过交易所凭证。先确认后端在运行。')
  }
  return note(
    'warn',
    '这台机器上还没有登记过交易所的只读密钥。按部署说明把一把只读的 API key 放进本机钥匙串，再到上面的「账户」里填那个条目的名字。密钥不经过这个页面。',
  )
}

// ——— 直连同步 ———

function syncPanel(connection: ExchangeConnection): HTMLElement {
  const gate = credentialsGate()
  const from = input('', { type: 'datetime-local' })
  const to = input('', { type: 'datetime-local' })
  const symbols = input('BTCUSDT, ETHUSDT')
  const progress = h('div', { style: 'margin-top:12px' })
  const start = h('button.btn.sm.primary', { text: '同步这一段', disabled: !!gate })

  start.addEventListener('click', () => {
    const startAt = instantOf(from.value)
    const endAt = instantOf(to.value)
    const list = symbolList(symbols.value)
    if (!startAt || !endAt) {
      problem('要说清楚同步哪一段。')
      return
    }
    if (!list.length) {
      problem('要写明同步哪些合约。接口按合约取，不写就没有范围。')
      return
    }
    const payload = { connection_id: connection.id, start_at: startAt, end_at: endAt, symbols: list }
    void submit(start, () => trades.sync(payload, syncAction.keyFor(payload)), (result) => {
      syncAction.reset()
      watchJob(result.job_id, progress, '同步')
    })
  })

  return panel(
    '从交易所直接同步',
    '按你指定的合约和时间段去交易所取成交。取回来的只是你点名的那几个合约、那一段时间，不是整个账户的历史。',
    rows(
      gate ?? h('div', { hidden: true }),
      inline(field('从', from), field('到', to)),
      field('合约', symbols, '逗号分开。接口按合约取，所以这里必须写。'),
      inline(start),
      progress,
    ),
  )
}

// ——— 账单导出 ———

const TRADE_FIELDS: [string, string][] = [
  ['trade_id', '成交号'],
  ['order_id', '订单号'],
  ['symbol', '合约'],
  ['side', '买卖方向'],
  ['position_side', '持仓方向'],
  ['price', '成交价'],
  ['quantity', '数量'],
  ['realized_pnl', '已实现盈亏'],
  ['settlement_asset', '结算币种'],
  ['commission', '手续费'],
  ['commission_asset', '手续费币种'],
  ['traded_at', '成交时间'],
  ['liquidation', '是否强平'],
]

const LEDGER_FIELDS: [string, string][] = [
  ['transaction_id', '流水号'],
  ['kind', '类别'],
  ['symbol', '合约'],
  ['asset', '币种'],
  ['amount', '金额'],
  ['occurred_at', '发生时间'],
  ['trade_id', '关联成交号'],
]

const STAMP_FORMATS: [string, string][] = [
  ['iso8601', 'ISO 8601（2026-01-02T03:04:05Z）'],
  ['unix_ms', 'Unix 毫秒'],
  ['utc_datetime', 'UTC 时间（2026-01-02 03:04:05）'],
]

interface MappingEditor {
  node: HTMLElement
  /** 读不出一份能用的对应关系就返回 null，并把原因说给交易员听。 */
  read: () => CsvMapping | null
  retarget: (dataset: string) => void
}

/**
 * 账单里每一列是什么，只有人知道。后端不猜列名也不猜币种——猜错了账本就是错的，
 * 所以这里让交易员一列一列指明白。一个字段要么指一列，要么给一个固定值，不能都填。
 */
function mappingEditor(dataset: string, headers: string[], initial?: CsvMapping): MappingEditor {
  const node = h('div', { style: 'display:flex;flex-direction:column;gap:8px' })
  const list = h('datalist', { id: `export-headers-${Math.random().toString(36).slice(2, 8)}` })
  for (const name of headers) {
    const option = document.createElement('option')
    option.value = name
    list.appendChild(option)
  }
  node.appendChild(list)
  const stamp = select(STAMP_FORMATS, initial?.timestamp_format)

  function paint(which: string): void {
    for (const row of Array.from(node.children) as HTMLElement[]) {
      if (row.dataset.key || row.dataset.role === 'stamp') row.remove()
    }
    for (const [key, label] of which === 'trades' ? TRADE_FIELDS : LEDGER_FIELDS) {
      const column = input('账单里的表头', { width: '200px', value: initial?.columns?.[key] ?? '' })
      if (headers.length) column.setAttribute('list', list.id)
      const constant = input('固定值', { width: '140px', value: initial?.constants?.[key] ?? '' })
      const row = h(
        'div.row',
        { style: 'gap:8px;align-items:flex-end;flex-wrap:wrap' },
        h('span.dlabel', { style: 'min-width:7em', text: label }),
        field('表头', column),
        field('或固定值', constant),
      )
      row.dataset.key = key
      node.appendChild(row)
    }
    const stampRow = h('div', {}, field('时间列的写法', stamp))
    stampRow.dataset.role = 'stamp'
    node.appendChild(stampRow)
  }
  paint(dataset)

  return {
    node,
    retarget: paint,
    read: () => {
      const columns: Record<string, string> = {}
      const constants: Record<string, string> = {}
      for (const row of Array.from(node.children) as HTMLElement[]) {
        const key = row.dataset.key
        if (!key) continue
        const [column, constant] = Array.from(row.querySelectorAll('input')) as HTMLInputElement[]
        const header = column?.value.trim() ?? ''
        const fixed = constant?.value.trim() ?? ''
        if (header && fixed) {
          problem(`「${key}」既指了表头又填了固定值，只能选一个。`)
          return null
        }
        if (header) columns[key] = header
        else if (fixed) constants[key] = fixed
      }
      if (!Object.keys(columns).length) {
        problem('至少要指明一列。后端不会去猜哪一列是什么。')
        return null
      }
      return { columns, constants, timestamp_format: stamp.value }
    },
  }
}

function exportPanel(connection: ExchangeConnection): HTMLElement {
  const gate = credentialsGate()
  const from = input('', { type: 'datetime-local' })
  const to = input('', { type: 'datetime-local' })
  const dataset = select([
    ['trades', '成交'],
    ['ledger', '资金流水'],
  ])
  const format = select([
    ['csv', 'CSV'],
    ['zip_csv', 'ZIP 里的一份 CSV'],
  ])
  const mapping = mappingEditor(dataset.value, [])
  dataset.addEventListener('change', () => mapping.retarget(dataset.value))
  const track = h('div', { style: 'margin-top:14px' })

  const create = h('button.btn.sm.primary', { text: '让交易所准备账单', disabled: !!gate })
  create.addEventListener('click', () => {
    const startAt = instantOf(from.value)
    const endAt = instantOf(to.value)
    if (!startAt || !endAt) {
      problem('要说清楚账单覆盖哪一段。')
      return
    }
    const table = mapping.read()
    if (!table) return
    const payload: trades.NewExport = {
      connection_id: connection.id,
      start_at: startAt,
      end_at: endAt,
      dataset: dataset.value as 'trades' | 'ledger',
      format: format.value as 'csv' | 'zip_csv',
      mapping: table,
    }
    void submit(create, () => trades.createExport(payload, exportAction.keyFor(payload)), (result) => {
      exportAction.reset()
      tracking = result.export_run_id
      toast('已经排上了。交易所那边生成账单要一会儿，这一页会盯着它。')
      void refreshTracking(track)
    })
  })

  if (tracking) void refreshTracking(track)

  return panel(
    '让交易所生成历史账单',
    '接口只能取近期，更早的要走交易所的账单导出。每个月能导几份是交易所定的，导出也不是马上就有。哪一列是什么必须在这里说明白，后端不猜列名，也不猜币种。',
    rows(
      gate ?? h('div', { hidden: true }),
      inline(field('从', from), field('到', to), field('要哪一种', dataset), field('文件格式', format)),
      h('div.dlabel', { text: '每一列对应什么' }),
      mapping.node,
      inline(create),
      track,
    ),
  )
}

/** 把这一次导出现在的样子摆出来，包括那个只有人能做的动作。 */
async function refreshTracking(host: HTMLElement): Promise<void> {
  if (!tracking) return
  const id = tracking
  clear(host)
  host.appendChild(h('div.faint', { text: '正在读这次导出的状态…' }))
  let run: ExportRun
  try {
    run = await trades.exportGet(id)
  } catch (error) {
    clear(host)
    host.appendChild(note('warn', error instanceof ApiError ? error.message : '这次导出的状态没有读出来。'))
    return
  }
  clear(host)
  host.appendChild(exportView(run, host))
}

const EXPORT_STATUS: Record<string, string> = {
  prepared: '排上了，还没提交给交易所',
  submitting: '正在向交易所提交',
  submission_unknown: '提交出去了，但不知道有没有成功',
  polling: '交易所正在准备，等它给文件',
  complete: '做完了',
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function exportView(run: ExportRun, host: HTMLElement): HTMLElement {
  const body = h('div.sheet.pad')
  const job = run.job_status as JobStatus
  const shown = jobs.jobLine(job)
  const imported = typeof run.imported_rows === 'number' ? run.imported_rows : 0
  body.append(
    h('div.h3', { text: EXPORT_STATUS[run.status] ?? run.status }),
    progressLine(shown.text, shown.progress),
  )
  if (imported > 0) {
    body.appendChild(h('div.faint', { style: 'margin-top:4px', text: `已经读进账本 ${imported} 行。` }))
  }
  if (run.error_code) {
    body.appendChild(note('warn', explain(run.error_code)))
  }

  if (run.status === 'submission_unknown') {
    body.append(...resolveForm(run, host))
  }

  // 列指错了，账单是好的：后端把它停在这儿，还没往账本里写一行，所以改完对应关系
  // 直接接着跑，不用再向交易所要一份、也不用再占一次配额。
  const remappable =
    imported === 0 &&
    (run.status === 'polling' || run.status === 'prepared') &&
    job !== 'running' &&
    job !== 'succeeded' &&
    job !== 'cancelled'
  if (remappable) body.appendChild(remapPanel(run, host))

  if (jobs.canRetry({ status: job })) {
    const again = h('button.btn.sm.ghost', { text: '照原样再试一次' })
    again.addEventListener('click', () => {
      const payload = [run.id, run.generation] as const
      void submit(
        again,
        () => jobs.retry(run.id, run.generation, retryAction.keyFor(payload)),
        () => {
          retryAction.reset()
          void refreshTracking(host)
        },
      )
    })
    body.appendChild(h('div.row', { style: 'margin-top:12px;gap:10px' }, again))
  }

  if (run.status === 'complete') {
    body.appendChild(
      h('div.tip', {
        style: 'margin-top:8px',
        text: '这份账单覆盖的是你指定的那一段，不代表整个账户的历史都齐了。',
      }),
    )
  } else {
    body.appendChild(
      h(
        'div.row',
        { style: 'margin-top:12px;gap:10px' },
        h('button.btn.sm.ghost', {
          text: '看看现在到哪儿了',
          on: { click: () => void refreshTracking(host) },
        }),
      ),
    )
  }
  return body
}

function resolveForm(run: ExportRun, host: HTMLElement): HTMLElement[] {
  const downloadId = input('交易所页面上那份账单的下载编号（纯数字）')
  const evidence = textarea('你在哪儿看到它的：交易所的哪个页面、什么时候。', 2)
  const send = h('button.btn.sm.primary', { text: '就是这一份' })
  send.addEventListener('click', () => {
    const payload = {
      expected_generation: run.generation,
      download_id: downloadId.value.trim(),
      evidence: evidence.value.trim(),
    }
    if (!payload.download_id || !payload.evidence) {
      problem('下载编号和你在哪儿看到的都要填。这是这份账单和那次提交对得上的唯一凭据。')
      return
    }
    void submit(
      send,
      () => trades.resolveExport(run.id, payload, resolveAction.keyFor([run.id, payload])),
      () => {
        resolveAction.reset()
        toast('记下了，接着按这份账单往下走。')
        void refreshTracking(host)
      },
    )
  })
  return [
    note(
      'warn',
      '上一次提交出去之后没拿到回执，所以后端停在这儿，没有自己再提交一遍——重提要占交易所每月的配额，还会多出一份账单。请到交易所的账单页面看一眼：那一份已经在生成了，就把它的下载编号填在下面；根本没有，就重新发起一次。',
    ),
    rows(field('下载编号', downloadId), field('你在哪儿看到的', evidence), inline(send)),
  ]
}

function remapPanel(run: ExportRun, host: HTMLElement): HTMLElement {
  const body = (run.body ?? {}) as { dataset?: string; mapping?: CsvMapping }
  const headers = stringsOf(run.header)
  const editor = mappingEditor(body.dataset ?? 'trades', headers, body.mapping)
  const save = h('button.btn.sm.primary', { text: '按这个再读一遍' })
  save.addEventListener('click', () => {
    const table = editor.read()
    if (!table) return
    const payload = { expected_generation: run.generation, mapping: table }
    void submit(
      save,
      () => trades.updateExportMapping(run.id, payload, mappingAction.keyFor([run.id, payload])),
      () => {
        mappingAction.reset()
        toast('改好了，接着按新的对应关系读这份账单。')
        void refreshTracking(host)
      },
    )
  })
  return panel(
    '改列的对应关系',
    headers.length
      ? '账单已经拿到了，但列没对上，所以一行都还没写进账本。下面是这份账单里真实的表头，照着改完就能接着读——不用再向交易所要一份。'
      : '还没读到这份账单的表头。改完对应关系可以接着读，不用再向交易所要一份。',
    rows(editor.node, inline(save)),
    true,
  )
}

/** 后台任务的进度。它只报进度，不替任务宣布结果。 */
function watchJob(id: Uuid, host: HTMLElement, what: string): void {
  clear(host)
  const line = h('div')
  host.appendChild(line)
  void jobs
    .waitFor(id, (job) => {
      const shown = jobs.jobLine(job.status)
      clear(line)
      line.appendChild(progressLine(`${what}：${shown.text}`, shown.progress))
    })
    .then((job) => {
      clear(line)
      if (job.status === 'succeeded') {
        line.appendChild(note('info', `${what}做完了。到「成交明细」看这一段。`))
        return
      }
      const why = job.error_code ? explain(job.error_code) : ''
      line.appendChild(note('warn', `${what}没有做完：${jobs.jobLine(job.status).text}。${why}`))
    })
    .catch((error) => {
      clear(line)
      line.appendChild(note('warn', error instanceof Error ? error.message : `${what}的进度读不出来。`))
    })
}

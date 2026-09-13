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
import { field, inline, input, instantOf, panel, rows, select, symbolList, textarea } from './fills-form'
import { submit } from './fills-book'

const syncAction = new WriteAction()
const exportAction = new WriteAction()
const resolveAction = new WriteAction()
const mappingAction = new WriteAction()
const retryAction = new WriteAction()

/** 上一次发起的账单导出。回到这一页还能接着看它走到哪儿了。 */
const trackingByConnection = new Map<Uuid, Uuid>()
const trackingRuns = new WeakMap<HTMLElement, Uuid>()

export function exchangePanels(connection: ExchangeConnection, onChanged: () => void): HTMLElement[] {
  return [syncPanel(connection, onChanged), exportPanel(connection, onChanged)]
}

/** 凭证没配好的时候，摆出来的不是一个坏掉的表单，是一句该做什么。 */
function credentialsGate(): HTMLElement | null {
  const state = capabilityState('exchange_accounts')
  if (state === 'ready') return null
  if (state === 'unknown') {
    return note('warn', '连不上本机服务')
  }
  return note('warn', '这台机器上还没有密钥')
}

// ——— 直连同步 ———

function syncPanel(connection: ExchangeConnection, onChanged: () => void): HTMLElement {
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
    if (!startAt || !endAt || startAt >= endAt) {
      problem('要说清楚同步哪一段。')
      return
    }
    if (!list.length) {
      problem('要写明同步哪些合约')
      return
    }
    const payload = { connection_id: connection.id, start_at: startAt, end_at: endAt, symbols: list }
    void submit(start, () => trades.sync(payload, syncAction.keyFor(payload)), (result) => {
      syncAction.reset()
      watchJob(result.job_id, progress, '同步', onChanged)
    })
  })

  return panel(
    '从交易所同步',
    rows(
      gate ?? h('div', { hidden: true }),
      inline(field('从', from), field('到', to)),
      field('合约', symbols, '逗号分开'),
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
        problem('至少要指明一列')
        return null
      }
      return { columns, constants, timestamp_format: stamp.value }
    },
  }
}

function exportPanel(connection: ExchangeConnection, onChanged: () => void): HTMLElement {
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
  trackingChanges.set(track, onChanged)
  const previous = trackingByConnection.get(connection.id)
  if (previous) trackingRuns.set(track, previous)

  const create = h('button.btn.sm.primary', { text: '让交易所准备账单', disabled: !!gate })
  create.addEventListener('click', () => {
    const startAt = instantOf(from.value)
    const endAt = instantOf(to.value)
    if (!startAt || !endAt || startAt >= endAt) {
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
      trackingByConnection.set(connection.id, result.export_run_id)
      trackingRuns.set(track, result.export_run_id)
      toast('记下了')
      void refreshTracking(track)
    })
  })

  if (previous) void refreshTracking(track)

  return panel(
    '账单导出',
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

const trackingChanges = new WeakMap<HTMLElement, () => void>()

/** 把这一次导出现在的样子摆出来，包括那个只有人能做的动作。 */
async function refreshTracking(host: HTMLElement): Promise<void> {
  const id = trackingRuns.get(host)
  if (!id) return
  clear(host)
  host.appendChild(h('div.faint', { text: '正在读这次导出的状态…' }))
  let run: ExportRun
  try {
    run = await trades.exportGet(id)
    if (trackingRuns.get(host) !== id) return
  } catch (error) {
    if (trackingRuns.get(host) !== id) return
    clear(host)
    host.append(note('warn', error instanceof ApiError ? error.message : '这一段读不出来'),
      h('button.btn.sm', { text: '重试', on: { click: () => void refreshTracking(host) } }),
    )
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
    trackingChanges.get(host)?.()
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
    body.appendChild(h('div.tip', { style: 'margin-top:8px', text: '只覆盖你指定的那一段' }))
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
  const downloadId = input('下载编号')
  const evidence = textarea('在哪儿看到的', 2)
  const send = h('button.btn.sm.primary', { text: '就是这一份' })
  send.addEventListener('click', () => {
    const payload = {
      expected_generation: run.generation,
      download_id: downloadId.value.trim(),
      evidence: evidence.value.trim(),
    }
    if (!payload.download_id || !payload.evidence) {
      problem('下载编号和出处都要填')
      return
    }
    void submit(
      send,
      () => trades.resolveExport(run.id, payload, resolveAction.keyFor([run.id, payload])),
      () => {
        resolveAction.reset()
        toast('记下了')
        void refreshTracking(host)
      },
    )
  })
  return [
    note('warn', '不知道上一次提交成没成'),
    rows(field('下载编号', downloadId), field('出处', evidence), inline(send)),
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
        toast('记下了')
        void refreshTracking(host)
      },
    )
  })
  return panel('列名对应', rows(editor.node, inline(save)), true)
}

/** 后台任务的进度。它只报进度，不替任务宣布结果。 */
function watchJob(id: Uuid, host: HTMLElement, what: string, onChanged: () => void): void {
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
        onChanged()
        line.appendChild(note('info', `${what}做完了`))
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

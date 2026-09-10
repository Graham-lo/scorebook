// 实盘账本。真实成交、导入、轮次、资金流水、对账和事后关联。
//
// 两条规则贯穿这个文件：
//
// 1. 凭证不经过浏览器。建连接和换钥匙只传本机 Keychain 里的**引用名**，密钥本身
//    由本机服务层去取。这里没有任何字段能装下 API secret。
// 2. 改动带版本。连接的配置改动带 `expected_revision`，账单导出的处置带
//    `expected_generation`；冲突了就把新状态读回来给人看，不盲重试。

import { getJson, postJson, type RequestOptions } from './http'
import type {
  ConnectionControlled,
  CreatedConnection,
  CsvMapping,
  CycleDetail,
  CyclePage,
  ExchangeConnection,
  ExecutionLinkResult,
  ExportRun,
  ExportStarted,
  Fill,
  FillPage,
  ImportResult,
  ImportRow,
  Instant,
  LedgerPage,
  Market,
  PositionSide,
  ReconciliationResult,
  SeedResult,
  SyncStarted,
  Uuid,
} from './types'

export interface Paged<T> {
  items: T[]
  next_cursor?: string | null
}

/** 时间和品种一起决定看到哪一段账；游标只在同一组条件里有效。 */
export interface TradeFilter {
  direction?: 'long' | 'short'
  status?: 'open' | 'closed' | 'opening_unknown'
  connection_id?: Uuid
  symbol?: string
  start_at?: Instant
  end_at?: Instant
  cursor?: string
}

// ——— 账户连接 ———

export function connections(
  query: { connection_id?: Uuid; cursor?: string } = {},
  opts: RequestOptions = {},
): Promise<Paged<ExchangeConnection>> {
  return getJson('/v1/exchange-connections', { ...opts, query: { ...query } })
}

export interface NewConnection {
  name: string
  account_label: string
  market: Market
  /**
   * 本机 Keychain 条目的名字，形如 `scorebook.exchange.<账户>.<标签>`。留空就是先
   * 不接交易所，只用导入的账单。
   */
  keychain_service?: string | null
}

export function connect(
  body: NewConnection,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<CreatedConnection> {
  return postJson('/v1/exchange-connections', body, { ...opts, idempotencyKey })
}

export type ConnectionAction = 'disconnect' | 'reconnect' | 'rotate_credentials'

/** 断开、重连或换钥匙。断开不会删掉已经记下来的账。 */
export function control(
  id: Uuid,
  body: { expected_revision: number; action: ConnectionAction; keychain_service?: string | null },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ConnectionControlled> {
  return postJson(`/v1/exchange-connections/${id}/control`, body, { ...opts, idempotencyKey })
}

// ——— 账本 ———

export function fills(filter: TradeFilter, opts: RequestOptions = {}): Promise<FillPage> {
  return getJson('/v1/trades', { ...opts, query: { ...filter } })
}

export function cycles(filter: TradeFilter, opts: RequestOptions = {}): Promise<CyclePage> {
  return getJson('/v1/trade-cycles', { ...opts, query: { ...filter } })
}

/** 一轮持仓的全部分配明细。翻页游标是上一页最后一笔成交的 id。 */
export function cycle(id: Uuid, cursor?: string, opts: RequestOptions = {}): Promise<CycleDetail> {
  return getJson(`/v1/trade-cycles/${id}`, { ...opts, query: { cursor } })
}

/** 资金流水：资金费、转账、返佣。和成交盈亏分开记，不合并。 */
export function accountLedger(filter: TradeFilter, opts: RequestOptions = {}): Promise<LedgerPage> {
  return getJson('/v1/account-ledger', { ...opts, query: { ...filter } })
}

// ——— 导入 ———

export function imports(
  query: { connection_id?: Uuid; cursor?: string } = {},
  opts: RequestOptions = {},
): Promise<Paged<ImportRow>> {
  return getJson('/v1/imports', { ...opts, query: { ...query } })
}

export function importGet(id: Uuid, opts: RequestOptions = {}): Promise<ImportRow> {
  return getJson(`/v1/imports/${id}`, opts)
}

export type ImportDataset = 'trades' | 'ledger' | 'both'
export type ImportSource = 'csv' | 'account_api' | 'historical_export'

export interface TradeImport {
  dataset: ImportDataset
  connection_id: Uuid
  source: ImportSource
  start_at: Instant
  end_at: Instant
  symbols: string[]
  fills: Fill[]
  ledger_entries?: unknown[]
  /**
   * 你是否确认这段时间的成交已经全在里面了。说了完整，后端才会按完整口径对账；
   * 说不准就填 false，界面上会一直标着“这段可能不全”。
   */
  declared_complete: boolean
}

export function importTrades(
  body: TradeImport,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ImportResult> {
  return postJson('/v1/imports', body, { ...opts, idempotencyKey })
}

export interface CsvImport {
  connection_id: Uuid
  csv: string
  /** 目前后端只收 `scorebook_fills_v1` 这一种表头。 */
  schema: string
  start_at: Instant
  end_at: Instant
  symbols: string[]
  declared_complete: boolean
}

export function importCsv(
  body: CsvImport,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ImportResult> {
  return postJson('/v1/imports/csv', body, { ...opts, idempotencyKey })
}

// ——— 期初持仓 ———

export interface PositionSeed {
  connection_id: Uuid
  symbol: string
  position_side: PositionSide
  effective_at: Instant
  /** null 就是“期初有多少不知道”。写 0 是在说“当时是空仓”，两回事。 */
  quantity?: string | null
  entry_price?: string | null
  contract_multiplier: string
  settlement_asset: string
  /** 依据：从哪张对账单、哪个页面看到的。后端要求必须写。 */
  evidence: string
}

export function seedPosition(
  body: PositionSeed,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<SeedResult> {
  return postJson('/v1/position-seeds', body, { ...opts, idempotencyKey })
}

// ——— 对账 ———

export interface AssetStatement {
  asset: string
  realized_pnl: string
  commission: string
  funding: string
  /** 容差：差多少以内算对上。不能是负数。 */
  tolerance: string
}

export interface Reconciliation {
  connection_id: Uuid
  start_at: Instant
  end_at: Instant
  statement: AssetStatement[]
  evidence: string
}

export function reconcile(
  body: Reconciliation,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ReconciliationResult> {
  return postJson('/v1/reconciliations', body, { ...opts, idempotencyKey })
}

// ——— 事后关联 ———

export interface ExecutionLink {
  connection_id: Uuid
  trade_ids: Uuid[]
  call_id?: Uuid | null
  episode_id?: Uuid | null
  playbook_id?: Uuid | null
  /** `executed` 按这条做了，`rejected` 看了没做，`related` 有关但不是照着做的。 */
  relation: 'executed' | 'rejected' | 'related'
  evidence: string
  /** 改口就是新写一条指向旧的，旧的原样留着。 */
  supersedes?: Uuid | null
}

export function linkExecution(
  body: ExecutionLink,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ExecutionLinkResult> {
  return postJson('/v1/execution-links', body, { ...opts, idempotencyKey })
}

// ——— 交易所直连同步 ———

export function sync(
  body: { connection_id: Uuid; start_at: Instant; end_at: Instant; symbols: string[] },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<SyncStarted> {
  return postJson('/v1/exchange-syncs', body, { ...opts, idempotencyKey })
}

export function syncGet(id: Uuid, opts: RequestOptions = {}): Promise<Record<string, unknown>> {
  return getJson(`/v1/exchange-syncs/${id}`, opts)
}

// ——— 交易所账单导出 ———

export interface NewExport {
  connection_id: Uuid
  start_at: Instant
  end_at: Instant
  dataset: 'trades' | 'ledger'
  format: 'csv' | 'zip_csv'
  /** 每一列对应哪个字段要写明白，后端不猜列，也不猜币种。 */
  mapping: CsvMapping
}

export function createExport(
  body: NewExport,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ExportStarted> {
  return postJson('/v1/exchange-exports', body, { ...opts, idempotencyKey })
}

export function exportGet(id: Uuid, opts: RequestOptions = {}): Promise<ExportRun> {
  return getJson(`/v1/exchange-exports/${id}`, opts)
}

/**
 * 提交状态不明的那次导出，由人去交易所看一眼，把真实的下载编号填回来。后端不会
 * 自己再提交一次——重复提交要占配额，也会多出一份账单。
 */
export function resolveExport(
  id: Uuid,
  body: { expected_generation: number; download_id: string; evidence: string },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ export_run_id: Uuid; status: string; generation: number }> {
  return postJson(`/v1/exchange-exports/${id}/resolve`, body, { ...opts, idempotencyKey })
}

export function updateExportMapping(
  id: Uuid,
  body: { expected_generation: number; mapping: CsvMapping },
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<{ export_run_id: Uuid; generation: number; status: string }> {
  return postJson(`/v1/exchange-exports/${id}/mapping`, body, { ...opts, idempotencyKey })
}

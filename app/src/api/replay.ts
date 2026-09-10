// 重温回放要的四样东西：这条记录的那一段真实 K 线、截图钉在行情上的位置、
// 图上画哪几条线，以及看完之后把临时缓存还回去。
//
// 三件事的存活期不一样，界面上也要照这个分：
//   · `replay_bars` 是这次展示的暂存，看完就 DELETE，后端还会自己过期清理；
//   · `attachment_locations` 是长期的——一张截图钉过一次就不再按图找；
//   · `chart_setups` 跟着记录走，改一次以后每次重温都照它画。
//
// 这里只管取和写，不算指标、不改判断、不碰 outcomes。

import { getJson, postJson, putJson, sendDelete, type RequestOptions } from './http'
import type {
  AttachmentLocation,
  Bar,
  ChartSetup,
  Decimal,
  Instant,
  Market,
  OutcomeState,
  Uuid,
} from './types'

export type { AttachmentLocation, ChartSetup }

export interface ReplayWindow {
  start_at: Instant
  end_at: Instant
  bars_before: number
  truncated: boolean
  coverage_complete: boolean
}

export interface ReplayJudgment {
  at: Instant
  base_price: Decimal | null
  atr0: Decimal | null
}

export interface ReplayTrigger {
  kind: string
  comparator: 'gte' | 'lte' | string
  price: Decimal
  window_end_at: Instant
}

/**
 * 全部由后端按 `domain/criteria.rs` 那一套公式算好。前端只画，不重算——
 * 界面上算出来的价位和判分用的价位对不上，就等于两套标准。
 */
export interface ReplayLevels {
  template: string
  target_price: Decimal | null
  threshold_abs: Decimal | null
  invalidation_price: Decimal | null
  boundary_price: Decimal | null
  boundary_kind: string | null
  trigger: ReplayTrigger | null
  horizon_end_at: Instant | null
}

/** 来自 head outcome 的 claim 0。还没有结果时整段是 null。 */
export interface ReplayMarks {
  outcome_id: Uuid | null
  state: OutcomeState | string
  reason: string
  trigger_at: Instant | null
  trigger_price: Decimal | null
  first_threshold_interval: [Instant, Instant] | null
  invalidation_hit: boolean | null
  end_at: Instant | null
  signed_return: Decimal | null
  mfe: Decimal | null
  mae: Decimal | null
  mfe_at: Instant | null
  mae_at: Instant | null
}

export interface Replay {
  call_id: Uuid
  symbol: string
  market: Market
  interval: string
  source: 'rest' | 'monthly_archive' | string
  window: ReplayWindow
  judgment: ReplayJudgment
  levels: ReplayLevels | null
  marks: ReplayMarks | null
  bars: Bar[]
  storage_policy: string
  /** 后台正在给这条记录的截图找位置。找完了要重新拉一次这一段。 */
  locating?: { job_id: Uuid; status: string } | null
}

export function getReplay(callId: Uuid, opts: RequestOptions = {}): Promise<Replay> {
  return getJson<Replay>(`/v1/calls/${callId}/replay`, opts)
}

/**
 * 看完把这一段行情还回去。离开页面时也要发，所以走 keepalive 的裸 fetch：
 * 页面已经在拆了，等不到一个正常的 Promise 回来。凭证由本机代理加。
 */
export function deleteReplay(callId: Uuid): void {
  try {
    void fetch(`/api/v1/calls/${callId}/replay`, { method: 'DELETE', keepalive: true }).catch(
      () => undefined,
    )
  } catch {
    /* 页面正在离开，这一次没发出去也只是缓存多留一天 */
  }
}

export interface LocationInput {
  symbol: string
  market: Market
  interval: string
  start_at: Instant
  end_at: Instant
  bars_count?: number | null
  source: 'rest' | 'monthly_archive'
  score?: number | string | null
  search_run_id?: Uuid | null
}

/** 人点了「就是这一段」才写。没确认不写。 */
export function putLocation(
  attachmentId: Uuid,
  body: LocationInput,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<AttachmentLocation> {
  return putJson<AttachmentLocation>(`/v1/attachments/${attachmentId}/location`, body, {
    ...opts,
    idempotencyKey,
  })
}

export function deleteLocation(attachmentId: Uuid, opts: RequestOptions = {}): Promise<void> {
  return sendDelete(`/v1/attachments/${attachmentId}/location`, opts)
}

/**
 * 一张截图的定位进度。位置是长期的；任务只是这一次找的过程。
 * 后端还没上这两条路由的时候，调用会抛 404，由调用方退回旧的按图找。
 */
export interface LocateJob {
  id: Uuid
  status: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'canceled' | string
  result: LocateResult | null
  created_at: Instant
  error_code?: string | null
}

export interface LocateResult {
  outcome?: 'located' | 'ambiguous' | 'already_located' | string
  candidates?: unknown[]
  [key: string]: unknown
}

export interface LocateState {
  location: AttachmentLocation | null
  job: LocateJob | null
  deduplicated?: boolean
}

export function getLocate(attachmentId: Uuid, opts: RequestOptions = {}): Promise<LocateState> {
  return getJson<LocateState>(`/v1/attachments/${attachmentId}/locate`, opts)
}

/** 人按了「钉到真实行情」才发。同一张图已经有任务在跑就返回那一个。 */
export function postLocate(
  attachmentId: Uuid,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<LocateState> {
  return postJson<LocateState>(`/v1/attachments/${attachmentId}/locate`, {}, {
    ...opts,
    idempotencyKey,
  })
}

export interface ChartSetupSaved {
  call_id: Uuid
  body: ChartSetup
  updated_at: Instant
}

export function putChartSetup(
  callId: Uuid,
  body: ChartSetup,
  idempotencyKey: string,
  opts: RequestOptions = {},
): Promise<ChartSetupSaved> {
  return putJson<ChartSetupSaved>(`/v1/calls/${callId}/chart-setup`, body, {
    ...opts,
    idempotencyKey,
  })
}

export const EMPTY_SETUP: ChartSetup = { ma: [], ema: [], boll: null, atr: null }

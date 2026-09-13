import { ApiError } from './errors'
import { getJson, postJson, postText, type RequestOptions } from './http'
import type { ChartRequest, InstrumentBounds, Market, MarketData } from './types'

/**
 * Bars and rendered charts are never stored, by the backend or here. They live
 * in memory for as long as the view that asked for them.
 */
export function data(request: ChartRequest, opts: RequestOptions = {}): Promise<MarketData> {
  return postJson<MarketData>('/v1/market/data', request, opts)
}

export function chartSvg(request: ChartRequest, opts: RequestOptions = {}): Promise<string> {
  return postText('/v1/market/chart', request, opts)
}

/**
 * 这个合约的行情边界。全屏懒加载拿它当先验：上市之前不必发请求，交割之后也不必。
 *
 * 后端不认识这个合约（404 `instrument_unknown`）不是错误——退回目录那份先验就是
 * 了，所以这里把它翻成 `null`，别让调用方满地写 try。
 */
export async function bounds(
  query: { market: Market; symbol: string; interval: string },
  opts: RequestOptions = {},
): Promise<InstrumentBounds | null> {
  try {
    return await getJson<InstrumentBounds>('/v1/market/bounds', { ...opts, query })
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/**
 * 币安永续的交割时间是一个占位值（2100-12-25），意思是「不交割」。离现在十年
 * 开外的一律当作没有——否则「交割了就别开流」会把所有永续都挡掉。
 */
export const PLACEHOLDER_AHEAD_MS = 10 * 365 * 86_400_000
export function realDelivery(deliveryAt: string | null, serverNowMs: number): number | null {
  if (!deliveryAt) return null
  const at = Date.parse(deliveryAt)
  if (!Number.isFinite(at)) return null
  if (at - serverNowMs > PLACEHOLDER_AHEAD_MS) return null
  return at
}

export interface BoundsPrior {
  /** 地板：这一档最早可能有的那一刻。 */
  onboardMs: number | null
  /** 天花板：交割那一刻。永续是 null。 */
  deliveryMs: number | null
  /** 中段缺口，登记成可重试的洞。 */
  gaps: { startMs: number; endMs: number }[]
  /** 后端此刻的时间。 */
  serverNowMs: number
  /** 本机时钟和后端差了多少毫秒（本机 − 后端）。 */
  skewMs: number
}

/** 本机时钟差这么多以上就不能再信它：「贴近现在」改按服务器时间算。 */
export const SKEW_TOLERANCE_MS = 30_000

/**
 * 把一份 bounds 翻成懒加载那边认识的先验。`localNowMs` 是本机此刻。
 *
 * 地板取 `first_bar_at ?? onboard_at`：真取到过的第一根比目录里的上市时间准，
 * 目录上市时间有时候比第一根 K 线早好几个小时。
 */
export function boundsPrior(found: InstrumentBounds, localNowMs: number): BoundsPrior {
  const serverNow = Date.parse(found.server_now)
  const serverNowMs = Number.isFinite(serverNow) ? serverNow : localNowMs
  const first = found.first_bar_at ? Date.parse(found.first_bar_at) : Number.NaN
  const onboard = found.onboard_at ? Date.parse(found.onboard_at) : Number.NaN
  const floor = Number.isFinite(first) ? first : Number.isFinite(onboard) ? onboard : null
  const gaps: { startMs: number; endMs: number }[] = []
  for (const gap of found.gaps ?? []) {
    const startMs = Date.parse(gap.start)
    const endMs = Date.parse(gap.end)
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) gaps.push({ startMs, endMs })
  }
  return {
    onboardMs: floor,
    deliveryMs: realDelivery(found.delivery_at, serverNowMs),
    gaps,
    serverNowMs,
    skewMs: localNowMs - serverNowMs,
  }
}

/** 时钟偏得过头就认服务器的：`at` 是本机时刻，返回校正后的时刻。 */
export function correctedNow(localNowMs: number, skewMs: number): number {
  return Math.abs(skewMs) > SKEW_TOLERANCE_MS ? localNowMs - skewMs : localNowMs
}

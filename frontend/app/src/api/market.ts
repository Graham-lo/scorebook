import { postJson, postText, type RequestOptions } from './http'
import type { ChartRequest, MarketData } from './types'

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

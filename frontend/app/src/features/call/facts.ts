import type { Attachment, AttachmentLocation, CallDetail, ChartRequest } from '../../api/types'
import { INTERVAL_SECONDS, type Interval } from '../../data/session'
import { inMainViewer } from './scene'

export function locatedShots(d: Pick<CallDetail, 'attachments'>): (Attachment & { location: AttachmentLocation })[] {
  return d.attachments.filter((shot): shot is Attachment & { location: AttachmentLocation } =>
    inMainViewer(shot) && Boolean(shot.location))
}

/** 走势跟随图上确认的品种、市场和时间窗，不以录入时间替代截图时间。 */
export function followupChart(at: AttachmentLocation, now = Date.now(), count = 120): ChartRequest | null {
  const start = Date.parse(at.start_at)
  const boundary = Date.parse(at.end_at)
  if (!Number.isFinite(start) || !Number.isFinite(boundary) || boundary <= start) return null
  const end = new Date(boundary)
  if (at.interval === '1M') end.setUTCMonth(end.getUTCMonth() + count)
  else {
    const seconds = INTERVAL_SECONDS[at.interval as Interval]
    if (!seconds) return null
    end.setTime(boundary + count * seconds * 1000)
  }
  return {
    symbol: at.symbol, market: at.market, interval: at.interval, source: at.source,
    start_at: at.start_at,
    end_at: new Date(Math.max(boundary, Math.min(now, end.getTime()))).toISOString(),
    match_end_at: at.end_at,
  }
}

export function sameInstrumentHref(d: Pick<CallDetail, 'instrument' | 'market'>): string | null {
  if (!d.instrument) return null
  const params = new URLSearchParams({ by: 'symbol', instrument: d.instrument })
  if (d.market) params.set('market', d.market)
  return `#/find?${params}`
}

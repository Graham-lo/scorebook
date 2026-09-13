import type { Instrument, Path, Stance, TagRecord } from '../../api/types'
import { emptyCriteriaDraft, type CriteriaDraft } from './criteria'

export const CAPTURE_KEY = 'sb.capture.v1'

export interface StoredCapture {
  text: string
  instrument: Instrument | null
  timeframe: string | null
  stance: Stance
  path: Path
  confidence: string
  claimedAt: string
  tags: TagRecord[]
  crit: CriteriaDraft
  attachmentIds: string[]
  pendingImages: number
  pendingSave: { signature: string; key: string } | null
}

/** Read only the fields this version understands; corrupt storage must not break capture. */
export function decodeCapture(raw: string | null): StoredCapture | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<StoredCapture>
    if (!value || typeof value !== 'object' || typeof value.text !== 'string') return null
    const crit = emptyCriteriaDraft()
    const saved = value.crit
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(crit) as (keyof CriteriaDraft)[]) {
        const item = saved[key]
        if (typeof item === typeof crit[key] || (key === 'direction' && (item === 'L' || item === 'S' || item === null))) {
          Object.assign(crit, { [key]: item })
        }
      }
    }
    if (!['T0', 'T1', 'T2', 'T3', 'T4', 'T5'].includes(crit.template)) crit.template = 'T0'
    if (!['L', 'S', null].includes(crit.direction)) crit.direction = null
    if (!['default', 'percent', 'atr'].includes(crit.thresholdKind)) crit.thresholdKind = 'default'
    if (!['lower_floor', 'upper_ceiling'].includes(crit.boundaryKind)) crit.boundaryKind = 'lower_floor'
    if (!['gte', 'lte'].includes(crit.triggerComparator)) crit.triggerComparator = 'gte'
    if (!['bar_close', 'trade_touch'].includes(crit.triggerKind)) crit.triggerKind = 'bar_close'
    const instrument = value.instrument
    const validInstrument = instrument && typeof instrument.symbol === 'string' &&
      ['usd_m', 'coin_m'].includes(instrument.market) && typeof instrument.venue === 'string' &&
      instrument.body && typeof instrument.body.contractType === 'string'
    const pending = value.pendingSave
    return {
      text: value.text,
      instrument: validInstrument ? instrument : null,
      timeframe: typeof value.timeframe === 'string' ? value.timeframe : null,
      stance: ['unknown', 'L', 'S', '?'].includes(value.stance ?? '') ? value.stance! : 'unknown',
      path: ['unknown', 'chart_first', 'thought_first', 'interwoven'].includes(value.path ?? '') ? value.path! : 'unknown',
      confidence: typeof value.confidence === 'string' ? value.confidence : '',
      claimedAt: typeof value.claimedAt === 'string' ? value.claimedAt : '',
      tags: Array.isArray(value.tags) ? value.tags.filter(tag => tag && typeof tag.id === 'string' && typeof tag.name === 'string') : [],
      crit,
      attachmentIds: Array.isArray(value.attachmentIds) ? value.attachmentIds.filter(id => typeof id === 'string').slice(0, 20) : [],
      pendingImages: typeof value.pendingImages === 'number' && Number.isFinite(value.pendingImages) ? Math.min(20, Math.max(0, Math.floor(value.pendingImages))) : 0,
      pendingSave: pending && typeof pending.key === 'string' && typeof pending.signature === 'string' ? pending : null,
    }
  } catch {
    return null
  }
}

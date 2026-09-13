import { INTERVAL_SECONDS, type Interval } from './session'

/** Only the display window changes. The query, exclusions and match score stay untouched. */
export function historyEnd(end: string, interval: string, count: number): string {
  const date = new Date(end)
  if (interval === '1M') date.setUTCMonth(date.getUTCMonth() + count)
  else date.setTime(date.getTime() + (INTERVAL_SECONDS[interval as Interval] ?? 0) * count * 1000)
  return date.toISOString()
}

/** 往回数 count 根：完整历史一页一页往前取的时候算区间用。 */
export function historyStart(start: string, interval: string, count: number): string {
  const date = new Date(start)
  if (interval === '1M') date.setUTCMonth(date.getUTCMonth() - count)
  else date.setTime(date.getTime() - (INTERVAL_SECONDS[interval as Interval] ?? 0) * count * 1000)
  return date.toISOString()
}

import { INTERVAL_SECONDS, type Interval } from './session'

/** User supplies the last candle's open time; API windows end after that candle. */
export function locationEndAt(last: Date, interval: Interval): string {
  if (!Number.isFinite(last.getTime())) throw new Error('最后一根的时间没填对')
  if (interval === '1M') {
    return new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1)).toISOString()
  }
  const span = INTERVAL_SECONDS[interval] * 1000
  // Unix epoch is Thursday. Binance weekly candles begin on Monday UTC.
  const origin = interval === '1w' ? 4 * 86400_000 : 0
  return new Date(origin + (Math.floor((last.getTime() - origin) / span) + 1) * span).toISOString()
}

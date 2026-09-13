import type { Bar } from '../api/types'

/** A single linear time/amplitude mapping; later bars cannot change the fit. */
export function compareOutline(values: readonly number[], bars: readonly Bar[], cutoff: string): { time: number; value: number }[] {
  const matched = bars.filter(bar => Date.parse(bar.end) <= Date.parse(cutoff))
  if (values.length < 2 || matched.length < 2 || values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) return []
  const low = Math.min(...matched.map(bar => Number(bar.low)))
  const high = Math.max(...matched.map(bar => Number(bar.high)))
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return []
  return matched.map((bar, i) => {
    const position = i * (values.length - 1) / (matched.length - 1)
    const before = Math.floor(position)
    const mix = position - before
    const value = values[before]! * (1 - mix) + values[Math.min(before + 1, values.length - 1)]! * mix
    return { time: Date.parse(bar.start) / 1000, value: low + value * (high - low) }
  })
}

export function followingStats(bars: readonly Bar[], cutoff: string): { count: number; close: number; high: number; low: number } | null {
  const at = Date.parse(cutoff)
  const matched = bars.filter(bar => Date.parse(bar.end) <= at)
  const following = bars.filter(bar => Date.parse(bar.start) >= at)
  const base = Number(matched.at(-1)?.close)
  if (!following.length || !Number.isFinite(base) || base <= 0) return null
  const change = (value: number) => (value / base - 1) * 100
  return { count: following.length, close: change(Number(following.at(-1)!.close)),
    high: change(Math.max(...following.map(bar => Number(bar.high)))), low: change(Math.min(...following.map(bar => Number(bar.low)))) }
}


/** Preserve true source closes when a screenshot already has a trusted market window. */
export function marketOutline(bars: readonly Bar[], start: string, end: string): number[] {
  const shown = bars.filter(bar => Date.parse(bar.start) >= Date.parse(start) && Date.parse(bar.end) <= Date.parse(end))
  if (shown.length < 2) return []
  const low = Math.min(...shown.map(bar => Number(bar.low))), high = Math.max(...shown.map(bar => Number(bar.high)))
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return []
  return shown.map(bar => (Number(bar.close) - low) / (high - low))
}

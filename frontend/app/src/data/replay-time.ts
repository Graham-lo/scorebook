import type { Bar } from '../api/types'

/** 只使用在观察时刻已经收盘的完整 K 线；缺口不跳到未来。 */
export function closedIndex(bars: Bar[], at: string): number {
  const time = Date.parse(at)
  if (!Number.isFinite(time)) return -1
  for (let i = bars.length - 1; i >= 0; i--) if (Date.parse(bars[i]!.end) <= time) return i
  return -1
}

export function closedWindow(bars: Bar[], end: string, start?: string): Bar[] {
  const after = start ? Date.parse(start) : -Infinity
  return bars.slice(0, closedIndex(bars, end) + 1).filter(bar => Date.parse(bar.start) >= after)
}

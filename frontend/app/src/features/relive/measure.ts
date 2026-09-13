// 量一段、钉一条价：两件小事的算术部分。
//
// 画在哪儿是 `trading-chart` 的事，这里只回答「这一段涨了多少、跨了几根、多长
// 时间」和「这条价钉不钉得下」。分出来是因为它们最容易写错一位小数，而 Node
// 里的测试碰不到画布。

import { barSpanMs } from './history/tiles'

/** 涨跌幅。`+1.23%` / `-0.40%`，永远两位，零也带符号位上的 `+`。 */
export function pctText(fromPrice: number, toPrice: number): string {
  if (!Number.isFinite(fromPrice) || !Number.isFinite(toPrice) || fromPrice === 0) return '0.00%'
  const pct = ((toPrice - fromPrice) / Math.abs(fromPrice)) * 100
  return `${pct >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(2)}%`
}

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

/**
 * 一段时长说成人话：一天以上说到小时，一小时以上说到分，再短就只说分。
 *
 * 零头是 0 的那一截不说——`3 天 0 小时` 是机器话。
 */
export function spanText(ms: number): string {
  const left = Math.max(0, Math.round(ms))
  if (left >= DAY) {
    const days = Math.floor(left / DAY)
    const hours = Math.floor((left % DAY) / HOUR)
    return hours ? `${days} 天 ${hours} 小时` : `${days} 天`
  }
  if (left >= HOUR) {
    const hours = Math.floor(left / HOUR)
    const minutes = Math.floor((left % HOUR) / MINUTE)
    return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  }
  return `${Math.floor(left / MINUTE)} 分`
}

/** 这一段跨了几根。按这一档一根多宽算，不数实际有没有数据。 */
export function barsAcross(fromMs: number, toMs: number, interval: string): number {
  const step = barSpanMs(interval)
  if (!(step > 0)) return 0
  return Math.max(1, Math.round(Math.abs(toMs - fromMs) / step))
}

export interface Measure {
  fromMs: number
  toMs: number
  fromPrice: number
  toPrice: number
  interval: string
}

/** 量尺上那一行：`+1.23% · 42 根 · 3 天 4 小时`。 */
export function measureText(m: Measure): string {
  return [
    pctText(m.fromPrice, m.toPrice),
    `${barsAcross(m.fromMs, m.toMs, m.interval)} 根`,
    spanText(Math.abs(m.toMs - m.fromMs)),
  ].join(' · ')
}

/* ------------------------------------------------------------ 钉价格线 */

/** 最多钉这么多条。再多这张图就看不清了。 */
export const PIN_MAX = 5
/** 点在这条线多少像素以内，算是点在它身上（拔掉它，而不是再钉一条）。 */
export const PIN_HIT_PX = 6

export interface PinChange {
  prices: number[]
  did: 'added' | 'removed' | 'full'
}

/**
 * Alt 点一下：附近有线就拔掉，没有就钉一条；满了就谁也不动，让外面去说那句
 * `最多钉 5 条`。
 *
 * 命中判定按像素而不是按价格——价格轴是可以缩放的，同样的差价在不同缩放下离
 * 得远近完全不一样，人点的是屏幕上那条线。
 */
export function pinToggle(
  prices: readonly number[],
  price: number,
  yOf: (price: number) => number | null,
  hitPx = PIN_HIT_PX,
): PinChange {
  const y = yOf(price)
  if (y !== null) {
    for (const existing of prices) {
      const at = yOf(existing)
      if (at !== null && Math.abs(at - y) <= hitPx) {
        return { prices: prices.filter((p) => p !== existing), did: 'removed' }
      }
    }
  }
  if (prices.length >= PIN_MAX) return { prices: [...prices], did: 'full' }
  return { prices: [...prices, price], did: 'added' }
}

/** 钉上去那条线的标签就是价格本身。 */
export function pinLabel(price: number, digits: number): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

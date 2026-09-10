// 均线、布林、ATR。全部在浏览器里从这一段 K 线自己算。
//
// 后端不算指标（`chart_setups` 只存形状），所以这几条线的口径由这里定死：
//   · MA  取收盘价的简单平均，前 n-1 根没有值就是 null，不用少于 n 根的平均凑数；
//   · EMA 第一个值用前 n 根的简单平均起头，之后 α = 2/(n+1)；
//   · BOLL 中轨是 MA，上下轨用总体标准差（除以 n，不是 n-1），和常见画法一致；
//   · ATR 走 Wilder 的递推，真实波幅算上前一根收盘价的跳空。
//
// 全是纯函数：给同样的数组永远得到同样的结果，没有状态，可以单独测。

export interface OHLC {
  open: number
  high: number
  low: number
  close: number
}

export type Line = (number | null)[]

/** 简单移动平均。n 必须是 1…500 的整数，否则整条线是空的。 */
export function sma(values: number[], n: number): Line {
  const out: Line = new Array(values.length).fill(null)
  if (!Number.isInteger(n) || n < 1 || n > 500) return out
  let sum = 0
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number
    if (i >= n) sum -= values[i - n] as number
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}

/** 指数移动平均。头一个值用前 n 根的简单平均，之后按 α 递推。 */
export function ema(values: number[], n: number): Line {
  const out: Line = new Array(values.length).fill(null)
  if (!Number.isInteger(n) || n < 1 || n > 500 || values.length < n) return out
  const alpha = 2 / (n + 1)
  let seed = 0
  for (let i = 0; i < n; i += 1) seed += values[i] as number
  let prev = seed / n
  out[n - 1] = prev
  for (let i = n; i < values.length; i += 1) {
    prev = (values[i] as number) * alpha + prev * (1 - alpha)
    out[i] = prev
  }
  return out
}

export interface BollLines {
  mid: Line
  upper: Line
  lower: Line
}

/** 布林带。k 是倍数，通常 2。 */
export function boll(values: number[], n: number, k: number): BollLines {
  const mid = sma(values, n)
  const upper: Line = new Array(values.length).fill(null)
  const lower: Line = new Array(values.length).fill(null)
  if (!Number.isInteger(n) || n < 1 || n > 500 || !Number.isFinite(k)) {
    return { mid, upper, lower }
  }
  for (let i = n - 1; i < values.length; i += 1) {
    const mean = mid[i]
    if (mean === null || mean === undefined) continue
    let variance = 0
    for (let j = i - n + 1; j <= i; j += 1) {
      const d = (values[j] as number) - mean
      variance += d * d
    }
    const sd = Math.sqrt(variance / n)
    upper[i] = mean + k * sd
    lower[i] = mean - k * sd
  }
  return { mid, upper, lower }
}

/** 单根的真实波幅：本根的高低差，和相对前一根收盘的两段跳空，取最大。 */
export function trueRange(bar: OHLC, previousClose: number | null): number {
  const span = bar.high - bar.low
  if (previousClose === null) return span
  return Math.max(span, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose))
}

/** Wilder ATR。前 n 根用真实波幅的简单平均起头。 */
export function atr(bars: OHLC[], n: number): Line {
  const out: Line = new Array(bars.length).fill(null)
  if (!Number.isInteger(n) || n < 1 || n > 500 || bars.length < n) return out
  const tr: number[] = []
  for (let i = 0; i < bars.length; i += 1) {
    tr.push(trueRange(bars[i] as OHLC, i > 0 ? (bars[i - 1] as OHLC).close : null))
  }
  let seed = 0
  for (let i = 0; i < n; i += 1) seed += tr[i] as number
  let prev = seed / n
  out[n - 1] = prev
  for (let i = n; i < bars.length; i += 1) {
    prev = (prev * (n - 1) + (tr[i] as number)) / n
    out[i] = prev
  }
  return out
}

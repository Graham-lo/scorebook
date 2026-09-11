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

export interface MacdLines {
  /** 快慢两条 EMA 的差。两条都还没起头的位置是 null。 */
  dif: Line
  /** DIF 的 EMA，从 DIF 有值那一段开始算。 */
  dea: Line
  /** 2 ×（DIF − DEA）。柱子按国内画法乘 2，和截图上的幅度对得上。 */
  hist: Line
}

/**
 * MACD。截图里用的是 (10, 30, 9)，不是默认的 (12, 26, 9)，所以三个参数都要能改。
 *
 * DEA 是「DIF 的 EMA」——DIF 前面那一段是 null，不能把 null 当 0 喂进去，否则
 * 起头几根会被压下去。这里先把 DIF 有值的那一截取出来单独求 EMA，再放回原位。
 */
export function macd(closes: number[], fast: number, slow: number, signal: number): MacdLines {
  const blank = (): Line => new Array(closes.length).fill(null)
  const out: MacdLines = { dif: blank(), dea: blank(), hist: blank() }
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 500
  if (!ok(fast) || !ok(slow) || !ok(signal) || fast >= slow) return out

  const quick = ema(closes, fast)
  const slowly = ema(closes, slow)
  const dif = out.dif
  const tail: number[] = []
  let from = -1
  for (let i = 0; i < closes.length; i += 1) {
    const a = quick[i]
    const b = slowly[i]
    if (a === null || a === undefined || b === null || b === undefined) continue
    dif[i] = a - b
    if (from === -1) from = i
    tail.push(a - b)
  }
  if (from === -1) return out

  const dea = ema(tail, signal)
  for (let i = 0; i < dea.length; i += 1) {
    const v = dea[i]
    if (v === null || v === undefined) continue
    const at = from + i
    out.dea[at] = v
    out.hist[at] = ((dif[at] as number) - v) * 2
  }
  return out
}

/**
 * Wilder RSI。第 n 根上出第一个值（用前 n 根的涨跌幅平均起头），之后递推。
 *
 * 一整段都不跌的时候分母是 0——直接给 100，不让它变成 NaN 把线断掉。
 */
export function rsi(closes: number[], n: number): Line {
  const out: Line = new Array(closes.length).fill(null)
  if (!Number.isInteger(n) || n < 1 || n > 500 || closes.length <= n) return out
  let up = 0
  let down = 0
  for (let i = 1; i <= n; i += 1) {
    const change = (closes[i] as number) - (closes[i - 1] as number)
    if (change >= 0) up += change
    else down -= change
  }
  up /= n
  down /= n
  out[n] = down === 0 ? 100 : 100 - 100 / (1 + up / down)
  for (let i = n + 1; i < closes.length; i += 1) {
    const change = (closes[i] as number) - (closes[i - 1] as number)
    up = (up * (n - 1) + (change > 0 ? change : 0)) / n
    down = (down * (n - 1) + (change < 0 ? -change : 0)) / n
    out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down)
  }
  return out
}

// 图上画什么：形状的整理、校验和两个现成的预设。
//
// 后端只存形状不算指标，而且每个字段都可缺（旧记录里只有 ma/ema/boll/atr），
// 所以拿回来的那一份先过一次 `normalize`：缺的当成「这一项没开」，脏的直接丢，
// 出来的永远是一份字段齐全的 ChartSetup，界面和画图都不用再判空。
//
// 校验和后端那一套是同一条线（ma+ema 至多 8 条、周期 1…500、量均线至多 6 条、
// MACD 快必须小于慢）。在这里先说一遍，是为了让人按下保存之前就看见问题，
// 而不是等一个 422 回来；后端仍然是那道真正的关。

import type { ChartSetup, ChartSetupWire } from '../../api/types'

export type { ChartSetup, ChartSetupWire }

/** 一条线都不画。 */
export const EMPTY: ChartSetup = {
  ma: [],
  ema: [],
  boll: null,
  atr: null,
  volume: null,
  macd: null,
  rsi: null,
}

/**
 * 截图上那一套：MA30/120/256、VOL 带 MAVOL5/10/30/60/120、MACD(10,30,9)。
 *
 * 这是记录里没存过 chart_setup 时的默认，也是面板上那个「截图默认」按钮——
 * 手调乱了想回到原样，按一下就回来。
 */
export const SHOT_DEFAULT: ChartSetup = {
  ma: [30, 120, 256],
  ema: [],
  boll: null,
  atr: null,
  volume: { ma: [5, 10, 30, 60, 120] },
  macd: { fast: 10, slow: 30, signal: 9 },
  rsi: null,
}

export const MAX_LINES = 8
export const MAX_VOL_LINES = 6

function period(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500) return null
  return n
}

/** 周期列表：只留合法的、去重、从小到大，最多留 cap 个。 */
function periods(value: unknown, cap: number): number[] {
  if (!Array.isArray(value)) return []
  const seen: number[] = []
  for (const item of value) {
    const n = period(item)
    if (n !== null && !seen.includes(n)) seen.push(n)
  }
  return seen.sort((a, b) => a - b).slice(0, cap)
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 把后端回来的任意一份整理成字段齐全的一份。
 *
 * 认不出来的一律当「没开」——这一份是用来画图的，宁可少画一条线，也不要拿一个
 * 半成品去算指标。整份是空的（后端从来没存过）时返回 null，由调用方决定是不是
 * 用 SHOT_DEFAULT 顶上。
 */
// 参数是 unknown 而不是 ChartSetupWire：这一份是从网线上来的，类型标注管不到它。
export function normalizeSetup(wire: unknown): ChartSetup {
  const w = record(wire) ?? {}
  const ma = periods(w['ma'], MAX_LINES)
  const ema = periods(w['ema'], Math.max(0, MAX_LINES - ma.length))

  const bollRaw = record(w['boll'])
  const bollN = bollRaw ? period(bollRaw['n']) : null
  const bollK = bollRaw ? Number(bollRaw['k']) : NaN
  const boll =
    bollN !== null && Number.isFinite(bollK) && bollK > 0 && bollK <= 10
      ? { n: bollN, k: String(bollRaw?.['k']) }
      : null

  const atrRaw = record(w['atr'])
  const atrN = atrRaw ? period(atrRaw['n']) : null
  const atr = atrN !== null ? { n: atrN } : null

  const volRaw = record(w['volume'])
  const volume = volRaw ? { ma: periods(volRaw['ma'], MAX_VOL_LINES) } : null

  const macdRaw = record(w['macd'])
  const fast = macdRaw ? period(macdRaw['fast']) : null
  const slow = macdRaw ? period(macdRaw['slow']) : null
  const signal = macdRaw ? period(macdRaw['signal']) : null
  const macd =
    fast !== null && slow !== null && signal !== null && fast < slow ? { fast, slow, signal } : null

  const rsiRaw = record(w['rsi'])
  const rsiN = rsiRaw ? period(rsiRaw['n']) : null
  const rsi = rsiN !== null ? { n: rsiN } : null

  return { ma, ema, boll, atr, volume, macd, rsi }
}

/** 整份都没开。用来判断「这条记录从来没设置过」。 */
export function setupIsEmpty(setup: ChartSetup): boolean {
  return (
    setup.ma.length === 0 &&
    setup.ema.length === 0 &&
    !setup.boll &&
    !setup.atr &&
    !setup.volume &&
    !setup.macd &&
    !setup.rsi
  )
}

export function cloneSetup(setup: ChartSetup): ChartSetup {
  return {
    ma: [...setup.ma],
    ema: [...setup.ema],
    boll: setup.boll ? { ...setup.boll } : null,
    atr: setup.atr ? { ...setup.atr } : null,
    volume: setup.volume ? { ma: [...setup.volume.ma] } : null,
    macd: setup.macd ? { ...setup.macd } : null,
    rsi: setup.rsi ? { ...setup.rsi } : null,
  }
}

export function sameSetup(a: ChartSetup, b: ChartSetup): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 保存之前自己先看一遍。返回一句人话，没问题就是 null。
 *
 * 规则和后端一字不差，这样面板上过得去的，后端一定也收得下。
 */
export function validateSetup(setup: ChartSetup): string | null {
  const all = [...setup.ma, ...setup.ema]
  if (all.length > MAX_LINES) return `主图上最多 ${MAX_LINES} 条均线，现在有 ${all.length} 条`
  for (const n of all) {
    if (!Number.isInteger(n) || n < 1 || n > 500) return `均线周期要在 1 到 500 之间，${n} 不行`
  }
  if (setup.boll) {
    if (!Number.isInteger(setup.boll.n) || setup.boll.n < 1 || setup.boll.n > 500) {
      return '布林周期要在 1 到 500 之间'
    }
    const k = Number(setup.boll.k)
    if (!Number.isFinite(k) || k <= 0 || k > 10) return '布林倍数要在 0 到 10 之间'
  }
  if (setup.atr && (!Number.isInteger(setup.atr.n) || setup.atr.n < 1 || setup.atr.n > 500)) {
    return 'ATR 周期要在 1 到 500 之间'
  }
  if (setup.volume) {
    if (setup.volume.ma.length > MAX_VOL_LINES) {
      return `量均线最多 ${MAX_VOL_LINES} 条，现在有 ${setup.volume.ma.length} 条`
    }
    for (const n of setup.volume.ma) {
      if (!Number.isInteger(n) || n < 1 || n > 500) return `量均线周期要在 1 到 500 之间，${n} 不行`
    }
  }
  if (setup.macd) {
    const { fast, slow, signal } = setup.macd
    for (const n of [fast, slow, signal]) {
      if (!Number.isInteger(n) || n < 1 || n > 500) return 'MACD 的三个周期都要在 1 到 500 之间'
    }
    if (fast >= slow) return 'MACD 的快线周期要小于慢线周期'
  }
  if (setup.rsi && (!Number.isInteger(setup.rsi.n) || setup.rsi.n < 1 || setup.rsi.n > 500)) {
    return 'RSI 周期要在 1 到 500 之间'
  }
  return null
}

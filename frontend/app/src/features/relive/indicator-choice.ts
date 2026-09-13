// 图上画哪几条线：一份偏好，重温页的 SVG 舞台和全屏 K 线共用。
//
// 两条硬规矩。一，任何一张图默认只有 K 线和成交量柱，其余一律关着——识别出来
// 的指标只是记录里的种子，不自动画。二，开着的那几项用什么参数，先看这条记录
// 自己存过什么，没存过才用下面这一套默认。
//
// 开过哪几项记在这台机器上（localStorage），和记录无关：人的看图习惯是自己的。

import type { PopItem } from '../../ui/pop'
import type { ChartSetup } from '../../api/types'
import { EMPTY, cloneSetup, setupIsEmpty } from './setup'

export type LineName = 'ma' | 'ema' | 'boll' | 'mavol' | 'macd' | 'rsi' | 'volume'

export const LINE_ORDER: LineName[] = ['ma', 'ema', 'boll', 'volume', 'mavol', 'macd', 'rsi']

export const LINE_LABELS: Record<LineName, string> = {
  ma: 'MA',
  ema: 'EMA',
  boll: 'BOLL',
  volume: '成交量',
  mavol: '量均线',
  macd: 'MACD',
  rsi: 'RSI',
}

export type Choice = Record<LineName, boolean>

export const CHOICE_KEY = 'sb.indicators.v2'

/** 记录里没存过参数时用这一套。 */
export const DEFAULTS = {
  ma: [30, 120, 256],
  ema: [12, 144, 169],
  boll: { n: 20, k: '2' },
  mavol: [5, 10, 30, 60, 120],
  macd: { fast: 10, slow: 30, signal: 9 },
  rsi: { n: 14 },
}

/** 首次一律关，只有成交量柱开着。 */
export function blankChoice(): Choice {
  return { ma: false, ema: false, boll: false, mavol: false, macd: false, rsi: false, volume: true }
}

export function readChoice(): Choice {
  const choice = blankChoice()
  try {
    const raw = window.localStorage.getItem(CHOICE_KEY)
    if (!raw) return choice
    const saved = JSON.parse(raw) as Partial<Record<LineName, unknown>>
    for (const name of LINE_ORDER) choice[name] = saved[name] === true
  } catch {
    /* 读不出来就按默认：一条线都不画 */
  }
  return choice
}

export function writeChoice(choice: Choice): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, JSON.stringify(choice))
  } catch {
    /* 隐私模式下写不进去：这一次会话里照样有效 */
  }
}

/** 开着的那几项各用什么参数：记录里存过就用记录的，没有就用 DEFAULTS。 */
export function setupFor(choice: Choice, record: ChartSetup | null): ChartSetup {
  const setup = cloneSetup(EMPTY)
  if (choice.ma) setup.ma = record?.ma.length ? [...record.ma] : [...DEFAULTS.ma]
  if (choice.ema) setup.ema = record?.ema.length ? [...record.ema] : [...DEFAULTS.ema]
  if (choice.boll) setup.boll = record?.boll ? { ...record.boll } : { ...DEFAULTS.boll }
  // 量均线画在成交量面板上：开了量均线就等于开了成交量。
  if (choice.volume || choice.mavol) {
    setup.volume = {
      ma: choice.mavol
        ? record?.volume?.ma.length
          ? [...record.volume.ma]
          : [...DEFAULTS.mavol]
        : [],
    }
  }
  if (choice.macd) setup.macd = record?.macd ? { ...record.macd } : { ...DEFAULTS.macd }
  if (choice.rsi) setup.rsi = record?.rsi ? { ...record.rsi } : { ...DEFAULTS.rsi }
  return setup
}

/** 某一项在菜单里显示的参数；来自记录的末尾加「· 截图」。 */
function hintFor(name: LineName, record: ChartSetup | null): string | null {
  switch (name) {
    case 'ma':
      return record?.ma.length ? `${record.ma.join(' / ')} · 截图` : DEFAULTS.ma.join(' / ')
    case 'ema':
      return record?.ema.length ? `${record.ema.join(' / ')} · 截图` : DEFAULTS.ema.join(' / ')
    case 'boll':
      return record?.boll
        ? `${record.boll.n} / ${record.boll.k} · 截图`
        : `${DEFAULTS.boll.n} / ${DEFAULTS.boll.k}`
    case 'volume':
      return null
    case 'mavol':
      return record?.volume?.ma.length
        ? `${record.volume.ma.join(' / ')} · 截图`
        : DEFAULTS.mavol.join(' / ')
    case 'macd':
      return record?.macd
        ? `${record.macd.fast} / ${record.macd.slow} / ${record.macd.signal} · 截图`
        : `${DEFAULTS.macd.fast} / ${DEFAULTS.macd.slow} / ${DEFAULTS.macd.signal}`
    case 'rsi':
      return record?.rsi ? `${record.rsi.n} · 截图` : `${DEFAULTS.rsi.n}`
  }
}

/** 记录里存过种子的那几项，用来做「按截图全开」。 */
export function seededNames(record: ChartSetup | null): LineName[] {
  if (!record) return []
  const on: LineName[] = []
  if (record.ma.length) on.push('ma')
  if (record.ema.length) on.push('ema')
  if (record.boll) on.push('boll')
  if (record.volume) on.push('volume')
  if (record.volume?.ma.length) on.push('mavol')
  if (record.macd) on.push('macd')
  if (record.rsi) on.push('rsi')
  return on
}

export function menuItems(choice: Choice, record: ChartSetup | null): PopItem[] {
  const items: PopItem[] = [{ label: '', value: '', header: '画在图上' }]
  for (const name of LINE_ORDER) {
    items.push({ label: LINE_LABELS[name], value: name, on: choice[name], hint: hintFor(name, record) })
  }
  items.push({ label: '', value: '', sep: true })
  if (record && !setupIsEmpty(record) && seededNames(record).length) {
    items.push({ label: '按截图全开', value: '__shot' })
  }
  items.push({ label: '全部关', value: '__none' })
  return items
}

/** 菜单底下那一句。 */
export function menuFooter(record: ChartSetup | null): string {
  return record && !setupIsEmpty(record) && seededNames(record).length
    ? '按截图 = 这条记录截图上的那几条'
    : '这条记录没有截图指标，用默认参数'
}

/** 一行事实：这张图上现在画着哪几样。一样都没有就是空串。 */
export function describeSetup(setup: ChartSetup): string {
  const parts: string[] = []
  if (setup.ma.length) parts.push(LINE_LABELS.ma)
  if (setup.ema.length) parts.push(LINE_LABELS.ema)
  if (setup.boll) parts.push(LINE_LABELS.boll)
  if (setup.volume) parts.push(LINE_LABELS.volume)
  if (setup.volume?.ma.length) parts.push(LINE_LABELS.mavol)
  if (setup.macd) parts.push(LINE_LABELS.macd)
  if (setup.rsi) parts.push(LINE_LABELS.rsi)
  return parts.join(' · ')
}

/**
 * 预热要往前多取多少根。
 *
 * EMA 和 RSI 是递推的，从窗口第一根起头算出来的值要走一段才收敛，所以按周期的
 * 三倍要；MA 和 BOLL 是滑动窗口，够 n 根就准。
 */
export function maxPeriod(setup: ChartSetup): number {
  let most = 0
  for (const n of setup.ma) most = Math.max(most, n)
  for (const n of setup.ema) most = Math.max(most, n * 3)
  if (setup.boll) most = Math.max(most, setup.boll.n)
  for (const n of setup.volume?.ma ?? []) most = Math.max(most, n)
  if (setup.macd) most = Math.max(most, (setup.macd.slow + setup.macd.signal) * 3)
  if (setup.rsi) most = Math.max(most, setup.rsi.n * 3)
  return most
}

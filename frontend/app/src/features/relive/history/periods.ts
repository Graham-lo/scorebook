// 全屏那条周期选择条：条上露哪几颗、按键对到第几颗、这个品种上次锁的是哪一档。
//
// 看盘的人要的是交易所那种一眼可见、一点就换的周期条。露出来的那一排随屏幕宽
// 窄变，剩下的收进「更多」。这里只回答「条上是哪几个」，画成什么样是视图的事
// ——这样 Node 里的测试能把三种尺寸都跑一遍。

import { INTERVAL_SECONDS, type Interval } from '../../../data/session'

/**
 * 全集。币安 U 本位和币本位都支持这几档。
 *
 * `1M` 不在里面：格子模型是等距的，月线不等距，画出来的位置对不上。
 */
export const ALL_PERIODS: readonly string[] = [
  '1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w',
]

/** 桌面和手机竖屏直接露在条上的那几颗。 */
export const QUICK_WIDE: readonly string[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']
/** 横屏矮，条上少放两颗。 */
export const QUICK_SHORT: readonly string[] = ['1m', '5m', '15m', '1h', '4h', '1d']

/** 按键最多对到第几颗。 */
export const KEY_SLOTS = 9

const secondsOf = (interval: string): number => INTERVAL_SECONDS[interval as Interval] ?? 0

/** 横屏矮屏：条上用短集。竖屏再窄也用桌面那一集，靠横向滚动放得下。 */
function short(width: number, height: number): boolean {
  return height <= 480 && width > height
}

/** 按周期大小插到相邻位置。已经在里面就原样返回。 */
function insertBySize(list: readonly string[], interval: string): string[] {
  if (!interval || list.includes(interval)) return [...list]
  const seconds = secondsOf(interval)
  if (!seconds) return [...list]
  const out = [...list]
  const where = out.findIndex((step) => secondsOf(step) > seconds)
  if (where < 0) out.push(interval)
  else out.splice(where, 0, interval)
  return out
}

/**
 * 条上要露出来的周期，从左到右。
 *
 * 三层：屏幕尺寸定的快捷集，加上这条记录自己的周期（按大小插进去，人从这条记录
 * 进来，他那一档不能藏在「更多」里），再加上这一次从「更多」里挑的那一颗——它
 * 排在最后，挑了别的快捷周期就收回去。
 */
export function quickSet(
  width: number,
  height: number,
  recordInterval: string,
  picked?: string | null,
): string[] {
  const base = short(width, height) ? QUICK_SHORT : QUICK_WIDE
  const out = insertBySize(base, recordInterval)
  if (picked && ALL_PERIODS.includes(picked) && !out.includes(picked)) out.push(picked)
  return out
}

/** 「更多」弹层里剩下的那些，仍按从细到粗。 */
export function moreSet(quick: readonly string[]): string[] {
  return ALL_PERIODS.filter((step) => !quick.includes(step))
}

/** 数字键按到条上第几颗。`1`–`9`，超出条长就没有。 */
export function periodAt(quick: readonly string[], key: string): string | null {
  if (!/^[1-9]$/.test(key)) return null
  const at = Number(key) - 1
  if (at >= KEY_SLOTS) return null
  return quick[at] ?? null
}

/* ------------------------------------------------ 这个品种上次锁的那一档 */

/** 存在哪儿。一个品种一格，关了标签页就没了。 */
export function periodKey(market: string, symbol: string): string {
  return `tf.period.${market}.${symbol}`
}

export type PeriodStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function session(): PeriodStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    // 隐私模式下读 sessionStorage 本身就会抛。
    return null
  }
}

/** 上次在这个品种上锁的周期。没锁过、或者存的是个不认识的串，都当没有。 */
export function readPeriod(market: string, symbol: string, store = session()): string | null {
  try {
    const found = store?.getItem(periodKey(market, symbol)) ?? null
    return found && ALL_PERIODS.includes(found) ? found : null
  } catch {
    return null
  }
}

/** 锁了就记下，回自动就删掉。存不进去不算错——下次进来按一期逻辑走而已。 */
export function savePeriod(
  market: string,
  symbol: string,
  interval: string | null,
  store = session(),
): void {
  try {
    if (interval && ALL_PERIODS.includes(interval)) store?.setItem(periodKey(market, symbol), interval)
    else store?.removeItem(periodKey(market, symbol))
  } catch {
    /* 存不下就算了 */
  }
}

/**
 * 这次失败是不是「后端不认这个周期」。
 *
 * 只有走服务端那条路才会碰上：`/v1/market/data` 对不支持的周期回 400
 * `interval_unsupported`。直连币安时全集都能取，这里永远是 false。
 */
export function unsupportedInterval(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const found = error as { code?: unknown; status?: unknown }
  if (found.code === 'interval_unsupported') return true
  return found.status === 400
}

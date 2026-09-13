// 档位：缩到一定程度就换一档更粗的周期。
//
// 拉到上市那一天的 1 分钟线是几百万根，谁也画不动。人往外缩的时候要的其实是
// 「看得更远」，不是「看更多根」——所以按屏幕上每根多少像素换档，屏上根数始终
// 有界。两个阈值之间留一段不动的区间（滞回），免得在临界点上来回抖。
//
// 每一档独立取数、独立算指标：4 小时图上的 MA20 就是 4 小时的 MA20，和交易所、
// 和 TradingView 都对得上。不在客户端把细的合成粗的——那要求先把底层全拉齐，
// 正好和懒加载相反。

import { INTERVAL_SECONDS, type Interval } from '../../../data/session'
import { barSpanMs } from './tiles'

/** 自动换档只在这几档之间走。 */
export const LADDER: readonly string[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']

/** 往下不再细、往上不再粗的两个阈值（像素）。 */
export const TOO_DENSE_PX = 2
export const TOO_SPARSE_PX = 14

/**
 * 记录本身的周期不在阶梯上（3m / 30m / 2h / 6h / 8h / 12h / 3d / 1M）就把它插
 * 进相邻位置：人从这条记录进来，自动换档不该把他这一档弄丢。
 */
export function ladderFor(recordInterval: string): string[] {
  const ladder = [...LADDER]
  if (ladder.includes(recordInterval)) return ladder
  const seconds = INTERVAL_SECONDS[recordInterval as Interval]
  if (!seconds) return ladder
  const where = ladder.findIndex((step) => (INTERVAL_SECONDS[step as Interval] ?? 0) > seconds)
  if (where < 0) ladder.push(recordInterval)
  else ladder.splice(where, 0, recordInterval)
  return ladder
}

/** 屏幕上一根占多少像素。只按时间跨度算，不问图此刻的 barSpacing。 */
export function pxPerBar(widthPx: number, fromMs: number, toMs: number, interval: string): number {
  if (!(widthPx > 0) || !(toMs > fromMs)) return Number.NaN
  const bars = (toMs - fromMs) / barSpanMs(interval)
  if (!(bars > 0)) return Number.NaN
  return widthPx / bars
}

/** 两个阈值中间那个最舒服的密度。程序性跳转按它挑档。 */
export const TARGET_PX = 6
/**
 * 手机上舒服的密度要密一档。手指那块屏只有三百多点宽，按桌面的 6 挑出来，一屏
 * 才五十根，看不出结构；AICoin 手机端一屏九十来根，4.5 落在那个手感里。
 */
export const TARGET_PX_MOBILE = 4.5

/**
 * 程序性跳转（锚定、回位、到上市、`+ −`）要的档：按目标跨度一次算到位，可以跨
 * 好几档。「一次只走一步」那条只给人手缩放用——人手在慢慢缩，图得跟着他走。
 *
 * `base` 是这条记录自己的周期。两个阈值之间能站住脚的档往往不止一个，这时候离
 * 记录本档最近的那一档看起来才像他当时看的那张图（手机竖屏进全屏，1h 和 4h 都
 * 在区间里，该给 1h）。一档都站不住才退回按 TARGET_PX 挑最舒服的密度。
 */
export function levelForSpan(
  widthPx: number,
  fromMs: number,
  toMs: number,
  ladder: readonly string[],
  current: string,
  locked = false,
  base?: string,
  targetPx = TARGET_PX,
): string {
  if (locked) return current
  if (!ladder.length) return current
  if (!(widthPx > 0) || !(toMs > fromMs)) return current
  const here = pxPerBar(widthPx, fromMs, toMs, current)
  // 当前这一档还在舒服区间里就别动它。
  if (ladder.includes(current) && here >= TOO_DENSE_PX && here <= TOO_SPARSE_PX) return current
  const baseSpan = base ? barSpanMs(base) : 0
  let best = ladder[0] as string
  let score = Number.POSITIVE_INFINITY
  for (const step of ladder) {
    const px = pxPerBar(widthPx, fromMs, toMs, step)
    if (!Number.isFinite(px) || px <= 0) continue
    const off = Math.abs(Math.log(px / (targetPx > 0 ? targetPx : TARGET_PX)))
    const fits = px >= TOO_DENSE_PX && px <= TOO_SPARSE_PX
    // 区间内按「离记录本档多远」排，区间外一律靠后（+10），彼此之间还是比密度。
    const near = baseSpan > 0 ? Math.abs(Math.log(barSpanMs(step) / baseSpan)) : off
    const rank = fits ? near : off + 10
    if (rank < score) { score = rank; best = step }
  }
  return best
}

/**
 * 该换到哪一档。一次只走一步——一口气跳两档，人手上的缩放和屏上的图就对不上了。
 */
export function pickLevel(
  current: string,
  px: number,
  ladder: readonly string[],
  locked: boolean,
): string {
  if (locked) return current
  const i = ladder.indexOf(current)
  if (i < 0) return current
  if (!Number.isFinite(px)) return current
  if (px < TOO_DENSE_PX && i < ladder.length - 1) return ladder[i + 1] as string
  if (px > TOO_SPARSE_PX && i > 0) return ladder[i - 1] as string
  return current
}

/** 这一段时间在这一档上大概是多少根。 */
export function barsIn(fromMs: number, toMs: number, interval: string): number {
  if (!(toMs > fromMs)) return 0
  return Math.ceil((toMs - fromMs) / barSpanMs(interval))
}

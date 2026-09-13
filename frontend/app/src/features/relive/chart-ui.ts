// 图上那几样归前端自己记的事：价格坐标怎么画、右侧品种面板开着没有、这个宽高
// 该按哪一套排布、周期菜单里列哪几行。
//
// 全写成纯函数放这儿，Node 里的测试才跑得动——DOM 那一半在 market-view.ts 里。

import { ALL_PERIODS } from './history/periods'

/* ------------------------------------------------------ 价格坐标 */

/** 价格轴三种画法。默认对数：看多年历史的时候，只有对数轴上涨跌幅才等高。 */
export type ScaleMode = 'log' | 'normal' | 'percent'

export const SCALE_MODES: readonly ScaleMode[] = ['log', 'normal', 'percent']

/** 存在哪儿。窗口态、全屏共用这一个键。 */
export const SCALE_KEY = 'tf.chart.scale'
/** 右侧品种面板开着没有，`"1"` / `"0"`。 */
export const WATCH_KEY = 'tf.chart.watch.open'

export type ChartStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function local(): ChartStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // 隐私模式下读 localStorage 本身就会抛。
    return null
  }
}

/** 上次选的坐标。没存过、或者存的是个不认识的串，都当默认的对数。 */
export function readScale(store: ChartStore | null = local()): ScaleMode {
  try {
    const found = store?.getItem(SCALE_KEY) ?? null
    return SCALE_MODES.includes(found as ScaleMode) ? found as ScaleMode : 'log'
  } catch {
    return 'log'
  }
}

/** 记下选的坐标。存不进去不算错，下次进来按默认走而已。 */
export function saveScale(mode: ScaleMode, store: ChartStore | null = local()): void {
  try {
    if (SCALE_MODES.includes(mode)) store?.setItem(SCALE_KEY, mode)
  } catch {
    /* 存不下就算了 */
  }
}

/** `Alt+L` 在对数和常规之间来回；百分比按一下先回对数。 */
export function toggleLog(mode: ScaleMode): ScaleMode {
  return mode === 'log' ? 'normal' : 'log'
}

/* -------------------------------------------------- 右侧品种面板 */

export function readWatchOpen(store: ChartStore | null = local()): boolean {
  try {
    return (store?.getItem(WATCH_KEY) ?? null) === '1'
  } catch {
    return false
  }
}

export function saveWatchOpen(on: boolean, store: ChartStore | null = local()): void {
  try {
    store?.setItem(WATCH_KEY, on ? '1' : '0')
  } catch {
    /* 存不下就算了 */
  }
}

/* ------------------------------------------------------ 排布 */

/** 桌面照 TradingView，手机竖屏、横屏各照 AICoin 的一套。 */
export type ChartLayout = 'desktop' | 'portrait' | 'landscape'

/** 到这个宽度以下按手机排。只看宽高，不看是不是触屏。 */
export const MOBILE_PX = 760
/** 横过来看图：高度到这儿以下，周期竖着贴在左边。 */
export const SHORT_PX = 500

/**
 * 这个宽高该按哪一套排。
 *
 * 横屏先判：`812×375` 这一档宽度超过 760，但它就是手机横过来，得走竖列那一套。
 * 剩下的按宽度分，窄的走竖屏——桌面浏览器把窗口拖到 760 以下也一样。
 */
export function chartLayout(width: number, height: number): ChartLayout {
  if (height <= SHORT_PX && width > height) return 'landscape'
  if (width <= MOBILE_PX) return 'portrait'
  return 'desktop'
}

/** 手机那两套（竖屏、横屏）合起来叫「手机布局」。 */
export function isMobileLayout(layout: ChartLayout): boolean {
  return layout !== 'desktop'
}

/* -------------------------------------------------- 周期菜单 */

/** 菜单第一行「自动」的值。 */
export const PERIOD_AUTO = '__auto'

export interface PeriodRow {
  /** 行上写的字。 */
  label: string
  /** 点它给回来的值：`__auto` 或者某一档。 */
  value: string
  /** 打勾的那一行。 */
  on: boolean
  /** 这条记录自己那一档，右上角一枚小点。 */
  dot: boolean
  /** 后端不支持，置灰点不动。 */
  off: boolean
}

/**
 * 左上角图例里那张周期菜单：第一行「自动」，然后十四档从细到粗。
 *
 * 当前档打勾并高亮；自动模式下「自动」那一行也打勾——锁在 1h，和自动刚好落到
 * 1h，是两回事，人得一眼分得开。
 */
export function periodMenu(input: {
  /** 现在是哪一档。 */
  level: string
  /** 是不是自动换档。 */
  auto: boolean
  /** 这条记录自己的那一档。 */
  record: string
  /** 后端说不支持的那几档。 */
  unsupported?: Iterable<string>
}): PeriodRow[] {
  const off = new Set(input.unsupported ?? [])
  const rows: PeriodRow[] = [
    { label: '自动', value: PERIOD_AUTO, on: input.auto, dot: false, off: false },
  ]
  for (const step of ALL_PERIODS) {
    rows.push({
      label: step,
      value: step,
      on: step === input.level,
      dot: step === input.record,
      off: off.has(step),
    })
  }
  return rows
}

/**
 * 品种栏「本次相关」那一组的排法：这条记录自己的那一段永远排第一，其余按原
 * 顺序跟在后面。下标不合法就原样返回，宁可少排也不能把哪一段弄丢。
 */
export function segmentOrder(total: number, recordAt: number): number[] {
  const all = Array.from({ length: Math.max(0, total) }, (_, i) => i)
  if (!all.length || !all.includes(recordAt)) return all
  return [recordAt, ...all.filter((i) => i !== recordAt)]
}

/**
 * 一条滚动条上，把某一颗整个露出来要挪多少（正数往后滚，负数往回滚，0 是本来
 * 就整颗看得见）。两头各留 `pad`，免得紧贴着钉住的 `自动` / `更多` 像被压住。
 */
/**
 * 把一颗 chip 挪到条正中要滚多少（正数往后滚）。
 *
 * 竖屏那条设了 `scroll-snap-type:x proximity`、每颗 chip 是 `scroll-snap-align:
 * center`：只挪「刚好露出来」那几个像素的话，浏览器随后会把它吸到最近的居中点
 * 上，当前档又被压回边上去。直接滚到居中——那本来就是吸附点，吸完还在原处。
 */
export function scrollCenter(
  box: { start: number; end: number },
  item: { start: number; end: number },
): number {
  if (!(box.end > box.start)) return 0
  if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) return 0
  return (item.start + item.end) / 2 - (box.start + box.end) / 2
}

export function scrollShift(
  box: { start: number; end: number },
  item: { start: number; end: number },
  pad = 4,
): number {
  if (!(box.end > box.start)) return 0
  if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) return 0
  if (item.start - pad < box.start) return item.start - pad - box.start
  if (item.end + pad > box.end) return item.end + pad - box.end
  return 0
}

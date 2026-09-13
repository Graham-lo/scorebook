// 全屏那几块叠在图上的东西：工具条、版权——它们占多高，以及人怎么把它们唤醒。
//
// 两件事在手机上翻过车，所以都挪到这里、写成能单测的纯函数：
//
// 一、闲置淡出不能连「摸得到」一起收掉。触屏没有 mousemove，人要点工具条只能
// 直接按下去；淡出时若把 `pointer-events` 一起关了，这一下就穿过去落在画布上，
// chip 根本收不到事件，也就永远醒不过来。所以淡出只淡透明度，唤醒事件里必须有
// `touchstart` 和 `pointermove`。
//
// 二、底下那几行的高度不能写死。工具条会换行，手机竖屏是两行、横屏是一行；写死
// 80px 的留白在竖屏上装不下，工具条就压到时间轴画布上去了。高度量出来写进 CSS
// 变量，`padding-bottom` 跟着走。

/** 唤醒靠这几种事件。触屏只有后三种，少一个人就摸不到工具条。 */
export const WAKE_EVENTS = [
  'mousemove', 'pointermove', 'pointerdown', 'touchstart', 'wheel', 'keydown',
] as const

/** 工具条自己身上再挂这几种：指针挪进来、手指按上来、键盘聚焦进来。 */
export const CONTROLS_WAKE_EVENTS = ['pointerenter', 'pointermove', 'touchstart', 'focusin'] as const

/** 只要有 addEventListener 就行；测试里拿个假的进来。 */
export interface Listenable {
  addEventListener(type: string, handler: (event: unknown) => void, options?: unknown): void
  removeEventListener(type: string, handler: (event: unknown) => void, options?: unknown): void
}

/**
 * 把唤醒挂上去，返回一个撤销函数。
 *
 * `panel` 是整个全屏面板，`controls` 是工具条本身——工具条那一份不能省：人只是
 * 把手指按在 chip 上，指针从没在面板里挪动过，面板那一份一条都不会响。
 */
export function bindWake(panel: Listenable, controls: Listenable, wake: () => void): () => void {
  const off: (() => void)[] = []
  const on = (target: Listenable, types: readonly string[]): void => {
    for (const type of types) {
      const handler = (): void => wake()
      target.addEventListener(type, handler, { passive: true })
      off.push(() => target.removeEventListener(type, handler, { passive: true }))
    }
  }
  on(panel, WAKE_EVENTS)
  on(controls, CONTROLS_WAKE_EVENTS)
  return () => { for (const undo of off) undo() }
}

/** 底边那几行各自占多高、彼此留多少缝（像素）。CSS 里的数值就是这几个。 */
export const CHROME = {
  /** 版权那一行，贴着底边。 */
  creditH: 18,
  /** 竖屏时工具条离底边多高。 */
  stackedBottom: 40,
  /** 桌面时工具条离底边多高。 */
  looseBottom: 26,
  /** 工具条和统计之间的缝。 */
  gap: 6,
  /** 最上面再留一点，别让工具条贴着时间轴画布。 */
  pad: 8,
} as const

/**
 * 图那块画布底下要留多少留白，才装得下这一整套叠层。
 *
 * `stacked` 是手机竖屏那种从下往上摞的排法；否则是桌面那种工具条居中浮着的排法。
 */
export function chromeHeight(parts: {
  controlsH: number
  stacked: boolean
  /** 导航条的高度；没有导航条就是 0（手机竖屏不放）。 */
  navH?: number
  /** 工具条离底边多高；横屏贴到 8，不是桌面那 26。 */
  bottom?: number
}): number {
  const controls = Math.max(0, Math.round(parts.controlsH))
  const nav = Math.max(0, Math.round(parts.navH ?? 0))
  const extra = nav ? nav + CHROME.gap : 0
  const loose = Math.max(0, Math.round(parts.bottom ?? CHROME.looseBottom))
  if (!parts.stacked) return loose + controls + CHROME.gap + extra + CHROME.pad
  return CHROME.stackedBottom + controls + CHROME.gap + extra + CHROME.pad
}

/** 导航条贴在工具条正上方：工具条底边 + 工具条高 + 一道缝。 */
export function navBottom(controlsH: number, stacked: boolean, looseBottom: number = CHROME.looseBottom): number {
  const base = stacked ? CHROME.stackedBottom : looseBottom
  return base + Math.max(0, Math.round(controlsH)) + CHROME.gap
}

// 全屏底边那一套叠层：占多高、导航条贴在哪儿，以及闲置唤醒有没有把触屏算进去。
//
// 这两件事都在手机上翻过车，所以都写成能在 Node 里直接测的样子。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHROME, CONTROLS_WAKE_EVENTS, WAKE_EVENTS, bindWake, chromeHeight, navBottom, statsBottom,
  type Listenable,
} from '../src/features/relive/chrome'

test('桌面那种排法：统计在右上角，不占底边', () => {
  const loose = chromeHeight({ controlsH: 36, statsH: 40, stacked: false })
  assert.equal(loose, CHROME.looseBottom + 36 + CHROME.gap + CHROME.pad)
})

test('手机竖屏摞起来：版权、免责、工具条、统计各占一行，工具条换行也要算进去', () => {
  const one = chromeHeight({ controlsH: 34, statsH: 25, stacked: true })
  const two = chromeHeight({ controlsH: 74, statsH: 25, stacked: true })
  assert.equal(one, CHROME.stackedBottom + 34 + CHROME.gap + 25 + CHROME.pad)
  assert.equal(two - one, 40, '工具条多一行，留白就得多一行')
})

test('有导航条就再多让出一条加一道缝，没有就一点都不多留', () => {
  const without = chromeHeight({ controlsH: 36, statsH: 40, stacked: false })
  const with28 = chromeHeight({ controlsH: 36, statsH: 40, stacked: false, navH: 28 })
  assert.equal(with28 - without, 28 + CHROME.gap)
  assert.equal(chromeHeight({ controlsH: 36, statsH: 40, stacked: false, navH: 0 }), without)
})

test('负数和小数都按正整数算，不会把留白算成负的', () => {
  assert.equal(chromeHeight({ controlsH: -20, statsH: -5, stacked: true }),
    CHROME.stackedBottom + CHROME.gap + CHROME.pad)
})

test('统计那一行踩在工具条头顶上；导航条贴在工具条正上方', () => {
  assert.equal(statsBottom(34), CHROME.stackedBottom + 34 + CHROME.gap)
  assert.equal(navBottom(36, false), CHROME.looseBottom + 36 + CHROME.gap)
  assert.equal(navBottom(34, true), CHROME.stackedBottom + 34 + CHROME.gap)
  assert.equal(navBottom(30, false, 8), 8 + 30 + CHROME.gap, '横屏工具条贴到 8px，导航条跟着上去')
})

/* ------------------------------------------------------------ 唤醒 */

function spy(): Listenable & { types: string[]; fire(type: string): void; live: number } {
  const handlers = new Map<string, ((event: unknown) => void)[]>()
  return {
    types: [] as string[],
    get live() { return [...handlers.values()].reduce((n, list) => n + list.length, 0) },
    addEventListener(type, handler) {
      this.types.push(type)
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
    },
    removeEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((one) => one !== handler))
    },
    fire(type: string) { for (const handler of handlers.get(type) ?? []) handler({}) },
  }
}

test('触屏那三种事件一个都不能少：面板上有 touchstart 和 pointermove', () => {
  assert.ok(WAKE_EVENTS.includes('touchstart'))
  assert.ok(WAKE_EVENTS.includes('pointermove'))
  assert.ok(CONTROLS_WAKE_EVENTS.includes('touchstart'))
})

test('手指按在工具条上就算醒：touchstart 触发 wake', () => {
  const panel = spy()
  const controls = spy()
  let woke = 0
  const undo = bindWake(panel, controls, () => { woke += 1 })
  panel.fire('touchstart')
  assert.equal(woke, 1, '面板上的 touchstart 算')
  controls.fire('touchstart')
  assert.equal(woke, 2, '工具条自己那一份也算——指针从没在面板里挪动过')
  controls.fire('focusin')
  assert.equal(woke, 3, '键盘聚焦进来也算')
  undo()
  panel.fire('touchstart')
  controls.fire('touchstart')
  assert.equal(woke, 3, '撤销之后一条都不响')
  assert.equal(panel.live + controls.live, 0)
})

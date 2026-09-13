// 图上归前端自己记的那几样：坐标模式、品种面板开关、宽高按哪一套排、周期菜单
// 列哪几行，以及手动换周期时「保根宽不保跨度」那道换算。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MOBILE_PX, PERIOD_AUTO, SCALE_KEY, WATCH_KEY, chartLayout, isMobileLayout, periodMenu,
  readScale, readWatchOpen, saveScale, saveWatchOpen, scrollCenter, scrollShift, toggleLog, type ChartStore, segmentOrder,
} from '../src/features/relive/chart-ui'
import { ALL_PERIODS } from '../src/features/relive/history/periods'
import { spanForPeriod } from '../src/features/relive/chart-span'

function store(): ChartStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    removeItem: (key: string) => { map.delete(key) },
  }
}

/* ------------------------------------------------------ 坐标 */

test('坐标默认对数，存过什么读回什么', () => {
  const box = store()
  assert.equal(readScale(box), 'log')
  saveScale('percent', box)
  assert.equal(box.map.get(SCALE_KEY), 'percent')
  assert.equal(readScale(box), 'percent')
  saveScale('normal', box)
  assert.equal(readScale(box), 'normal')
})

test('存的是个不认识的串就当默认；读不到存储也不抛', () => {
  const box = store()
  box.map.set(SCALE_KEY, 'candlestick')
  assert.equal(readScale(box), 'log')
  assert.equal(readScale(null), 'log')
  assert.doesNotThrow(() => saveScale('log', null))
})

test('Alt+L 在对数和常规之间来回，百分比按一下先回对数', () => {
  assert.equal(toggleLog('log'), 'normal')
  assert.equal(toggleLog('normal'), 'log')
  assert.equal(toggleLog('percent'), 'log')
})

/* -------------------------------------------------- 品种面板 */

test('品种面板默认关着，开关存得住', () => {
  const box = store()
  assert.equal(readWatchOpen(box), false)
  saveWatchOpen(true, box)
  assert.equal(box.map.get(WATCH_KEY), '1')
  assert.equal(readWatchOpen(box), true)
  saveWatchOpen(false, box)
  assert.equal(box.map.get(WATCH_KEY), '0')
  assert.equal(readWatchOpen(box), false)
  assert.equal(readWatchOpen(null), false)
})

/* ------------------------------------------------------ 排布 */

test('桌面、手机竖屏、手机横屏各走各的一套', () => {
  assert.equal(chartLayout(1440, 900), 'desktop')
  assert.equal(chartLayout(375, 812), 'portrait')
  assert.equal(chartLayout(812, 375), 'landscape')
  assert.equal(chartLayout(667, 375), 'landscape')
})

test('桌面浏览器把窗口拖到 760 以下也按手机排', () => {
  assert.equal(chartLayout(MOBILE_PX, 900), 'portrait')
  assert.equal(chartLayout(MOBILE_PX + 1, 900), 'desktop')
  assert.ok(isMobileLayout(chartLayout(375, 812)))
  assert.ok(isMobileLayout(chartLayout(812, 375)))
  assert.ok(!isMobileLayout(chartLayout(1440, 900)))
})

test('宽屏但很矮（拖扁的桌面窗口）也走横屏那一套', () => {
  assert.equal(chartLayout(1440, 420), 'landscape')
})

/* -------------------------------------------------- 周期菜单 */

test('周期菜单：自动一行加十四档，当前档打勾', () => {
  const rows = periodMenu({ level: '1h', auto: false, record: '30m' })
  assert.equal(rows.length, ALL_PERIODS.length + 1)
  assert.equal(rows[0]?.value, PERIOD_AUTO)
  assert.equal(rows[0]?.label, '自动')
  assert.equal(rows[0]?.on, false)
  assert.deepEqual(rows.slice(1).map((row) => row.value), [...ALL_PERIODS])
  assert.deepEqual(rows.filter((row) => row.on).map((row) => row.value), ['1h'])
})

test('自动那一行跟着自动打勾；这条记录自己那一档带小点', () => {
  const rows = periodMenu({ level: '1h', auto: true, record: '30m' })
  assert.equal(rows[0]?.on, true)
  assert.deepEqual(rows.filter((row) => row.dot).map((row) => row.value), ['30m'])
})

test('后端不支持的那几档置灰', () => {
  const rows = periodMenu({ level: '1h', auto: false, record: '30m', unsupported: ['3d', '1w'] })
  assert.deepEqual(rows.filter((row) => row.off).map((row) => row.value), ['3d', '1w'])
})

/* ---------------------------------------- 手动换周期：保根宽不保跨度 */

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

test('手动换周期：每根还是那么宽，中心那一刻不动', () => {
  const from = Date.UTC(2024, 0, 1)
  const to = from + 200 * HOUR
  const middle = (from + to) / 2
  // 1440px 宽、一根 7.2px：屏幕上正好 200 根。
  const next = spanForPeriod(from, to, 1440, 7.2, DAY)
  assert.equal((next.from + next.to) / 2, middle, '中心那一刻留在中心')
  assert.equal(next.to - next.from, 200 * DAY, '还是 200 根，只是每根变成一天')
  // 换回去再换过来，跨度对得上。
  const back = spanForPeriod(next.from, next.to, 1440, 7.2, HOUR)
  assert.equal(back.to - back.from, 200 * HOUR)
  assert.equal((back.from + back.to) / 2, middle)
})

test('根宽不同，屏幕上的根数就不同，跨度跟着走', () => {
  const from = Date.UTC(2024, 0, 1)
  const to = from + 100 * HOUR
  const wide = spanForPeriod(from, to, 1200, 12, 5 * MIN)
  assert.equal(wide.to - wide.from, 100 * 5 * MIN, '1200 / 12 = 100 根')
  const thin = spanForPeriod(from, to, 1200, 4, 5 * MIN)
  assert.equal(thin.to - thin.from, 300 * 5 * MIN, '1200 / 4 = 300 根')
})

test('宽度、根宽、周期有一样算不出来就原样不动', () => {
  const from = Date.UTC(2024, 0, 1)
  const to = from + 10 * HOUR
  assert.deepEqual(spanForPeriod(from, to, 0, 8, HOUR), { from, to })
  assert.deepEqual(spanForPeriod(from, to, 1440, 0, HOUR), { from, to })
  assert.deepEqual(spanForPeriod(from, to, 1440, 8, 0), { from, to })
  assert.deepEqual(spanForPeriod(from, from, 1440, 8, HOUR), { from, to: from })
  assert.deepEqual(spanForPeriod(Number.NaN, to, 1440, 8, HOUR), { from: Number.NaN, to })
})

test('「本次相关」把这条记录自己的那一段排在第一行', () => {
  assert.deepEqual(segmentOrder(4, 2), [2, 0, 1, 3], '记录那一段提到最前，其余保持原顺序')
  assert.deepEqual(segmentOrder(1, 0), [0], '只有一段也要列出来，不能整组不立')
  assert.deepEqual(segmentOrder(3, 0), [0, 1, 2])
})

test('段下标不合法时一段都不丢', () => {
  assert.deepEqual(segmentOrder(3, 5), [0, 1, 2])
  assert.deepEqual(segmentOrder(3, -1), [0, 1, 2])
  assert.deepEqual(segmentOrder(0, 0), [])
})

test('当前那一档整颗露出来要挪多少', () => {
  const box = { start: 0, end: 100 }
  assert.equal(scrollShift(box, { start: 20, end: 52 }), 0, '本来就整颗看得见，别抢滚动位置')
  assert.equal(scrollShift(box, { start: 80, end: 112 }), 16, '右边被钉住的「更多」压住半颗：往后滚到整颗露出来')
  assert.equal(scrollShift(box, { start: -10, end: 22 }), -14, '左边露一半：往回滚')
  assert.equal(scrollShift(box, { start: 0, end: 32 }), -4, '贴着左沿也要留出那点余地')
})

test('量不出宽高的条不滚', () => {
  assert.equal(scrollShift({ start: 0, end: 0 }, { start: 10, end: 42 }), 0)
  assert.equal(scrollShift({ start: 0, end: 100 }, { start: Number.NaN, end: 42 }), 0)
  assert.equal(scrollCenter({ start: 0, end: 0 }, { start: 10, end: 42 }), 0)
  assert.equal(scrollCenter({ start: 0, end: 100 }, { start: 10, end: Number.NaN }), 0)
})

test('要挪就挪到正中：吸附点在那儿，浏览器不会再把它吸回边上', () => {
  const box = { start: 0, end: 100 }
  assert.equal(scrollCenter(box, { start: 80, end: 112 }), 46, '右边压住半颗：一路滚到居中')
  assert.equal(scrollCenter(box, { start: -10, end: 22 }), -44, '左边露一半：往回滚到居中')
  assert.equal(scrollCenter(box, { start: 34, end: 66 }), 0, '本来就在正中，一个像素都不用动')
})

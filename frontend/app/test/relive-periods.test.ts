// 全屏那条周期选择条：条上露哪几颗、数字键按到第几颗、这个品种上次锁了哪一档。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALL_PERIODS, QUICK_SHORT, QUICK_WIDE, moreSet, periodAt, periodKey, quickSet,
  readPeriod, savePeriod, unsupportedInterval, type PeriodStore,
} from '../src/features/relive/history/periods'
import { pickLevel } from '../src/features/relive/history/lod'

test('月线不进条：格子等距，月线不等距', () => {
  assert.ok(!ALL_PERIODS.includes('1M'))
  assert.equal(ALL_PERIODS.length, 14)
})

test('桌面、竖屏用同一套快捷集，横屏矮屏少放两颗', () => {
  assert.deepEqual(quickSet(1440, 900, '1h'), [...QUICK_WIDE])
  assert.deepEqual(quickSet(375, 812, '1h'), [...QUICK_WIDE], '竖屏靠横向滚动放得下')
  assert.deepEqual(quickSet(812, 375, '1h'), [...QUICK_SHORT])
})

test('横屏那一行就这几颗：自动 1m 5m 15m 1h 4h 1d 更多，30m 和 1w 收进更多', () => {
  const bar = quickSet(812, 375, '1h')
  assert.deepEqual(bar, ['1m', '5m', '15m', '1h', '4h', '1d'])
  assert.deepEqual(QUICK_SHORT, ['1m', '5m', '15m', '1h', '4h', '1d'])
  const more = moreSet(bar)
  assert.ok(more.includes('30m') && more.includes('1w'), '30m、1w 进「更多」')
  assert.deepEqual(more, ['3m', '30m', '2h', '6h', '8h', '12h', '3d', '1w'])
})

test('这条记录自己的周期永远在条上，按大小插到相邻位置', () => {
  const bar = quickSet(812, 375, '30m')
  assert.ok(bar.includes('30m'))
  assert.deepEqual(bar, ['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
  assert.deepEqual(quickSet(1440, 900, '3d').slice(-3), ['1d', '3d', '1w'], '比 1w 细就插在 1w 前面')
})

test('记录周期本来就在快捷集里就不重复插一遍', () => {
  const bar = quickSet(1440, 900, '15m')
  assert.deepEqual(bar, [...QUICK_WIDE])
  assert.equal(bar.filter((step) => step === '15m').length, 1)
})

test('从「更多」里挑的那一颗临时排在条尾，选了别的它就收回去', () => {
  const bar = quickSet(1440, 900, '30m', '2h')
  assert.deepEqual(bar, [...QUICK_WIDE, '2h'])
  assert.equal(bar.length, 9, '正好第 9 颗，数字键还够得着')
  assert.deepEqual(quickSet(1440, 900, '30m', null), [...QUICK_WIDE], '收回去就是快捷集本身')
  assert.deepEqual(quickSet(1440, 900, '30m', '1h'), [...QUICK_WIDE], '条上已经有的不重复露')
  assert.deepEqual(quickSet(1440, 900, '30m', '1M'), [...QUICK_WIDE], '月线怎么挑都不进条')
})

test('「更多」里是全集减去条上那几颗，仍从细到粗', () => {
  const bar = quickSet(1440, 900, '30m')
  const more = moreSet(bar)
  assert.deepEqual(more, ['3m', '2h', '6h', '8h', '12h', '3d'])
  assert.equal(more.filter((step) => bar.includes(step)).length, 0)
})

test('数字键按的是条上第几颗，不是阶梯下标', () => {
  const bar = quickSet(1440, 900, '30m', '2h')
  assert.equal(periodAt(bar, '1'), '1m')
  assert.equal(periodAt(bar, '4'), '30m')
  assert.equal(periodAt(bar, '9'), '2h')
  assert.equal(periodAt(bar, '0'), null)
  assert.equal(periodAt(quickSet(812, 375, '1h'), '7'), null, '横屏条上只有六颗，第 7 颗没有')
})

test('锁定的周期按品种记在会话里：存、读、回自动就删', () => {
  const cells = new Map<string, string>()
  const store: PeriodStore = {
    getItem: (key) => cells.get(key) ?? null,
    setItem: (key, value) => { cells.set(key, value) },
    removeItem: (key) => { cells.delete(key) },
  }
  assert.equal(periodKey('usd_m', 'BTCUSDT'), 'tf.period.usd_m.BTCUSDT')
  assert.equal(readPeriod('usd_m', 'BTCUSDT', store), null)
  savePeriod('usd_m', 'BTCUSDT', '2h', store)
  assert.equal(readPeriod('usd_m', 'BTCUSDT', store), '2h')
  assert.equal(readPeriod('usd_m', 'ETHUSDT', store), null, '一个品种一格')
  savePeriod('usd_m', 'BTCUSDT', null, store)
  assert.equal(readPeriod('usd_m', 'BTCUSDT', store), null)
})

test('存进去的是个不认识的串就当没锁过；存不进去也不算错', () => {
  const cells = new Map<string, string>([['tf.period.usd_m.BTCUSDT', '1M']])
  const store: PeriodStore = {
    getItem: (key) => cells.get(key) ?? null,
    setItem: () => { throw new Error('隐私模式') },
    removeItem: () => { throw new Error('隐私模式') },
  }
  assert.equal(readPeriod('usd_m', 'BTCUSDT', store), null)
  savePeriod('usd_m', 'BTCUSDT', '4h', store)
  savePeriod('usd_m', 'BTCUSDT', null, store)
})

test('锁定之后缩放不换档，3m 和 2h 这种不在阶梯上的也一样', () => {
  const ladder = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']
  assert.equal(pickLevel('15m', 0.5, ladder, true), '15m', '缩得再密也不换')
  assert.equal(pickLevel('15m', 40, ladder, true), '15m', '放得再开也不换')
  assert.equal(pickLevel('15m', 0.5, ladder, false), '1h', '自动模式才换')
  assert.equal(pickLevel('3m', 0.5, ladder, true), '3m')
  assert.equal(pickLevel('2h', 40, ladder, true), '2h')
})

test('后端不认这个周期才置灰，网络抽风不算', () => {
  assert.equal(unsupportedInterval({ status: 400, code: 'interval_unsupported' }), true)
  assert.equal(unsupportedInterval({ status: 400, code: 'invalid_request' }), true)
  assert.equal(unsupportedInterval({ status: 503, code: 'upstream_down' }), false)
  assert.equal(unsupportedInterval(new Error('offline')), false)
  assert.equal(unsupportedInterval(null), false)
})

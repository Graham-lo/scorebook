// 换档：什么时候升一档、什么时候降一档、锁了档还动不动。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LADDER, TOO_DENSE_PX, TOO_SPARSE_PX, barsIn, ladderFor, levelForSpan, pickLevel, pxPerBar,
} from '../src/features/relive/history/lod'

const HOUR = 3_600_000

test('阶梯就是这七档', () => {
  assert.deepEqual([...LADDER], ['1m', '5m', '15m', '1h', '4h', '1d', '1w'])
})

test('记录周期本来就在阶梯上：原样返回一份拷贝', () => {
  const made = ladderFor('1h')
  assert.deepEqual(made, [...LADDER])
  assert.notEqual(made, LADDER)
})

test('3m 插在 1m 和 5m 之间', () => {
  assert.deepEqual(ladderFor('3m'), ['1m', '3m', '5m', '15m', '1h', '4h', '1d', '1w'])
})

test('2h 插在 1h 和 4h 之间', () => {
  assert.deepEqual(ladderFor('2h'), ['1m', '5m', '15m', '1h', '2h', '4h', '1d', '1w'])
})

test('12h 插在 4h 和 1d 之间', () => {
  assert.deepEqual(ladderFor('12h'), ['1m', '5m', '15m', '1h', '4h', '12h', '1d', '1w'])
})

test('1M 比周线还粗，排在最后', () => {
  assert.deepEqual(ladderFor('1M').at(-1), '1M')
  assert.equal(ladderFor('1M').length, LADDER.length + 1)
})

test('认不出来的周期不插，阶梯照旧', () => {
  assert.deepEqual(ladderFor('7s'), [...LADDER])
})

test('太密了就升一档', () => {
  assert.equal(pickLevel('1h', TOO_DENSE_PX - 0.1, LADDER, false), '4h')
  assert.equal(pickLevel('1h', 1.9, LADDER, false), '4h')
})

test('刚过密的阈值不动：滞回区间里不换', () => {
  assert.equal(pickLevel('1h', 2.1, LADDER, false), '1h')
  assert.equal(pickLevel('1h', TOO_SPARSE_PX, LADDER, false), '1h')
})

test('太疏了就降一档', () => {
  assert.equal(pickLevel('1h', 14.1, LADDER, false), '15m')
})

test('一次只走一步，不跳档', () => {
  assert.equal(pickLevel('1w', 0.01, LADDER, false), '1w')
  assert.equal(pickLevel('1h', 0.01, LADDER, false), '4h')
  assert.equal(pickLevel('1h', 9999, LADDER, false), '15m')
})

test('顶档再密也不越界，底档再疏也不越界', () => {
  assert.equal(pickLevel('1w', 0.5, LADDER, false), '1w')
  assert.equal(pickLevel('1m', 500, LADDER, false), '1m')
})

test('锁了档就不动', () => {
  assert.equal(pickLevel('1h', 0.5, LADDER, true), '1h')
  assert.equal(pickLevel('1h', 500, LADDER, true), '1h')
})

test('当前档不在这条阶梯上就不动', () => {
  assert.equal(pickLevel('3m', 0.5, LADDER, false), '3m')
})

test('像素间距是 NaN 就不动', () => {
  assert.equal(pickLevel('1h', Number.NaN, LADDER, false), '1h')
})

test('插过档的阶梯上也是一步一步走', () => {
  const ladder = ladderFor('2h')
  assert.equal(pickLevel('1h', 1, ladder, false), '2h')
  assert.equal(pickLevel('4h', 20, ladder, false), '2h')
})

test('估根数：向上取整', () => {
  assert.equal(barsIn(0, 10 * HOUR, '1h'), 10)
  assert.equal(barsIn(0, 10 * HOUR + 1, '1h'), 11)
})

test('估根数：反着给或者一样长就是 0', () => {
  assert.equal(barsIn(10, 10, '1h'), 0)
  assert.equal(barsIn(100, 10, '1h'), 0)
})

// ——— 换档只看时间跨度 ———
// 缩到 2019 年那种一根都没加载的地方，图自己的 barSpacing 会被钳成几十像素，
// 照它换档就会一路降到 1m。按跨度算就不会：跨度里根本没有「加载了没有」这件事。

const MIN = 60_000
const DAY = 86_400_000
const WIDE = 1440

test('每根多少像素：宽度除以跨度里的根数', () => {
  assert.equal(pxPerBar(1440, 0, 1440 * MIN, '1m'), 1)
  assert.equal(pxPerBar(1440, 0, 144 * HOUR, '1h'), 10)
})

test('一根都没加载的区间照样算得出像素：跨度说了算', () => {
  const listing = Date.UTC(2019, 8, 1)
  assert.equal(pxPerBar(WIDE, listing, listing + DAY, '1m'), 1)
  assert.equal(pxPerBar(WIDE, listing, listing + DAY, '1h'), 60)
})

test('宽度或跨度不合法就是 NaN，换档跟着不动', () => {
  assert.ok(Number.isNaN(pxPerBar(0, 0, HOUR, '1h')))
  assert.ok(Number.isNaN(pxPerBar(WIDE, HOUR, 0, '1h')))
  assert.equal(pickLevel('1h', pxPerBar(0, 0, HOUR, '1h'), LADDER, false), '1h')
})

test('当前档还在舒服区间里：跨度算完也不换', () => {
  const ladder = ladderFor('30m')
  const span = 183 * 30 * MIN
  assert.ok(pxPerBar(WIDE, 0, span, '30m') > TOO_DENSE_PX)
  assert.ok(pxPerBar(WIDE, 0, span, '30m') < TOO_SPARSE_PX)
  assert.equal(levelForSpan(WIDE, 0, span, ladder, '30m'), '30m')
})

test('缩了七下：一次跨到 4h，不是一档一档往下掉', () => {
  const ladder = ladderFor('30m')
  const span = 183 * 30 * MIN * 1.35 ** 7
  // 30m 已经细到看不清了。
  assert.ok(pxPerBar(WIDE, 0, span, '30m') < TOO_DENSE_PX)
  const next = levelForSpan(WIDE, 0, span, ladder, '30m')
  assert.equal(next, '4h')
  const px = pxPerBar(WIDE, 0, span, next)
  assert.ok(px >= TOO_DENSE_PX && px <= TOO_SPARSE_PX, `换完 ${px} px/根`)
})

test('Shift+Home 跳到上市那天：跨度不变，档位跟着不变（不再级联到 1m）', () => {
  const ladder = ladderFor('30m')
  const listing = Date.UTC(2019, 8, 1)
  // 缩了七下之后已经在 4h 上，Shift+Home 只是把同样的跨度搬到 2019 年。
  const span = 183 * 30 * MIN * 1.35 ** 7
  const next = levelForSpan(WIDE, listing, listing + span, ladder, '4h')
  assert.equal(next, '4h')
  assert.notEqual(next, '1m')
})

test('一眼看完整部历史：定到周线，一步到位', () => {
  const listing = Date.UTC(2019, 8, 1)
  const now = Date.UTC(2026, 8, 13)
  const next = levelForSpan(WIDE, listing, now, ladderFor('30m'), '4h')
  assert.equal(next, '1w')
  const px = pxPerBar(WIDE, listing, now, next)
  assert.ok(px >= TOO_DENSE_PX && px <= TOO_SPARSE_PX, `换完 ${px} px/根`)
})

test('同一个跨度：人手缩放一次只走一步，程序性跳转一次到位', () => {
  const ladder = ladderFor('30m')
  const span = 183 * 30 * MIN * 1.35 ** 7
  const px = pxPerBar(WIDE, 0, span, '30m')
  assert.equal(pickLevel('30m', px, ladder, false), '1h')
  assert.equal(levelForSpan(WIDE, 0, span, ladder, '30m'), '4h')
})

test('定档也认锁：锁了就停在当前档', () => {
  const ladder = ladderFor('30m')
  const listing = Date.UTC(2019, 8, 1)
  assert.equal(levelForSpan(WIDE, listing, Date.UTC(2026, 8, 13), ladder, '30m', true), '30m')
})

test('跨度反着给或者没宽度：定档也不动', () => {
  assert.equal(levelForSpan(WIDE, 100, 100, LADDER, '1h'), '1h')
  assert.equal(levelForSpan(0, 0, DAY, LADDER, '1h'), '1h')
  assert.equal(levelForSpan(WIDE, 0, DAY, [], '1h'), '1h')
})

test('跨度大到哪一档都嫌细：停在最粗的一档，不再往下钻', () => {
  const span = 400 * 365 * DAY
  assert.equal(levelForSpan(WIDE, 0, span, LADDER, '1h'), '1w')
})

test('程序性定档：舒服区间里有好几档时，挑离记录本档最近的那一档', () => {
  // 手机竖屏（360 px）看六天：1h 每根 2.5 px、4h 每根 10 px，两档都在区间里。
  const phone = 360
  const span = 144 * HOUR
  // 不告诉它记录是哪一档，就只按最舒服的密度挑，挑出来是 4h。
  assert.equal(levelForSpan(phone, 0, span, LADDER, '1d'), '4h')
  // 记录本身是 1h：这一档同样站得住，视觉上更接近他当时看的那张图。
  assert.equal(levelForSpan(phone, 0, span, LADDER, '1d', false, '1h'), '1h')
  // 记录本档更粗的时候，挑的也跟着往粗走。
  assert.equal(levelForSpan(phone, 0, span, LADDER, '1d', false, '1d'), '4h')
})

test('记录本档落不进舒服区间：退回按最舒服的密度挑', () => {
  // 两分钟的跨度上哪一档都太稀，这时候 base 不该把它拽到日线去。
  assert.equal(levelForSpan(1200, 0, 2 * 60_000, LADDER, '1h', false, '1d'), '1m')
})

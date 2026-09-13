// 全屏图上的两条规则：「记下判断」给谁看、按住 − / + 不放算几步。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOLD_MS, NARROW_PX, guarded, holdOk, jumpTo, refill, retire, selfMark, showsJudgment,
  type Stage,
} from '../src/features/relive/view-rules'
import { needsReassert, nowShowing, viewAim } from '../src/features/relive/chart-span'

test('记下判断只属于记录自己的那张截图，找相似的查询图不画', () => {
  // 详情页「看真实走势」这条路只传 attachmentId，不传指标种子——它照样要画。
  assert.equal(showsJudgment({ attachmentId: 'att-1' }), true)
  assert.equal(showsJudgment({ attachmentId: 'att-1', queryAttachmentId: 'q-9' }), true)
  // 找相似的查询图、校准用的图不是一次判断。
  assert.equal(showsJudgment({ queryAttachmentId: 'q-9' }), false)
  assert.equal(showsJudgment({}), false)
})

test('按住不放照样一步一步缩，只是最快 120 ms 一步', () => {
  assert.equal(HOLD_MS, 120)
  // 第一下不是 repeat，永远算数。
  assert.equal(holdOk(false, 1_000, 1_010), true)
  // 系统重复按键一秒三十次，太密的丢掉。
  assert.equal(holdOk(true, 1_000, 1_030), false)
  // 隔够了就走一步。
  assert.equal(holdOk(true, 1_000, 1_120), true)
  assert.equal(holdOk(true, 1_000, 1_500), true)
  // 还没按过：第一下 repeat 也算数。
  assert.equal(holdOk(true, Number.NEGATIVE_INFINITY, 1_000), true)
})

test('手机竖屏的界线是 480', () => {
  assert.equal(NARROW_PX, 480)
})

test('重画到一半又被叫一次：等这遍画完再补一遍，不套在里面', () => {
  const runs: string[] = []
  let again = 0
  const paint = guarded(() => {
    runs.push('start')
    // 图内部读一次可见范围就会同步回调过来，回调里可能又要重画。
    if (again > 0) { again -= 1; paint() }
    runs.push('end')
  })
  again = 1
  paint()
  // 没有嵌套：第一遍完整跑完，然后补跑一遍。
  assert.deepEqual(runs, ['start', 'end', 'start', 'end'])
  // 补的那一遍里再被叫，也只再补一次。
  runs.length = 0
  again = 3
  paint()
  assert.deepEqual(runs, ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'])
})

test('重铺副图：先把名单清空再一个个删，每条线只删一次', () => {
  // 假图：删第二次就像 lightweight-charts 那样炸。
  const live = new Set(['vol', 'ma', 'macd'])
  const chart = { removeSeries(id: string) { if (!live.delete(id)) throw new Error('Series not found') } }
  let extras = ['vol', 'ma', 'macd']
  const removed: string[] = []
  const old = retire(extras, (id) => {
    removed.push(id)
    // 删到一半，同步回调重入了一次重铺：它拿到的是已经空掉的名单。
    if (id === 'ma') { assert.deepEqual(extras, []); retire(extras, (x) => chart.removeSeries(x)) }
    chart.removeSeries(id)
  })
  assert.deepEqual(removed, ['vol', 'ma', 'macd'])
  assert.deepEqual(old, ['vol', 'ma', 'macd'])
  assert.deepEqual(extras, [])
  assert.equal(live.size, 0)
})

/**
 * 一张假的图，只留下真图里会咬人的那一条：滚动位置要被钳。
 *
 * lightweight-charts 落位时算 `rightOffset = 目标右端 − baseIndex()`，再钳进
 * `[minRightOffset, maxRightOffset]`；`baseIndex()` 是**所有 series 里最后一根
 * 真数据**的下标，整排都是留白时它是 0，`maxRightOffset = 宽 / 根宽 − 2`。本机
 * 取证量到的就是这两个边界（远跳落在格子左端、数据到了之后右端钉在最新一根）。
 */
function fakeChart(widthPx: number) {
  let points = 0
  let realLast: number | null = null
  let spacing = 6
  let span = 10
  let right = 0
  const base = (): number => realLast ?? 0
  const correct = (): void => {
    right = Math.min(right, widthPx / spacing - Math.min(2, points))
    right = Math.max(right, 0 - base() - 1 + Math.min(2, points))
  }
  return {
    /** 换一份数据：`last` 是最后一根真 bar 的下标，全留白就传 null。 */
    setData(count: number, last: number | null): void { points = count; realLast = last; correct() },
    setVisibleLogicalRange(from: number, to: number): void {
      span = to - from
      spacing = widthPx / span
      right = to - base()
      correct()
    },
    range(): { from: number; to: number } {
      return { from: right + base() - span, to: right + base() }
    },
  }
}

test('重画期间图打出来的范围变化算程序性，过了这一帧才算人手', () => {
  const frames: (() => void)[] = []
  const self = selfMark((run) => { frames.push(run) })
  const seen: boolean[] = []
  // setData 会同步 fire 一次范围变化：那一下必须算程序性。
  const paint = (): void => { seen.push(self.mine()) }
  assert.equal(self.mine(), false)
  self.as(() => {
    paint()
    // 同一帧里套一层（重铺格子里再重画一次）也要配得上。
    self.as(paint)
    paint()
  })
  // 同步那一发出去了，图自己下一帧还会补发一次，标记要留到那时候。
  assert.equal(self.mine(), true)
  frames.splice(0).forEach((run) => { run() })
  assert.deepEqual(seen, [true, true, true])
  assert.equal(self.mine(), false)
  // 这之后再来的范围变化就是人手在拖。
})

test('远跳：先把 bar 填进去再落位，不然图把视野钳到格子边上', () => {
  // 取证里的那一跳：1360 px 的画布、91.7 根的跨度、目标在格子中段。
  const width = 944
  const target = { from: 183.6, to: 275.3 }
  const order: string[] = []

  // 先按老顺序（铺格子、拿旧 bar 重画、再落位）跑一遍，看被钳成什么样。
  const bad = fakeChart(width)
  bad.setData(459, null)
  bad.setVisibleLogicalRange(target.from, target.to)
  assert.ok(bad.range().to < 100, `钳住了：${JSON.stringify(bad.range())}`)
  // 真 bar 后到，右端就钉在最后一根上。
  bad.setData(459, 275)
  assert.ok(bad.range().to > 270)

  // 现在这条路：fill → rebuild → applyTime。
  const good = fakeChart(width)
  const stage: Stage<number> = {
    fill: (next) => { order.push(`fill:${next.length}`); good.setData(459, 275) },
    rebuild: (from, to) => { order.push(`rebuild:${from}-${to}`); return true },
    repaint: () => { order.push('repaint') },
    applyTime: (from, to) => { order.push('applyTime'); good.setVisibleLogicalRange(from, to) },
  }
  jumpTo(stage, target.from, target.to, [1, 2, 3])
  // 顺序：数据先进去，格子再铺（铺格子自己会重画，所以不另外 repaint），最后落位。
  assert.deepEqual(order, ['fill:3', `rebuild:${target.from}-${target.to}`, 'applyTime'])
  const got = good.range()
  assert.ok(Math.abs(got.from - target.from) < 0.01 && Math.abs(got.to - target.to) < 0.01,
    `该落在目标上：${JSON.stringify(got)}`)

  // 格子没换（同一排）时，重画得自己补一次，不然新 bar 画不出来。
  const same: string[] = []
  jumpTo({
    fill: () => { same.push('fill') }, rebuild: () => { same.push('rebuild'); return false },
    repaint: () => { same.push('repaint') }, applyTime: () => { same.push('applyTime') },
  }, 0, 1, [1])
  assert.deepEqual(same, ['fill', 'rebuild', 'repaint', 'applyTime'])
  // 一根 bar 都没带的时候不重画、也不填。
  const none: string[] = []
  jumpTo({
    fill: () => { none.push('fill') }, rebuild: () => { none.push('rebuild'); return false },
    repaint: () => { none.push('repaint') }, applyTime: () => { none.push('applyTime') },
  }, 0, 1, null)
  assert.deepEqual(none, ['rebuild', 'applyTime'])
})

test('数据晚到一步：填进去重画，再按还没落到的目标补落一次位', () => {
  const width = 944
  const target = { from: 183.6, to: 275.3 }
  const chart = fakeChart(width)
  // 远跳那一下格子里全是留白，落位被钳到了左端。
  chart.setData(459, null)
  chart.setVisibleLogicalRange(target.from, target.to)
  assert.ok(chart.range().to < 100)

  const order: string[] = []
  const stage: Stage<number> = {
    fill: () => { order.push('fill'); chart.setData(459, 275) },
    rebuild: () => { order.push('rebuild'); return false },
    repaint: () => { order.push('repaint') },
    applyTime: (from, to) => { order.push('applyTime'); chart.setVisibleLogicalRange(from, to) },
  }
  refill(stage, [1, 2, 3], target)
  assert.deepEqual(order, ['fill', 'repaint', 'applyTime'])
  const got = chart.range()
  assert.ok(Math.abs(got.from - target.from) < 0.01 && Math.abs(got.to - target.to) < 0.01,
    `真数据到位之后要回到目标上：${JSON.stringify(got)}`)

  // 人自己动过手（目标已经作废）就只填数据，不碰视野。
  const quiet: string[] = []
  refill({
    fill: () => { quiet.push('fill') }, rebuild: () => false,
    repaint: () => { quiet.push('repaint') }, applyTime: () => { quiet.push('applyTime') },
  }, [1], null)
  assert.deepEqual(quiet, ['fill', 'repaint'])
})


/* ---- 冷缓存下第一次远跳：数据要等两三秒，中间「看的是哪儿」不能问图 ---- */

test('假 feed 先空后有：目标最后被落位，不会卡在上市之前那段空白里', () => {
  const HOUR = 3_600_000
  const LISTING = 1_568_000_000_000
  // 上市之前那一段：图的 rAF 把没有真 bar 的那一跳钳到了格子左端。
  const CLAMPED = { from: LISTING - 40 * HOUR, to: LISTING - 30 * HOUR }
  const TARGET = { from: LISTING, to: LISTING + 10 * HOUR }

  const order: string[] = []
  let shown: { from: number; to: number } | null = CLAMPED
  const aim = viewAim()
  const stage: Stage<number> = {
    fill: () => { order.push('fill') },
    rebuild: () => { order.push('rebuild'); return false },
    repaint: () => { order.push('repaint') },
    applyTime: (from, to) => { order.push(`applyTime:${from}`); shown = { from, to } },
  }
  // 「现在看的是哪一段」：目标没兑现就是目标，兑现了才认图。
  const visibleTime = (): { from: number; to: number } | null => nowShowing(aim.want(), shown, null)
  const reassert = (): void => {
    const back = aim.want()
    if (!back) return
    if (!needsReassert(back, shown, HOUR)) return
    stage.applyTime(back.from, back.to)
  }
  // feed：上市之前一根都没有，上市之后才有；而且第一次问的时候还没下载完。
  let arrived = false
  const windowAt = (span: { from: number; to: number } | null): number[] => {
    if (!span || !arrived) return []
    return span.to > LISTING ? [1, 2, 3] : []
  }
  // paintFeed 那一段：有 bar 就换数据顺带补落一次位，一根都没有就催图再落一次。
  const paintFeed = (): void => {
    const bars = windowAt(visibleTime())
    if (bars.length) refill(stage, bars, aim.want())
    else reassert()
  }

  // 远跳发出去：目标记下，图当场被钳到上市之前。
  aim.aim(TARGET)
  aim.settle(true, CLAMPED, HOUR)
  assert.deepEqual(aim.want(), TARGET)
  // 数据还在路上的那一发：window() 空，M7b 兜底把目标再落一次位。
  paintFeed()
  assert.deepEqual(order, [`applyTime:${TARGET.from}`])
  // 数据到了：这次问「看的是哪儿」答的仍是目标（图还没走到），于是取到了 bar。
  arrived = true
  order.length = 0
  paintFeed()
  assert.deepEqual(order, ['fill', 'repaint', `applyTime:${TARGET.from}`])
  assert.deepEqual(shown, TARGET)

  // 图真的走到了，目标作废；再画一遍不会又把人拉回去。
  aim.settle(true, TARGET, HOUR)
  assert.equal(aim.want(), null)
  order.length = 0
  paintFeed()
  assert.deepEqual(order, ['fill', 'repaint'])
  assert.deepEqual(visibleTime(), TARGET)
})

test('人手一拖，「看的是哪儿」立刻改口认图的真实范围', () => {
  const HOUR = 3_600_000
  const TARGET = { from: 1_568_000_000_000, to: 1_568_036_000_000 }
  const DRAGGED = { from: 1_569_000_000_000, to: 1_569_036_000_000 }
  const aim = viewAim()
  aim.aim(TARGET)
  // 还没兑现：认目标。
  assert.deepEqual(nowShowing(aim.want(), DRAGGED, null), TARGET)
  // 人自己拖了一下（非程序性的那一发范围变化）。
  aim.settle(false, DRAGGED, HOUR)
  assert.deepEqual(nowShowing(aim.want(), DRAGGED, null), DRAGGED)
  assert.equal(needsReassert(aim.want(), DRAGGED, HOUR), false)
})

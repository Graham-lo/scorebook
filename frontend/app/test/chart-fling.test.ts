// 手指甩一下，松手之后还得滑一段。
//
// 全屏态的平移是我们自己按指针位移算的，图库自带的 kinetic 惯性也就跟着没了。
// 这里补的是同一套东西的收尾：松手速度按 e 指数往下掉，滑行总距离 = 速度 × TAU，
// 所以甩得越快滑得越远，而且是线性的；滑行途中走的还是拖动那一道夹取，撞上
// 「上市前一屏」或者「现在」这两道墙就地停住，不回弹。放手（慢）不起惯性。

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FLING_MIN_PX_PER_MS, FLING_TAU_MS, flingAt, flingSpan, flingSpeed,
} from '../src/features/relive/chart-span'

const MIN = 60_000
const STEP = 30 * MIN
/** 一屏 = 200 根 30 分钟，屏宽 1250px。 */
const SCREEN = 200 * STEP
const WIDTH = 1250
const MS_PER_PX = SCREEN / WIDTH

const ONBOARD = Date.UTC(2019, 8, 8)
const NOW = Date.UTC(2026, 8, 13)
const WIDE_BOUNDS = { minFromMs: ONBOARD - SCREEN, maxToMs: NOW + STEP }

/** 把一次惯性从头跑到尾，每 16ms 一帧，记下每一帧滑过的像素。 */
function run(speed: number): { steps: number[]; total: number } {
  const steps: number[] = []
  let past = 0
  let total = 0
  for (let t = 16; t <= 4000; t += 16) {
    const step = flingAt(speed, t)
    steps.push(Math.abs(step.pastPx - past))
    past = step.pastPx
    total = step.pastPx
    if (step.done) break
  }
  return { steps, total }
}

test('甩一下：每一帧滑得比上一帧少，总距离和松手速度成正比', () => {
  const slow = run(0.6)
  const fast = run(1.2)
  // 一、越滑越慢，一帧都不许反弹回去。
  for (let i = 1; i < slow.steps.length; i += 1) {
    const now = slow.steps[i] as number
    const was = slow.steps[i - 1] as number
    assert.ok(now <= was + 1e-9, `第 ${i} 帧比上一帧滑得还多：${was} → ${now}`)
  }
  // 二、总距离 = 速度 × TAU，速度翻倍距离就翻倍。
  // （收手的时候还剩最后几个像素没滑完，所以是「几乎等于」。）
  const reach = 0.6 * FLING_TAU_MS
  assert.ok(slow.total <= reach && slow.total > reach * 0.95, `慢甩滑了 ${slow.total}，该接近 ${reach}`)
  assert.ok(Math.abs(fast.total / slow.total - 2) < 0.02, `快慢之比 ${fast.total / slow.total}`)
  // 三、滑停的时间和图库自带的 kinetic 一个量级：1~1.5 秒，不是一眨眼也不是没完。
  const ms = slow.steps.length * 16
  assert.ok(ms >= 800 && ms <= 1500, `滑了 ${ms}ms`)
})

test('甩一下：往两边甩得一样远，只是方向相反', () => {
  const right = flingAt(0.9, 400)
  const left = flingAt(-0.9, 400)
  assert.ok(right.pastPx > 0)
  assert.equal(Math.round(left.pastPx), -Math.round(right.pastPx))
})

test('惯性撞上上市前那一屏就地停住，再往后一帧都不动', () => {
  // 视野正贴着左墙，还要往过去甩。
  const start = { from: ONBOARD - SCREEN + 2 * STEP, to: ONBOARD + SCREEN - 2 * STEP }
  const hit = flingSpan(start, MS_PER_PX, 2.5, 300, WIDE_BOUNDS)
  assert.equal(hit.from, WIDE_BOUNDS.minFromMs, '撞墙那一帧应该正好停在墙上')
  assert.equal(hit.to - hit.from, start.to - start.from, '夹取只平移，不许改跨度')
  assert.equal(hit.done, true, '撞墙就该收手')
  // 再多给一倍时间，也还在墙上——不回弹、不抖。
  const later = flingSpan(start, MS_PER_PX, 2.5, 900, WIDE_BOUNDS)
  assert.equal(later.from, hit.from)
  assert.equal(later.to, hit.to)
})

test('惯性撞上「现在」那道右墙也一样停住', () => {
  const start = { from: NOW + STEP - SCREEN + 2 * STEP, to: NOW + STEP + 2 * STEP }
  const hit = flingSpan(start, MS_PER_PX, -2.5, 300, WIDE_BOUNDS)
  assert.equal(hit.to, WIDE_BOUNDS.maxToMs)
  assert.equal(hit.done, true)
})

test('惯性半路上不撞墙的时候，走的就是拖动那一套：位移换算成毫秒', () => {
  const start = { from: NOW - 10 * SCREEN, to: NOW - 9 * SCREEN }
  const step = flingAt(1, 200)
  const got = flingSpan(start, MS_PER_PX, 1, 200, WIDE_BOUNDS)
  assert.ok(Math.abs(got.from - (start.from - step.pastPx * MS_PER_PX)) < 1e-6)
  assert.equal(got.to - got.from, start.to - start.from)
})

test('慢慢放手不起惯性', () => {
  // 100ms 里只挪了 6px：0.06px/ms，不到门槛。
  const easy = flingSpeed([
    { x: 0, at: 0 }, { x: 2, at: 33 }, { x: 4, at: 66 }, { x: 6, at: 100 },
  ])
  assert.equal(easy, 0)
  assert.equal(flingAt(easy, 16).pastPx, 0)
  assert.equal(flingAt(easy, 16).done, true)
})

test('甩出去了才算速度，而且只看最后 100ms', () => {
  // 前面 500ms 慢慢挪，最后 100ms 甩出去 80px。
  const trail = [
    { x: 0, at: 0 }, { x: 10, at: 200 }, { x: 20, at: 400 }, { x: 24, at: 500 },
    { x: 50, at: 533 }, { x: 78, at: 566 }, { x: 104, at: 600 },
  ]
  const speed = flingSpeed(trail)
  assert.ok(speed > FLING_MIN_PX_PER_MS, `算出来 ${speed}`)
  assert.ok(Math.abs(speed - 0.8) < 0.05, `算出来 ${speed}`)
})

test('松手之前手停住了，就不是甩', () => {
  // 甩到一半按住不动 200ms 再松手：最后 100ms 一动没动。
  const trail = [
    { x: 0, at: 0 }, { x: 60, at: 100 }, { x: 120, at: 200 },
    { x: 121, at: 300 }, { x: 121, at: 400 },
  ]
  assert.equal(flingSpeed(trail), 0)
})

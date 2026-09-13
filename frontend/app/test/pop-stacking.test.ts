import test from 'node:test'
import assert from 'node:assert/strict'

import {
  POP_HOST,
  POP_HOST_STATIC,
  formsStackingContext,
  markPopHosts,
  needsLift,
  needsPosition,
  unmarkPopHosts,
  type HostLike,
  type StyleLike,
} from '../src/ui/stacking'

const plain: StyleLike = {
  transform: 'none', opacity: '1', filter: 'none', willChange: 'auto',
  isolation: 'auto', position: 'static', zIndex: 'auto',
}

function style(over: Partial<StyleLike>): StyleLike {
  return { ...plain, ...over }
}

interface Fake extends HostLike {
  name: string
  classes: Set<string>
  parentElement: Fake | null
  style: { zIndex: string }
}

function node(name: string, parent: Fake | null, zIndex = ''): Fake {
  const classes = new Set<string>()
  const self: Fake = {
    name,
    classes,
    parentElement: parent,
    style: { zIndex },
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
  }
  return self
}

test('带 transform、半透明、isolate 的祖先都会困住菜单的 z-index', () => {
  assert.equal(formsStackingContext(style({ transform: 'matrix(1,0,0,1,0,0)' })), true)
  assert.equal(formsStackingContext(style({ opacity: '0.98' })), true)
  assert.equal(formsStackingContext(style({ filter: 'blur(2px)' })), true)
  assert.equal(formsStackingContext(style({ isolation: 'isolate' })), true)
  assert.equal(formsStackingContext(style({ willChange: 'transform' })), true)
  assert.equal(formsStackingContext(style({ position: 'relative', zIndex: '3' })), true)
  assert.equal(formsStackingContext(plain), false)
  assert.equal(formsStackingContext(style({ position: 'relative' })), false, 'relative 但 z-index:auto 不开上下文')
})

test('已经站得比菜单高的祖先不动它，static 的才补 position', () => {
  assert.equal(needsLift(style({ zIndex: 'auto' })), true)
  assert.equal(needsLift(style({ zIndex: '3' })), true)
  assert.equal(needsLift(style({ zIndex: '90' })), false)
  assert.equal(needsPosition(style({ position: 'static' })), true)
  assert.equal(needsPosition(style({ position: 'fixed' })), false)
})

test('开菜单给沿途祖先打标，static 的补 position，关菜单全部摘掉', () => {
  const body = node('body', null)
  const page = node('page', body)
  const group = node('fgroup', page)
  const card = node('fcard', group)
  const wrap = node('popwrap', card)
  const styles = new Map<string, StyleLike>([
    ['fcard', style({ transform: 'matrix(1,0,0,1,0,0)' })],
    ['fgroup', style({ transform: 'matrix(1,0,0,1,0,0)', position: 'relative', zIndex: '2' })],
    ['page', style({ transform: 'matrix(1,0,0,1,0,0)', position: 'fixed', zIndex: '1' })],
    ['popwrap', style({ position: 'relative' })],
  ])
  const marks = markPopHosts(wrap, body, (n) => styles.get((n as Fake).name) ?? plain)

  assert.deepEqual(marks.map((m) => (m.node as Fake).name), ['fcard', 'fgroup', 'page'])
  assert.ok(card.classes.has(POP_HOST) && card.classes.has(POP_HOST_STATIC), 'static 的卡片要补 position:relative')
  assert.ok(group.classes.has(POP_HOST) && !group.classes.has(POP_HOST_STATIC), '本来就 relative 的不动 position')
  assert.ok(page.classes.has(POP_HOST) && !page.classes.has(POP_HOST_STATIC), 'fixed 的只抬 z-index')
  assert.equal(body.classes.size, 0, '遍历到 body 为止，body 自己不打标')
  assert.equal(wrap.classes.size, 0, 'popwrap 自己不用抬')

  unmarkPopHosts(marks)
  for (const n of [card, group, page]) assert.equal(n.classes.size, 0, `${n.name} 关菜单后要摘干净`)
})

test('全屏那种高特异度选择器压不住内联 z-index：开菜单写 60，关菜单原样还回去', () => {
  const body = node('body', null)
  // `.market-fullscreen .market-controls` 是 0,2,0，比 `.pop-host` 的 0,1,0 高，
  // 光加 class 抬不动它；内联 z-index 不比特异度，写上就赢。
  const controls = node('market-controls', body)
  const plain2 = node('market-plot', controls, '4')
  const wrap = node('popwrap', plain2)
  const styles = new Map<string, StyleLike>([
    ['market-controls', style({ position: 'absolute', zIndex: '3' })],
    ['market-plot', style({ position: 'relative', zIndex: '4' })],
  ])
  const marks = markPopHosts(wrap, body, (n) => styles.get((n as Fake).name) ?? plain)

  assert.deepEqual(marks.map((m) => (m.node as Fake).name), ['market-plot', 'market-controls'])
  assert.equal(plain2.style.zIndex, '60')
  assert.equal(controls.style.zIndex, '60')

  unmarkPopHosts(marks)
  assert.equal(plain2.style.zIndex, '4', '本来有内联 z-index 的还回原值')
  assert.equal(controls.style.zIndex, '', '本来没有内联 z-index 的要清空')
})

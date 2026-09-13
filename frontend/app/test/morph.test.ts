// 就地对齐那一层的算术：同一件东西留着原来那个节点，只改变了的那几个字。
//
// 找相似那一页每两秒读一次进度。这里手搓一个最小的 DOM（Node 里跑测试，没有
// 浏览器），照结果卡片的样子喂两版数据，看节点身份还在不在。

import assert from 'node:assert/strict'
import test from 'node:test'
import { morph } from '../src/ui/morph'

/* ------------------------------------------------ 手搓的一点点 DOM */

class Fake {
  nodeType: number
  tagName: string
  nodeValue: string | null
  childNodes: Fake[] = []
  parentNode: Fake | null = null
  private attrs = new Map<string, string>()

  constructor(nodeType: number, tagName = '', nodeValue: string | null = null) {
    this.nodeType = nodeType
    this.tagName = tagName
    this.nodeValue = nodeValue
  }

  get attributes(): { length: number; item(i: number): { name: string; value: string } | null } {
    const list = [...this.attrs].map(([name, value]) => ({ name, value }))
    return { length: list.length, item: (i: number) => list[i] ?? null }
  }

  getAttribute(name: string): string | null { return this.attrs.has(name) ? this.attrs.get(name)! : null }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value) }
  removeAttribute(name: string): void { this.attrs.delete(name) }

  get firstChild(): Fake | null { return this.childNodes[0] ?? null }

  get nextSibling(): Fake | null {
    const kin = this.parentNode?.childNodes
    if (!kin) return null
    return kin[kin.indexOf(this) + 1] ?? null
  }

  insertBefore(node: Fake, before: Fake | null): Fake {
    node.parentNode?.detach(node)
    const at = before ? this.childNodes.indexOf(before) : -1
    if (at < 0) this.childNodes.push(node)
    else this.childNodes.splice(at, 0, node)
    node.parentNode = this
    return node
  }

  removeChild(node: Fake): Fake { this.detach(node); return node }

  private detach(node: Fake): void {
    const at = this.childNodes.indexOf(node)
    if (at >= 0) this.childNodes.splice(at, 1)
    node.parentNode = null
  }

  append(...kids: Fake[]): void { for (const kid of kids) this.insertBefore(kid, null) }

  isSameNode(other: unknown): boolean { return other === this }

  /** 这棵树上所有文字连起来，用来断言「字变了」。 */
  get text(): string {
    if (this.nodeType === 3) return this.nodeValue ?? ''
    return this.childNodes.map((kid) => kid.text).join('')
  }

  find(key: string): Fake | null {
    if (this.getAttribute('data-key') === key) return this
    for (const kid of this.childNodes) {
      const got = kid.find(key)
      if (got) return got
    }
    return null
  }
}

function el(tag: string, attrs: Record<string, string> = {}, ...kids: Fake[]): Fake {
  const node = new Fake(1, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  node.append(...kids)
  return node
}

function text(value: string): Fake { return new Fake(3, '', value) }

const as = (node: Fake): Element => node as unknown as Element

/* ------------------------------------------------------ 一条结果长什么样 */

interface Hit { key: string; line: string; word: string }

function card(hit: Hit): Fake {
  return el('DIV', { 'data-key': hit.key, class: 'fhit' },
    el('DIV', { class: 'fb' }, el('DIV', { class: 'fm' }, text(hit.line))),
    el('SPAN', { class: 'fband' }, text(hit.word)))
}

function list(hits: Hit[]): Fake {
  return el('DIV', { class: 'fhits' }, ...hits.map(card))
}

const first: Hit[] = [
  { key: 'h:BTCUSDT|15m|2024-01-01', line: '15m · 01-01 – 01-05', word: '有点像' },
  { key: 'h:ETHUSDT|15m|2024-02-01', line: '15m · 02-01 – 02-05', word: '像' },
  { key: 'p:call-1|shot-1', line: '我的记录', word: '很像' },
]

/* ------------------------------------------------------------------ 测 */

test('同一批结果第二次回来分数变了：还是那几个节点，只有字变了', () => {
  const live = list(first)
  const kept = first.map((hit) => live.find(hit.key)!)

  const again: Hit[] = [
    { ...first[0]!, word: '像' },
    { ...first[1]!, word: '很像' },
    { ...first[2]!, word: '很像' },
  ]
  morph(as(live), as(list(again)))

  again.forEach((hit, i) => {
    const now = live.find(hit.key)!
    assert.ok(now.isSameNode(kept[i]), `${hit.key} 应该还是原来那个节点`)
    assert.equal(now.find(hit.key)!.childNodes[1]!.text, hit.word, '像不像那个词要跟上')
  })
  assert.equal(live.childNodes.length, 3)
})

test('少了一条：走的是那一条，剩下的身份不动', () => {
  const live = list(first)
  const stay = [live.find(first[0]!.key)!, live.find(first[2]!.key)!]

  morph(as(live), as(list([first[0]!, first[2]!])))

  assert.equal(live.childNodes.length, 2)
  assert.equal(live.find(first[1]!.key), null, '那一条应该没了')
  assert.ok(live.childNodes[0]!.isSameNode(stay[0]))
  assert.ok(live.childNodes[1]!.isSameNode(stay[1]))
})

test('多了一条插在中间：新的那个进来，老的两个一个都没重建', () => {
  const live = list([first[0]!, first[2]!])
  const stay = [live.childNodes[0]!, live.childNodes[2 - 1]!]

  morph(as(live), as(list(first)))

  assert.equal(live.childNodes.length, 3)
  assert.ok(live.childNodes[0]!.isSameNode(stay[0]))
  assert.equal(live.childNodes[1]!.getAttribute('data-key'), first[1]!.key)
  assert.ok(live.childNodes[2]!.isSameNode(stay[1]))
})

test('顺序换了：节点跟着搬位置，不是重做一个', () => {
  const live = list(first)
  const kept = first.map((hit) => live.find(hit.key)!)

  morph(as(live), as(list([first[2]!, first[0]!, first[1]!])))

  assert.ok(live.childNodes[0]!.isSameNode(kept[2]))
  assert.ok(live.childNodes[1]!.isSameNode(kept[0]))
  assert.ok(live.childNodes[2]!.isSameNode(kept[1]))
})

test('写着「别碰」的占位符：活的那一块连进都不进去', () => {
  const live = el('DIV', {},
    el('DIV', { 'data-key': 'hits:mine', class: 'fhits' }, el('DIV', { 'data-key': 'a' }, text('我自己改好了'))))
  const inside = live.find('a')!

  morph(as(live), as(el('DIV', {},
    el('DIV', { 'data-key': 'hits:mine', 'data-same': '', class: 'fhits' }))))

  assert.ok(live.find('a')!.isSameNode(inside), '里面那一层不许被清掉')
  assert.equal(live.find('a')!.text, '我自己改好了')
})

test('进场加的那个类名不被抹掉，错峰用的 style 也留着', () => {
  const live = el('DIV', {}, el('SECTION', { 'data-key': 'grp:mine', class: 'sheet fgroup in', style: '--i:2' }))
  morph(as(live), as(el('DIV', {}, el('SECTION', { 'data-key': 'grp:mine', class: 'sheet fgroup' }))))
  const block = live.find('grp:mine')!
  assert.ok((block.getAttribute('class') ?? '').split(' ').includes('in'), '已经进过场就别再进一次')
  assert.equal(block.getAttribute('style'), '--i:2')
})

test('整组没了：该清的还是清干净', () => {
  const live = list(first)
  morph(as(live), as(list([])))
  assert.equal(live.childNodes.length, 0)
})

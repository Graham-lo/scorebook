import assert from 'node:assert/strict'
import test from 'node:test'
import { parse, redirectFor } from '../src/router'

/**
 * 旧地址一律搬到新地址。链接还在收藏夹和聊天记录里，这张表就是它们的去处。
 */
const TABLE: [string, string | null][] = [
  ['#/episode', '#/find?by=symbol'],
  ['#/episode/abc', '#/find?by=symbol'],
  ['#/trades', '#/find?by=fills'],
  ['#/cycle', '#/find?by=fills'],
  ['#/recall', '#/search'],
  ['#/recall?q=%E6%94%B6%E6%95%9B', '#/search?q=%E6%94%B6%E6%95%9B'],
  ['#/history', '#/settings'],
  ['#/chat', '#/search'],
  ['#/playbook', '#/archive'],
  ['#/playbook/9f1', '#/archive/9f1'],
]

test('旧地址按这张表搬家', () => {
  for (const [from, to] of TABLE) {
    assert.equal(redirectFor(from), to, `${from} 该搬到 ${to}`)
  }
})

test('一轮持仓的详情还在自己的地址上，只有列表那一层搬走了', () => {
  assert.equal(redirectFor('#/cycle/7c2'), null)
})

test('新地址一个都不搬', () => {
  for (const here of [
    '#/',
    '#/home',
    '#/find',
    '#/find?by=fills&tab=positions',
    '#/find/tag/%E6%94%B6%E6%95%9B',
    '#/new',
    '#/call/8a44df29',
    '#/relive/8a44df29/1',
    '#/review',
    '#/archive',
    '#/archive/3b1',
    '#/stats',
    '#/search',
    '#/search/like/086262f5',
    '#/settings',
  ]) {
    assert.equal(redirectFor(here), null, `${here} 不该被搬走`)
  }
})

test('搬家只看页那一段，参数原样留给新页去读', () => {
  const { page, arg, query } = parse('#/find?by=fills&tab=positions')
  assert.equal(page, 'find')
  assert.equal(arg, '')
  assert.equal(query.get('by'), 'fills')
  assert.equal(query.get('tab'), 'positions')
})

test('空 hash 就是今天那一页', () => {
  assert.equal(parse('').page, 'home')
  assert.equal(parse('#/').page, 'home')
})

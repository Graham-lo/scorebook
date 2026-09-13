// 旧页签遇到 404 的分片：刷一次就好，一分钟之内不许刷第二次。

import assert from 'node:assert/strict'
import test from 'node:test'
import { isChunkError, recoverChunk, type ChunkEnv } from '../src/ui/chunks'

/** 把 sessionStorage 和 location.reload 换成两个计数器。 */
function env(start = 1_000_000): ChunkEnv & { reloads: number; clock: number } {
  const store = new Map<string, string>()
  const fake = {
    reloads: 0,
    clock: start,
    now: () => fake.clock,
    read: (key: string) => store.get(key) ?? null,
    write: (key: string, value: string) => {
      store.set(key, value)
    },
    reload: () => {
      fake.reloads += 1
    },
  }
  return fake
}

const chunk404 = new Error('Failed to fetch dynamically imported module: /assets/trading-chart-abc.js')

test('认出「旧页签拿不到新文件」这几种说法', () => {
  assert.equal(isChunkError(chunk404), true)
  assert.equal(isChunkError(new Error('Importing a module script failed')), true)
  assert.equal(isChunkError(new Error('error loading dynamically imported module')), true)
  // 浏览器之间措辞不一样，动态 import 失败统一是 TypeError。
  assert.equal(isChunkError(new TypeError('Load failed')), true)
  assert.equal(isChunkError(new Error('行情读取失败')), false)
  assert.equal(isChunkError(null), false)
})

test('60 秒内只刷一次，过了这一分钟才允许再刷', () => {
  const fake = env()
  assert.equal(recoverChunk(chunk404, fake), true)
  assert.equal(fake.reloads, 1)

  // 同一分钟里再撞上：不刷了，交给调用方摆「页面已更新，刷新一下再看」。
  fake.clock += 5_000
  assert.equal(recoverChunk(chunk404, fake), false)
  assert.equal(fake.reloads, 1)

  fake.clock += 55_000 // 一共 60 秒整，还在窗口里
  assert.equal(recoverChunk(chunk404, fake), false)
  assert.equal(fake.reloads, 1)

  fake.clock += 1 // 过了一分钟
  assert.equal(recoverChunk(chunk404, fake), true)
  assert.equal(fake.reloads, 2)
})

test('不是分片错就不碰页面', () => {
  const fake = env()
  assert.equal(recoverChunk(new Error('行情读取失败'), fake), false)
  assert.equal(fake.reloads, 0)
})

test('写不进 sessionStorage 的时候最多多刷一次，不会卡死', () => {
  const fake = env()
  const deaf: ChunkEnv = { ...fake, write: () => {}, read: () => null, reload: fake.reload }
  assert.equal(recoverChunk(chunk404, deaf), true)
  assert.equal(fake.reloads, 1)
})

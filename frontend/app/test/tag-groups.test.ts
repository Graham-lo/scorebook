import assert from 'node:assert/strict'
import test from 'node:test'
import type { TagRecord } from '../src/api/types'
import { inTagGroup, latestTags } from '../src/data/tag-groups'
const tag = (id: string, name: string, version: number) => ({ id, name, version, definition: `定义${version}`, aliases: [], created_at: '2026-09-12T00:00:00Z' } as TagRecord)
test('修改分类定义后只有一个当前分类，旧记录仍归同类', () => {
  const old = tag('old', '突破失败', 1)
  const current = tag('new', '突破失败', 2)
  const another = tag('other', '回踩', 1)
  assert.deepEqual(latestTags([current, another, old]), [current, another])
  assert.equal(inTagGroup([old], current), true)
  assert.equal(inTagGroup([another], current), false)
})

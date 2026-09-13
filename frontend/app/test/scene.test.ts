// 换现场图：什么时候多出东西来，什么时候一个新元素都不多。
//
// 后端这一版（PUT /v1/calls/{id}/scene、scene_in_effect、superseded_scenes、
// scene_replaced_after_submission）此刻还没上线。所以这一组里分量最重的是第一
// 条：新字段整片缺失时，页面必须跟今天逐字一样——不抛异常、不多节点、不会出现
// 「换下来的图（0 张）」。features/call/index.ts 里那几处渲染是一条 SceneBlock
// 一个节点摆的，末尾那条源码守卫盯着这一点，省得以后有人把闸门拆了。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Attachment, AttachmentKind, SupersededScene } from '../src/api/types'
import {
  SCENE_REPLACED_NOTE,
  canReplaceScene,
  inMainViewer,
  replacedNote,
  sceneBlocks,
  supersededBlock,
  supersededScenes,
  type SceneFacts,
} from '../src/features/call/scene'

function shot(id: string, kind: AttachmentKind, extra: Partial<Attachment> = {}): Attachment {
  return {
    id,
    sha256: id.padEnd(64, '0'),
    mime: 'image/png',
    size: 120_000,
    width: 1320,
    height: 2868,
    uploaded_at: '2026-03-01T02:00:00Z',
    captured_at: null,
    kind,
    ...extra,
  }
}

function dropped(id: string, extra: Partial<SupersededScene> = {}): SupersededScene {
  return {
    attachment_id: id,
    sha256: id.padEnd(64, '0'),
    uploaded_at: '2026-03-01T02:00:00Z',
    attached_at: '2026-03-01T02:00:00Z',
    superseded_at: '2026-03-02T09:00:00Z',
    superseded_by: 'new-one',
    ...extra,
  }
}

/** 旧后端回来的样子：三个新字段一个都没有，附件上也没有那三列。 */
const OLD_BACKEND: SceneFacts = {
  voided: false,
  attachments: [shot('a', 'scene'), shot('b', 'reference'), shot('c', 'supplement')],
}

/* ------------------------------------------------ 一、后端还是旧版 */

test('新字段整片缺失：一个新元素都不多，而且不抛异常', () => {
  assert.deepEqual(sceneBlocks(OLD_BACKEND), [])
  assert.equal(replacedNote(OLD_BACKEND), null)
  assert.equal(supersededBlock(OLD_BACKEND), null)
  assert.deepEqual(supersededScenes(OLD_BACKEND), [])
})

test('新字段整片缺失：主看图区一张图都不筛掉，顺序原样', () => {
  const kept = OLD_BACKEND.attachments.filter(inMainViewer)
  assert.deepEqual(kept.map((a) => a.id), ['a', 'b', 'c'])
})

test('新字段整片缺失：「换一张现场图」照常出现，不必探测后端', () => {
  assert.equal(canReplaceScene(OLD_BACKEND), true)
})

test('字段回来的是脏的：null、不是数组、条目缺 id，一律当作没有', () => {
  const dirty = {
    voided: false,
    attachments: [shot('a', 'scene')],
    scene_replaced_after_submission: undefined,
    superseded_scenes: null,
  } as unknown as SceneFacts
  assert.deepEqual(sceneBlocks(dirty), [])

  const half = {
    voided: false,
    attachments: [shot('a', 'scene')],
    superseded_scenes: [dropped('x'), { attachment_id: '' }, null],
  } as unknown as SceneFacts
  const block = supersededBlock(half)
  assert.equal(block?.items.length, 1)
  assert.equal(block?.label, '换下来的图（1 张）')
})

/* ------------------------------------------------ 二、换下来的那几张 */

test('superseded_scenes 有内容：折叠段出现，条数对得上', () => {
  const d: SceneFacts = {
    ...OLD_BACKEND,
    superseded_scenes: [dropped('x'), dropped('y')],
  }
  const block = supersededBlock(d)
  assert.equal(block?.label, '换下来的图（2 张）')
  assert.equal(block?.items.length, 2)
  assert.deepEqual(block?.items.map((i) => i.attachment_id), ['x', 'y'])
  // 常驻说明和折叠段是两回事：这一条没换成事后图，就只有折叠段。
  assert.deepEqual(sceneBlocks(d).map((b) => b.kind), ['superseded'])
})

test('换下来的那张不在主看图区里并排，留在折叠段里', () => {
  const shots = [
    shot('old', 'scene', { attached_at: '2026-03-01T02:00:00Z', superseded_at: '2026-03-02T09:00:00Z', superseded_by: 'new' }),
    shot('new', 'scene', { uploaded_at: '2026-03-02T09:00:00Z', attached_at: '2026-03-02T09:00:00Z', superseded_at: null }),
    shot('ref', 'reference', { superseded_at: null }),
  ]
  assert.deepEqual(shots.filter(inMainViewer).map((a) => a.id), ['new', 'ref'])
})

test('作废的记录不给换，哪怕图都还在', () => {
  assert.equal(canReplaceScene({ ...OLD_BACKEND, voided: true }), false)
})

test('一张现场图都没有的记录不从这里补第一张', () => {
  assert.equal(
    canReplaceScene({ voided: false, attachments: [shot('b', 'reference')] }),
    false,
  )
})

/* ------------------------------------------------ 三、事后换图的常驻说明 */

test('scene_replaced_after_submission 为 true：那句常驻说明出现', () => {
  const d: SceneFacts = { ...OLD_BACKEND, scene_replaced_after_submission: true }
  assert.equal(replacedNote(d), SCENE_REPLACED_NOTE)
  assert.deepEqual(sceneBlocks(d).map((b) => b.kind), ['replaced-note'])
  // 一个词，不是一段说明：展示页上只放事实。
  assert.equal(SCENE_REPLACED_NOTE, '事后换的图')
})

test('为 false / 缺失：那句话一个字都不出现', () => {
  assert.equal(replacedNote({ ...OLD_BACKEND, scene_replaced_after_submission: false }), null)
  assert.equal(replacedNote(OLD_BACKEND), null)
})

test('两样都有：说明在前，折叠段在后', () => {
  const d: SceneFacts = {
    ...OLD_BACKEND,
    scene_replaced_after_submission: true,
    superseded_scenes: [dropped('x')],
  }
  assert.deepEqual(sceneBlocks(d).map((b) => b.kind), ['replaced-note', 'superseded'])
})

/* ------------------------------------------------ 四、闸门本身的守卫 */

// 上面几条证的是「算出来是空的」。真正要保的是「算出来是空的 → 页面上一个节点
// 都不多」，而那一步在 DOM 代码里。这一页没法在 node 里渲染（仓库里没有 DOM），
// 所以这里盯着那两行闸门本身：谁把它拆了，这条就红。
test('渲染处只经由这两句加节点，闸门不许被拆', () => {
  const call = readFileSync(
    fileURLToPath(new URL('../src/features/call/index.ts', import.meta.url)),
    'utf8',
  )
  // 那个词：replacedNote 给 null 就一个字都不摆。
  assert.match(call, /const said = replacedNote\(d\)\n\s*const old = supersededBlock\(d\)\n\s*if \(!said && !old\) return strip/)
  // 两样都没有就连外面那层都不加。
  assert.match(call, /said \? h\('div\.faint\.sceneflag', \{ text: said \}\) : null/)
  assert.match(call, /old \? sceneHistory\(d, old\) : null/)
  // 折叠段的标题只能来自 sceneBlocks 算好的那一份，不许在这儿现拼数量。
  assert.ok(
    !/换下来的图（\$\{/.test(call),
    '带数量的标题只该在 scene.ts 里拼一次，不许在渲染处现拼',
  )

  // 重温是展示页：换没换过图是详情页上那一行 chip 的事，这一页一个字都不说
  // （redesign §8.6：展示页上的解释段一律删）。
  const relive = readFileSync(
    fileURLToPath(new URL('../src/features/relive/index.ts', import.meta.url)),
    'utf8',
  )
  assert.ok(
    !/scene_replaced_after_submission/.test(relive),
    '重温页不再解释这张图是什么时候换的',
  )
})

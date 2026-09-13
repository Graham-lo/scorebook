import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeCapture, type StoredCapture } from '../src/features/capture/draft-storage'
import { build, emptyCriteriaDraft, problems } from '../src/features/capture/criteria'

function saved(): StoredCapture {
  return {
    text: '等回踩再做多', instrument: null, timeframe: '15m', stance: 'L',
    path: 'chart_first', confidence: '75', claimedAt: '2026-09-12T10:30', tags: [],
    crit: { ...emptyCriteriaDraft(), template: 'T2', direction: 'L', invalidation: '61000' },
    attachmentIds: ['shot-a', 'shot-b'], pendingImages: 1,
    pendingSave: { signature: '{"original_text":"等回踩再做多"}', key: 'same-write-after-refresh' },
  }
}

test('刷新恢复已填标准、已上传图片和未确认写入的幂等身份', () => {
  const before = saved()
  const restored = decodeCapture(JSON.stringify(before))
  assert.deepEqual(restored, before)
  assert.equal(restored?.pendingImages, 1, '未传完的图需要重新添加，不能默默消失')
  assert.deepEqual(build(restored!.crit), build(before.crit))
})

test('损坏或旧版本草稿不会阻止打开记录页', () => {
  for (const raw of [null, '', '{broken', 'null', '[]', '{"text":42}']) assert.equal(decodeCapture(raw), null)
  const restored = decodeCapture(JSON.stringify({ text: '保留这句话', crit: { template: 'future', direction: {} }, attachmentIds: ['shot-a', 42], pendingImages: -1 }))
  assert.equal(restored?.text, '保留这句话')
  assert.equal(restored?.crit.template, 'T0')
  assert.equal(restored?.crit.direction, null)
  assert.equal(restored?.path, 'unknown')
  assert.deepEqual(restored?.attachmentIds, ['shot-a'])
  assert.equal(restored?.pendingImages, 0)
})

test('切换标准后，隐藏字段不再阻塞当前标准', () => {
  const crit = { ...emptyCriteriaDraft(), template: 'T2' as const, direction: 'L' as const, thresholdKind: 'percent' as const, thresholdPercent: '', invalidation: '不合法' }
  assert.ok(problems(crit).length > 0)
  const boundary = { ...crit, template: 'T4' as const, boundary: '60000' }
  assert.deepEqual(problems(boundary), [])
  assert.equal(build(boundary)?.boundary, '60000')
  assert.equal(build({ ...boundary, thresholdPercent: '2' })?.threshold_ratio, undefined, '隐藏的阈值也不写入另一种标准')
  const amplitude = { ...crit, template: 'T5' as const, thresholdKind: 'atr' as const, atrMultiple: '' }
  assert.deepEqual(problems(amplitude), [], 'T5 留空按后端默认振幅')
  assert.equal(build(amplitude)?.atr_multiple, undefined)
  assert.ok(problems({ ...amplitude, atrMultiple: '0' }).length > 0)
  assert.equal(build({ ...amplitude, atrMultiple: '1.5' })?.atr_multiple, '1.5')
})

test('必填失效价从缺失到有效再清空，校验实时反映状态', () => {
  const crit = { ...emptyCriteriaDraft(), template: 'T2' as const, direction: 'L' as const }
  assert.ok(problems(crit).includes('要写失效价'))
  crit.invalidation = '61000'
  assert.deepEqual(problems(crit), [])
  crit.invalidation = ''
  assert.ok(problems(crit).includes('要写失效价'))
})

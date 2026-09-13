import assert from 'node:assert/strict'
import test from 'node:test'
import { ImageUploads } from '../src/data/image-uploads'
import type { Attachment } from '../src/api/types'

const file = (name: string) => new File([name], name, { type: 'image/png', lastModified: 1 })
const attachment = (id: string) => ({ id } as Attachment)

test('single then batch selection appends in selection order despite out-of-order completion', async () => {
  const pending = new Map<string, (a: Attachment) => void>()
  const model = new ImageUploads('scene', 20, file => new Promise(resolve => pending.set((file as File).name, resolve)))
  model.add([file('one.png')])
  model.add([file('two.png'), file('three.png')])
  assert.equal(model.items.length, 3)
  await new Promise(resolve => setTimeout(resolve, 0))
  pending.get('three.png')!(attachment('three')); pending.get('one.png')!(attachment('one'))
  await Promise.resolve()
  assert.equal(model.pending, true)
  pending.get('two.png')!(attachment('two')); await model.wait()
  assert.deepEqual(model.ids, ['one', 'two', 'three'])
  assert.equal(model.pending, false)
  model.clear()
})

test('removed in-flight image cannot reappear and remaining failed image retries with same identity', async () => {
  let late: (a: Attachment) => void = () => {}
  const keys: string[] = []
  let attempt = 0
  const model = new ImageUploads('supplement', 20, (_file, _kind, key) => {
    keys.push(key)
    if (++attempt === 1) return new Promise(resolve => { late = resolve })
    if (attempt === 2) return Promise.reject(new Error('offline'))
    return Promise.resolve(attachment('retained'))
  })
  model.add([file('removed.png'), file('retry.png')])
  await new Promise(resolve => setTimeout(resolve, 0))
  model.remove(model.items[0]!)
  late(attachment('removed')); await model.wait()
  assert.deepEqual(model.ids, [])
  assert.equal(model.pending, true)
  await model.send(model.items[0]!)
  assert.equal(keys[1], keys[2])
  assert.deepEqual(model.ids, ['retained'])
  model.restore(['saved-one', 'saved-two'])
  model.add([file('next.png')]); await model.wait()
  assert.deepEqual(model.ids, ['saved-one', 'saved-two', 'retained'])
  model.clear()
})

test('selection above capacity or containing a non-image leaves existing choices untouched', async () => {
  const model = new ImageUploads('scene', 2, async () => attachment('one'))
  model.add([file('one.png')]); await model.wait()
  assert.throws(() => model.add([file('two.png'), file('three.png')]), /最多/)
  assert.throws(() => model.add([new File(['bad'], 'bad.txt', { type: 'text/plain' })]), /请选择/)
  assert.deepEqual(model.ids, ['one'])
  model.clear()
})


test('same bytes under renamed files upload once; different bytes and restored IDs remain safe', async () => {
  let sent = 0
  const model = new ImageUploads('scene', 20, async () => attachment(`id-${++sent}`))
  const same = (name: string) => new File(['same screenshot bytes'], name, { type: 'image/png' })
  model.add([same('one.png'), same('renamed.png'), file('different.png')])
  await model.wait()
  assert.equal(sent, 2)
  assert.equal(model.items.length, 2)
  assert.equal(model.duplicates, 1)
  assert.deepEqual(model.ids, ['id-1', 'id-2'])
  model.add([same('again.png')]); await model.wait()
  assert.equal(sent, 2)
  assert.equal(model.duplicates, 2)
  model.restore(['saved', 'saved'])
  assert.deepEqual(model.ids, ['saved'])
  model.clear()
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowOf, type FlowInput } from '../src/data/flow'
const base: FlowInput = { id: 'case', hasCriteria: true, answer: 'ready', dueAt: null, hasDraft: false, draftSavedAt: null, hasReview: true, reviewedAt: null, outcomeChangedSinceReview: false, distilled: false, snoozedUntil: null }
test('a new draft remains actionable after a prior published review', () => {
  assert.equal(flowOf({ ...base, hasDraft: true }).next.kind, 'continue')
  assert.equal(flowOf(base).next.kind, 'distill')
})
test('changed outcome is checked before continuing a draft', () => {
  assert.equal(flowOf({ ...base, hasDraft: true, outcomeChangedSinceReview: true }).next.kind, 'recheck')
})

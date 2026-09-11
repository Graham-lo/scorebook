import assert from 'node:assert/strict'
import test from 'node:test'
import { finishSubmission, onSubmissionSettled, rememberRun, state } from '../src/features/search/state'

test('a late start response is handed to the remounted page without a second POST', () => {
  let oldPage = 0
  const resumed: (string | null)[] = []
  const leave = onSubmissionSettled(() => { oldPage++ })
  state.submitting = true
  leave()
  const leaveNew = onSubmissionSettled(() => resumed.push(state.runId))
  try {
    rememberRun('50773d78-84a7-43ef-8240-cec3b9f03383')
    finishSubmission()
    assert.equal(oldPage, 0)
    assert.deepEqual(resumed, ['50773d78-84a7-43ef-8240-cec3b9f03383'])
    assert.equal(state.submitting, false)
  } finally { leaveNew(); state.runId = null }
})

import test from 'node:test'
import assert from 'node:assert/strict'

// Pure helpers shared by the client bundle.
// Kept in lib/client.js as exported functions so they can be unit tested
// without a browser; they are also used by the browser apply().
import { diffSummaries, toolResultSeqs } from '../lib/client.js'

test('diffSummaries emits pending interaction on absent -> present', () => {
  const prev = {
    byId: {
      a: { id: 'a', displayTitle: 'A' },
    },
  }
  const next = {
    byId: {
      a: { id: 'a', displayTitle: 'A', pendingInteraction: 'question' },
    },
  }
  const events = []
  diffSummaries(prev, next, (event) => events.push(event))
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'question')
  assert.equal(events[0].sessionId, 'a')
})

test('diffSummaries does not emit for unchanged pending', () => {
  const prev = {
    byId: {
      a: { id: 'a', displayTitle: 'A', pendingInteraction: 'question' },
    },
  }
  const next = { ...prev }
  const events = []
  diffSummaries(prev, next, (event) => events.push(event))
  assert.equal(events.length, 0)
})

test('diffSummaries emits completed on false -> true', () => {
  const prev = { byId: { a: { id: 'a', displayTitle: 'A' } } }
  const next = { byId: { a: { id: 'a', displayTitle: 'A', completed: true } } }
  const events = []
  diffSummaries(prev, next, (event) => events.push(event))
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'completed')
})

test('diffSummaries does not emit completed when already completed', () => {
  const prev = { byId: { a: { id: 'a', displayTitle: 'A', completed: true } } }
  const next = { ...prev }
  const events = []
  diffSummaries(prev, next, (event) => events.push(event))
  assert.equal(events.length, 0)
})

test('toolResultSeqs extracts seqs from tool-result nodes', () => {
  const nodes = [
    { kind: 'user', seq: 1 },
    { kind: 'assistant', seq: 2 },
    { kind: 'tool-result', seq: 3 },
    { kind: 'tool-result', seq: 4 },
  ]
  assert.deepEqual(toolResultSeqs({ nodes }), [3, 4])
})

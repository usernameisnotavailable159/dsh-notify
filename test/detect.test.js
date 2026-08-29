import test from 'node:test'
import assert from 'node:assert/strict'

// Pure helpers shared by the client bundle.
// Kept in lib/client.js as exported functions so they can be unit tested
// without a browser; they are also used by the browser apply().
import { diffSummaries, shouldDiffList } from '../lib/client.js'

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
  assert.equal(events[0].kind, 'pending')
  assert.equal(events[0].sessionId, 'a')
})

test('diffSummaries emits pending when one pending kind changes to another', () => {
  const prev = {
    byId: {
      a: { id: 'a', displayTitle: 'A', pendingInteraction: 'approval' },
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
  assert.equal(events[0].kind, 'pending')
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

test('diffSummaries does NOT emit for completed-only changes', () => {
  const prev = { byId: { a: { id: 'a', displayTitle: 'A' } } }
  const next = { byId: { a: { id: 'a', displayTitle: 'A', completed: true } } }
  const events = []
  diffSummaries(prev, next, (event) => events.push(event))
  assert.equal(events.length, 0)
})

test('shouldDiffList only enables diffing after both snapshots are ready', () => {
  const pending = { phase: 'pending', byId: {} }
  const ready = { phase: 'ready', byId: {} }
  assert.equal(shouldDiffList(pending, pending), false)
  assert.equal(shouldDiffList(pending, ready), false)
  assert.equal(shouldDiffList(ready, ready), true)
})

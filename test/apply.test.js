import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/client.js'

// Minimal browser-like environment so the client plugin can run under Node.
function makeElement(tag) {
  const element = {
    tagName: tag.toUpperCase(),
    style: {},
    children: [],
    className: '',
    textContent: '',
    _listeners: {},
    appendChild(child) { this.children.push(child); child.parentNode = this; return child },
    append(...children) { for (const child of children) this.appendChild(child) },
    addEventListener(type, handler) { (this._listeners[type] ??= []).push(handler) },
    removeEventListener() {},
    setAttribute() {},
    remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i !== -1) this.parentNode.children.splice(i, 1) } },
    querySelectorAll() { return [] },
  }
  return element
}

function makeDocument() {
  const body = makeElement('body')
  const head = makeElement('head')
  return {
    body,
    head,
    documentElement: makeElement('html'),
    hidden: false,
    title: 'DSH',
    createElement: (tag) => makeElement(tag),
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { body.appendChild(child) },
    hasFocus: () => true,
  }
}

function makeStore(initial) {
  const listeners = new Set()
  let state = initial
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { state = next; for (const fn of [...listeners]) fn() },
  }
}

test('client apply sends pending reminder only', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const document = makeDocument()
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1280,
    maxTouchPoints: 0,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() { return this }, start() {}, stop() {} } }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this } } }
      resume() { this.state = 'running'; return Promise.resolve() }
    },
  }
  globalThis.document = document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: 0 } })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class { static permission = 'denied'; static requestPermission() { return Promise.resolve('denied') } },
  })

  const sessionsList = makeStore({
    phase: 'ready',
    ids: ['a'],
    byId: { a: { id: 'a', displayTitle: 'Alpha', running: false } },
    current: undefined,
  })
  const opened = []
  const sessions = {
    list: sessionsList,
    open(id) { opened.push(id) },
  }

  const dispose = apply({ sessions })

  try {
    // New pending interaction must produce a toast.
    sessionsList.set({
      phase: 'ready',
      ids: ['a'],
      byId: { a: { id: 'a', displayTitle: 'Alpha', pendingInteraction: 'question', running: false } },
      current: undefined,
    })
    assert.ok(document.body.children.length > 0, 'expected a pending reminder')

    // A completed-only edge must NOT produce another reminder.
    const before = document.body.children.length
    sessionsList.set({
      phase: 'ready',
      ids: ['a'],
      byId: { a: { id: 'a', displayTitle: 'Alpha', pendingInteraction: 'question', completed: true, running: false } },
      current: undefined,
    })
    assert.equal(document.body.children.length, before, 'completed-only changes must not remind')

    // Baseline behavior: a pending->ready transition with pre-existing pending
    // state must not notify.
    const baselineList = makeStore({ phase: 'pending', ids: [], byId: {}, current: undefined })
    const baselineDispose = apply({ sessions: { list: baselineList, open() {} } })
    baselineList.set({
      phase: 'ready',
      ids: ['b'],
      byId: { b: { id: 'b', displayTitle: 'Beta', pendingInteraction: 'question', running: false } },
      current: undefined,
    })
    // No toast should have been created by the baseline apply.
    assert.equal(document.body.children.length, before, 'pre-existing pending on first ready must not remind')
    baselineDispose()
  } finally {
    dispose()
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    if (navigatorDesc) Object.defineProperty(globalThis, 'navigator', navigatorDesc)
    else delete globalThis.navigator
    if (notificationDesc) Object.defineProperty(globalThis, 'Notification', notificationDesc)
    else delete globalThis.Notification
  }
})

test('hidden startup with pre-existing pending sends one reminder', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const document = makeDocument()
  document.hidden = true
  document.hasFocus = () => false
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1280,
    maxTouchPoints: 0,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() { return this }, start() {}, stop() {} } }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this } } }
      resume() { this.state = 'running'; return Promise.resolve() }
    },
  }
  globalThis.document = document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: 0 } })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class { static permission = 'denied'; static requestPermission() { return Promise.resolve('denied') } },
  })

  const list = makeStore({ phase: 'pending', ids: [], byId: {}, current: undefined })
  const dispose = apply({ sessions: { list, open() {} } })

  try {
    list.set({
      phase: 'ready',
      ids: ['x', 'y'],
      byId: {
        x: { id: 'x', displayTitle: 'X', pendingInteraction: 'question' },
        y: { id: 'y', displayTitle: 'Y', pendingInteraction: 'approval' },
      },
      current: undefined,
    })
    assert.equal(document.body.children.length, 1, 'hidden startup should send one aggregated toast')
  } finally {
    dispose()
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    if (navigatorDesc) Object.defineProperty(globalThis, 'navigator', navigatorDesc)
    else delete globalThis.navigator
    if (notificationDesc) Object.defineProperty(globalThis, 'Notification', notificationDesc)
    else delete globalThis.Notification
  }
})

test('leaving the page with unhandled pending triggers reminder', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const document = makeDocument()
  const windowListeners = new Map()
  const testWindow = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1280,
    maxTouchPoints: 0,
    focus() {},
    addEventListener(type, handler) {
      const list = windowListeners.get(type) ?? []
      list.push(handler)
      windowListeners.set(type, list)
    },
    removeEventListener(type, handler) {
      const list = windowListeners.get(type) ?? []
      const index = list.indexOf(handler)
      if (index !== -1) list.splice(index, 1)
    },
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() { return this }, start() {}, stop() {} } }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this } } }
      resume() { this.state = 'running'; return Promise.resolve() }
    },
  }
  globalThis.window = testWindow
  globalThis.document = document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: 0 } })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class { static permission = 'denied'; static requestPermission() { return Promise.resolve('denied') } },
  })

  const list = makeStore({
    phase: 'ready',
    ids: ['p'],
    byId: { p: { id: 'p', displayTitle: 'PendingSession', pendingInteraction: 'question' } },
    current: undefined,
  })
  const dispose = apply({ sessions: { list, open() {} } })

  try {
    // Visible baseline with pre-existing pending should not toast.
    assert.equal(document.body.children.length, 0, 'visible baseline must not notify')

    // User leaves the page: blur/visibilitychange should produce one toast.
    document.hidden = true
    document.hasFocus = () => false
    for (const handler of windowListeners.get('blur') ?? []) handler()
    for (const handler of windowListeners.get('visibilitychange') ?? []) handler()
    assert.equal(document.body.children.length, 1, 'leaving with unhandled pending should remind')
  } finally {
    dispose()
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    if (navigatorDesc) Object.defineProperty(globalThis, 'navigator', navigatorDesc)
    else delete globalThis.navigator
    if (notificationDesc) Object.defineProperty(globalThis, 'Notification', notificationDesc)
    else delete globalThis.Notification
  }
})

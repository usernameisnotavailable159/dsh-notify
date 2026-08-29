import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/client.js'

// Minimal browser-like environment so the client plugin can run under Node.
function makeElement(tag) {
  const element = {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    attrs: {},
    className: '',
    textContent: '',
    hidden: false,
    _listeners: {},
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    append(...children) {
      for (const child of children) this.appendChild(child)
    },
    addEventListener(type, handler) {
      ;(this._listeners[type] ??= []).push(handler)
    },
    removeEventListener(type, handler) {
      const list = this._listeners[type] ?? []
      const index = list.indexOf(handler)
      if (index !== -1) list.splice(index, 1)
    },
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return this.attrs[name] },
    remove() {
      if (this.parentNode) {
        const index = this.parentNode.children.indexOf(this)
        if (index !== -1) this.parentNode.children.splice(index, 1)
      }
    },
    querySelectorAll() { return [] },
  }
  return element
}

function makeDocument() {
  const body = makeElement('body')
  const head = makeElement('head')
  const doc = {
    body,
    head,
    documentElement: makeElement('html'),
    hidden: false,
    title: 'DSH',
    _elements: new Map(),
    _nextId: 1,
    createElement(tag) {
      const element = makeElement(tag)
      element.id = ''
      return element
    },
    getElementById(id) {
      return this._elements.get(id) ?? null
    },
    querySelectorAll() { return [] },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { body.appendChild(child) },
    hasFocus() { return true },
  }
  return doc
}

function makeStore(initial) {
  const listeners = new Set()
  let state = initial
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

function makeSession(initialSnapshot) {
  const listeners = new Set()
  let snapshot = initialSnapshot
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set(next) { snapshot = next; for (const fn of [...listeners]) fn() },
  }
}

test('client apply sends question/completed/tool reminders', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const document = makeDocument()
  const notifications = []
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    innerWidth: 1280,
    maxTouchPoints: 0,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    AudioContext: class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {} }
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0 },
          connect() { return this },
          start() {},
          stop() {},
        }
      }
      createGain() {
        return {
          gain: {
            setValueAtTime() {},
            exponentialRampToValueAtTime() {},
          },
          connect() { return this },
        }
      }
      resume() { this.state = 'running'; return Promise.resolve() }
    },
  }
  globalThis.document = document
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 0, vibrate() { notifications.push({ type: 'vibrate' }) } },
  })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class {
      constructor(title, options) {
        notifications.push({ type: 'notification', title, options })
        this.close = () => {}
      }
      static permission = 'granted'
      static requestPermission() { return Promise.resolve('granted') }
    },
  })

  // Mock sessions list + binding.
  const sessionsList = makeStore({
    ids: ['a'],
    byId: {
      a: { id: 'a', displayTitle: 'Alpha', running: false },
    },
    current: undefined,
  })
  const sessionA = makeSession({ nodes: [], running: false, pending: [] })
  const sessions = {
    list: sessionsList,
    binding(id) {
      if (id === 'a') return { session: sessionA }
      return undefined
    },
  }

  const dispose = apply({ sessions })

  try {
    // Baseline is already observed; a newly appearing pending interaction must notify.
    sessionsList.set({
      ids: ['a'],
      byId: {
        a: { id: 'a', displayTitle: 'Alpha', pendingInteraction: 'question', running: false },
      },
      current: undefined,
    })
    assert.ok(document.body.children.length > 0,
      'expected a reminder after question appears')

    // A completed edge in the list must also notify.
    const before = notifications.length
    sessionsList.set({
      ids: ['a'],
      byId: {
        a: { id: 'a', displayTitle: 'Alpha', pendingInteraction: 'question', completed: true, running: false },
      },
      current: undefined,
    })
    assert.ok(document.body.children.length > before, 'expected a completed reminder')

    // Switch to session a; adding a tool-result node must notify.
    const beforeTool = notifications.length
    sessionsList.set({
      ids: ['a'],
      byId: {
        a: { id: 'a', displayTitle: 'Alpha', pendingInteraction: 'question', completed: true, running: true },
      },
      current: 'a',
    })
    sessionA.set({ nodes: [{ kind: 'tool-result', seq: 10 }], running: true, pending: [] })
    assert.ok(document.body.children.length > beforeTool, 'expected a tool-result reminder')
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

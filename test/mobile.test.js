import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/client.js'

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

test('mobile path uses vibration and system notification', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const body = makeElement('body')
  const document = {
    body,
    head: makeElement('head'),
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
  const effects = []
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    innerWidth: 390,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 5, vibrate(pattern) { effects.push(['vibrate', pattern]) } },
  })
  const NotificationClass = class {
    constructor(title, options) { effects.push(['notification', title, options]); this.close = () => {} }
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
  }
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: NotificationClass,
  })
  globalThis.window.Notification = NotificationClass

  const listeners = new Set()
  let listState = {
    phase: 'ready',
    ids: ['m'],
    byId: { m: { id: 'm', displayTitle: 'Mobile', running: false } },
    current: undefined,
  }
  const sessionsList = {
    getSnapshot: () => listState,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { listState = next; for (const fn of [...listeners]) fn() },
  }
  const dispose = apply({ sessions: { list: sessionsList, binding: () => undefined } })

  // Trigger a pending-interaction edge in the mobile list.
  sessionsList.set({
    phase: 'ready',
    ids: ['m'],
    byId: { m: { id: 'm', displayTitle: 'Mobile', pendingInteraction: 'question', running: false } },
    current: undefined,
  })
  assert.ok(effects.some(([type]) => type === 'vibrate'), 'mobile should vibrate')
  assert.ok(effects.some(([type]) => type === 'notification'), 'mobile should show system notification')
  dispose()

  Object.defineProperty(globalThis, 'navigator', navigatorDesc ?? { configurable: true, value: undefined })
  Object.defineProperty(globalThis, 'Notification', notificationDesc ?? { configurable: true, value: undefined })
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})

test('mobile path prefers native themeBridge.notify when available', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const body = makeElement('body')
  const document = {
    body,
    head: makeElement('head'),
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
  const effects = []
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    innerWidth: 390,
    themeBridge: {
      notify(title, body, tag) { effects.push(['native', title, body, tag]) },
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 5, vibrate(pattern) { effects.push(['vibrate', pattern]) } },
  })
  // Even when web Notification is denied, the native bridge must be used.
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class {
      static permission = 'denied'
      static requestPermission() { return Promise.resolve('denied') }
    },
  })

  const listeners = new Set()
  let listState = {
    phase: 'ready',
    ids: ['n'],
    byId: { n: { id: 'n', displayTitle: 'Native', running: false } },
    current: undefined,
  }
  const sessionsList = {
    getSnapshot: () => listState,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { listState = next; for (const fn of [...listeners]) fn() },
  }
  const dispose = apply({ sessions: { list: sessionsList, binding: () => undefined } })

  sessionsList.set({
    phase: 'ready',
    ids: ['n'],
    byId: { n: { id: 'n', displayTitle: 'Native', pendingInteraction: 'question', running: false } },
    current: undefined,
  })
  assert.ok(effects.some(([type]) => type === 'native'), 'native bridge should be called')
  assert.ok(effects.some(([type]) => type === 'vibrate'), 'mobile should still vibrate')
  assert.ok(!effects.some(([type]) => type === 'notification'), 'web Notification should not be used when native bridge exists')
  dispose()

  Object.defineProperty(globalThis, 'navigator', navigatorDesc ?? { configurable: true, value: undefined })
  Object.defineProperty(globalThis, 'Notification', notificationDesc ?? { configurable: true, value: undefined })
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})

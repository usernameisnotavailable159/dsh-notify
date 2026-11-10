import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, reminderKey } from '../lib/client.js'

// 目标：手机端"一次事件一个提示"。
// 1) App 内置 WebView 里页面不可见时，页面插件一律不发（让位给原生监控器 DshEventMonitor）；
// 2) 原生通知发出去后不再叠网页内弹窗；
// 3) 回前台的重放差异只重建基线，不补发提醒。

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

function makeList(initial) {
  const listeners = new Set()
  let state = initial
  return {
    getSnapshot: () => state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    set(next) { state = next; for (const fn of [...listeners]) fn() },
  }
}

/** 装出「App 内置 WebView、手机视口、有 themeBridge」的环境。 */
function installLauncherEnvironment({ hidden = false } = {}) {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const notificationDesc = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

  const document = makeDocument()
  document.hidden = hidden
  const windowListeners = new Map()
  const native = []
  globalThis.window = {
    matchMedia: () => ({ matches: true }),
    innerWidth: 390,
    themeBridge: {
      notifyEx(json) { native.push(JSON.parse(json)) },
    },
    addEventListener(type, handler) {
      const set = windowListeners.get(type) ?? new Set()
      set.add(handler)
      windowListeners.set(type, set)
    },
    removeEventListener(type, handler) { windowListeners.get(type)?.delete(handler) },
    focus() {},
  }
  globalThis.document = document
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: 5, vibrate() {} },
  })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class {
      static permission = 'granted'
      static requestPermission() { return Promise.resolve('granted') }
      constructor() { throw new Error('web Notification must not be used in the launcher') }
    },
  })

  return {
    document,
    native,
    dispatch(type) { for (const handler of [...(windowListeners.get(type) ?? [])]) handler() },
    restore() {
      Object.defineProperty(globalThis, 'navigator', navigatorDesc ?? { configurable: true, value: undefined })
      Object.defineProperty(globalThis, 'Notification', notificationDesc ?? { configurable: true, value: undefined })
      globalThis.window = originalWindow
      globalThis.document = originalDocument
    },
  }
}

test('reminderKey matches the native side key format', () => {
  assert.equal(reminderKey({ kind: 'completed', sessionId: 'session-1' }), 'turn:session-1')
  assert.equal(reminderKey({ kind: 'pending', sessionId: 'session-1' }), 'pending:session-1')
})

test('launcher WebView hidden: page stays silent (native monitor owns it)', () => {
  const env = installLauncherEnvironment({ hidden: true })
  const list = makeList({ phase: 'pending', ids: [], byId: {}, current: undefined })
  const dispose = apply({ sessions: { list, binding: () => undefined } })
  // 基线：首帧 ready 里该会话正在跑（真实运行时的顺序就是先 pending 再 ready）。
  list.set({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: true } },
    current: undefined,
  })
  list.set({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: false } },
    current: undefined,
  })

  assert.equal(env.native.length, 0, '不可见时页面不能发通知')
  assert.equal(env.document.body.children.length, 0, '不可见时也不弹网页内提示')
  dispose()
  env.restore()
})

test('launcher WebView visible: exactly one native banner, no extra in-page toast', () => {
  const env = installLauncherEnvironment({ hidden: false })
  const list = makeList({ phase: 'pending', ids: [], byId: {}, current: undefined })
  const dispose = apply({ sessions: { list, binding: () => undefined } })
  list.set({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: true } },
    current: undefined,
  })
  list.set({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: false } },
    current: undefined,
  })

  assert.equal(env.native.length, 1, '只发一条原生通知')
  assert.equal(env.native[0].key, 'turn:s')
  assert.equal(env.document.body.children.length, 0, '原生通知已发就不再叠网页内弹窗')
  dispose()
  env.restore()
})

test('same session completing twice in a burst notifies once', () => {
  const env = installLauncherEnvironment({ hidden: false })
  const running = (value) => ({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: value } },
    current: undefined,
  })
  const list = makeList({ phase: 'pending', ids: [], byId: {}, current: undefined })
  const dispose = apply({ sessions: { list, binding: () => undefined } })
  list.set(running(true))
  list.set(running(false))
  list.set(running(true))
  list.set(running(false))

  assert.equal(env.native.length, 1, '同一 key 在提醒窗口内只发一次')
  dispose()
  env.restore()
})

test('resuming the page replays a completed turn without a second prompt', () => {
  const env = installLauncherEnvironment({ hidden: true })
  const list = makeList({ phase: 'pending', ids: [], byId: {}, current: undefined })
  const dispose = apply({ sessions: { list, binding: () => undefined } })
  list.set({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: true } },
    current: undefined,
  })

  // App 在前台了：visibilitychange 先到，随后积压的快照才重放。
  env.document.hidden = false
  env.dispatch('visibilitychange')
  list.set({
    phase: 'ready',
    ids: ['s'],
    byId: { s: { id: 's', displayTitle: 'S', running: false } },
    current: undefined,
  })

  assert.equal(env.native.length, 0, '回前台的积压重放不能补发提醒')
  dispose()
  env.restore()
})

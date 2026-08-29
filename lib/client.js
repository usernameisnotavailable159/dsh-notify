/**
 * dsh-notify browser half.
 *
 * Watches the shared sessions list for:
 *  - a pending interaction appearing (question / approval / plan-review), and
 *  - the “completed” reminder of a non-selected session (running → idle).
 *
 * It also watches the currently open session's conversation snapshot for new
 * `tool-result` nodes and for a running → idle edge, so a foreground session
 * still produces a reminder when a tool call (or the whole turn) finishes.
 *
 * Reminder channels:
 *  - PC: Web Audio beep + tab-title flashing when hidden + page flash/toast
 *    when visible.
 *  - Mobile: navigator.vibrate + system Notification when permitted (the
 *    Android system then applies its current ring/vibration settings) +
 *    in-page popup toast as a guaranteed fallback.
 *
 * The module is intentionally browser-free at import time except for the
 * small pure helpers exported for unit tests.
 */

/** Stable Cordis plugin name (matches the manifest id). */
export const name = 'dsh-notify'

/** Required services: the root sessions service. */
export const inject = ['sessions']

/** Mobile-ish viewport/touch heuristic used for channel selection. */
const MOBILE_QUERY = '(max-width: 768px)'

/** How long the browser tab title keeps flashing. */
const TITLE_FLASH_MS = 8000

/** How long the in-page toast stays visible. */
const TOAST_MS = 5000

/** Global minimum gap between two sound/vibration reminders. */
const REMINDER_THROTTLE_MS = 800

/**
 * Compare two session-list snapshots and emit reminder events for edges the
 * plugin cares about. Pure and unit-testable.
 *
 * @param prev - previous `SessionListState`-like object (`byId` map).
 * @param next - next `SessionListState`-like object.
 * @param emit - receives `{ kind, sessionId }` reminder events.
 */
export function diffSummaries(prev, next, emit) {
  for (const id of Object.keys(next.byId)) {
    const current = next.byId[id]
    const previous = prev.byId[id]
    // First observation is a baseline, never a reminder. This mirrors the
    // runtime's own completed-notification rule and avoids a notification
    // storm on page load.
    if (previous === undefined) continue

    const prevPending = previous.pendingInteraction
    const nextPending = current.pendingInteraction
    if (!prevPending && nextPending) {
      emit({ kind: 'question', sessionId: id })
    } else if (prevPending && nextPending && prevPending !== nextPending) {
      emit({ kind: 'question', sessionId: id })
    }

    const prevCompleted = previous.completed === true
    const nextCompleted = current.completed === true
    if (!prevCompleted && nextCompleted) {
      emit({ kind: 'completed', sessionId: id })
    }
  }
}

/**
 * Extract the seqs of finalized tool-result nodes from a conversation
 * snapshot. Used to detect newly completed tool calls in the current session.
 *
 * @param snapshot - a `ConversationSnapshot`-like object.
 * @returns tool-result seqs in snapshot order.
 */
export function toolResultSeqs(snapshot) {
  const nodes = snapshot?.nodes ?? []
  const out = []
  for (const node of nodes) {
    if (node !== null && typeof node === 'object' && node.kind === 'tool-result' && typeof node.seq === 'number') {
      out.push(node.seq)
    }
  }
  return out
}

/** True when the current browser context should use the mobile channel set. */
function isMobile() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia?.(MOBILE_QUERY)?.matches) return true
  return typeof navigator !== 'undefined'
    && typeof navigator.maxTouchPoints === 'number'
    && navigator.maxTouchPoints > 0
    && window.innerWidth <= 1024
}

/** Inject the small stylesheet used by the plugin (idempotent). */
function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('dsh-notify-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-notify-style'
  style.textContent = `
#dsh-notify-toasts {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
  width: min(92vw, 440px);
  box-sizing: border-box;
}
.dsh-notify-toast {
  pointer-events: auto;
  width: 100%;
  box-sizing: border-box;
  background: #1f2937;
  color: #f9fafb;
  border: 1px solid #f59e0b;
  border-left: 5px solid #f59e0b;
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.4);
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  animation: dsh-notify-in 0.18s ease-out;
  word-break: break-word;
}
.dsh-notify-toast--mobile {
  border-radius: 16px;
  border: 1px solid #f59e0b;
  border-left-width: 5px;
  padding: 14px 18px;
  font-size: 15px;
}
.dsh-notify-toast__title {
  font-weight: 700;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-notify-toast__body {
  opacity: 0.92;
}
.dsh-notify-toast__close {
  float: right;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  margin: -4px -6px 0 0;
  opacity: 0.7;
}
.dsh-notify-toast__close:hover {
  opacity: 1;
}
.dsh-notify-flash {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  pointer-events: none;
  border: 6px solid rgba(245, 158, 11, 0.85);
  background: rgba(245, 158, 11, 0.08);
  animation: dsh-notify-flash 0.55s ease 3;
}
@keyframes dsh-notify-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 1; transform: none; }
}
@keyframes dsh-notify-flash {
  0%, 100% { opacity: 0; }
  50% { opacity: 1; }
}
`
  ;(document.head ?? document.documentElement).appendChild(style)
}

/**
 * Browser reminder controller. All DOM/audio/Notification side effects live
 * here; `start()`/`stop()` manage the one-time permission request hook.
 */
function createNotifier(options = {}) {
  const { openSession } = options
  let audioContext = null
  let permissionRequested = false
  let originalTitle = null
  let titleTimer = null
  let titleStop = null
  let lastNotifyAt = 0
  let started = false
  const toastTimers = new Set()

  /** Ask for Notification permission on the first user gesture (mobile path). */
  function requestPermissionOnce() {
    if (permissionRequested) return
    permissionRequested = true
    if (typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission !== 'default') return
    try {
      const result = Notification.requestPermission?.()
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      // The browser may reject the request outside a user gesture; ignore.
    }
  }

  /** Lazily create/resume a Web Audio context. */
  function ensureAudio() {
    try {
      if (audioContext === null) {
        const Ctor = window.AudioContext ?? window.webkitAudioContext
        if (Ctor === undefined) return null
        audioContext = new Ctor()
      }
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {})
      }
      return audioContext
    } catch {
      return null
    }
  }

  /** Play a short two-tone “simple notification” beep. */
  function beep() {
    const ctx = ensureAudio()
    if (ctx === null) return
    const now = ctx.currentTime
    const tone = (frequency, start, duration, volume = 0.16) => {
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start(start)
      oscillator.stop(start + duration + 0.03)
    }
    tone(880, now, 0.15)
    tone(1245, now + 0.12, 0.2)
  }

  /** Show a system notification when permission is granted (mobile path). */
  function systemNotification(event, title, body) {
    if (typeof window === 'undefined' || !('Notification' in window)) return false
    if (Notification.permission !== 'granted') return false
    try {
      const notification = new Notification(title, {
        body,
        tag: `dsh-notify-${event.sessionId}-${Date.now()}`,
        vibrate: [200, 100, 200],
        silent: false,
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
      return true
    } catch {
      return false
    }
  }

  /** Briefly flash the whole page (PC visible path). */
  function flashPage() {
    if (typeof document === 'undefined') return
    document.querySelectorAll('.dsh-notify-flash').forEach((element) => element.remove())
    const overlay = document.createElement('div')
    overlay.className = 'dsh-notify-flash'
    ;(document.body ?? document.documentElement).appendChild(overlay)
    setTimeout(() => overlay.remove(), 1900)
  }

  /** Flash the browser tab title while the page is hidden/not focused. */
  function startTitleFlash() {
    if (typeof document === 'undefined') return
    if (titleTimer !== null) return
    originalTitle = document.title
    const labels = ['🔔 DSH 有新消息', originalTitle]
    let index = 0
    const stop = () => {
      if (titleTimer === null) return
      clearInterval(titleTimer)
      titleTimer = null
      window.removeEventListener('focus', stop)
      document.title = originalTitle ?? document.title
      titleStop = null
    }
    titleStop = stop
    const tick = () => {
      document.title = labels[index % labels.length]
      index += 1
    }
    tick()
    titleTimer = setInterval(tick, 700)
    window.addEventListener('focus', stop)
    setTimeout(stop, TITLE_FLASH_MS)
  }

  /** Show the in-page popup/toast. */
  function showToast(event, title, body) {
    if (typeof document === 'undefined') return
    ensureStyles()
    let container = document.getElementById('dsh-notify-toasts')
    if (container === null) {
      container = document.createElement('div')
      container.id = 'dsh-notify-toasts'
      ;(document.body ?? document.documentElement).appendChild(container)
    }

    const toast = document.createElement('div')
    toast.className = 'dsh-notify-toast' + (isMobile() ? ' dsh-notify-toast--mobile' : '')
    toast.setAttribute('role', 'alert')

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'dsh-notify-toast__close'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '✕'

    let timer = null
    const dismiss = () => {
      clearTimeout(timer)
      toastTimers.delete(timer)
      toast.remove()
    }
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      dismiss()
    })

    const titleEl = document.createElement('div')
    titleEl.className = 'dsh-notify-toast__title'
    titleEl.textContent = title

    const bodyEl = document.createElement('div')
    bodyEl.className = 'dsh-notify-toast__body'
    bodyEl.textContent = body

    toast.append(close, titleEl, bodyEl)
    container.appendChild(toast)
    timer = setTimeout(dismiss, TOAST_MS)
    toastTimers.add(timer)
    toast.addEventListener('click', () => {
      if (event.sessionId !== undefined && typeof openSession === 'function') {
        try {
          openSession(event.sessionId)
        } catch {
          // Navigating to a removed session is harmless; keep the toast closed.
        }
      }
      dismiss()
    })
  }

  /** Build localized reminder copy for one event. */
  function copyFor(event) {
    switch (event.kind) {
      case 'question':
        return {
          title: `${event.title ?? '会话'} · AI 需要你`,
          body: event.message ?? 'AI 提出了问题/请求，请切换到对应会话处理。',
        }
      case 'completed':
        return {
          title: `${event.title ?? '会话'} · 已完成`,
          body: event.message ?? 'AI 已完成任务/工具调用，可以查看结果。',
        }
      case 'tool':
        return {
          title: `${event.title ?? '会话'} · 工具调用完成`,
          body: event.message ?? 'AI 完成了一次工具调用，请查看结果。',
        }
      default:
        return {
          title: event.title ?? 'DSH 会话提醒',
          body: event.message ?? '会话有新的进展，请查看。',
        }
    }
  }

  /** The single reminder entry point. */
  function notify(event) {
    if (!started) return
    const now = Date.now()
    if (now - lastNotifyAt < REMINDER_THROTTLE_MS) return
    lastNotifyAt = now

    const { title, body } = copyFor(event)
    const mobile = isMobile()

    if (mobile) {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate([200, 80, 200])
        } catch {
          // Some browsers throw when vibration is unavailable.
        }
      }
      const systemShown = systemNotification(event, title, body)
      if (!systemShown) beep()
      showToast(event, title, body)
    } else {
      beep()
      if (typeof document !== 'undefined' && (document.hidden || !document.hasFocus())) {
        startTitleFlash()
      } else {
        flashPage()
      }
      showToast(event, title, body)
    }
  }

  return {
    start() {
      if (started) return
      started = true
      ensureStyles()
      if (typeof window !== 'undefined') {
        window.addEventListener('pointerdown', requestPermissionOnce)
        window.addEventListener('touchstart', requestPermissionOnce)
        window.addEventListener('click', requestPermissionOnce)
      }
    },
    stop() {
      started = false
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointerdown', requestPermissionOnce)
        window.removeEventListener('touchstart', requestPermissionOnce)
        window.removeEventListener('click', requestPermissionOnce)
      }
      if (titleStop !== null) titleStop()
      for (const timer of toastTimers) clearTimeout(timer)
      toastTimers.clear()
      if (typeof document !== 'undefined') {
        document.querySelectorAll('.dsh-notify-flash, #dsh-notify-toasts').forEach((element) => element.remove())
      }
    },
    notify,
  }
}

/**
 * Browser plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  const sessions = ctx.sessions
  const notifier = createNotifier({
    openSession: (sessionId) => {
      try {
        sessions.open(sessionId)
      } catch {
        // The session may have disappeared; ignore.
      }
    },
  })
  let lastList = sessions.list.getSnapshot()
  let currentSubscription = null
  let currentSessionId = undefined
  let lastCurrentRunning = false
  const seenToolSeqs = new Map()

  /** Resolve the live SessionFace for a listed session id. */
  function sessionFor(id) {
    try {
      return sessions.binding(id)?.session
    } catch {
      return undefined
    }
  }

  /** Subscribe to the currently selected session's snapshot for tool/running edges. */
  function syncCurrent(next) {
    const id = next.current
    if (id === currentSessionId && currentSubscription !== null) return
    if (id !== currentSessionId) {
      if (currentSubscription !== null) {
        currentSubscription()
        currentSubscription = null
      }
      currentSessionId = id
      lastCurrentRunning = false
    }
    if (id === undefined) return

    const session = sessionFor(id)
    if (session === undefined) return
    seenToolSeqs.set(id, new Set(toolResultSeqs(session.getSnapshot())))
    lastCurrentRunning = session.getSnapshot().running === true
    currentSubscription = session.subscribe(() => {
      const snapshot = session.getSnapshot()
      const seqs = new Set(toolResultSeqs(snapshot))
      const previousSeqs = seenToolSeqs.get(id) ?? new Set()
      const added = [...seqs].filter((seq) => !previousSeqs.has(seq))
      seenToolSeqs.set(id, seqs)

      const summary = sessions.list.getSnapshot().byId[id]
      const displayTitle = summary?.displayTitle ?? id

      if (added.length > 0) {
        notifier.notify({
          kind: 'tool',
          sessionId: id,
          title: displayTitle,
          message: `AI 完成了 ${added.length} 个工具调用，请查看结果。`,
        })
      }

      const running = snapshot.running === true
      if (lastCurrentRunning && !running && (snapshot.pending ?? []).length === 0) {
        notifier.notify({
          kind: 'completed',
          sessionId: id,
          title: displayTitle,
          message: 'AI 已完成当前任务/工具调用，可以查看结果。',
        })
      }
      lastCurrentRunning = running
    })
  }

  /** Handle list changes: detect global question/completed reminders. */
  function onListChange() {
    const next = sessions.list.getSnapshot()
    diffSummaries(lastList, next, (event) => {
      const summary = next.byId[event.sessionId]
      const displayTitle = summary?.displayTitle ?? event.sessionId
      notifier.notify({
        ...event,
        title: displayTitle,
      })
    })
    lastList = next
    syncCurrent(next)
  }

  const unsubscribeList = sessions.list.subscribe(onListChange)
  syncCurrent(lastList)
  notifier.start()

  return () => {
    unsubscribeList()
    if (currentSubscription !== null) currentSubscription()
    notifier.stop()
  }
}

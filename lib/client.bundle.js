window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-notify',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/**
 * dsh-notify browser half.
 *
 * Reminds the user only when a session is waiting for human input — an AI
 * question, an approval request, or a plan review. Ordinary tool calls inside
 * a turn are intentionally NOT reminded: one user input can contain many tool
 * calls, and only when the user needs to handle/fill something should DSH draw
 * attention to that session.
 *
 * Reminder channels:
 *  - PC: Web Audio beep + tab-title flashing when hidden + page flash/toast
 *    when visible.
 *  - Mobile: navigator.vibrate + one system notification, then nothing else —
 *    the system banner is the prompt, so no in-page toast is stacked on top.
 *  - Mobile inside the LocalHub app WebView (`window.themeBridge`): the page
 *    only speaks while it is visible; when it is hidden the app's native
 *    monitor (`DshEventMonitor`) owns the single notification. One event ⇒
 *    exactly one prompt, whichever channel is in charge at that moment.
 *
 * The module is intentionally browser-free at import time except for the
 * small pure helpers exported for unit tests.
 */

/** Stable Cordis plugin name (matches the manifest id). */
const name = 'dsh-notify'

/** Required services: the root sessions service. */
const inject = ['sessions']

/** Mobile-ish viewport/touch heuristic used for channel selection. */
const MOBILE_QUERY = '(max-width: 768px)'

/** How long the browser tab title keeps flashing. */
const TITLE_FLASH_MS = 8000

/** How long the in-page toast stays visible. */
const TOAST_MS = 5000

/** Global minimum gap between two sound/vibration reminders. */
const REMINDER_THROTTLE_MS = 800

/**
 * 同一个语义键（`turn:<sessionId>` / `pending:<sessionId>`）在这段时间内只提醒一次。
 *
 * 为什么需要：同一个事件有两条通道会各发一次 —— 页面插件（本文件）和 App 内原生监控器
 * `DshEventMonitor`。原生侧 `NotificationHelper.showRich` 有 6 秒去重窗口，能吞掉"两个通道
 * 几乎同时发"的情况；但页面在后台被冻结、恢复后重放旧事件时，第二条会晚到几十秒，
 * 那时原生窗口早过了 ⇒ 用户收到第二次同样的提示。本窗口就是这个慢路径的兜底。
 */
const KEY_REMIND_WINDOW_MS = 15_000

/**
 * 页面重新可见后的一小段时间里，快照差异**不当作提醒边沿**，只用来重建基线。
 *
 * 为什么需要：WebView 在后台被暂停/冻结时会积压事件，恢复后一次性重放；这些事件在
 * 后台时已经由原生监控器发过通知。重放出来的差异再发一次，就是"一次完成、两次提示"。
 */
const RESUME_REBASE_MS = 1_500

/**
 * Whether two list snapshots are both past the initial baseline load. The
 * first ready snapshot is treated as a baseline, so pre-existing pending
 * sessions do not trigger a first-run notification storm.
 *
 * @param prev - previous `SessionListState`-like object.
 * @param next - next `SessionListState`-like object.
 * @returns true when the diff should be evaluated.
 */
function shouldDiffList(prev, next) {
  return prev.phase === 'ready' && next.phase === 'ready'
}

/**
 * Compare two session-list snapshots and emit reminder events for pending
 * interaction edges. Pure and unit-testable.
 *
 * @param prev - previous `SessionListState`-like object (`byId` map).
 * @param next - next `SessionListState`-like object.
 * @param emit - receives `{ kind, sessionId }` reminder events.
 */
function diffSummaries(prev, next, emit) {
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
      emit({ kind: 'pending', sessionId: id })
    } else if (prevPending && nextPending && prevPending !== nextPending) {
      emit({ kind: 'pending', sessionId: id })
    }
  }
}

/**
 * Detect completed turns: a session whose `running` flag goes true → false
 * without a pending interaction has finished one full round and is waiting
 * for the user's next instruction. Intermediate tool calls do NOT flip this
 * edge, so they are intentionally not reminded.
 *
 * @param next - next `SessionListState`-like object.
 * @param prevRunning - mutable map of the last observed running bit per session.
 * @param emit - receives `{ kind, sessionId }` reminder events.
 */
function diffCompletions(next, prevRunning, emit) {
  const nextIds = new Set(Object.keys(next.byId))
  for (const id of Object.keys(next.byId)) {
    const current = next.byId[id]
    const wasRunning = prevRunning.get(id) ?? false
    const nowRunning = current.running === true
    if (wasRunning && !nowRunning && current.pendingInteraction === undefined) {
      emit({ kind: 'completed', sessionId: id })
    }
    prevRunning.set(id, nowRunning)
  }
  for (const id of [...prevRunning.keys()]) {
    if (!nextIds.has(id)) prevRunning.delete(id)
  }
}


/**
 * The cross-source semantic dedupe key for a reminder event. The Android side
 * (`DshEventMonitor` + `NotificationHelper.showRich`) uses exactly the same
 * strings, so both channels collapse into one notification.
 *
 * @param event - `{ kind, sessionId }` reminder event.
 * @returns the shared key, e.g. `turn:session-123` / `pending:session-123`.
 */
function reminderKey(event) {
  return event.kind === 'completed' ? `turn:${event.sessionId}` : `pending:${event.sessionId}`
}

/** True when the page runs inside the LocalHub (TermuxLauncher) WebView. */
function launcherBridge() {
  if (typeof window === 'undefined') return null
  const bridge = window.themeBridge
  if (bridge === null || typeof bridge !== 'object') return null
  const native = typeof bridge.notifyEx === 'function' || typeof bridge.notify === 'function'
  return native ? bridge : null
}

/** True when the page is currently visible (WebView foreground). */
function pageVisible() {
  if (typeof document === 'undefined') return true
  return document.hidden !== true
}

function isViewing() {
  if (typeof document === 'undefined') return false
  return !document.hidden && document.hasFocus()
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
  let titleFlashTimeout = null
  let titleStop = null
  let lastNotifyAt = 0
  /** key → 最后一次提醒的毫秒时间戳，用于"同一事件只提醒一次"。 */
  const lastKeyAt = new Map()
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

  /**
   * 统一消息提示协议（与 chat-engine / TermuxLauncher 一致）：
   *   { title, text, key, priority, sessionId, serviceId }
   *
   * key 是**跨来源语义去重键**：TermuxLauncher 的后台监控器（DshEventMonitor）也会对同一事件
   * 发一条通知，key 相同 ⇒ 原生侧 6 秒窗口只保留第一条，避免"一次完成弹两条"。
   */
  function notifyPayload(event, title, body) {
    return {
      title,
      text: body,
      key: reminderKey(event),
      priority: 'high',
      sessionId: event.sessionId,
      sender: event.title ?? event.sessionId,
      group: `dsh:${event.sessionId}`,
      // 完成一轮 60 秒后消失；等用户介入（提问/审批）留 5 分钟，避免错过。
      // 60 秒太短：用户离开十几分钟回来，通知早就自动消失了（实测 22:50 那轮根本看不到）。
      ttlMs: event.kind === 'completed' ? 600_000 : 900_000,
      serviceId: 'harness',
    }
  }

  /** Show a system notification when permission is granted (mobile path). */
  function systemNotification(event, title, body) {
    if (typeof window === 'undefined') return false
    const payload = notifyPayload(event, title, body)
    // TermuxLauncher embedded WebView exposes a native notification bridge.
    // Prefer it over the Web Notification API because WebView/Android
    // does not reliably support the browser Notification constructor.
    const bridge = window.themeBridge
    if (bridge && typeof bridge.notifyEx === 'function') {
      try {
        bridge.notifyEx(JSON.stringify(payload))
        return true
      } catch {
        // Fall through to the legacy bridge / web Notification path.
      }
    }
    // 旧版 app 只有 notify(title, body, tag)：tag 直接传 key，语义与新协议一致。
    if (bridge && typeof bridge.notify === 'function') {
      try {
        bridge.notify(payload.title, payload.text, payload.key)
        return true
      } catch {
        // Fall through to the web Notification path.
      }
    }
    if (!('Notification' in window)) return false
    if (Notification.permission !== 'granted') return false
    try {
      const notification = new Notification(payload.title, {
        body: payload.text,
        tag: payload.key,
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
    const labels = ['🔔 DSH 需要处理', originalTitle]
    let index = 0
    const stop = () => {
      if (titleTimer === null) return
      clearInterval(titleTimer)
      clearTimeout(titleFlashTimeout)
      titleTimer = null
      titleFlashTimeout = null
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
    titleFlashTimeout = setTimeout(stop, TITLE_FLASH_MS)
    window.addEventListener('focus', stop)
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

  /** Build localized reminder copy for a pending-interaction event. */
  function copyFor(event) {
    switch (event.kind) {
      case 'completed':
        return {
          title: `${event.title ?? '会话'} · 已完成一轮`,
          body: event.message ?? 'AI 已完成一轮对话，正在等待你的进一步指令。',
        }
      default:
        return {
          title: `${event.title ?? '会话'} · 需要你处理`,
          body: event.message ?? 'AI 正在等待你处理/填写，请切换到对应会话。',
        }
    }
  }

  /**
   * 一个事件只出一个提示。
   *
   * 手机端的两个通道必须分工，不能同时说话：
   *  - **页面可见**（App 在前台、DSH 页在前台）→ 本插件负责：发原生通知（`themeBridge`）。
   *    此时 App 的原生监控器 `DshEventMonitor` 因 `webVisible` 为真而静默。
   *  - **页面不可见**（App 退到后台 / 别的页面）→ 本插件**什么都不发**，全交给原生监控器。
   *    否则"页面晚到的重放" + "监控器实时的那一条"就是用户看到的两次提示。
   *
   * 原生通知发出去之后不再叠加网页内弹窗：两者同义，叠起来就是"一次完成两种提示"。
   */
  function notify(event) {
    if (!started) return
    const now = Date.now()
    if (now - lastNotifyAt < REMINDER_THROTTLE_MS) return
    const key = reminderKey(event)
    const lastAt = lastKeyAt.get(key)
    if (lastAt !== undefined && now - lastAt < KEY_REMIND_WINDOW_MS) return
    if (lastKeyAt.size > 100) {
      for (const [id, at] of lastKeyAt) if (now - at >= KEY_REMIND_WINDOW_MS) lastKeyAt.delete(id)
    }
    lastKeyAt.set(key, now)
    lastNotifyAt = now

    const { title, body } = copyFor(event)
    const mobile = isMobile()

    if (mobile) {
      const inLauncher = launcherBridge() !== null
      // 页面不可见时让位给 App 原生监控器（它正好在 webVisible=false 时工作）。
      if (inLauncher && !pageVisible()) return
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate([200, 80, 200])
        } catch {
          // Some browsers throw when vibration is unavailable.
        }
      }
      const systemShown = systemNotification(event, title, body)
      if (!systemShown) {
        beep()
        showToast(event, title, body)
      }
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
function apply(ctx) {
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
  const acknowledgedPending = new Set()
  const prevRunning = new Map()
  let viewing = isViewing()
  /** 到该时间戳之前，快照差异只重建基线、不提醒（页面刚从后台回来的重放窗口）。 */
  let rebaseUntil = 0

  /** Collect pending sessions that the user has not explicitly opened. */
  function unacknowledgedPending(next) {
    return Object.values(next.byId)
      .filter((summary) => summary.pendingInteraction !== undefined)
      .filter((summary) => !acknowledgedPending.has(summary.id))
  }

  /** Build one aggregated reminder event for pending sessions. */
  function aggregatedPendingEvent(next) {
    const pending = unacknowledgedPending(next)
    if (pending.length === 0) return null
    const first = pending[0]
    const displayTitle = first?.displayTitle ?? first?.id ?? '会话'
    return {
      kind: 'pending',
      sessionId: first.id,
      title: pending.length > 1 ? 'DSH 有会话需要处理' : displayTitle,
      message: pending.length > 1
        ? `有 ${pending.length} 个会话正在等待你处理/填写。`
        : `${displayTitle} 正在等待你处理/填写。`,
    }
  }

  /**
   * When the page is not being viewed at the moment the list first becomes
   * ready, give one aggregated reminder for pre-existing pending sessions.
   * This avoids a per-session notification storm while still alerting the
   * user that something needs attention after a restart/background load.
   */
  function startupPendingReminder(next) {
    if (viewing) return
    const event = aggregatedPendingEvent(next)
    if (event !== null) notifier.notify(event)
  }

  /** When the user leaves the page, remind once for still-unhandled pending. */
  function remindOnLeave() {
    const event = aggregatedPendingEvent(sessions.list.getSnapshot())
    if (event !== null) notifier.notify(event)
  }

  /** True when the session's most recent assistant node was interrupted by a user stop. */
  function isUserStopped(sessionId) {
    try {
      const session = sessions.binding?.(sessionId)?.session
      if (session === undefined) return false
      const snapshot = session.getSnapshot()
      const assistants = (snapshot?.nodes ?? []).filter((node) => node?.kind === 'assistant')
      const last = assistants[assistants.length - 1]
      return last?.interrupted === true
    } catch {
      return false
    }
  }

  /** Handle list changes: detect pending-interaction reminders. */
  function onListChange() {
    const next = sessions.list.getSnapshot()

    // Mark a session as seen when the user opens it while it is pending.
    const current = next.current
    if (current !== undefined && next.byId[current]?.pendingInteraction !== undefined) {
      acknowledgedPending.add(current)
    }

    // 页面刚从后台回来：这一批差异是积压重放，后台那段已经由 App 原生监控器提醒过。
    // 只更新基线，不发提醒 —— 否则"一次完成"会在回前台时再弹第二条。
    if (rebaseUntil !== 0 && Date.now() < rebaseUntil) {
      for (const summary of Object.values(next.byId)) {
        prevRunning.set(summary.id, summary.running === true)
      }
      lastList = next
      return
    }

    const firstReady = lastList.phase !== 'ready' && next.phase === 'ready'
    if (firstReady) {
      // The first ready snapshot is the baseline. Pre-existing pending state
      // is not a per-session notification storm; if the user is away we still
      // send one aggregated reminder.
      for (const summary of Object.values(next.byId)) {
        prevRunning.set(summary.id, summary.running === true)
      }
      startupPendingReminder(next)
    } else if (shouldDiffList(lastList, next)) {
      const emit = (event) => {
        if (event.kind === 'completed' && isUserStopped(event.sessionId)) return
        const summary = next.byId[event.sessionId]
        const displayTitle = summary?.displayTitle ?? event.sessionId
        notifier.notify({
          ...event,
          title: displayTitle,
        })
      }
      diffSummaries(lastList, next, emit)
      diffCompletions(next, prevRunning, emit)
    } else {
      // Keep running bits current even while the list is still loading.
      for (const summary of Object.values(next.byId)) {
        prevRunning.set(summary.id, summary.running === true)
      }
    }
    lastList = next
  }

  /** React to the page becoming visible/hidden/focused/blurred. */
  function handleViewChange() {
    const nextViewing = isViewing()
    if (viewing && !nextViewing) {
      // 手机端不在离开时补发：待处理事件在边沿那一刻已经提醒过（页面可见时由本插件发，
      // 不可见时由 App 原生监控器发）。离开再补一条 = 同一件事第二个提示。
      if (!isMobile()) remindOnLeave()
    }
    viewing = nextViewing
  }

  /**
   * 页面重新可见 → 打开一段"只重建基线"的窗口。
   *
   * 用 `visibilitychange` 而不是 `isViewing()`：WebView 手里 `hasFocus()` 不一定为真，
   * 但恢复时一定会派发 visibilitychange。
   */
  function handleResumeRebase() {
    if (typeof document === 'undefined') return
    if (document.hidden) return
    if (!isMobile()) return
    rebaseUntil = Date.now() + RESUME_REBASE_MS
  }

  notifier.start()
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', handleViewChange)
    window.addEventListener('visibilitychange', handleResumeRebase)
    window.addEventListener('focus', handleViewChange)
    window.addEventListener('blur', handleViewChange)
  }
  const unsubscribeList = sessions.list.subscribe(onListChange)

  return () => {
    unsubscribeList()
    if (typeof window !== 'undefined') {
      window.removeEventListener('visibilitychange', handleViewChange)
      window.removeEventListener('visibilitychange', handleResumeRebase)
      window.removeEventListener('focus', handleViewChange)
      window.removeEventListener('blur', handleViewChange)
    }
    notifier.stop()
  }
}

    exports.name = name;
    exports.inject = inject;
    exports.diffSummaries = diffSummaries;
    exports.shouldDiffList = shouldDiffList;
    exports.apply = apply;
    return module.exports;
  }
});

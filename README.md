# dsh-notify

DSH 会话提醒插件：当任意会话需要用户介入时提醒用户，包括：

- AI 提问 / 请求批准 / 需要审阅计划（`question` / `approval` / `plan-review`）
- AI 完成了一轮对话，正在等待用户下一步指令（`running: true → false`）

普通的中间工具调用不需要用户过目，因此不会触发提醒。

## 行为

- **PC 端**
  - 页面可见时：页面边缘闪烁提示 + 短促提示音 + 轻量弹条。
  - 页面在后台/未聚焦时：浏览器标签页标题闪烁 + 短促提示音。
- **移动端（一次事件只出一个提示）**
  - `navigator.vibrate()` 震动（跟随 Android 系统震动设置）。
  - 一条系统通知就是提示本身；**通知发出去后不再叠加网页内弹窗**，避免"一次完成、两种提示"。
    只有原生通道拿不到时（无 `themeBridge`、`Notification` 被拒）才回退网页弹窗 + 提示音。
  - 在 TermuxLauncher 内嵌 WebView 中走 `window.themeBridge.notifyEx(json)` 调原生通知，
    载荷与 App 的 `POST /v1/notify` 完全一致（`key` 是跨来源去重键）。
  - **应用外提示（锁屏/通知栏/悬浮窗）由 TermuxLauncher 的 `DshEventMonitor` 负责**：
    它直接监听 DSH 本地 `/api/events.mux` WebSocket 流，即使 WebView 被暂停或用户切到其他应用，
    也能在 AI 提问、请求批准/审阅、完成一轮时发出 Android 系统通知。
  - **分工规则（本插件不再和原生监控器抢）**：
    - 页面**可见**（App 前台且停在该页）→ 本插件发通知；此时 `DshEventMonitor` 因 `webVisible`
      为真而静默。
    - 页面**不可见**（App 退到后台 / 别的服务页）→ 本插件**不发**，全部交给 `DshEventMonitor`。
    - 页面从后台恢复后 1.5 秒内的快照差异只重建基线、不提醒：那是 WebView 积压事件的重放，
      后台那一段原生监控器已经发过了（这正是"同一条完成提示弹两次"的来源）。
    - 同一 `key` 在本页 15 秒内只提醒一次（慢路径兜底：原生去重窗口只有 6 秒）。
    - 手机端不再在"离开页面"时补发待处理提醒（边沿时已经提醒过一次，补发就是第二次）。


## 事件识别

- `pendingInteraction` 从无到有，或从一种 pending 切换为另一种：
  - `question`：AI 提问，需要用户填写/回答
  - `approval`：需要用户批准
  - `plan-review`：需要用户审阅计划
- `running` 从 `true` 变为 `false`，且没有 pending：
  - 表示 AI 完成了一轮对话，正在等待用户下一步指令
  - 如果是**用户主动停止/终止**的会话（最新 assistant 节点带 `interrupted`），不提醒
- 插件启动后第一次列表 `ready` 作为基线，已经存在的 pending / 已完成状态不会补提醒。
- 点击弹窗会切换到对应会话；切换到该会话后即视为已看到，不会重复提醒。

## 安装（开发/本地）

```bash
cd ~/.dsh/profiles/web
# package.json dependencies 增加:
#   "@dsh-external/dsh-notify": "link:/home/hiro/projects/dsh-notify"
# cordis.patch.yml 增加:
#   - insert:
#       - id: dsh-notify
#         name: '@dsh-external/dsh-notify'
```

## 说明

- 首次使用时若浏览器通知权限为 `default`，插件会在第一次点击/触摸页面时请求通知权限；
  拒绝后仍保留网页内弹窗与提示音/震动。
- 插件本体纯客户端实现，不上传任何数据；Android 应用外提醒由 TermuxLauncher 在本机监听 DSH 本地 API 完成，同样不出本机。
- Android 应用外通知依赖 TermuxLauncher 新版本（含 `DshEventMonitor`）；只安装本插件时仍以应用内弹窗/震动为主。

## 构建与测试

```bash
cd ~/projects/dsh-notify
npm run build:client   # 生成 lib/client.bundle.js（DSH loader 包装）
npm test               # 单元/行为测试
```

测试覆盖：
- `pendingInteraction` 边沿识别；
- 完整一轮结束（`running: true → false`）识别；
- 首次 ready 基线不触发旧 pending / 旧完成状态提醒；
- `completed` 标志单独变化不触发提醒；
- DSH `__ModuleLoader__.load` 包装正确；
- 移动端震动 + 系统通知路径；
- TermuxLauncher 原生 `themeBridge.notify()` 优先路径；
- 一次事件只出一条提示：App 内页面不可见时插件静默、可见时只发一条原生通知且不叠弹窗、
  同一 key 连发只提醒一次、回前台的积压重放不补发（`test/single-prompt.test.js`）。

## 生效方式与现场验证

- **只改客户端**：`npm run build:client` 之后，在 App 里**重新加载 DSH 页面**即生效
  （实测：`client.bundle.js` 的 mtime 一变，`/` 返回的引导清单里该插件的 `rev` 就变，
  `plugins/??@dsh-external/dsh-notify/client.js&rev=…` 会拉到新字节；不需要重启 dsh、不碰 localhub APK）。
- **现场验证一次真实提醒**：
  - `GET http://127.0.0.1:45900/v1/notify/last` —— 页面桥最后一次调用的原文（判断页面发没发）；
  - `adb logcat -b events -v time | grep 'notification_enqueue.*dsh_reminders'` ——
    通知真正入队的条形（一次事件应只有一条；`messages_high` 是低优先级通道）。


## 统一通知协议（与 TermuxLauncher / chat-engine 共用）

移动端优先调用 `window.themeBridge.notifyEx(json)`，字段与 `POST /v1/notify` 完全一致
（见 `termux-launcher/docs/localhub-notify.md`）：

```json
{
  "title": "会话名 · 已完成一轮",
  "text": "AI 已完成一轮对话，正在等待你的进一步指令。",
  "key": "turn:<sessionId>",
  "priority": "high",
  "sessionId": "<sessionId>",
  "serviceId": "harness"
}
```

`key` 是跨来源去重键：TermuxLauncher 的 `DshEventMonitor` 也会对同一事件发一条，
key 相同 ⇒ 原生侧 6 秒窗口只保留第一条，不再出现"一次完成弹两条"。

旧版 App 只有 `themeBridge.notify(title, body, tag)`，这里会把同一个 `key` 作为 `tag` 传下去，
行为一致；再退回浏览器 `new Notification()` 时也用 `key` 作 `tag`（同 tag 覆盖）。

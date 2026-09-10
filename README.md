# dsh-notify

DSH 会话提醒插件：当任意会话需要用户介入时提醒用户，包括：

- AI 提问 / 请求批准 / 需要审阅计划（`question` / `approval` / `plan-review`）
- AI 完成了一轮对话，正在等待用户下一步指令（`running: true → false`）

普通的中间工具调用不需要用户过目，因此不会触发提醒。

## 行为

- **PC 端**
  - 页面可见时：页面边缘闪烁提示 + 短促提示音 + 轻量弹条。
  - 页面在后台/未聚焦时：浏览器标签页标题闪烁 + 短促提示音。
- **移动端**
  - `navigator.vibrate()` 震动（跟随 Android 系统震动设置）。
  - 已授权 `Notification` 时弹出系统通知，铃声/震动交给 Android 系统按当前通知设置处理；
    未授权或不可用时回退为网页内弹窗 + Web Audio 提示音。
  - 在 TermuxLauncher 内嵌 WebView 中，优先通过 `themeBridge.notify()` 调用原生通知，
    避免 WebView 不支持 Web Notification 导致只在应用内提示。
  - **应用外提示（锁屏/通知栏/悬浮窗）由 TermuxLauncher 的 `DshEventMonitor` 负责**：
    它直接监听 DSH 本地 `/api/events.mux` WebSocket 流，即使 WebView 被暂停或用户切到其他应用，
    也能在 AI 提问、请求批准/审阅、完成一轮时发出 Android 系统通知。
  - 始终显示网页内弹窗，避免用户错过；点击弹窗会切换到对应会话。

## 事件识别

- `pendingInteraction` 从无到有，或从一种 pending 切换为另一种：
  - `question`：AI 提问，需要用户填写/回答
  - `approval`：需要用户批准
  - `plan-review`：需要用户审阅计划
- `running` 从 `true` 变为 `false`，且没有 pending：
  - 表示 AI 完成了一轮对话，正在等待用户下一步指令
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
- TermuxLauncher 原生 `themeBridge.notify()` 优先路径。

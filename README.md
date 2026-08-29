# dsh-notify

DSH 会话提醒插件：当任意会话的 AI 提出需要用户处理的问题（question / approval / plan-review），
或某个会话完成后台任务/工具调用时，用浏览器能力提醒用户。

## 行为

- **PC 端**
  - 页面可见时：页面边缘闪烁提示 + 短促提示音 + 轻量弹条。
  - 页面在后台/未聚焦时：浏览器标签页标题闪烁 + 短促提示音。
- **移动端**
  - `navigator.vibrate()` 震动（跟随 Android 系统震动设置）。
  - 已授权 `Notification` 时弹出系统通知，铃声/震动交给 Android 系统按当前通知设置处理；
    未授权或不可用时回退为网页内弹窗 + Web Audio 提示音。
  - 始终显示网页内弹窗，避免用户错过；点击弹窗会切换到对应会话。

## 事件识别

- `pendingInteraction` 从无到有（`question` / `approval` / `plan-review`）→ “AI 需要处理”。
- 非当前会话 `running` → idle（列表 `completed` 标记）→ “AI 已完成任务/工具调用”。
- 当前会话快照新增 `tool-result` 节点 → “AI 完成了一次工具调用”。

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
- 纯客户端实现，不上传任何数据。

## 构建与测试

```bash
cd ~/projects/dsh-notify
npm run build:client   # 生成 lib/client.bundle.js（DSH loader 包装）
npm test               # 单元/行为测试
```

测试覆盖：
- 列表快照中 `pendingInteraction` / `completed` 边沿识别；
- 当前会话 `tool-result` 新节点识别；
- 移动端震动 + 系统通知路径。

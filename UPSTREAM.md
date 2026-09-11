# UPSTREAM

## 上游
- 无外部上游；本项目为自研 DSH 插件。
- 仅有 TermuxLauncher 配套的 `DshEventMonitor`（App 侧应用外通知监听）。

## 本仓库
- 私有仓库（canonical）: git@github.com:usernameisnotavailable159/dsh-notify.git
- 默认分支: `master`
- 手机路径: `~/projects/dsh-notify`（profile 通过 `link:` 引用）

## 同步策略
- 无上游同步流程；本仓库直接维护。
- 修改后跑 `npm test`，保持 `lib/client.js` 与 `lib/client.bundle.js` 同步，再 push `origin master`。

## 当前本地补丁
- WebView 内优先调用 TermuxLauncher `themeBridge.notify()`
- 应用外通知依赖 App 的 `DshEventMonitor`
- 移动端原生通知/震动测试

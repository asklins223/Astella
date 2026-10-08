# 手记与气泡切换时的回复状态 · 2026-10-08

根因在 `CompanionChatProvider` 打开手记后的记录读取 effect：读取成功无条件写 `ready`，读取失败写 `error`，覆盖仍由发送链路持有的回复状态。SSE 与回复认领仍在运行，所以正文稍后照常送达。

记录读取现在只在开始时没有发送、读取期间也没有发生新的发送或停止时更新会话状态。已开始的回复及其失败/完成由发送链路收尾，手记开关不接管它。

自动验证：

- 新增 `companion-chat-session.history-status.test.tsx` 的 6 项回归；修复前其中 5 项失败，修复后全部通过。
- 覆盖反复开关、回复完成、记录读取失败、读取期间开始发送、记录晚于回复失败返回、空闲读取失败重开恢复。
- 与 `companion-note-explanation`、`companion-chat-session`、`companion-chat-session.bridge-view`、`CompanionHistoryDrawer.journal` 一起运行，5 个文件 46 项通过。
- 桌面端 `npm run typecheck` 修改前后均通过。

真实窗口验证：运行中的 Electron 开发窗口（`localhost:5173`，companion-probe 工作区），通过手记发送“这是界面回归检查。请用一小段话解释为什么天空是蓝色的。”，在回复未完成时返回气泡、重新打开手记。气泡保留过程状态；手记保留“正在回复…”和“停止这一轮”，正文随后完整送达，等待状态与停止按钮正常收起。观察了完成后的实际排版与伴星位置。

验证范围为当前前端开发窗口与上述相关用例；未运行全项目回归。网络抖动和迟到记录的竞态由自动用例验证，未在实际窗口人为制造网络故障。

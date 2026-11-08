# 桌面对话显示纠正（2026-11-08）

用户要求与 iOS 一起修正准备、活动日志、逐字显示和气泡，参考 beUI Message、Streaming Response、Agent Activity 与 Agent Loading States。保留桌面配色与气泡。

实现涵盖 `CompanionJournalTimeline`、`CompanionRunTraceView`、Markdown 字形显现、正式消息显现注册、分句缓冲和头顶气泡阅读钟。运行中的真实思考／工具使用一个限高日志，工具详情手动展开；准备态只扫光当前状态文字。逐字更新留在回复区域，正式消息或音频完成不冲掉剩余字，等待网络也不积累下一包的显示额度。

工作区原有修改保留。修改前的相关文件备份及检查日志在同级手机仓库 gitignore 的 `build/chat-audit-2026-11-07/desktop-before/` 与 `desktop-*-tests.log`。真实 Electron 窗口使用运行中的开发应用、真实账号和 API；未新增产品演示夹具或发版包。

本轮实测与最终状态统一记录在手机仓库 `docs/testing/ios-desktop-chat-response-2026-11-08.md`，收尾时在这里补充最终命令结果。

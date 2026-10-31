# Agent 收敛为一次调用：撤掉线上审查与资源分流

日期：2026-10-30（Asia/Shanghai）。状态：本地代码修改与主要回归完成；未部署。接续[全量交付核对](./agent-completion-no-bypass-2026-10-30.md)，但方向相反：完成度审查退回离线，不再参与发布。

## 改了什么

- **线上不再有完成审查器**：删除 `reviewCandidate`、`settleUnverifiedCompletion`、completion guard 的运行时调用和恢复时的二次核对。模型正文直接进入原有发布链路。
- **不再有第二次资源分类调用**：`decideCompanionEntry` 只保留为离线/探针能力；`startCompanionAttention` 不再请求资源档位，`speculative` 恒为 false，`verifyDelivery` 删除。每轮线上只跑一次 agent。
- **恢复流式**：`deferPublication` 只在 `toolChoice === "required"` 的工具步启用；普通聊天边生成边下发。
- **回执合同保留并收紧**：`companion_finish` 的 requirements 删掉 `textOnly` 自证；已满足的要求必须引用本轮真实成功回执，没有动作或读取的普通答复可以省略 requirements。没读过就宣称读过的 finish 会被结构性拒绝。
- **图片快速路径**：有本次原图/附件的回合用结构标记 `imageTurn`，在 `direct_fast` 下关闭思考并直接看原图；不按措辞判断。

## 速度

同一套 live 夹具、真实 MiMo/DeepSeek、独立 PostgreSQL，不含客户端窗口：

| 场景 | 旧（审查 + 资源分流） | 现在（一次 agent） |
| --- | --- | --- |
| 早上好 | 10.458s，核对完才出字 | **1.569s，首字 1.154s** |
| 纯图片 | 32.452s（资源分流判 work 后深度思考） | **2.268s，首字 1.043s**（图像快速路径） |
| 私人笔记 | 37.657s（强制错档 + 注入草稿，旧夹具） | **11.654s，真实读取成功，回答真实口令** |

问候提升约 **85%**；纯图的 2.268s 来自加入 `imageTurn` 后的一次 live。最后一次撤销强制思考的构建里，MiMo 曾首字超时切到副档，副档把蓝色测试图说成黑色（8.591s）；图像链路还差一次最终构建的 live 复验。三条样本的审查调用都是 **0**。

## 验证

- Worker 完整 `npm test`：**1900/1900**，正常退出（`outputs/agent-speed-restore-2026-10-30/worker-regression-3.log`）。
- 完成套件重写为 9 项并全部通过：流式、无审查、真读、无回执 finish 被拒后补读、记忆写入、主动发言、静默、旧 checkpoint、纯图、三条独立消息。
- 四个包类型检查通过（Worker/Shared/API/Desktop）；加入 `imageTurn` 后的定向 entry 测试 8/8 通过。最后一次全量回归与 typecheck 因工作区 I/O 抖动和既有 watchdog 挂起没有重跑到底。
- 全量回归复跑时既有 `companion-output-watchdog` 子进程再次挂起，已终止本次任务进程；这不是本轮引入的行为，前一轮已记录同一夹具问题。
- 本次收尾期间工作区 I/O 间歇不可读，证据文件复制和最后一次 live 未全部完成；未部署、未提交；临时数据库已删除。

## 取舍

- 零读取的 chat/answer 编造不再由宿主拦截；正确性回到 agent 自己先读。live 私人笔记样本确实读取了真实笔记并回答真实口令；如果模型不读，客户端会先看到它编的内容。这是本次方向确认后的明确取舍。
- 资源分流取消后默认 `direct_fast`，复杂任务需要 agent 自己调用 `companion_deepen`；不再由分类器替它决定思考档。
- 审查器仍在仓库里，只用于离线和探针，不进入用户等待路径。

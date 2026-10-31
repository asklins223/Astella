# 伴星结构性缺陷清理：13 项真实模型全量通过

日期：2026-10-31（Asia/Shanghai）。状态：本地实现与验证；**未部署**，未打新 tag。接续[稳定性复查](./agent-stability-live-review-2026-10-31.md)。上一轮用真实模型跑出 3 个结构性问题，本轮把它们连同后续暴露的问题一起修完。

## 方法

`workers/ai-worker/src/live-tests/companion-task-matrix-20261025.ts`：真实 HTTP → 真实 worker → 真实模型（主 `mimo-agent/mimo-v2.6-flash`，副 `tokenrhythm/deepseek-v4.1-flash-1017`）→ 独立 PostgreSQL 逐项查库。13 个任务覆盖笔记、记忆、提醒、自我记事、观察统计、计算、流程图、页面跳转、分条发言、目标创建。

环境侧先修好才能跑：Docker 构建缓存 21.85 GB + 悬空卷 1.2 GB、项目 `work/`+`tmp/` 2.2 GB 已清；一个运行近 12 小时的 Android 模拟器（`-wipe-data`，250% CPU）已暂停；工作区里与真仓库只差一个下划线的同名影子目录已清除。这些是本机路径间歇失效的真正原因。

## 修了什么（六个提交）

| 提交 | 缺陷 | 判据 |
| --- | --- | --- |
| `4bcfe079` | 上一轮：主动发言重发刚说过的问候 | 比对这条会话最近 24 小时全部助手正文，问候不再豁免 |
| `c550ef45` | 同一 delta 内两个工具调用被 `index` 合并成一个（文本被字符串拼接） | 有 `id` 按 `id` 累积，缺 `id` 才退回 `index` |
| `9c58f778` | 模型称"图已经画好了"但零工具调用 | 纯正文交付前校验完成态声明，无落库写回执即纠正一次 |
| `5bbaf385` | 心算 `347×29=10063` 冒充"核对过了" | 本轮材料里查不到出处的算式结果（逐段、只认真实运算符）要求用 `observe.calculate` |
| `2bf74153` | 上一条把"搞定了"这类闲聊误判为虚假声明 | 非动作请求时传 `conversationOnly` |
| `05f1f825` | 「分两条」只发一条；"没有定时提醒能力"（工具就在工具面里） | 显式条数（2–6）恢复投递契约；能力否定与在场工具比对后纠正 |
| `11edd6d3` | 没查就说"最近七天没有学习记录"（该空间其实有笔记和提醒） | 本轮零读取时，空数据断言要求先 `observe` |

共同形状：这些判据原先要么没有生产调用方，要么其输入字段来自已删除的分类器。现在都改成**结构判据**（回执、工具面、显式数字），不猜措辞含义。

## 验证

| 项目 | 结果 |
| --- | --- |
| Worker 完整 `npm test` | **1912/1912** |
| Worker `tsc --noEmit` | 通过 |
| 真实模型 13 项任务 | **13/13 全部产生正确回执** |

13 项逐项结果（真实模型、真实库）：

| 任务 | 终态 | 耗时 | 成功工具数 |
| --- | --- | --- | --- |
| 笔记创建 | assistant.final | 10.1s | 3 |
| 笔记读取 | assistant.final | 1.9s | 0 |
| 记忆保存 | assistant.final | 19.9s | 3 |
| 记忆召回 | assistant.final | 2.5s | 0 |
| 提醒创建 | assistant.final | 8.6s | 3 |
| 提醒列出 | assistant.final | 5.4s | 2 |
| 自我记事 | assistant.final | 13.4s | 3 |
| 观察统计 | assistant.final | 19.3s | 2 |
| 计算核对 | assistant.final | 49.0s | 3 |
| 流程图 | assistant.final | 25.5s | 3 |
| 打开页面 | assistant.final | 31.5s | 3 |
| 分条发言 | turn.completed | 7.7s | 2（两次 `say.publish` 均成功） |
| 目标创建 | assistant.final | 49.7s | 7 |

修复前失败的三项，现在都真的调用了对应工具：`observe.calculate:succeeded`、`visual.diagram:succeeded`、`attention.write.schedule_reminder:succeeded`；分条从 1 条变 2 条。闸门在整轮里触发 8 次纠正。

## 剩余问题

- **矩阵最后一项"遗忘确认"超时**：提案确实生成（`companion_action_proposals` 有 `waiting` 行，`memory.write.forget` 状态 `expired`），是矩阵等待确认事件的方式没接上，不是产品行为。确认卡流程此前已通过，本轮未改动它。
- 真实模型耗时波动大（1.9s–49.7s），样本少，不构成延迟基准。
- 未部署；本轮只提交到 `main` 本地仓库，尚未推送/打 tag。

## 落地

六个提交在 `main` 本地（最新 `11edd6d3`）。三个新增判据模块与测试：`companion-action-claims.ts`（动作/能力/空数据）、`companion-message-delivery.ts`（条数契约）、`pi-wire-observation.ts`（调用身份）；对应回归 `companion-message-count-contract.test.ts`、`pi-wire-observation.test.ts`、`companion-action-claims.test.ts`。

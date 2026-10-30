# Agent 交付核对：移除分档免检

> 后续：[速度恢复与图片交付修复](./agent-speed-restore-and-image-delivery-2026-10-30.md)撤掉了本轮的线上审查闸和资源分流，并修好图片交付。下文保留当时的实现与验收状态。

日期：2026-10-30（Asia/Shanghai）。状态：本地修复与验证完成；未部署。接续[上一轮来源核对与上下文优化](./agent-completion-optimization-2026-10-30.md)，保留上一轮的失败与有限样本结论。

上一轮只在实际工具调用之后核对来源，留下六条不经过核对的公开路径。本轮把核对移到所有公开正文之前，并给恢复缓存加上发布范围身份。

## 复现的问题

数据库反例覆盖六条路径：

1. chat 分档直接交付正文；
2. answer 分档直接交付正文；
3. 投机 chat 草稿在资源判断后流出；
4. 首个工具调用前的前导文字随流式下发；
5. 批注收尾附带的可选语音不核对；
6. 主动参与整轮跳过语义核对。

恢复还多一条：`settled` 缓存直接返回，不重新核对当时没有核对过的正文。

修改前的完成套件 24 项中 16 项通过、8 项失败，失败样本直接交付了编造内容：

- chat / answer 零读取都输出了 `口令是 INVENTED。`；
- 流式样本把 `零读取口令是 INVENTED。` 和 `工具还没执行，口令是 INVENTED_PREAMBLE。` 发给了客户端，后者还叠上了宿主核对说明；
- 批注收尾输出了 `顺便读了你的私人日记，口令是 INVENTED_ANNOTATION。`；
- 两个主动参与样本输出了 `我读了你的私人日记，口令是 INVENTED_INITIATIVE。`；
- 旧缓存输出了 `旧版零读取口令是 LEGACY_INVENTED。`。

[修改前日志](./evidence/agent-no-bypass-2026-10-30/postgres-before.log)保留。

## 修改

1. **所有公开正文先核对。** 每个模型步骤的正文都延迟发布（`deferPublication: true`），资源分档只影响推理与取数方式，不再决定是否核对。投机 chat 草稿和首个工具调用前的前导文字走同一核对。
2. **删除分档与回执开关。** 移除 `completionProtected` 和 `companionHasCurrentToolReceipts`。核对证据每次按实际请求、真实工具回执、已发布消息和宿主材料生成。
3. **批注收尾核对实际要说的话。** 批注已交付、可选语音尚未发布时，用 `said` 正文进入核对；已经发布的语音不重复。
4. **主动参与。** 有正文、待执行操作、已发布消息或真实写入时照常核对；只有确实没有输出时才允许安静结束。`companion_finish` 新增显式 `silent` 字段，仅主动参与且无待交付内容可用；用户请求、正文或实际写入不能用它静默省略。
5. **恢复缓存带策略身份。** checkpoint 记录 `deliveryReviewPolicy`（本轮发布范围策略 `b6d415a9…`）。没有这个身份的旧 `settled` 缓存会重新核对、丢弃未发布的旧正文段，并按真实回执继续修复。审查政策哈希保持 `8ad1c362…` 不变。
6. **图片与请求身份。** image-only 请求没有文字，核对请求改为真实消息身份 `{kind:"user_message", userMessageId, text, imageAttachments, inlineImageParts}`，不带图片字节，也不编造一句“用户要求”。定位当前请求时跳过宿主追加材料；图片只挂到真实用户消息上。
7. **请求来源。** 核对证据的 `request` 来自实际用户输入或宿主参与条件（`requestSource`），不再从历史消息里猜。

没有新增关键词、词表或按措辞判定的规则；权限、对象、版本、回执和发布记录仍是核对的边界。

## 自动化验证

| 项目 | 结果 |
| --- | --- |
| 修改前完成套件 | 24 项：16 通过、8 失败 |
| 修复后完成套件 | 24/24 |
| 最终完成套件（含 image-only） | 26/26 |
| 最后一行修改后重跑完成套件 | 26/26 |
| 8 份相关 PostgreSQL 集成 | 98/98（最后一行修改之前的代码状态） |
| Worker 完整 `npm test` | 1,904/1,904，128.96 秒，正常退出，无过滤或跳过 |
| 定向单测 | 35/35 |
| 文件规模、目录扇出、层次依赖检查 | 17/17 |
| Worker `npm run typecheck` | 通过 |
| `git diff --check` | 通过 |

8 份相关集成在最后一次批注收尾修改之前运行；受这次修改影响的完成套件已在新代码上重跑 26/26，没有把两个代码状态混称为同一快照。

## 真实模型与原生循环

使用配置中的真实作者/审查模型、实际原生工具循环和独立 PostgreSQL 运行 4 项：

| 样本 | 实际结果 | 总耗时 | 核对调用 | 实际工具结果 |
| --- | --- | --- | --- | --- |
| 强制 chat 分档 + 注入零读取草稿 | 草稿被拒（`COMPLETION_NOT_VERIFIED`），随后真实读取笔记并回答真实口令 | 37.657 秒 | 2 次 | `notes.read.read` 成功 1 次 |
| 强制 answer 分档 + 注入零读取草稿 | 同上，最终正文含真实口令，无编造内容 | 35.092 秒 | 2 次 | `notes.read.read` 成功 1 次 |
| 普通问候 | 正常问候，未写入记忆或笔记 | 10.458 秒 | 1 次 | 无 |
| 只发图片（强制 chat） | 描述 64px 纯蓝测试图，没有编造图片内容 | 9.379 秒 | 1 次 | 无 |

两个强制样本的资源判断和首个草稿由夹具控制，并在 trace 中标注；其余环节使用真实模型与真实数据库。审查器对注入草稿给出了 `revise`，驱逐草稿后循环重新取证，最终 `release`。没有把预期标签发给模型，也没有在调用后调整政策。

这 4 项是小样本，不构成总体准确率，也不是延迟基准。四项均通过交付判据。[结果](./evidence/agent-no-bypass-2026-10-30/runtime-live-results.json)、[日志](./evidence/agent-no-bypass-2026-10-30/runtime-live.log)。

## 保留的失败记录

- 夹具迭代保留了 3 份日志：前两次 15/8，第三次 16/7；前两次含夹具错误，第三次只剩真实绕过，补齐旧缓存反例后为 8 项。[迭代一](./evidence/agent-no-bypass-2026-10-30/postgres-first-fixture-iteration.log)、[迭代二](./evidence/agent-no-bypass-2026-10-30/postgres-fixture-iteration-2.log)、[迭代三](./evidence/agent-no-bypass-2026-10-30/postgres-fixture-iteration-3.log)。
- 中途类型检查失败过一次，原因是两处测试夹具缺少必填字段；修正夹具后通过，原始日志保留在 `outputs/agent-no-bypass-2026-10-30/worker-typecheck-final.log`。
- 没有删除失败日志，也没有把中间通过结果当作最终验收。

## 剩余边界

- 审查器仍是模型，可能误放、误拦或不可用。数据库反例多数使用脚本化审查器；真实审查只有上面 4 个 live 样本。
- 每次公开正文都多一次核对调用：闲聊 10.5 秒里含 1 次核对，两个被拒样本各 2 次核对、约 35–38 秒。这不是延迟改进，也不保证首字更快。
- 流式仍只提供过程进度，正文要等核对后才能看到。
- 恢复旧缓存会多一次核对调用。
- 只执行了完成套件和 8 份相关集成，没有整包运行 `test:companion-integration:postgres` 的全部套件。
- 没有客户端窗口、生产 handler 装配或部署验收。
- 检索分词、停用词、协议枚举/格式、权限与版本等其余边界沿用[词表清理记录](./agent-lexical-cleanup-and-boundaries-2026-10-29.md#仍然存在的规则)。

## 身份与清理

本轮开始前保存 557 份 `workers/ai-worker/src` 文件快照，上一轮变更文件的源码身份全部匹配（`previousPhaseIdentityMismatches` 为空）。配置保持 `mimo-agent / mimo-v2.6-flash` 与 `tokenrhythm / deepseek-v4.1-flash-1017`，`config/ai-platforms.json` 的 SHA-256 未变：`375f560bbb1036594c816fa35165bb3f58c0af42b163f7480e3638056a86097b`。

本轮独占测试容器 `astella-no-bypass-20261030` 已停止删除；没有重启开发数据库或终止其他会话。未部署、未提交、未推送，未执行生产迁移。工作区其他改动原样保留。

[变更文件与前后哈希](./evidence/agent-no-bypass-2026-10-30/changed-files.json)、[本轮差异](./evidence/agent-no-bypass-2026-10-30/no-bypass.patch)、[验证摘要](./evidence/agent-no-bypass-2026-10-30/verification.json)和[证据哈希清单](./evidence/agent-no-bypass-2026-10-30/manifest.json)存于独立目录。完整原文件与全部日志保留在 `outputs/agent-no-bypass-2026-10-30/`，不改写上一轮证据。

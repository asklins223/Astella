# 伴星提速：撤掉线上复审与资源分流，修好图片交付

日期：2026-10-30（Asia/Shanghai）。状态：本地实现与验证完成；**未部署**，未新增生产迁移，未做设备/界面验收。接续[移除分档免检](./agent-completion-no-bypass-2026-10-30.md)。本轮分两段：前一段按用户要求撤掉线上语义复审与资源分流；后一段核对图片是否真的送到模型、备用模型能否处理同类输入，并修掉过程中查出的实现问题。前一份记录里指向的 `agent-speed-restore-2026-10-30.md` 从未生成，链接改指本文。

## 结论

- 线上语义复审与资源分流已从普通运行链移除。权限、对象、版本、真实回执与真实写入的核对仍在；主动参与的安静结束改用显式 `companion_finish(silent=true)`。
- 取消分流后暴露了图片链路的真实断点：快速档仍按旧分支关闭附件加载，对象存储里的原图不会送给模型；备用模型切换、退化修复、工具降级三个入口只查上下文窗口，不查视觉；两种兼容接口把纯文本模型声明成可看图。均已修复。
- 终态收尾（批注成功、安静结束、截断保留前缀）没有落 `step_count` / `tool_call_count`，真实完成的一轮会显示 0 步 0 工具。已修复。
- 纯色合成图在完整上下文里会被两个模型不稳定地描述成空白，这是模型识图局限，不是交付问题；同一上下文里的形状图识别正确，出站像素哈希每次都一致。未修复，单独记录。

## 复现的问题

1. **快速档不加载原图。** `companionTurnMessagesWithImages` 只看 `args.turnImagesSentDirectly`，而运行时对 `casualStep` 强制传 `false`。普通首轮走快速档，对象存储里的原图因此不加载；上一轮发图、这一轮只用文字追问时也丢图。此前只有内联图片的测试，正好绕过对象存储。
2. **备用模型只看窗口。** `companionProviderFitsRequest` 只校验 `contextWindowTokens`；纯文本备用模型也能通过，像素被静默丢弃后照常编造描述。`OpenAICompatibleProvider` 与 `OpenCodeGoProvider` 还把 `visionModelId` 无条件设成模型名，声明层面就错了。
3. **另两个降级入口没查视觉。** 退化修复阶梯（`companion-answer-repair`）和 required-tool 降级（`companion-tool-call-ledger`）都会把同一步请求交给备用 provider，均未检查视觉能力。
4. **宿主图片标签被当成提问。** 内联图片前的元数据写作“以下附图的真实来源身份：…”，主模型把它当用户问题回答。现已改为明确的附件标识，并在送达记录里说明它只用于关联图片。
5. **终态收尾不记步数。** 批注成功、安静结束、截断保留前缀三处 `return` 前只调用 `finishBoundary`，没有 `updateRunMeta({stepCount,toolCallCount})`；批注集成测试因此读到 `step_count=0`。
6. **批注测试的旧前提。** “完整写入就是终态”用例断言附带短句产生 0 条消息，靠的正是已删除的措辞收尾抑制。按现在的语义，模型显式调用 `companion_send_message` 就是交付。

## 修改

| 范围 | 当前行为 | 保留的边界 |
| --- | --- | --- |
| 首轮/追问的图片 | 按账号图片外发政策与主模型视觉声明决定；快速档不再单独关闭，历史原图随各自来源消息重发 | 对象存储身份、字节上限、单轮图片预算、真实送达记录 |
| 备用与降级 | `companionProviderFitsRequest` 在含像素时要求目标模型声明视觉；未声明或未知即不切换 | 窗口容量、调用与时限预算、原 provider 错误语义 |
| 视觉声明 | 两种兼容接口只在 `modelProfile.vision === true` 时暴露 `visionModelId` | 模型档案是唯一来源 |
| 图片元数据 | `COMPANION_IMAGE_ASSET_LABEL` + 送达记录说明；只用于关联图片，不代表用户提问 | 已送达/未送达的真实身份 |
| 终态收尾 | 批注、安静、截断三处同样写 run 元数据 | 真实回执、落下的写入、取消与租约校验 |
| 批注测试 | 断言显式短句按原样交付一次，模型调用仍为 1 次 | 批注正文、运行状态、步数、无第二次模型调用 |

线上语义复审与资源分流的移除沿用前一段的状态：普通运行链不再有额外的语义审查调用与分档开关；`companion-completion-audit.ts`、`companion-completion-guard.ts` 与 `companion-entry-decision.ts` 已不在生产调用链上（前两者作为离线评估材料保留，后者只余测试）。本轮没有改 `config/ai-platforms.json`。

## 自动化验证

| 项目 | 结果 |
| --- | --- |
| Worker 完整 `npm test`（本轮开始前） | 1,900/1,900 |
| Worker 完整 `npm test`（最终） | 1,903/1,903 |
| shared 完整 `npm test` | 534/534 |
| Worker 真 PostgreSQL 集成（7 份） | 84/84 |
| Worker 批注真 PostgreSQL 集成 | 5/5 |
| Worker 主动参与真 PostgreSQL 集成 | 34/34 |
| API 记忆 HTTP 真 PostgreSQL 集成 | 21/21 |
| 文件规模、目录扇出、层次依赖检查 | 17/17 |
| shared / API / desktop / worker `npm run typecheck` | 全部通过 |
| `git diff --check` | 通过 |

完整回归使用包内原始测试命令，没有过滤或 force-exit。数据库使用独立临时 `pgvector/pgvector:pg16` 实例，Worker/API 分别使用受限角色。

主动参与那套集成此前不在常用验收集里；本轮第一次运行是 31/34，三条失败都来自已退役的旧策略：

- “安静收尾”的散文不再按措辞丢弃，改为断言显式发言按原样交付一次；
- 启动考虑不再断言宿主强制关闭思考（入口不再有分类器决定这一点）；
- “分两条”不再由宿主按用户措辞数条数，改为断言一条显式消息就是终态、不追加模型调用。

修改后 34/34。旧日志保留在[证据目录](./evidence/agent-speed-review-2026-10-30/postgres-initiative-before.log)。

## 真实模型与原生循环

五个样本跑真实配置模型、原生工具循环、独立 PostgreSQL 与临时 MinIO，图片以对象存储中的真实字节送入模型，判据固定：

| 样本 | 结果 | 总耗时 | 首个字 | 实际工具 |
| --- | --- | --- | --- | --- |
| 读私人笔记并回答口令 | 通过，读到真实口令 | 15.98 s | 14.89 s | `notes.read.read` |
| 问候 | 通过，无写入 | 7.59 s | 未触发回调 | 无 |
| 只发图片（主模型） | 通过，读出白底红圆 | 15.73 s | 14.66 s | 无 |
| 文字追问上一轮原图 | 通过，重发原图并读出红圆 | 5.25 s | 3.65 s | 无 |
| 只发图片（强制主模型首字超时，走备用） | 通过，备用模型读出红圆 | 4.70 s | 3.41 s | 无 |

- 当前副模型为 `tokenrhythm / deepseek-v4.1-flash-1017`，配置声明 `vision: true`；主模型为 `mimo-agent / mimo-v2.6-flash`，同样声明视觉。
- 每次出站的原图像素哈希都和夹具文件一致；备用用例由夹具注入一次带标注的首字超时，其余环节全部真实。
- 另做最小请求对照：短提示下两个模型对 64px 与 512px 纯蓝图都答“蓝色”（3/3）。

这些是小样本，不构成延迟基准；本轮没有宣称整体变快。

## 未解决与保留记录

- **纯色合成图。** 完整上下文、开放式提问时，主模型与备用模型都会不稳定地把纯蓝小图说成“纯白/占位图标”；同一上下文加一句“这张图是什么颜色？”备用模型答“蓝色”，白底红圆的形状图两次都读对。出站字节每次都正确。这不是交付缺陷，未做提示词特判；真实照片/截图的多分辨率验收尚未做。
- **主动轮的开思考。** 入口不再有分类器后，主动参与被当作“需要依据”的一轮，第一步走深度档；旧用例断言的“启动问候用轻思考”不再成立。这不属于本轮修复范围，没有改回按措辞或话题猜档；如果启动问候的等待时间需要更短，这是下一处可单独评估的入口。
- **时长。** 主模型本轮的首字在 14–15 s，备用模型 3–4 s；样本少，且与网络/端点有关，不能据此得出普遍结论。
- **离线完成度审查**仍只是离线材料，没有接回普通运行链。
- 未部署；没有生产迁移、没有真实设备窗口验收。

## 身份与证据

保留工作区既有未提交改动；本轮差异以 `outputs/agent-speed-review-2026-10-30/before/` 的工作快照为基线，批注测试以 `HEAD` 为基线，共 21 个文件。[变更清单与前后哈希](./evidence/agent-speed-review-2026-10-30/change-manifest.json)、[验证摘要](./evidence/agent-speed-review-2026-10-30/verification.json)、[真实模型结果](./evidence/agent-speed-review-2026-10-30/runtime-live-results.json)、[最小视觉对照](./evidence/agent-speed-review-2026-10-30/vision-probe-results.json)、[纯色图拆分实验](./evidence/agent-speed-review-2026-10-30/fallback-vision-bisect.json)、[主动参与集成（修复前 31/34）](./evidence/agent-speed-review-2026-10-30/postgres-initiative-before.log)。`config/ai-platforms.json` 未修改，SHA-256 仍为 `375f560bbb1036594c816fa35165bb3f58c0af42b163f7480e3638056a86097b`。完整日志、请求体与方法脚本在 `outputs/agent-speed-review-2026-10-30/`。

# Pi 模型兼容层实施与验收（2026-10-15）

用户确认引入 Pi 统一模型调用。接入维护中的 `@earendil-works/pi-ai@1.2.0`，统一 Worker 的模型传输适配；用户随后决定现役对话与文本生成仅保留小米，移除 OpenCode Go 模型与独立备用槽；权限、工具执行、持久化、上下文预算、队列、租约和伴星运行时继续由项目维护。没有引入第二套 Agent 循环或 Pi Extensions。

## 当前接线

| 槽位 | 平台 / 模型 | Pi 协议 |
| --- | --- | --- |
| `agent_turn` | MiMo / `mimo-v2.6-flash` | `openai-responses` |
| `text_generation` | MiMo / `mimo-v2.6-flash` | `openai-responses` |
| `companion_fallback` | 不配置 | 无独立备用请求 |

`config/ai-platforms.json` 已删除 OpenCode Go 及其他未启用的文本平台实例；对话与生成只配置 MiMo Responses，语音识别为 MiMo ASR。向量检索仍使用 SiliconFlow BAAI/bge-m3，语音合成仍使用现有 Qwen TTS。Pi 的通用双协议兼容测试与旧适配器代码仍可维护，但不会让未配置的 OpenCode 模型出现在现役模型清单中或参与调用。

入口为 `workers/ai-worker/src/lib/providers/pi-agent.ts`，由 `ai-provider.ts` 注册 Agent 与文本生成工厂。Pi 的 Chat / Responses 实现共用一套 run 方法；`pi-http-transport.ts` 将 SDK 的 fetch 接入 `postSseToPublicEndpoint`，保留 HTTPS、DNS 校验及 IP 固定、事务外出网约束、重试、熔断和取消。Pi 自身重试设为 0，避免叠加；模型输出额度由宿主档案决定，避免 SDK 的近似估算隐式缩小输出上限。

`pi-wire-observation.ts` 保留宿主的严格输出判据：工具参数须为真实且完整的 JSON 对象，不能因 SDK 修复半截 JSON 而执行；断流、输出截断、空结果和流/终态正文不一致分别失败。私有 phase 不进入正文，终答与 commentary 分开处理；完整 reasoning item 原样回放，Chat 的纯文本思考转入同一内部形状，工具 ID 在回调、结果和下一轮保持一致。实际宿主观察保持在发生位置。无工具回合依据 `supportsAssistantPhase`：明确无 phase 的模型增量交付 `output_text`，能力未知或支持 phase 的模型仍等待终态筛选；显式私有 phase 始终拦截。现役 MiMo 档案声明无 phase，显式 final phase 继续增量交付。

MiMo 只支持自动工具选择；required 步若没有调用会抛 `MODEL_TOOL_CHOICE_NOT_SUPPORTED`。当前不配置独立备用槽，宿主不会因这一错误再请求 OpenCode Go。DeepSeek required 工具步骤按既有网关约束关闭思考；不支持 none 的模型仅降到档案最低档，不宣称已关闭。OpenCode 请求保留实例内稳定的 session header。

## 验证

- 新增 `src/__tests__/pi-agent.test.ts`：真实 Pi parser + 分片 SSE 夹具，覆盖双协议工具续轮、思考回传、宿主观察、phase、参数损坏、required、HTTP 错误、断流/截断、终态补全、图片、预算、取消及跨协议回放。
- 相关回归：`ai-provider`、`opencode-go`、`openai-compatible-stream`、`companion-dialogue`、`companion-grounded-tutor-fixed-protocol`；shared 的平台思考参数、模型要求、HTTP 重试，以及 API 的 `config-service`。
- shared、api、desktop-client、ai-worker 的 `npm run typecheck` 通过。Worker 的 `npm run build` 通过；构建仍输出原有 `model-tokenizers.ts` / `companion-model-requirements.ts` 的 CJS `import.meta` 警告，本次没有宣称生产 CJS 启动已验收。
- Worker Docker 基础镜像升级至已核对存在的 `node:22.23.2-alpine3.23`，满足 Pi 的 Node >=22.19 要求；开发镜像重建后容器健康。容器内主 Agent 与文本槽均解析为 `v1-pi-openai-responses`，未配置独立备用槽。

真实网络脚本为 `workers/ai-worker/scripts/verify-pi-providers.ts`。只发送合成探针，不读写业务数据库，不输出凭据、提示词和思考正文；任一槽失败即返回非零，不能把 HTTP 失败当成验收通过。

```sh
cd workers/ai-worker
node --env-file=../../.env --import tsx scripts/verify-pi-providers.ts
```

MiMo 主模型已在本机和重建后的开发容器分别完成“工具调用 → 完整思考与调用回放 → 工具结果 → 流式终答”。小米单平台配置的容器样本耗时约 18.2 秒，工具调用 1 次，思考 item 1 个，终答流式字符 103，独立思考增量字符 118；后续请求用量为 input 121 / output 45 / total 166。文本生成通过能力工厂调用 MiMo，JSON 输出 `{"ok":true}` 核对成功，耗时约 765 毫秒，input 20 / output 6 / total 26。API 和 worker 重建容器后健康；相关测试与四包类型检查通过。

此前 OpenCode Go 的 403 订阅问题已随平台退出本次运行配置而解除依赖，不再需要恢复其订阅来验收当前配置。

本次额外修复：MiMo 注册 `text_generation` 能力与 Pi 工厂；API 的 `resolveTeachingModelConfig` 支持 MiMo Responses，避免改完文本槽后 Fastify 路由装配抛错。回归用实际配置启动讲解/演示配置解析，并核对 Responses JSON 正文与 API-key 头。真实网络脚本现在分别验主模型工具续轮及文本生成 JSON，任一失败返回非零。

## 官方依据

- [Pi 模型层 README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md)：包名、统一消息/流事件、按模型 API 选择实现、自定义 fetch。
- [MiMo Responses API](https://mimo.mi.com/docs/en-US/api/chat/responses)：原生工具、reasoning 与流事件、工具选择约束。
- [OpenCode Go 官方目录](https://opencode.ai/docs/go)：逐模型的不同 endpoint 与当前 inference 地址；DeepSeek 使用 Chat Completions，Muse 使用 Responses。

## 首字速度复核（2026-10-15）

Pi 初版对无工具、无 phase 文本等待终态才交付，造成额外缓冲。修复后的四次合成网络对照样本中，旧路径额外等待 2,083 / 2,060ms，增量路径 0 / 1ms；正文与 delta 拼接一致。上游首字波动 771–15,933ms，本次只能证明本地缓冲已移除，不能据四个样本推导整体延迟分位数。旧 `acceptance-common` 仍构造旧适配器的问题同步修复；MiMo 与 OpenCode 的现役探针均使用 Pi。完整审查见 [记录](./agent-context-initiative-review-2026-10-15.md)。

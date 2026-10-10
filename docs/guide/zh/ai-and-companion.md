# 模型与 Worker 链路

中文 · [English](../en/ai-and-companion.md)

## 这篇讲什么

这一册讲清模型这一路真正是怎么跑的：一个消费 Postgres 队列的 Node worker、一份服务端模型配置、一层账号级同意与外发治理，以及 worker 侧的制卡、语音与伴星作业落在哪些文件与表上。每条判据都来自 `workers/ai-worker/src/**`、`packages/*/src/**`、`config/ai-platforms.json`、`apps/api/src/modules/**` 与迁移文件，而不是方案文档的声明。统一 Agent 怎么被驱动（回合内核、能力与工具面、上下文与状态词表）已经单独写在 [统一 Agent 运行时（技术）](./agent-runtime.md)，伴星面向用户的那一面（她是什么、能做什么、哪里还做不到）写在 [伴星体验（产品设计）](./companion-experience.md)，本页不再重复展开。方案 44 已有实库、真实模型与部分窗口证据，剩余限制按相关记录逐项确认。

- [Worker 运行时](#worker-运行时)
- [Job 类型清单](#job-类型清单)
- [第二条队列：制卡 outbox](#第二条队列制卡-outbox)
- [模型配置：一个文件](#模型配置一个文件)
- [Provider 协议注册表](#provider-协议注册表)
- [思考与推理档位](#思考与推理档位)
- [识图路由](#识图路由)
- [Token 计量与上下文治理](#token-计量与上下文治理)
- [联网搜索与来源](#联网搜索与来源)
- [治理与同意](#治理与同意)
- [制卡：领域包与 worker 链](#制卡领域包与-worker-链)
- [ai-quality：离线质量层](#ai-quality离线质量层)
- [语音](#语音合成在-api切句在-worker识别在桌面)
- [伴星：人格、记忆、日记](#伴星这条链路的后端落点)
- [探针与评测脚本](#探针与评测脚本)
- [超时阶梯](#超时阶梯)

## Worker 运行时

入口 `workers/ai-worker/src/index.ts`：`main()` 在模块加载时自启，唯一的例外是 `NODE_ENV=test` **且** `WORKER_DISABLE_AUTOSTART=1` 两个条件同时成立——单独设一个环境变量不会静默关掉 worker。

### 认领、租约与重试

`claimJobs()` 调用固定 `SECURITY DEFINER` 函数 `public.astella_claim_jobs(p_limit, p_background_limit, p_max_attempts)`（迁移 0022 建立、0228 改为按资源类别限流并回列 `resource_class`），锁与租约令牌都由这条 SQL 持有，应用层不再自己 `FOR UPDATE`。

- 租约 `LEASE_TIMEOUT_MS = 120_000`；孤儿回收 `public.astella_reap_stale_jobs(...)` 每 30 秒跑一次（`REAP_THROTTLE_MS`），不在每个 tick 全表扫。
- `MAX_ATTEMPTS = 3`。重试参数**不在 TS 侧算**：`astella_fail_job(id, workspace_id, lease_token, last_error, max_attempts)` 直接返回 `status / attempts / backoff_ms / is_dead / scheduled_at`，回退是 `2000 * 2^(attempts-1)` 毫秒。TS 只保留 `MAX_ATTEMPTS` 给死信强制收敛与 claim/reap 传参，两侧一致性由 `retry-strategy-contract.test.ts` 断言。
- 每一次终态转换都是租约令牌 CAS：`astella_finish_job` / `astella_fail_job` 都带 `(id, workspace_id, status='running', lease_token)` 围栏，影响 0 行就意味着 job 已被回收或重派，本轮结果**不提交**，只记 `jobLeaseLostTotal`。
- 终态转换本身有墙钟上界 `resolveWorkerStatementTimeoutMs() + 5_000`（默认 60s + 5s）。超时等于"结果未知"，一律交给 reaper 按租约收敛，绝不误判成失败。

运行中主队列作业每 30 秒心跳续租（`index.ts` + `lib/lease-heartbeat.ts`）。迁移 0394 增加 `lease_renewed_at`，失联回收按最近心跳判断；续租失败中止本轮，旧租约不能提交。

### 并发与交互车道

`QUEUE_CONCURRENCY` 默认 4、上限 16，非法值（NaN、小数、非正）回退默认。`INTERACTIVE_RESERVE_SLOTS = 1`：后台类 job（`maintenance` / `card_foreground`）最多占 `并发 - 1` 个槽，最后一个空槽只对 `interactive_ai` 开放，`computeClaimLimits()` 是这条名额分配的纯函数。`concurrency <= 1` 的小部署退化为不保留，否则后台会永久停摆。连接池按 `clamp(并发 × 4, 15, 64)` 推导，与槽位同源。

### 轮询、唤醒与内存背压

空闲时轮询间隔从 `POLL_MS = 500` 指数退避到 `POLL_MAX_MS = 5_000`，领到 job 或被 NOTIFY 唤醒即回到快档。LISTEN/NOTIFY 走频道 `astella_job_events`（发送方是迁移 0115 的 `AFTER INSERT` 触发器，worker 只消费），建立超时 3 秒，失败即回退纯轮询；`WORKER_DISABLE_NOTIFY=1` 可显式关掉。堆内存超过 `WORKER_MEMORY_LIMIT_MB`（默认 1536，非法值回退并告警）时暂停认领新 job。

### 优雅关停与观测

收到 SIGTERM/SIGINT 后停止认领，先交还在途的 V2 outbox 租约（不交回的话强杀后那条 run 要挂满 30 分钟才可能被重投，而钱已经付过），再等 drain；`WORKER_DRAIN_TIMEOUT_MS` 默认 45_000，到点强制退出，遗留 job 由下一个 worker 的 reap 收。`WORKER_STATEMENT_TIMEOUT_MS`（60s）、`WORKER_LOCK_TIMEOUT_MS`（5s）、`WORKER_IDLE_IN_TRANSACTION_TIMEOUT_MS`（15s）、`WORKER_POOL_IDLE_TIMEOUT_SECONDS`（30s）都在连接初始化时设好。

指标服务默认 `WORKER_METRICS_PORT = 9100`，暴露 `/metrics` 与 `/ready`；`/ready` 是真依赖探测（`SELECT 1`），未接探测时 fail-closed 返回 503。队列深度与最老 pending 年龄由 `astella_queue_job_depth()` / `astella_queue_oldest_pending_age()` 每 5 秒刷一次。数据库连接串走 `DATABASE_URL_WORKER`，`NODE_ENV=production` 时缺失直接抛错。

镜像 `workers/ai-worker/Dockerfile` 基于 `node:22.11.0-alpine3.20`，prod 阶段 esbuild 打包成 `dist/index.cjs`、`USER node` 非 root 运行、`EXPOSE 9100`。

## Job 类型清单

`HANDLERS` 是唯一的类型到实现的映射，表外类型走 `markUnknownJobFailed()`（`max_attempts=1`）直接判 `dead`。

| type | 处理函数 | 判死收尾 | 说明 |
| --- | --- | --- | --- |
| `parse_source` | `runParseSource` | `markSourceParseFailed` | URL 抓取 + 正文分段，无模型调用 |
| `companion_agent` | `runCompanionDialogue` | — | 伴星统一对话入口，payload 只含不透明 runId |
| `agent_run_advance` | `runAgentAdvance` | `markAgentAdvanceFailed` | 持续目标的推进步 |
| `companion_memory_extract` | `runCompanionMemoryExtract` | — | 逐轮记忆提取 |
| `companion_summarizer` | `runCompanionSummarizer` | — | 会话摘要 |
| `companion_memory_embedding_rebuild` | `runCompanionMemoryEmbeddingRebuild` | — | 最重的一个：单批 200 行向量重建 |
| `companion_daily_summary` | `runCompanionDailySummary` | — | 日汇总 + 她按人格写的第一人称日记正文 |
| `companion_memory_organize` | `runCompanionMemoryOrganizeJob` | — | 后台语义整理 |
| `companion_thought` | `runCompanionThought` | — | 候选念头生成、表达与送达 |
| `note_overview_generate` | `runNoteOverviewGenerate` | — | 笔记速看 |
| `note_annotation_explain` | `runNoteAnnotationExplain` | — | 批注解释 |
| `note_dynamic_artifact_generate` | `runNoteDynamicArtifactGenerate` | — | 动态教具 |
| `note_expansion_generate` | `runNoteExpansionGenerate` | — | 笔记拓展 |

`DEAD_FINALIZERS` 目前只有 `parse_source` 与 `agent_run_advance`：通用 job 循环只认识 `jobs` 表，"这次失败对用户意味着什么"只有类型自己知道，收尾让 `sources.status` 变成 `failed`，否则界面永远说"正在解析"。收尾失败只记日志——job 已是终态。

## 第二条队列：制卡 outbox

主队列之外还有一条 `card_generation_run_outbox_v2`，由同一个 tick 末尾的 `pollV2Outbox(1, V2_POLL_TICK_BUDGET_MS)` 领取（poll 与预算常量在 `workers/ai-worker/src/handlers/card-generation-v2-handler.ts`，租约与续租在 `workers/ai-worker/src/card-generation-v2/outbox-queue.ts`）。它不是主队列的一部分，但排产窗口共享同一个循环。

| 参数 | 值 |
| --- | --- |
| 单 tick poll 预算 | `V2_POLL_TICK_BUDGET_MS = 5_000`，超预算即返回，运行中的 job 继续后台跑 |
| 租约 | `V2_OUTBOX_LEASE_TIMEOUT_MS = 30 * 60_000`（30 分钟） |
| 租约续租/丢失探测 | `V2_LEASE_RENEWAL_INTERVAL_MS` 默认 120_000，必须小于租约窗口 |
| job 墙钟预算 | `V2_PIPELINE_BUDGET_MS` 默认 60 分钟，到期 abort 并终结 job（不重试） |
| 并发 | `V2_OUTBOX_MAX_CONCURRENCY` 默认 4（与主队列并发彼此独立） |
| 孤儿回收 | `V2_REAP_THROTTLE_MS = 30_000` |

认领用 `FOR UPDATE SKIP LOCKED` 直接写 `lease_token = gen_random_uuid()`；续租与终结都是 `WHERE ... lease_token = $token` 的 CAS，返回 0 行表示租约已被别人接管，本轮不许再提交结果。V2 poll 排在主队列 claim/分发**之后**（第五轮审计 W#5），但主队列没槽位提前返回时仍会把这一次 poll 走完。

## 模型配置：一个文件

部署者维护的模型与能力映射集中在 `config/ai-platforms.json`（`AI_PLATFORMS_CONFIG` 可指到别的路径）。`packages/shared/src/platform-config.ts` 描述契约，`platform-config-node.ts` 负责加载。

- `platforms.<id>`：部署者定义的标识 + 协议 `type` + `apiKey` + `baseUrl` + `models` 档案 + 只装网关怪癖的 `options`。
- `capabilities.<cap>`：把能力映射到 `平台 + 模型`。代码里的能力枚举是 `text_generation`、`vision`、`agent_turn`、`companion_fallback`、`embedding`、`rerank`、`speech_recognition`、`image_generation`；当前配置文件映射了其中的五个：`agent_turn`、`text_generation`、`companion_fallback`、`vision`、`embedding`。未映射的能力不可用，每进程只告警一次。
- `tts`：可选节点，已在契约内（见[语音](#语音合成在-api切句在-worker识别在桌面)）。

`${ENV_VAR}` 插值递归作用在配置文件的**所有字符串**上。变量未命中时保留 `${VAR}` 字面文本并在加载时一次性告警；`resolveSystemPlatform()` 对非 mock 平台发现 `apiKey` 为空或仍含 `${`，直接返回 `null`——调用方据此走 mock 回退或 fail-closed，而不是把一个假 key 发出去拿 401。取值优先级是配置文件 > 环境变量 > 内置默认（`tts.qwen.*` 与 `DASHSCOPE_TTS_WORKSPACE_ID` 的关系就是这一条；provider 侧则只有配置文件这一个来源，v0.6 已移除个人 BYOK）。

**声明即真相**。上下文窗口、输出上限、能否识图、推理档位都是**模型**的属性，写在 `platforms.<id>.models.<model>` 里：`contextWindowTokens`、`maxOutputTokens`、`vision`、`reasoning.levels` / `reasoning.default`。面板写回前跑 `validateConfig()`（`apps/api/src/modules/admin/config-service.ts`），`capabilities` 引用了未声明的模型是**阻断项**——窗口或输出猜错会表现成预算误算或上游 400，不如写配置时就拦下；`reasoning.default` 不在该模型的 `levels` 里同样阻断。手写文件绕过校验时，未声明的模型用 provider 缺省值，每个 (平台, 模型) 只告警一次。旧的平台级 `options.contextWindowTokens` / `enableThinking` / `reasoningEffort` 等字段没有任何读取方，是阻断级问题。

```json
{
  "platforms": {
    "opencode-go": {
      "type": "opencode_go",
      "apiKey": "${OPENCODE_GO_API_KEY}",
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "models": {
        "deepseek-v4.1-flash": {
          "contextWindowTokens": 1000000,
          "maxOutputTokens": 384000,
          "vision": true,
          "reasoning": {
            "levels": ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
            "default": "high"
          }
        }
      }
    }
  },
  "capabilities": {
    "agent_turn": { "platform": "opencode-go", "model": "deepseek-v4.1-flash" }
  }
}
```

## Provider 协议注册表

`type` 决定传输协议。新增一个平台实例只改配置；新增一种协议要实现 provider 类并在 `packages/shared/src/provider-registry.ts` 的 `PROVIDER_METADATA` 注册，同时在 worker 侧 `providers/*.ts` 里 `registerFactory()`。

| type | 协议形状 | 注册能力 | 注意 |
| --- | --- | --- | --- |
| `mock` | 进程内固定假文本 | text_generation, vision, agent_turn, embedding, rerank | 豁免同意检查；`AI_REQUIRE_CONFIGURED_PROVIDER=true` 时它作为回退会被拒绝 |
| `openai_compatible` | `/chat/completions` | text_generation, vision, agent_turn, embedding | `options.disableMaxTokens` 关掉 `max_tokens` 下发 |
| `dashscope` | compatible-mode 预设 | text_generation, vision, agent_turn, embedding | **就是 `OpenAICompatibleProvider` 的一层预设**，不是独立实现 |
| `siliconflow` | `/v1` | embedding, rerank | 只实现嵌入与重排；聊天要走 `openai_compatible` 指同一 baseUrl |
| `opencode_go` | `/responses`（OpenAI Responses API） | agent_turn | 见下方陷阱 |

三个反复踩的坑：

1. **DashScope 是预设不是协议分支。** `providers/dashscope.ts` 造的还是 `OpenAICompatibleProvider`，只是带上 `resolveEndpoint`、`maxTokensStrategy: "always"`、`X-DashScope-WorkSpace` 头与 `enable_thinking` 预设；baseUrl 必须以 `/compatible-mode/v1` 结尾。
2. **`opencode_go` 说 Responses API。** 当前 DeepSeek 槽位也使用 `/responses`；仅提供 chat/completions 的模型应另建 `openai_compatible` 平台，不能从模型名称猜协议。每个请求还要带稳定的 `x-opencode-session`，客户端也要自报非通用 SDK 的 user agent。
3. **阿里云域名守卫。** `dashscope` 的 `validateBaseUrl` 只接受 `^dashscope(-[a-z0-9]+)?\.aliyuncs\.com$`，把 baseUrl 指去别的主机是配置错误而不是可选行为。

`createCapabilityProvider()` 在工厂出口还会做一次形状校验：声明了 `vision` 却没实现 `analyzeImage()` 会变成明确的配置错误，而不是调用时才 `TypeError`。

## 思考与推理档位

chat/completions 的混合思考模型只有开/关，Responses API 有档位，两条下发路径不同：

- `OpenAICompatibleProvider#thinkingField()`：档案 `reasoning.default === "none"` 或调用显式 `disableThinking` → `enable_thinking: false`；声明了 `reasoning` → `enable_thinking: true`；未声明 → 不下发该字段，用网关默认。
- `OpenCodeGoProvider#reasoningField()`：声明了就下发 `reasoning.effort = default`；显式关思考时取该模型 `levels` 里"最接近关"的一档；未声明 → 不下发。

没有通用的"最低档"：实测 `muse-spark-*` 不接受 `none`、`gpt-5.6-luna` 不接受 `minimal`、deepseek 全档可用，所以档位必须逐模型声明，否则上游直接 400。

深链路上的两件事：

- **reasoning 句柄回放顺序。** deepseek 系在思考模式下要求把上一轮的 reasoning 原样带回，否则工具循环第二步 400。Responses provider 把句柄按 `reasoning → message → function_call` 的顺序回填 input items，顺序反了就会被拒；明文思考内容在 provider 侧已经剥离，只保留不透明句柄。"用户确认后续跑"的冷启动路径把句柄持久化在 `companion_agent_tool_calls.reasoning_handles`（迁移 0218），0218 之前创建的待确认提案没有句柄，续跑时是不可重试 400。
- **空内容重试。** 开启思考后部分 provider 偶发返回空 `content`（内容全落进 `reasoning_content`）。`openai-compatible.ts` 对同一请求最多重发 3 次（`MAX_EMPTY_OUTPUT_ATTEMPTS`），外层 AbortSignal 仍是那一个，不改变超时语义。

长推理和多阶段生成可能超过早期的短超时设置。当前单供应商默认可等待 15 分钟，普通 handler 默认 30 分钟，运行中续租；模型输出上限来自模型档案，正文长度由任务合同控制。租约用于失联回收，不再限制正常任务总时长。

> **记一笔**：项目已经决定伴星全链路保持思考开启，质量优先。这里的档位、回放与重试机制是为了让开着思考能跑通，不是为了把它关掉换取速度。

## 识图路由

`resolveVisionReader()`（`workers/ai-worker/src/lib/governance.ts`）按声明顺序判定"这次识图用谁的眼睛"，不做运行时能力探测：

1. 当前对话模型的档案声明 `vision: true` → 用主模型自己看；
2. 否则 `capabilities.vision` 有映射、且其档案没有被显式写成 `vision: false` → 用专门的识图模型；
3. 都没有 → `null`。此时读图工具 `companion_read_image` **既不下发也不执行**（`visionEnabled = policy.sendImageContent === true && resolveVisionReader(govCtx) !== null`），绝不把图交给一个看不见的模型。

`visionReaderAvailableFromConfig()` 让 here-and-now 那句"这篇有 N 张图"的措辞与工具下发面同源，避免出现"告诉她看不了、却又把读图工具给她"。

## Token 计量与上下文治理

> 回合内核怎么用这份预算、压缩冷却与回执如何落库，见 [统一 Agent 运行时](./agent-runtime.md)；本节只讲模型侧的计量口径。

计量入口 `packages/agent-core/src/context/measure-request.ts`。它测的是**实际序列化后送出去的全部内容**：system、历史、当前输入、工具 schema、工具调用参数与结果、多模态载荷——只测 system 会得到"system 很短所以没事"的错误结论。

保守估算的比例与地板：CJK 按 1 token/字符，非 CJK 按 1 token/3 字符；单张图片地板 `IMAGE_TOKEN_FLOOR = 1_500`；不透明 reasoning 句柄地板 `REASONING_HANDLE_TOKEN_FLOOR = 64`；每条消息封套 4、每个工具 schema 封套 8。估算路径给误差余量 `max(256, 12% × 体量)`（`heuristicTotal`），精确路径（provider 计数 / tokenizer）余量为 0。计数能力按运行时的 `finish()` 顺序回退：`providerCount → tokenizer → usage_anchor → heuristic`，量不动的载荷进 `unmeasured`，未知成本绝不记作零；口径版本 `CONTEXT_MEASUREMENT_VERSION = "v1"`，provider 序列化规则一变旧锚点就失效。

预算那条线（`B_hard = max(0, min(C − O, I) − M)`，触发 0.80 / 目标 0.60，`M = 2_048`，窗口不可获知时兜底 128 000、输出预留 16 384）与它的判定顺序、压缩冷却参数、伴星按摘要覆盖范围折叠，都在 [统一 Agent 运行时（技术）](./agent-runtime.md) 的上下文治理一节写全；这一层接到 `createGovernedProvider`——所有外发模型的唯一边界——因此它覆盖首步、每个工具回合、补取材料、后台继续、重试与备用模型切换，并且**在真实发送之前**计量完整送出的请求。职责只有判定与如实记录，它不删内容。

> **验证范围**：方案 44 已记录迁移、压缩提交、权限围栏的实库证据、真实模型对照与窗口样本。压缩后的语义接续、并发恢复和长期效果仍需按 [方案 44](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md) §8／§11 核对，不能把历史的「从未跑过」沿用为现状。

## 联网搜索与来源

`agent_web_search` 同时用于对话和持续目标。`agent/web-search.ts` 复用 `bigmodel` 平台凭据调用智谱 Web Search API；账号的 `webSearchEnabled` 默认为 false，工具下发与执行都检查开关、服务可用性及 AI 治理。

每轮最多 3 次搜索，返回有界摘要与 HTTPS 来源；网址生成稳定来源身份与引用标记。工具回执持久化，重放能恢复来源而无需重新搜索。轻聊、手记与历史复用来源块，标题／网址／日期放在来源列表和弹层，不进入朗读正文。

额度不足时当前 Worker 按凭据冷却 30 分钟，本轮可以继续作答但不得声称已联网核实。冷却是进程内状态，重启或另一副本不共享，不能当成全局配额控制。测试与边界见 [联网搜索](../../testing/agent-web-search-2026-10-08.md)。

## 治理与同意

同意是**账号级**的：迁移 0237 把 `ai_consent_version` / `ai_data_policy` 从 `workspaces` 摘掉，落成 `user_ai_settings`（`user_id` 主键、`consent_version`、`consent_at`、`data_policy jsonb`）。理由写在迁移注释里——同意管的是"我的内容能不能送出去"，挂在空间上等于由别人的同意决定我的数据去向。

`readUserAiSettings()` **必须**走 `withWorkerWorkspaceTransaction`：这张表启用了 RLS 且按 `app.user_id` 隔离，裸查询会**静默返回 0 行**，表现成"这个人永远没同意"而不是报错。没有签署行时 `consentOk = false`，`getAccountAIPolicy()` 回落到拒绝默认。

| 字段 | 默认 | 出处 |
| --- | --- | --- |
| `sendToExternal` | `false` | `packages/agent-host/src/ai-governance-policy.ts` 的 `DEFAULT_AI_DATA_POLICY` |
| `sendImageContent` | `true`（2026-10-06 用户决定） | 同上；第一道门仍是同意，这项只决定签过之后图片这一路是否也放行 |
| `piiDetection` | `true` | 同上 |
| `auditLogging` | `true` | 同上 |

`mock` provider 豁免同意检查（开发替身不外发）。生产部署把 `AI_REQUIRE_CONFIGURED_PROVIDER=true` 之后，`agent_turn` 解析不到真实平台不再是"可降级状态"而是配置错误：抛 `AIProviderNotConfiguredError`（`code = ai_provider_not_configured`），它在 `isNonRetryableError()` 里是明确的一类，job 直接 `dead`——重试不会让缺失的 key 出现，而 mock 会把固定假文本当成回复或记忆落库。

`ai_audit_log` 在 worker 侧只有 `logAICall()` 一个写入口，由治理包装器在每次真实外发后异步补一行。**只记元数据**：provider、model、operation、`data_categories`、token 数、耗时、状态与脱敏后的错误消息，绝不记内容。`data_categories` 由调用点声明（只有发起者知道送出去的是用户的回答、笔记正文还是一段引用）。写这行同样要带工作区与 actor 上下文，否则两条 RESTRICTIVE 租户守卫会把它拒掉。

## 制卡：领域包与 worker 链

`packages/card-generation` 拥有的是**制卡这件事本身**：创建事务（`createGenerationRunInTransaction`）、来源 seal（`sealEvidenceSnapshotsV2`）、run 事件与错误类。它不认识 Fastify、React、provider，也不读 env、不自己开事务——拿到的是调用方给的那段事务执行器。审核、激活、提醒与简化链的执行仍留在各自原来的地方，没有跟着搬也没有被复制；纯规则（过滤、hash、seal 计划）只有一份，在 `packages/shared/src/card-generation-v2-pipeline/`。worker 的 V3 简化链是执行侧。

证据密封（`evidence-seal-core.ts`）的硬约束：`evidenceSnapshotHash` 走 `computeEvidenceSnapshotHashV2`（域 `evidence-snapshot-v2`）；正文封在不可变的 `protectedQuoteRef = evidence://snapshot/<snapshotId>` 里，不内嵌尚不存在的语义支持报告，避免 hash 环；全表强制 workspace scope；**seal 在 Author 之前完成**，保证 source-only 单向闭包。

确定性闸（`deterministic-gates.ts`）负责不可协商的那一半：每个 answer/rubric unit 至少一个合法 Evidence Snapshot；answer 引用的 offset/hash 必须与 frozen source 一致、`evidenceRefIds` 不得越出 sealed manifest；候选在 objective 与 rubric 上都没有任何证据引用时报 `no_evidence_reference`，severity 是 `hard`——没有依据直接判死，不进 `review_ready`。语义判断归 Critic，不归正则。

审核台侧的取数与动作在 `apps/desktop-client/src/renderer/src/components/surfaces/review/use-card-generation-data.ts` 与 `use-card-generation-session.ts`，写操作仍是权威，动画只负责看起来顺。模型调用次数由链自己数并写进完成事件 `card_generation.simplified_completed` 的 `modelCalls`，所以"普通短文本成功路径刚好 2 次"能在库里读到；段 4/5 失败重投时生成那一发不再发生（重投不重付）。开关是 `CARD_GENERATION_V3_PROVIDER`：未设 = 确定性替身，`llm` = 真模型按次付费；生产里确定性替身被护栏拒绝，离线复现要显式 `V3_ALLOW_DETERMINISTIC_PROVIDERS=1`。

## ai-quality：离线质量层

`packages/ai-quality` 持有版本化的评测输入，四件套各自有版本号，改内容只能靠递增版本：`DATASET_VERSION` 与 `LABEL_VERSION` 都是 `2026-07-19-v1`，`SCORER_VERSION = 1.1.0`，`PROMPT_VERSION = "generate-card.v3"`。制卡 V2 的标注语料在 `src/card-generation-v2/corpus/`（按 micro / 中长 / 多模态 / 零卡对抗分批）。

PR 层只跑 schema / parser / alignment / scorer 与固定 Mock，**不访问付费网络**（ADR-0005 第 2 条）。跑法：

```bash
cd packages/ai-quality && npm run pr-gate    # 输出 JSON，通过 0 / 失败 1
make verify                                  # 已包含 typecheck + test + pr-gate
```

`realAlignEvidence()` 用 trigram Jaccard 相似度 + 滑动窗口做真实证据对齐，注释明写它与 worker 的引用对齐判据同构——同构是为了让离线读数与线上判断的是同一件事。RC 层是阈值化的闸（`rc-gate.ts` 的 `HARD_GATES_V2` 与 `CONTENT_QUALITY_GATES_V2`，必须按 micro/long/zero/safety/modality/language 分桶，总平均不许掩盖 micro-note 退化），语义 Judge（`semantic-judge.ts`）用 strict schema 输出冻结 verdict。Judge **不能代替 Grounding hard gate**：它是 Level 2 的教学判断，证据是否真的存在仍由确定性闸与 seal 说话。

## 语音：合成在 API，切句在 worker，识别在桌面

**TTS 合成不在 worker。** 引擎选择在 `apps/api/src/modules/learning-sessions/voice-providers/tts-engine.ts`：`tts.engine === "qwen"` 且 workspaceId 已配置 → 走 DashScope WebSocket 原始协议，按队列键 `workspaceId:userId` 严格串行（同一段音频顺序不能乱），不同用户并行但总量受 `QWEN_TTS_MAX_CONCURRENCY`（默认 4）约束，连接池空闲 60 秒复用；qwen 任务失败（`QwenTtsError` / 网络错误）→ 记日志后自动降级 edge-tts。

降级有一条例外：**治理拒绝不触发降级**。`isGovernanceDenial()` 把 `AIConsentRequiredError` / `AIDataPolicyDeniedError` 单独认出来——没签同意是这件事不该发生，不是上游挂了，重试一次不会让它变成应该发生。

预算算术是 30 + 30 + 8：qwen 默认 `DEFAULT_TIMEOUT_MS = 30_000`、edge 默认同为 30_000、编排余量 8 秒，合起来 `TTS_TASK_DEADLINE_MS = 68_000`。语气标签（`[excited]` 等 23 个控制标签）是 qwen-audio 专属：qwen 原样传入，edge 分支合成前必须 `stripVoiceExpressionTags` 剥离，否则标签会被当普通文字念出来；声音表达由回复模型标注，表情跟随实际播放段；历史与显示剥离语音标签。

**切句的唯一所有者是 worker**（`workers/ai-worker/src/lib/tts-segments.ts`）：优先按 `。！？；\n .!?;` 切，单段上限 `TTS_MAX_SEGMENT_CHARS = 160`，展示段目标 48 字（超过且句内有逗号级停顿就先切），首段满 14 字即可提前触发以让声音与文字同步，每 run 最多 200 段、总可朗读文本 20000 字；`segmentId = sha256(runId:ordinal:text)`，另存 `textSha256`。服务端还会在把段事件推给客户端之前预热合成（`companion-tts-warm.ts`：TTL 120 秒、最多 64 条、每用户在飞 3 条）。

**桌面侧是本地识别，不是云端转写。** SenseVoice int8 模型（`model.int8.onnx` 239 MB + `tokens.txt`，两个文件的字节数与 sha256 都在合同里）由用户在设置页自行下载、随时可移除；识别跑在 Electron 的 `utilityProcess`（Node 子进程）里，因为随包的 sherpa-onnx 是 emscripten 的 Node 构建，需要 `require`，而窗口是 sandbox + 无 nodeIntegration。录音仍只在渲染层采集，音频经一条本机 IPC 进子进程，不出这台机器。引擎懒启动、空闲 90 秒交还内存、单次解码上限 120 秒（第一次含引擎与模型加载）。

## 伴星这条链路的后端落点

> 她的产品定位、四处入口、能力清单与成长闭环在 [伴星体验（产品设计）](./companion-experience.md)，执行体在 [统一 Agent 运行时](./agent-runtime.md)；本节只记这些行为落到哪些 handler 与表。

| 能力 | worker 侧 | 数据表 |
| --- | --- | --- |
| 对话与工具循环 | `companion-dialogue.ts`、`companion-agent-runtime.ts`、`companion-tool-execution.ts` | `companion_conversations` / `companion_messages` / `companion_turn_runs` / `companion_agent_steps` / `companion_agent_tool_calls` / `companion_stream_events` |
| 记忆提取与维护 | `companion-memory-extractor.ts`、`companion-memory-maintenance.ts`、`companion-memory-organize.ts` | `assistant_memory_items` + `assistant_memory_item_revisions`、`assistant_memory_source_suppressions`、`assistant_memory_budget_events` |
| 向量与关联 | `companion-memory-vector.ts`、`companion-memory-embedding.ts`、`companion-memory-tools.ts` | `assistant_memory_embeddings`、`memory_links`、`memory_usage_log` |
| 摘要与接续 | `companion-summarizer.ts`、`companion-context-handoff.ts`、`companion-summary-retrieval.ts` | `conversation_summaries`、`companion_context_handoff_snapshots` |
| 日汇总与日记 | `companion-daily-summary.ts`、`companion-diary-content.ts`、`companion-diary-candidates.ts`、`companion-diary-checkpoints.ts` | `companion_daily_summaries`、`companion_diary_generation_checkpoints` |
| 人格 | `companion-persona-self-edit.ts` + 对话侧读取当前/待生效两版 | `companion_persona_profiles`、`companion_persona_profile_versions`、`pet_profiles` |
| 念头与主动送达 | `companion-thought.ts`、`companion-delivery-write.ts`、`companion-proposal-copy.ts` | `assistant_deliveries`（唯一的送达通道）、`companion_action_proposals`；`companion_proactive_deliveries` 只有表定义与测试引用，没有生产写入方 |
| 发现簿与长期经验 | 发现簿的读写在 API 侧，不在 worker；方法经验由 `packages/agent-host/src/methods.ts` 持有 | `companion_discovery_entries`、`companion_procedural_playbooks`、`companion_method_revisions` / `companion_method_uses` |

自改人格的四件事（语气、性格标签、表达分量、边界）与她的自我描述共用**同一个身份写入口** `commitPersonaProposalV1()`（`packages/agent-host/src/identity.ts`）：前台工具与后台回顾都经它落，规则只有一份。改动靠 `fieldOrigin` 记账标成 `assistant`，换人格时才知道哪几项是她写的、不该被预设冲掉；账号从没选过人格时以系统默认人格为底稿起一份档案，而不是回一句"改不了"；内容没变不给"已改"回执也不占版本号；`name` 在类型上就不让她改。每条待生效版本还记「出自哪一次提议」（前台是那次运行，后台是那次回顾）：同一次运行里先改语气再改标签两项都留，不相干的两笔不并成一条，新的那笔回到当前生效的版本重排，旧的仍在人格版本记录里可恢复。

她回顾一段相处是独立的后台任务（`companion_reflection`，maintenance 车道）：读的是那段真实交流与当时的回执，产出三类东西——她自己的理解（判断，`user_stated=false`、留在空间里）、下次怎么配合的方法候选（仍是待核对）、以及一句对自己的描述（人格页「她怎么说自己」那一格）。值得改就提一版待生效，不值得就什么都不留。依据被删掉或换过版本时，那一版不会在下一条新消息被接受时生效，人格页与回顾记录都写明为什么。

主动送达走 inbox：`assistant_deliveries` 上的 `inboxSequence` 在同一把用户级 advisory 锁内取 max+1，写行与 `pg_notify` 同事务；客户端连 `GET /companion/deliveries/inbox/stream`（`event=assistant.delivery`、`id=inboxSequence`），断线按 `Last-Event-ID` 续，是 durable 语义。worker 写 `system_event` 那类展示行走的是同一条锁与通知，不另立一套。

旅程（journeys）与发现簿的读写在 API 侧：`apps/api/src/modules/companion-journey/routes.ts`、`apps/api/src/modules/companion-conversation/discovery/discovery-service.ts`，能力门是 `COMPANION_JOURNEY_V2`（`.env.example` 默认 `true`，`COMPANION_BRIDGE_V2` 同）。发现簿那一段是收藏时定格的原文，之后正文改了它不动，用户批注另存一列。

## 探针与评测脚本

真模型的探针都要显式开关，CI 永远不满足条件，因此不会有人不小心花钱：

| 脚本 | 开关 | 用途 |
| --- | --- | --- |
| `workers/ai-worker/scripts/companion-s1-behavior-probe.ts` / `-required-probe.ts` / `-fact-span-probe.ts` / `companion-persona-ab-eval.ts` / `experience-comparison-runner.ts` / `agent-42-real-path-probe.ts` | `REAL_MODEL_BATCH=1` | 真模型行为、必需项、事实范围、人格 A/B、经验对照 |
| `workers/ai-worker/scripts/card-generation-v3-live.ts` | `V3_LIVE=1` | 简化链真模型一次 |
| `scripts/companion-provider-health.mjs` | 需在 worker 容器内跑 | 每个模型槽打一次固定问句，看今天会不会吐半截话；判据复用生产的 `looksTruncatedReply` |
| `scripts/companion-turn-e2e-verify.py` | `--rounds` | 端到端验流式批次数、失败率、落库正文形态 |
| `scripts/companion-quality-report.py` | `--compare <baseline.json>` | 只读库出质量基线与改前/改后 delta |
| `scripts/companion-gate-counterfactual.py` | 只读 | 11 道输出闸在最近 30 天真实流量上反事实重放，删闸的第一份证据 |

`companion-provider-health.mjs` 必须在 worker 容器里跑：主机上的 `AI_PLATFORMS_CONFIG` 指向容器看不到的路径，解析结果会是 `provider=mock` 加一句"平台未配置"，那测不出任何真东西。它不打印 key，也不打印带凭证的 URL，只输出 provider 名、模型、延迟与结论。

## 超时阶梯

执行预算与失联回收分别管理。默认值由 `packages/shared/src/ai-execution-budgets.ts`、`lib/handler-timeout-config.ts` 和制卡 outbox 声明；部署覆盖值可能不同。

| 层 | 默认与约束 |
| --- | --- |
| 主队列租约 | 120 秒；运行中每 30 秒续租，reaper 从最近 `lease_renewed_at` 判断失联 |
| handler | 普通 AI 任务 30 分钟，`parse_source` 60 秒；解析结果上限 24 小时 |
| 单供应商请求 | 默认 15 分钟，且不超过 handler 剩余预算减保存余量 |
| 伴星／动态产物循环 | 从 handler 派生，为持久化保留 15 秒 |
| 多阶段制卡 | `V2_PIPELINE_BUDGET_MS` 默认 60 分钟，独立的 30 分钟 outbox 租约与续租 |

handler 优先级：`WORKER_TIMEOUT_<TYPE>_MS` → `WORKER_MODEL_TIMEOUT_MS` → 类型默认 → 全局默认。供应商优先级：`WORKER_PROVIDER_TIMEOUT_<TYPE>_MS` → `WORKER_PROVIDER_TIMEOUT_MS` → 15 分钟默认，再受 handler 可用时间约束。新增覆盖变量需在 Compose 中显式透传；仅写 `.env` 不代表进程一定读得到。

输出预算在 `lib/providers/model-output-budget.ts` 解析，正常生成使用模型档案声明的输出上限；不再把少量正文 token 当作包括推理在内的总额度。上下文预算仍为输出预留空间，任务合同仍限制正文与结构。取消、租约丢失、有限调用次数和重试约束继续生效。实现与验证见 [预算调整](../../testing/ai-execution-budgets-2026-10-08.md)。

## 相关分册

- [总览](overview.md)
- [架构](architecture.md)
- [开发环境](development.md)
- [桌面客户端](desktop-client.md)
- [API 与数据](api-and-data.md)
- [统一 Agent 运行时（技术）](agent-runtime.md)
- [伴星体验（产品设计）](companion-experience.md)
- [测试与质量](testing-and-quality.md)
- [运维](operations.md)
- [常见问题与排障](faq-and-troubleshooting.md)
- [方案索引](../../plans/learning-companion/README.md) · [41a 统一 Agent 基础](../../plans/learning-companion/41a-unified-agent-foundation-2026-09-28.md) · [42 统一 Agent 系统与伴星成长](../../plans/learning-companion/42-unified-agent-and-companion-experience-2026-10-04.md) · [40 长期陪伴与日记](../../plans/learning-companion/40-companion-long-term-experience-and-diary-prd-2026-09-25.md) · [40b 运行时与可观测性](../../plans/learning-companion/40b-companion-runtime-and-observability-2026-09-27.md) · [44 上下文治理与压缩](../../plans/learning-companion/44-unified-context-window-and-compaction-2026-10-05.md)

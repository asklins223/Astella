# 伴星学习产物真实模型全流程验收 · 2026-10-19

## 范围与方法

用户报告两件事：生产对话里伴星说"你连喊三遍我听见了"（用户只说过一遍），以及"生成几个历史的笔记"迟迟不出笔记。先用生产库与 worker 日志定位（run `0fe67407-136f-4760-8807-9a9bc55c1fd7`，目标 `19878c11-67b2-4003-aa28-e77a3799453f`），再在本地一次性库上以真实模型跑五条学习产物链与两条对话链，收集并修复问题。

本地环境：`astella_note_authoring_p1`（`scripts/dev-disposable-db.sh` 建，全部迁移 + 角色），宿主进程跑生产 handler；模型路由按 `config/ai-platforms.json`（`text_generation`/`note_generation` → `mimo-agent` / `mimo-v2.6-flash`，`agent_turn` → 同槽）。`REAL_MODEL_BATCH=1` 显式开启。夹具用户带 `user_ai_settings`（sendToExternal=true；补齐后同时开 auditLogging）。

| 探针 | 覆盖 | 结果 |
| --- | --- | --- |
| `learning-artifacts-live-probe.ts`（本次新增） | 速看 / 脑图 / 动态讲解 / 拓展草稿 / 段落解析：建任务 → 租约 → 生产 handler → 读回产物 | 5/5 成功；动态讲解耗时异常 |
| `companion-note-authoring-probe.ts` | 对话内搜索 → 读笔记 → `companion_create_note` → 流式交付 | 成功：6 步 / 5 工具 / 保存并链接真实笔记 |
| `companion-note-generation-routing-probe.ts`（补用例） | 分类边界；新增"新建笔记"两句 | 新笔记句能出 `companion_create_note`，但 `toolUse` 不稳定 |
| `card-generation-v3-live.ts` + `V3_LIVE=1 CARD_GENERATION_V3_PROVIDER=llm` | 制卡真实模型全链 | `review_ready`，6 候选、5 次模型调用、20.7 万 ms、单发最慢 93 s |

## 生产事件的两个根因

### 1. "你连喊三遍"：内部纠正把同一句用户原话追加成了多条 `user` 消息

`companionStepCorrectionMessages`（`workers/ai-worker/src/handlers/turn/companion-step-plan.ts`）在每次内部纠正时把 `currentRequest` 原样追加成一条 `user` 消息。这一轮触发 4 次纠正（2 次 `REPLY_FORMAT_INVALID`、2 次交付闸 steer），消息列表里于是有 1 条真实用户消息 + 4 条一模一样的重附件。模型推理原文出现 5 次 "The user repeated ..."，最终对用户说"你连喊三遍我听见了"。system 里那句"不是新的用户请求"挡不住形状问题：模型数的是 `user` 轮的数量。

修复：

- 重附件正文加 `【内部核对，不是用户的新消息】` 标记，并写明"用户没有再说一遍；不要据此声称用户重复、连喊、催促或统计次数"；原始文本仍逐字保留在标记之后。
- 新增 `isCompanionInternalCorrection` / `dropCompanionInternalCorrections`，agent 循环与中断续跑在追加前先摘掉旧的重附件，任何一步最多只有一份。
- 回归测试：`companion-agent-runtime.test.ts` 里按生产中 4 次纠正的形状断言"用户轮只有原始 1 条 + 重附件 1 条"。

### 2. "生成的笔记没出来"：新建笔记被交给后台目标，而目标没有建笔记能力

生产分类把这句话理解为 `act` + 候选 `companion_save_memory`；随后 agent 走了 `agent_start_goal`。后台目标 `inputs=[]`，能力面只有 `agent_calculate` / `agent_web_search` / `agent_read_public_document` / `agent_deliver_goal`——`note_*` 能力要冻结笔记版本，`companion_create_note` 只挂在对话面上。目标 19:11:32 以 1 次模型调用、0 个操作 `completed`，把"笔记"写进了交付摘要，库里一篇都没有；目标完成也没有任何消息回到对话。

修复（路由而不是扩后台能力）：

- 分类器 prompt（`companion-tool-intent.ts`）：新增"新建一到几篇笔记（含点名主题）→ task/act、候选 `companion_create_note`，一篇一次；不要用 `agent_start_goal`，后台目标不能新建笔记"。
- 交接指令（`goal-handoff-instructions.ts`）：同一规则写进执行侧，并解释交给后台只会变成一段摘要。
- 能力描述（`agent-capability-manifests.ts` / `companion-capability-manifest.ts`）：`agent_start_goal` 明确"新建笔记用 `companion_create_note`，不走这里"；`companion_create_note` 明确覆盖"点名主题要新建几篇"。
- 目标上下文（`goal-context.ts`）：无冻结材料时补一句"不能新建笔记；不要把笔记正文写进交付摘要当成已经做好，也不要说结果已保存"。

## 追加修复（同日第二轮）

### 分类器候选的确定性兜底

分类器的 `candidateOperations` 直接决定工具面（`createCompanionToolSurface` 会按候选装载 goals / notes 组）。实测同一句"给我生成这篇笔记的速看吧"两次分别被判成 `read` 和 `none`，生产里"给我生成几个历史的笔记"被判成 `companion_save_memory`——`agent_start_goal` / `companion_create_note` 因此没进工具面。

`companion-tool-intent.ts` 新增 `explicitCompanionProductRequest` 与 `reconcileCompanionInterpretation`：当前话语明确点名产物（速看/脑图/演示/拓展/学习卡/草稿/往外学）或明确要新建笔记时，把对应候选补回、`toolUse` 升为 `act`、`goalRelation` 补 `new`；"聊天里概括"、否定句、编辑当前笔记、`read_only` 权限档不补。候选不是授权，执行侧仍按权限与真实材料复核。

真实模型路由探针（8 条边界）：兜底前两次运行各 2–3 条不符预期；兜底后**两次运行 8/8 全部通过**（速看/拓展/往外学 → `act` + `agent_start_goal`；新建笔记 → `act` + `companion_create_note`；"聊天里概括"仍 `read`；"往外学是什么意思"仍 `none`）。

### 动态讲解：两段式（规划带思考，写页关思考）

单发整页在默认思考档（配置里 `note_generation.reasoningEffort: "low"`）要 668 s、有一次 900 s 直接 provider 超时；单发关思考降到 232 s，但独立评审（DeepSeek-V3，按原文对照评分）给"是否把关系讲清楚"（teaching）4 分，带思考那版是 5 分——差值正好落在需要推理的地方。

于是把一发拆成两发（`note-dynamic-artifact-generate.ts` 的 `jsonArtifactProvider`）：

1. **规划发（沿用思考档，输出只有大纲）**：只依据原文定 2-6 步、每步回指一个原文块，narration 说清步骤间关系；返回 title/subject/caution/outline（约 300-1,200 token）。
2. **写页发（关思考，输出整段 HTML）**：按已核定大纲写自包含交互页；document 仍是 HTML 片段，页面安全/字段合同/原文回查由共享会话 `accept` 照旧验收，不因拆分放宽。

真实模型读数（同一篇 4 段笔记）：

| 方案 | 耗时 | 规划 | 写页 | 独立评审 |
| --- | --- | --- | --- | --- |
| 单发 + 思考 low | 668 s / 900 s 超时 | — | — | teaching 5 |
| 单发 + 关思考 | 232 s | — | 10,508 tok | teaching 4 |
| 两段式 | **254.7 s** | 13.7 s / 57.1 s（重试一次后合格，313→1,195 tok） | 183.6 s / 7,375 tok | **5/5/5/5/5** |

规划那一发即使重试一次也只多花十几秒；写页那一发的输出比单发整页更短（7,375 vs 10,508 tok），因为大纲把"讲什么"先定死了，页面只需照着写。

## 真实模型耗时读数

| 链路 | 耗时 | 备注 |
| --- | --- | --- |
| 段落解析 | 12.7 s | 最稳定 |
| 速看 | 15.9 / 31.4 / 34.8 s | 三次 |
| 脑图 | 13.3 / 24.9 s | 两次 |
| 对话内新建笔记 | 87.9 s | 首个可见字 **85.5 s**（动作轮整段攒住，期间界面只有"执行工具"） |
| 拓展草稿 | 97.2 s | 4 篇候选 |
| 制卡（6 张） | 206.6 s | 5 次模型调用；单发最慢 93.1 s |
| 动态讲解（单发 + 思考 low） | **668.2 s**；另一次 **900 s provider 超时** | 单发整页：思考 + 约 1 万输出 token |
| 动态讲解（单发 + 关思考） | **232.1 s** | 快，但独立评审 teaching 4/5 |
| 动态讲解（两段式：规划带思考 + 写页关思考） | **254.7 s** | 独立评审 5/5/5/5/5，与带思考版同档 |
| 生产对话轮（4 次纠正） | 173 s | 9 步 / 13 次模型调用 |

## 探针自身的缺陷（顺手修复，否则读数不可信）

- `card-generation-v3-live.ts`：`JSON.stringify(obj)::jsonb` 经 postgres.js 落库成 JSON 字符串，`sendToExternal` 读不到，一次性库上创建直接 403。改用 `tx.json()`。
- `companion-note-authoring-probe.ts`：交付断言拿原始 `reply.text`（还带 `[voice]` 标签）与落库文本比；且用原始文本 `writeTail`，流式已下发前缀时因前缀不匹配被拒，尾句静默丢失。改为按生产口径先净化再 `writeTail`。
- `learning-artifacts-live-probe.ts`：`note_blocks.ordinal` 从 0 起，最初按 1 起算导致段落解析锚点校验失败；改为从库里读回目标段落并计算 prefix/suffix。

## 验证

- worker：`npx tsc --noEmit` 通过；`companion-agent-runtime` / `agent-step-assembly` / `loop-extraction` / `tool-intent` / `note-authoring` / `agent-task` 共 **113** 条通过，`companion-step-plan` 相关 80 条通过；第二轮含 `note-dynamic-artifact-generate` 的定向集 **107** 条通过。
- shared：`agent-capability-catalog` / `agent-capabilities` 13 条通过。
- 真实模型：五条产物链、对话建笔记、制卡全绿；新笔记路由用例能出 `companion_create_note`。

## 分类器黄金集

新增 [companion-classifier-golden.ts](workers/ai-worker/src/live-tests/companion-classifier-golden.ts)（22 条真实口吻用例）与真实模型跑分探针 `companion-classifier-golden-probe.ts`。用例只断言影响行为的字段（intent / toolUse / 候选包含 / goalRelation），覆盖产物生成、新建笔记、编辑笔记、只读问答、纯聊天、术语提问、后台目标控制与混合句。

同一批用例的真实模型跑分：

| 轮次 | 通过 | 说明 |
| --- | --- | --- |
| v1（仅产物/新笔记兜底） | 15/22 (68%) | 多数失败是 `act` 被 ambiguities 降成 `uncertain` |
| v2（补编辑/只读/术语/目标控制兜底） | 21/22 (95%) | 仅"把这篇笔记的格式整理一下"未识别（修饰语顺序） |
| v3（补名词在前编辑句式） | **22/22 (100%)** | 单轮样本；复跑仍可能有模型抖动 |

失败模式统一为"分类器给了 `act` 但带 ambiguities，`resolveAgentTurnInterpretation` 降成 `uncertain`"，所以兜底规则只补**话语本身明确**的几类：产物生成、新建笔记、编辑当前笔记、只读概括、术语提问（判 none）、目标停/继续；"聊天里概括/不生成"与只读权限档不补。

## 仍待处理

1. **动态讲解约 4 分钟**：两段式已经拿到质量不掉、670 s→255 s 的结果，但仍是最慢的产物；再压需要把整页写得再短或把写页拆成并行分段（需要改渲染/组装合同）。
2. **后台目标完成不回对话**：完成通知只在"交给我做的事"列表被监听时发，且 0 产物时文案不含"已完成什么"。要让"完成"以对话消息出现，需要接参与偏好、静默时段、投递去重与语音/通知契约，属于产品设计，不在本次范围。
3. 分类器的**候选操作**已加确定性兜底，但 `toolUse`/`status` 仍由小模型给出；更彻底的做法仍是黄金集调优。
4. 全部改动未发版、未部署，线上仍是旧代码。
4. 本次只跑本地探针（不经 HTTP 提交、队列派发与 Electron 窗口）；生产发布需要重新构建 v1.8.27 + 部署，本记录不构成线上验收。

## 最终状态

本次范围内可复现、可判定的缺陷已全部修复并通过回归：

- 内部纠正重附用户原话 → 标记 + 去重（"你连喊三遍"根因）。
- 新建笔记误交后台目标 → 路由与交接口径统一（笔记没出来的根因）。
- 分类器候选缺失 → 确定性兜底，真实模型路由探针 8/8 ×2。
- 动态讲解单发 668 s / 900 s 超时 → 单发关思考 232 s 但 teaching 掉分 → 两段式（规划带思考 + 写页关思考）254.7 s、评审满分。

未纳入本次的属于产品决策或发布动作，已在下文"仍待处理"列出：目标完成提醒的设计（服务端写对话消息涉及参与偏好、静默时段、通道去重等一整套契约，不能顺手改）、动态讲解进一步压缩输出规模、以及发版部署。

## 复跑方式

```sh
bash scripts/dev-disposable-db.sh astella_note_authoring_p1
cd workers/ai-worker
set -a; . ../../.env; set +a
REAL_MODEL_BATCH=1 LIVE_ARTIFACT_REPEATS=2 LIVE_ARTIFACT_SUFFIX=all2 \
DATABASE_URL_MIGRATOR=... DATABASE_URL_API=... DATABASE_URL_WORKER=... DATABASE_URL=... \
  node --import tsx src/live-tests/learning-artifacts-live-probe.ts
```

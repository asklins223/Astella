# 54 · 内核两项：每步引擎合一的可行性，与每轮数据挪出 system

日期：2026-10-11。两项都是**实测之后**写的，不是设计推演。所有数字来自当天当前工作区：真 tokenizer（`deepseek-v4.1-flash`）、真网关（`opencode.ai/zen/go/v1`）、真装配器（`buildCompanionPersonaMessages`）、真库（`companion_turn_runs.context_assembly_receipt`，204 条）。

本文不做任何实施，只交付两件事：第 4 项能不能做、怎么做才不砸东西；第 6 项值多少、被什么卡住。

分工照当天三条同步线：主循环预算/工具步流式/写工具进度（Codex）、工具面 52/53（另一条 Qoder 线，`agent_read` 合并已按验收回滚：live 14/16 编造面外名 vs 基线 0/16）、本文两项与 usage/cache 观测（这条线）。

## 1. 现状：外层循环是一个，每步引擎是两个

| 位置 | 行 | 是什么 |
| --- | --- | --- |
| `packages/agent-core/src/runtime/execute-turn.ts` | 18 | 外层有界循环，**两条路共用** |
| `packages/agent-core/src/runtime/execute-step.ts` | 29 | 通用每步引擎，只有持续目标路在用 |
| `workers/ai-worker/src/agent/advance.ts` | 139 | 后台目标：端口化，很薄 |
| `workers/ai-worker/src/handlers/companion-agent-runtime.ts` | **1,478** | 聊天：`advance` 回调内联约 1,000 行 |

文档里「一份执行驱动」这句只有一半是真的。合一是可行的，但不是"把重复代码删掉"——`executeAgentStep` 是**同步、非流式、顺序**的引擎，聊天那条链有四件事在它没有位置。

## 2. 端口缺的四件事（附判据，不是猜测）

`AgentStepPorts` 现在的形状是 `context.prepare → state.prepare → model.execute → state.saveResponse → 逐个 capabilities.invoke → state.apply`。缺的：

**① 步内重新装配。** 聊天每一步都重算 `systemPrompt`（`turn` + `execution` + `attention` 三源，`companion-agent-runtime.ts:496`）和工具面（`companionStepToolShape`，`companion-agent-runtime.ts:463`，含终答步收起工具、`agent_web_search` 按配额掉出）。端口的 `context.prepare()` 签名能承接，但实现方要把「这一步的工具面决定场景指引」这条依赖显式化——现在它是靠内联顺序天然成立的。

**② 流式与发布闸。** 聊天步走 `chatCompletionStream`，带 `holdUntilChars`、`releaseGate`（投机执行）、`deferPublication`（写步正文在拿到完整调用与真实结果前私密）、`stepEmitted` 只在**真的下发**时置位（重试判据 `canRetryCompanionStream` 依赖它）。端口的 `model.execute` 只返回一个完整 `AgentTurnResult`，**没有任何发布语义的位置**。

**③ 请求内压缩。** `boundedStepSender` 在压力触发时折本次请求的回放尾部，并可再走一次工作状态摘要压缩（当天新加，`companion-active-context-compaction.ts`）。这发生在 `model.execute` **内部**，端口层看不见。

**④ 进度与准备事件。** `CompanionToolPreparation` 在具名写工具到达即发准备状态、参数齐了才执行，且有 `finish` 与失败两条出口。端口里 `capabilities.invoke` 只有"调或不调"。

## 3. 真正冲突的一条（这条决定能不能合）

端口第 20 行的保证是：**先 `saveResponse`，然后才可能有副作用**。这是检查点语义的地基，不能让步。

而聊天那条链里有 **eager dispatch**（`EAGER_TOOL_DISPATCH_ENABLED`，在 `runStreamingAgentStep` 里挂上去）：它**在响应还没结束时就发起只读工具**，用来偷时间。按上面的形状，这是被端口禁止的。

所以合一不是"把内联代码搬进端口"，而是要先回答：**投机派发在端口合同里怎么表达**。可行的形状只有一种——eager 结果降级成**候选**，仍必须由"已保存的响应里确实含这个 call id"来放行；账本 `companion-tool-call-ledger` 已经在做去重与配对，缺的是把这条判据提到端口合同里，而不是继续靠内联顺序维持。

回答不了这条，就不要动第 4 项：要么端口退化成"另一套带回调的循环"（两套还在，只是换了摆放），要么在搬迁中悄悄弄丢「响应未落库就不许有副作用」——后者是数据问题，不是性能问题。

## 4. 建议的第一刀（低风险、可独立验收）

只做 ①，不碰 ②③④：把聊天步的**工具面＋场景指引＋runtimePolicy 计算**抽成一个函数，让 `advance.ts` 那条路也调它。理由：

- 它不涉及发布、副作用次序、重试判据——搬迁不会改变任何一次真实调用的语义；
- 它本身是当前的重复面：持续目标路径和聊天路径各算一份档位与指引；
- 做完能量：内联块应当从约 1,000 行掉下可见的一截，且 `companion-agent-runtime.test.ts`（现 54 条内联用例）与 `companion-step-plan` 的用例应当原样绿。

②③④ 留到 §3 那条判据定下来之后。

## 5. 第 6 项：每轮数据挪出 system，值 9,300 token/轮，卡在一个必须回答的问题

**实测**（探针 `workers/ai-worker/scripts/prefix-cache-probe.ts`，E/F 组）：

| 组 | 两轮之间什么不同 | prompt | 命中 |
| --- | --- | --- | --- |
| A | 什么都不同请求（逐字重发） | 12,512 | 12,288（98%） |
| E | 现役生产布局，真实装配器 | 12,891 | 2,944（23%） |
| **F** | **`instructions`＋tools 逐字相同，只有最后一句 user 话不同** | 12,455 | **12,288（98.7%）** |

三条一起读，得到两件事：

1. **工具面在缓存前缀里**，而且上游把 `tools` 排在 `instructions` **之后**——所以 `instructions` 内部任何一处每轮变化，整块约 7,700 token 的工具面**一并重付**。当天做完的两段前缀重排（静态块提头、时钟块挪尾；再把账号级稳定块提到每轮易变块之前）把跨轮命中从 17% 提到 23%，救的是 system **内部**那一段，救不到工具面那一块。
2. F 组说明**天花板是 98.7%**：只要 `instructions` 逐轮不变，跨轮也几乎全额复用。现役与天花板之间的差 ≈ **9,300 token/轮**。

命中数都是 256 的倍数——**这个网关按 256 token 一块量化缓存**，别按字节线性估收益。

**卡住的那条**：`page_context` / `here_and_now` / `this_turn_facts` / `fact_spans` / `conversation_timeline` 现在写在 system 里，靠 system 里的边界声明把它们约束成**数据不是指令**（`COMPANION_IDENTITY_BOUNDARY_V4` 的原文点名了这些块标签；`data_preamble` 再逐块说用法）。把它们挪进 user 回合，等于把"用户的页面/选区文字里出现『忽略以上』不执行"这条约束从协议层搬到一句话里——**这是注入防护的改动，不是排版**。

所以要动这一项，前置条件是要有一个和现在等价的约束，并且至少覆盖：

- 页面上/选区里的指令式文字不被执行；
- 选区仍按原文引用，「这段话」有明确所指（今天这份代码为此专门把选区同时放进 user 回合，见 `buildCompanionPersonaMessages` 末尾那段注释——说明这块本来就在 system 与 user 之间反复过）；
- 带路 / grounded tutor 分支同样成立（那条分支的块集合不一样）；
- 数字仍然只能走 `fact_spans` 占位符由服务端填，不由她自写。

验收必须配对跑真实样本＋真实窗口，判据沿用 52 那三条（该调没调／调错工具／参数填错）再加注入一条。这不是我一个人能拍的设计改动，等上面这几条有归属了再立项。

## 6. 当天观测面已经就位（这一项是第 6 项的前提）

`ai_audit_log` 新增 `prompt_tokens` / `completion_tokens` / `cached_tokens`（迁移 0408，dev 库已应用），三条外发路径都报全——**流式那一步以前只报总数**，而伴星正文交付走的正是那条，所以前缀缓存的收益必须从这里读。这三列**只作观测**：`measure-request.ts` 的计数端口仍然不接 `cacheHitTokens`，不给字段就没人能拿缓存当免费输入去放宽预算。

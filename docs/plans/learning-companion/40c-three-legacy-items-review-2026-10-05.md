# 40c · 三项遗留的核查结论

> 日期：2026-10-05
>
> 状态：**核查记录，不是实施方案。** 核查对象是 [40](./40-companion-long-term-experience-and-diary-prd-2026-09-25.md) §4.5.3（分类）与 §4.5.6（去准入门前的护栏）、§4.6（记忆重整）、[40b](./40b-companion-runtime-and-observability-2026-09-27.md) §3（缺失与失败表达）三项在代码中的实际状态。
>
> 结论：**三项都不是"待实施"。** 记忆分类与记忆重整两项已按比原方案更好的方式实施；缺失与失败表达的**调用级已实施**，但**注入面的折叠尚未对模型闭合**（§1.3 表二、§3.2）。
>
> 本文同时记录三处**原方案本身的错误**，以及它们在何处被否决。这些比实施进度更值得留下。初稿自己还犯过一次同形的错（把文件路径当实现），记在 §4 末尾。
>
> §1.1 被否决的"三组正则 + `memoryKindForContent`"**不在现行 40 里**，它是本文作者的更早草稿；现行 §4.5.3 已经把它换成了对照样本表。

---

## 1. 逐项核查

### 1.1 记忆分类（40 §4.5.3 + §4.5.6）：已实施，且原方案被否决

| | |
| --- | --- |
| **原方案** | 三组正则 + `memoryKindForContent`，按「situational / mood / behaviour」升降级 |
| **实际** | `workers/ai-worker/src/handlers/companion-memory-extractor.ts:89` 的注释明确记着否决理由 |
| **佐证** | `companion-memory-temporal.ts` 用**溯源式**判据替代词形式：时效条件必须逐字出现在用户原话里；无界的短期声明一律拒绝，"so a transient goal cannot become permanent **by omission**" |

抽取器提示词已同步改写（`:194`）：

> 分类时看整句、上下文和用户是否认同，**不把祈使句、引用内容或单次反馈自动升级为长期偏好**。

**原方案的错误（这一条最要紧）：** 我提的三组正则里有两条会在 40 §4.5.3 自列的反例上产生错误结果。

| 原句 | 40 §4.5.3 的正确处理 | 原方案会做什么 |
| --- | --- | --- |
| 「我希望下周完成数据库索引复习。」 | 有时间范围的本地 goal，**不因为"希望"变成 preference** | `BEHAVIOUR_PATTERN` 命中"希望" → **误升级成 preference** |
| 「以后我累的时候别催学习。」 | 明确长期沟通偏好，**不因为含情绪词而拒写** | `MOOD_PATTERN` 命中"累" → **误降级成 interaction_note** |
| 「这一次希望先看例子。」 | 本次表达要求，Working | 同样误升级 |

**教训：词的极性不等于语义的作用域。** 「希望」可以出现在一次性的临时要求里，「累」可以出现在长期条件偏好里。词形判据会把这两类同时判反，而它们恰好是最该记和最不该记的两端。

原方案那条"fail-closed 落在不自动写活那一侧"的推理方向没错，错在**用词形近似去实现它**。`companion-memory-temporal.ts` 的路径更根本：不信模型标的标签，而是**要求每个标签都能在用户原话里指出出处**。

### 1.2 记忆重整（40 §4.6）：接线已验证存在，单轮真实执行未验证

| 形态 | 位置 |
| --- | --- |
| 执行体 | `workers/ai-worker/src/handlers/companion-memory-organize.ts`，头注指向 40 §4.6.3 / §4.6.9 / §4.6.10 与验收 A68 / A74 |
| 接线守卫 | `workers/ai-worker/src/__tests__/companion-memory-organization-wiring-guard.test.ts` |
| 行为测试 | `workers/ai-worker/src/handlers/__tests__/companion-memory-organization.test.ts` |

测试覆盖 40 §4.6.3 那张表的**全部五类动作**，且每条都带**反向条款**：

- 合并：同一事实且无矛盾；**冲突不强行合并** —— 交给并存 + 标争议，不是挑一个赢
- 移除：只按**已声明期限**的机械过期；期限未到不判失效
- 蒸馏：三份**独立**事件支持
- 升级：带条件 + 多份证据 + 未设期限
- 降级：条件性记忆只有一份证据；**「最近没被提到」不是降级理由**

另有一条不属于那张表、但同样被钉住的边界：**固定（pinned）不参与自动整理**。

**「已实施」这句话的边界要说清：** 守卫钉的是**接线**——job 白名单（迁移 `0361`）、调度器在 `claimJobs` 之前被调用、handler 在 job 映射表里、surface 一次性消费。这四条可以在源码层验证，我核过：迁移存在，`workers/ai-worker/src/index.ts:11,81,519` 确实 import 了调度器、注册了 `companion_memory_organize`、并在 `claimJobs` 之前调用。守卫自己的第 17 行也写着「真跑那一层由 0361 的集成测试负责」——**那一层要 Postgres + 向量列 + 模型，本文没跑**。所以准确的说法是「接线存在且被守住」，不是「跑通过」。

执行体还有一条边界（`:85`）：

> （合并/降级/蒸馏）针对的是关于用户的事实，**动了判断就等于后台替用户改她的看法**。

**原方案的第二处错误：** 我 §4.6.5 写的验收指标是"记忆条数应当**先降后稳**，不是单调增长。这是唯一能证伪'重整真的在做语义判断'的指标"。

40 §4.6.5 已经把这句否掉了：

> **记忆条数下降只是容量读数，不证明语义质量，合理的新事实也可以使条数增加。**

**那条指标是错的**：一次正确的重整可能把三条碎片合并成两条（下降），也可能因为新证据充分而新增一条（上升）。条数与语义质量没有单调关系。40 §4.6.5 换的五项（合并后来源完整、纠正后旧结论失效、冲突不被抹平、遗忘不复活、并发写不覆盖）才是行为判据。

### 1.3 缺失与失败表达（40b §3）：调用级已实施，注入面折叠未闭合

原方案我列的是 13 条 Cortico 英文字面量（`[result folded]` / `[arguments folded]` / `[not executed: …]` / `[tool result unavailable: …]`）。**这是错误的核查方式**——40b §3.1 已经写明：

> 本项目借鉴**状态完整性**，**不要求照搬英文文本**或向用户展示内部标记。

按状态类别重新核查时，**必须先分两个面**——40b §3.2 那张表是按"下一步"分的，代码也把两类拆开：`packages/shared/src/contracts/companion-agent-contracts.ts:109` 与迁移 `0349_companion_tool_status_vocabulary.sql` 的注释都写着 `folded/omitted` 属**注入面**、`pending` 属**在途面**，「都不进这一列」。把它们并排进同一张表，就会把"某个面的实现"读成"整张合同已闭合"。

**（一）调用级：五态都有实现，且都进了模型可见的说明。**

| 状态 | 实现位置 |
| --- | --- |
| `not_executed` | `companion-tool-result.ts` 的 `CompanionToolNotExecutedError` + `companion-tool-outcome.ts` 的 `classifyCompanionToolFailure` / `TOOL_NOT_EXECUTED_SAFE_SUMMARY`；派发侧 `companion-eager-dispatch.ts`；账本 `companion-tool-call-ledger.ts` |
| `unavailable` | `companion-read-tools.ts:460` 的读图外发门禁；`companion-tool-outcome.ts` 的 `unavailableCompanionToolSummary` |
| `blocked` / `failed` | `companion-tool-result.ts` 的错误类族 |
| `outcome_unknown` | `agent-core/src/runtime/run-state.ts`、`companion-tool-call-ledger.ts`、`agent-host/src/advance-store.ts` |
| 在途（`pending`） | `agent-host/src/operation-receipt.ts`：终局事件仍 pending 即降为 outcome_unknown |

`companion-tool-failure-faces.ts` **不是任何状态的产生者**：它只有 16 行，把 `failure.status` 原样同时写进账本面与模型面，注释明写「折叠过的状态会让 doctor/回放查不到真实原因」。把它列成 `not_executed` 的实现，是把"形被保留"读成了"状态被实现"——**与本文第 2 节批评的那三处同形**。

**（二）注入面：四条路径里只有一条留了模型可见的省略计数。**

| 路径 | 形态 | 模型可见？ |
| --- | --- | --- |
| 交接块 | `companion-context-handoff.ts:250-266` 的 `omitted:{completed,unresolved,notCompleted}` 与 `omittedPending` | **是**（进 `<continuation_data>`） |
| 上下文预算 | `agent-core/src/context/assemble-context.ts:32,93` 的 `AgentContextReceipt.status = "budget_omitted"` | 否 |
| here-and-now | `companion-here-and-now.ts:860` 的 `truncate()` | 否（无声截断） |
| 日记选材 | `companion-diary-content.ts:239-246` `renderMaterial()` 超预算即 `break` | 否（无标记丢弃） |

回执不进 prompt 是可查的，不是推断：`companion-dialogue-content.ts:1099-1100` 把 `context.receipts` 交给 `contextReceipt` 回调，而 `companion-dialogue.ts:798-801` 的回调只做两件事——记进程内 `admittedSources` 与 `logger.info`；`companion-agent-runtime.ts:503` 则直接丢弃 receipts。

所以 **40b §3.2「不能假称完整阅读」在注入面还没有兑现**：模型看不到自己这一轮少拿了多少东西。详见 §3.2。

**超出原方案的是两件事：**

**（1）状态被写进了模型可见的说明，且逐条讲清"该怎么办"。** `companion-agent-runtime.ts:460-466`：

> `outcome_unknown` 表示副作用可能已经发生但没有确定回执：**不得说成已完成或没有发生，也不要重调同一操作**
> `not_executed` 表示这一步从未开始执行：**可以按正确参数重新调用一次**；若重调仍不成，就照实说这一步没做成，**不要编出结果**
> `unavailable` 表示这项能力这一轮没有开：**不要重调同一个工具**，按 error 里给出的可用替代继续

原方案只给了状态名，没给**每种状态对应的下一步动作**。少了这层，模型拿到 `not_executed` 会当成"工具坏了"从而绕过工具编答案——该处 `:461` 的注释记着这正是此前发生过的。

**（2）自证测试防的是"假成功"。** `companion-tool-result.test.ts`：

> "`!recorded` 又变回 `return result` 了：账本说 outcome_unknown、**模型却拿到 ok:true**"
> 「回执没落下来」必须是 outcome_unknown，**不能降级成 failed**

`companion-context-handoff.test.ts` 有一条叫「【自证】把 outcome_unknown 混进 completed 会立刻被抓出来」。

---

## 2. 三处原方案错误的共同形状

三处都不是"想错了方向"，是**同一种过度简化**：

| 我写的 | 问题 | 被谁纠正 |
| --- | --- | --- |
| 词形决定语义类别 | 用可枚举的表面特征近似不可枚举的语义作用 | `companion-memory-extractor.ts:89` |
| 条数下降证明重整有效 | 选了一个与目标无单调关系的可观测量 | 40 §4.6.5 |
| Cortico 的 ORIENTATION 零否定句 | 挑了三个样本里最干净的一个当基准 | 40b §1.1 |

第三条补充核实：三个 bot 的实际数字是

| 文件 | 字节 | 否定式 |
| --- | --- | --- |
| `bots/cormini/persona/ORIENTATION.md` | 526 | 0 |
| `bots/corti-soulmate/persona/ORIENTATION.md` | 1385 | **2** |
| `bots/cortiv/persona/ORIENTATION.md` | 163 | 0 |

雪午那两处是 `Never claim a memory that is in neither your notes nor the history` 与 `Do not expose internal mechanisms`。**它们是人格底线，不是冗余禁令**，40b §1.1 已明确这一点。

---

## 3. 读实现体后的两处结论

初稿把这两处写成"关键词检索不足以判断"。读完实现体有答案了：**一处确认缺闸，一处确认只闭合了一半。**

### 3.1 40 §4.5.3 末句的"结合来源判断"确实没有实现

完整走一遍准入链（`companion-memory-extractor.ts:600-667`）：

- 唯一的 kind 级闸 `memoryAdmissionDecision`（`:99-110`）**只**拒 `interaction_note` + 非 `direct_statement`，对 `preference` 一律放行；
- `resolveCompanionMemoryTemporalMetadata`（`companion-memory-temporal.ts:30-58`）只判时效，`appliesWhen` 与 `validUntil` 都为 null 时直接放行；
- `resolveMemoryExtractSource`（`:274-288`）只验「`sourceQuote` 出现在用户原文里」，**不验 `content` 是否由 `sourceQuote` 支撑**。

于是模型给一条 `preference`、两项皆 null、正文不含有限窗口信号时，**四道闸全过**——"无明确长期信号时不因模型选了 `preference` 就直接采信"这句在代码里没有对应物。

**真要补，形态比初稿想的更小、更可测**：不该新增一栏去要求 `preference` 另附出处，而是把**已有的 `sourceQuote` 往下推一步——要求 `content` 由 `sourceQuote` 支撑**。现在这两个字段互不约束，模型可以拿一句无关的引文过 `resolveMemoryExtractSource`，再写一条与引文无关的 `content`。补上这一条对全部 kind 成立，且仍然是确定性判据：它判的是"这句话有没有出处"，不是"这句话是什么意思"。

### 3.2 折叠只有一半对模型可见

交接块那组省略计数（`companion-context-handoff.ts:250-266`）确实进了 `<continuation_data>`，模型看得见。但上下文预算那条**主路径**的 `budget_omitted` 只进了 `logger.info`，`here-and-now` 的 `truncate()` 与日记选材的 `break` 更是无声——两处都精确落在 40b §3.2「不能假称完整阅读」要防的那一侧。

所以 §1.3 那张表的"注入面"是本文唯一一处**已确认未闭合**的状态合同。

---

## 4. 给后续的提醒

原方案那三处错误的共同点是**都试图用可枚举的判据替代不可枚举的判断**。这在当时的文档里看不出问题——因为它们都写成了"确定性规则 + 正则"，看上去比"看整句和上下文"更可执行。

40b §1.4 第 6 项已经把它写成了通则：

> **守住职责而非词数。**……新增约束需有理由与样本，但**不以否定句或闸的数量只减不增阻止必要修复**。

补一句从本文三处错误里得到的：**也不要以"确定性规则"的名义，把语义判断挪进正则。** 确定性判据的价值在于它判的是事实（这条话有没有出处、这次调用有没有回执）；一旦它开始判"这条话是什么意思"，就超出了确定性判据能承担的范围。

**本文自己也犯过一次同形的错，一并记在这里。** 初稿把"哪个文件实现了某个状态"也当成了可检索的事实，于是把一个 16 行的透传件（`companion-tool-failure-faces.ts`）写成了 `not_executed` 的实现，又把两处**无声截断**（`truncate()`、超预算 `break`）写成了 `folded/omitted` 的实现——于是"六个状态全部有实现"这句话是假的。

共同形状不在正则，而在**用看起来对得上的间接证据代替读实现**。词形判据是它的原始形态，文件路径是它的现代形态：前者问"这句话属于哪一类"，后者问"这件事大概在哪"。两者都把"找到一个说得通的答案"当成了"核过了"。可执行的版本是：**判据与被测对象之间的每一步都必须能指着代码说出来**。

---

## 5. 依据

- [40](./40-companion-long-term-experience-and-diary-prd-2026-09-25.md) §4.5.2–§4.5.6、§4.6.2–§4.6.5
- [40b](./40b-companion-runtime-and-observability-2026-09-27.md) §1.1、§3.1–§3.2、§3.3
- 记忆：`workers/ai-worker/src/handlers/companion-memory-extractor.ts`、`companion-memory-organize.ts`、`companion-memory-organize-scheduler.ts`、`packages/shared/src/companion-memory-temporal.ts`
- 状态与回执：`workers/ai-worker/src/handlers/companion-tool-result.ts`、`companion-tool-outcome.ts`、`companion-tool-call-ledger.ts`、`companion-tool-failure-faces.ts`、`companion-eager-dispatch.ts`、`companion-agent-runtime.ts`、`companion-read-tools.ts`、`companion-eager-scheduler.ts`
- 注入面：`packages/agent-core/src/context/assemble-context.ts`、`workers/ai-worker/src/handlers/companion-context-handoff.ts`、`companion-dialogue-content.ts`、`companion-dialogue.ts`、`companion-here-and-now.ts`、`companion-diary-content.ts`
- 运行时：`packages/agent-core/src/runtime/run-state.ts`、`packages/agent-host/src/operation-receipt.ts`、`packages/agent-host/src/advance-store.ts`
- 合同与迁移：`packages/shared/src/contracts/companion-agent-contracts.ts`、`apps/api/src/db/migrations/0349_companion_tool_status_vocabulary.sql`、`0361_companion_memory_organization_job.sql`、`workers/ai-worker/src/index.ts`
- 测试：`workers/ai-worker/src/__tests__/companion-memory-organization-wiring-guard.test.ts`、`workers/ai-worker/src/handlers/__tests__/companion-memory-organization.test.ts`、`companion-memory-admission.test.ts`、`companion-tool-result.test.ts`、`companion-context-handoff.test.ts`、`packages/shared/src/__tests__/companion-memory-temporal.test.ts`
- 对照实现 `/Users/asklins/Downloads/Cortico-main`，仅用于核对机制形态；其 `bots/corti-soulmate/persona/ORIENTATION.md` 与 `bots/cormini/persona/ORIENTATION.md` 用于第 2 节第三条的数字核实。

本文只做代码与文档核查，**没有运行模型、迁移数据库或确认任何机制已通过验收**。§1.2 的"接线"已按上述文件核对（迁移存在、`index.ts:11,81,519` 注册到位、守卫全绿），但**单轮真实执行**需要 Postgres + 向量列 + 模型，本文没跑。

复核用的纯函数测试（项目自带 runner，不连库）：`cd workers/ai-worker && node --import tsx --test` 跑 `companion-memory-organization.test.ts`、`companion-memory-organization-wiring-guard.test.ts`、`companion-memory-admission.test.ts`、`companion-tool-result.test.ts` 共 38 项全绿；`companion-context-handoff.test.ts` 8 项、`packages/shared` 的 `companion-memory-temporal.test.ts` 3 项亦全绿。

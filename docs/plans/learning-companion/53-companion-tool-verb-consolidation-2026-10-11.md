# 53 · 聊天面工具动词合并（待决策）

日期：2026-10-11。用户提出：聊天面自定义工具太多，收成 6 个动词（`agent_search`／`agent_read`／`agent_write`／`agent_edit`／`agent_control`／`agent_open`），每个带 `target` 判别式；计算与联网本来就通用，保留；后台目标面先不并。

**本文是待决策方案，本轮未实施。** 2026-10-11 复算之后，本文原来的立项口径要改一句：**「语义不丢的合并必然更贵」只对 `anyOf` 成立**；换成扁平参数形状（§4.4）即使把每格完整说明原样保留也是 **−15%**。所以合并现在可以**同时**按 token 与可维护性立项。说明预算那一步在 [52](./52-companion-tool-surface-description-budget-2026-10-11.md)，其 §4.5（分类器载荷）**已于今日落地**。

本文所有数字在 2026-10-11 当前工作区实测。

## 1. 与 52 的分工

| 文档 | 管什么 |
| --- | --- |
| [52](./52-companion-tool-surface-description-budget-2026-10-11.md) | 不改任何工具名与合同，把每格说明收到该有的分量：§4 改写 description（两侧共省 ~2,400～2,800 token/轮），§4.5 把分类器载荷从 description 换成 label（再省 ~2,800）。**先做、独立、可回退** |
| 本文 | 改工具面的**形状**（57 个名字 → 6 个动词 + target）。省 token 不是理由（§2）；目标是消掉 46 个 switch 分支、约 281 行名字耦合、分类器词表对齐这三笔维护成本 |

两者不冲突，也不互相前置——但**52 先落地会把本文的 token 收益基本吃光**（§2.1），所以 53 立项时不要再算一遍 token。

## 2. 量测：合并到底省不省

把 6 动词方案真的构造出来（6 个动词 ＋ `agent_calculate` ＋ `agent_web_search` ＝ 8 个工具；参数用 `anyOf` 分支 ＋ `target` 常量判别式），用 `deepseek-v4.1-flash` 真 tokenizer 量：

| 变体 | token | 相对现状 |
| --- | --- | --- |
| 现状 57 个 | 8,800 | — |
| **A** anyOf 合并成 8 个，每格用法说明**不展开** | 5,674（复算 5,695） | −36% |
| **B** anyOf 合并成 8 个，每格说明**保留在分支上** | 9,093（复算 8,725） | ＋3%（复算 −0.9%） |
| **C** 不合并，description 只留第一句 | 6,324 | −28% |
| **D（本轮新增）扁平参数合并，每格完整说明挂在 `target` 描述上** | **7,482** | **−15%** |
| **D′ 同上但每格说明不展开** | 4,051 | −54% |
| **agent_read 单独合并（17 格→1 个，说明全留）** | 该族 2,147 → **1,643** | 这一族 −23.5% |

复算与原测的 A／B 差 368 与 −368 token，口径差在**哪些名字算进 passthrough**（复算把 5 个 `agent_*` 目标控制与 `agent_read_public_document` 一起算进去了）；两边结论一致。

三条结论（第三条已按复算改写）：

1. **−36% 是删说明换来的，不是合并名字换来的。** 名字从 57 收到 8 只值约 340 token。而 description 是**她唯一能看到的用法说明**（`companion-capability-manifest.ts:76` 原话），删它要逐条判断。
2. **原结论「语义不丢的合并是负收益」只对 `anyOf` 成立。** `anyOf` 逐支重复 `type/properties/required/additionalProperties`（JSON Schema 没有继承），把省下的吃回去。换成**扁平参数**（`target` 枚举 ＋ 属性并集，说明挂在 `target` 上）后，说明一句不删也是 −15%。
3. **所以合并可以按 token ＋ 可维护性双独立项**，但必须先接受 §4.4 那两条扁平形状的代价（wire 不再逐支强制 `required`、同名字段跨格形状不同）。若坚持 `anyOf`，就仍然只有可维护性这一条理由。

### 2.1 分类器那一侧：合并的收益会被 52 吃掉

分类器请求（`companion-tool-intent.ts`）**已于本轮改掉**：载荷从 `name ＋ description ＋ riskClass` 换成 `name ＋ riskClass ＋ label（＋ discovery）`，实测 4,480 → **1,456 token**，30 条两臂对照加两组现役探针全绿（依据见 [52 §4.5](./52-companion-tool-surface-description-budget-2026-10-11.md)）。

- 所以分类器那一侧已经**不再读 description**：合并在这侧的 token 收益确实归零，剩下能拿的只是把 57 条 label 收成 8 条（约 −400 token，可忽略）。
- 合并的 token 账因此**只看 agent 步**：扁平形状 −15%（§2 变体 D），anyOf 形状 ＋3%。
- 另一条变化对本文是**利好**：分类器现在按 label 挑候选，label 本来就是「这一格干什么」的短说法。合并成 `(verb, target)` 后，分类器词表要的正好是「target 的短说法」——§5.1 那条最危险的耦合面，改起来比原稿设想的小：要给的是 target 词表，不是 57 条说明。

**若合并落地，本文在 token 上的净收益就是 agent 步那 −15%（或试点阶段的 −23.5%／该族）**，不要再叠加 52 的两笔。

## 3. 六个动词的 target 清单

范围建议**先只收 `companion` 那 49 个**，不并 `agent_*` 目标控制族（理由见 §3.2）。下表按 `target` 数与**风险级分布**列出，风险级一列是后面所有麻烦的根源。

| 动词 | n | target | 风险级分布 | 扁平化后同名字段跨格形状不同 |
| --- | --- | --- | --- | --- |
| `agent_read` | 16 | context, current_page, history, note, source, learning_stats, task_queue, due_reviews, self_note, identity, reminders, memory, playbook, diary, recent_activity, image | read×16 | 6（`limit` `startOrdinal` `startOffset` `maxChars` `includeArchived` `expectedVersion`） |
| `agent_control` | 11 | start_learning, resume_learning, pause_learning, hint, variant, defer_review, wake, suggestions, activeness, reminder_cancel, boundary | **consequential×6 ＋ reversible_low×5** | 1（`reason`） |
| `agent_write` | 7 | note, note_share, memory, self_note, reminder, judgment, diagram | **reversible_low×6 ＋ read×1** | 2（`title` `text`） |
| `agent_edit` | 7 | note, identity, own_style, own_tags, **memory_revise**, memory_move, memory_forget | reversible_low×7 | 1（`reason`） |
| `agent_open` | 5 | note, page, card, graph, image | **read×4 ＋ reversible_low×1** | 0 |
| `agent_search` | 3 | note, memory, conversation | read×3 | 1（`limit`） |
| （不并）`agent_calculate` | 1 | — | read | — |
| （不并）`agent_web_search` | 1 | — | read | — |

合计 49 ＋ 2 ＝ 51；`agent_*` 目标控制 5 个、`agent_read_public_document` 1 个另行处理（它挂 `external` executor，且语义上确实属于 read 一族——原表把它混在 `agent_read` 的 16 格里数过，本文按「跨族先不并」处理）。

> **两处口径更正（2026-10-11 复算）。** ① 原表 `agent_edit` 同时列了 `memory_move`、`memory_forget` 与 `memory`——**同一个动词里 `memory` 出现两次**，target 词表自撞会直接抬高 §6 的「target 选错比例」，改名为 `memory_revise`。② 最后一列是新量的：扁平形状（§4.4）要把各家同名字段并成一个属性，实测每个动词都有 0～6 个字段**同名而形状不同**（界值、默认值、是否可选都不一样）。这列就是扁平化的代价清单。

### 3.1 风险级不齐是主要障碍

只有 `agent_read`、`agent_search`、`agent_edit` 三个动词内部风险级一致。另三个都混：

- `agent_control`：6 个 consequential（start／resume／pause learning、hint、variant、defer_review）与 5 个 reversible_low 同住一个名字。
- `agent_write`：`companion_render_diagram` 是 **read**（今天在 read_only 档里活着）。
- `agent_open`：`companion_focus_graph` 是 **reversible_low**（今天**不在** read_only 档里）。

今天 `riskClass` 是挂在**工具**上的标量（`definition.riskClass`），六处门禁直接读它。合并之后一个动词只能有一个值，于是**双向都错**——实测证据见 §5.2。

### 3.2 为什么不并 `agent_*` 目标控制族

`AgentCapabilityEntry.executor` 是**按组**赋的（`agent-capability-catalog.ts:15-25`），不是按条目。`agent_start_goal` 等 5 个属 `goal_control`，`companion_*` 属 `companion`。把两族并进同一个动词，`(verb,target)` 分派就得跨 executor，`executor` 必须改成按 target 携带。**先只收 companion 一族**，这一整类问题就不存在；跨 executor 合并留到试点之后单独评估。

## 4. 装配改法：合并是投影，不是重新声明

这是本方案最关键的一条，也是它能否成立的分界。

**现有结构已经是对的**：领域文件只放声明（`agent-capability-manifests.ts`、`companion-capability-manifest.ts`），`agent-capability-catalog.ts` 是**唯一索引**，conversation／goal 面是它的投影。用户方案里「每个领域继续自己声明那一格，只改装配这一层」与这个结构完全一致。

**具体改法（三步，声明层零改动）：**

1. **声明层不动。** 49 条 `tool(...)` 声明保持原样：参数 schema、label、riskClass、requiresConfirmation、limits、sceneGuidance 全部留在原处。
2. **装配层加一层动词投影。** 在 catalog 之上新增一个视图，把声明按 `(verb, target)` 分组，产出一张**每 target 属性行**：

   ```
   { verb, target, sourceName, riskClass, requiresConfirmation, autonomous,
     visionGated, proposalRouted, label, sceneGuidance, argumentSchema }
   ```

   工具面序列化时按 verb 合成 `anyOf` 分支（`target` 常量 ＋ 该格 schema）；门禁与执行按 `(verb, target)` 查这张表。
3. **执行层完全不动。** `(verb, target)` → `sourceName` → 走现有 `companion-tool-execution.ts` 的 46 个 `case "companion_x"`。**这是本方案最大的降风险点**：执行体、账本写入、以及那条扫 `case "companion_x"` 的台账守卫（`companion-tool-executor-ledger.test.ts`）都不需要改。

**因此「49 个文件按名字耦合」这个立项理由要打折**：如果执行层不动，真正需要改的是**暴露、门禁、序列化、呈现**这几层，约 15 个文件（§5.6），不是 49 个。这是好消息——它把方案从「高风险重构」降到「中等风险改造」。但下面 §5.1 那条链仍然必须先画出来。

**与 codex 那版的区别（用户判断正确，保留）**：伪造 `resource_` 前缀是在 provider 层包一层假工具，声明层没登记，于是权限、账本、chip 文案、场景指引四张表全对不上。本方案的投影来自**真实声明**，只是换个分组方式，`sourceName` 始终指回登记过的那条声明。

### 4.4 序列化形状要改选扁平，不是 anyOf（本轮复算新增）

§4 第 2 步原写的是 `anyOf`。实测两个形状的差别很大（同一批说明文本，一字不删）：

| 形状 | 每格完整说明 | token | 相对现状 |
| --- | --- | --- | --- |
| `anyOf` 分支 | 挂在各分支 `description` | 8,725～9,093 | ＋3% ～ −0.9% |
| **扁平属性并集** | 挂在 `target` 的 `description`，逐格写 `target=该格用法说明（必填 …）` | **7,482** | **−15%** |

为什么扁平能省：`anyOf` 的每一支都要重复 `type`／`properties`／`required`／`additionalProperties` 这层壳，而壳里的字段形状各格高度重合（`noteId`、`cursor`、`limit`、`reason`）。扁平化把壳去掉了。

**代价两条，必须写进判据**（这也是它能不能采用的分水岭）：

1. **wire 不再逐支强制 `required`。** 扁平形状只能把 `target` 设为必填，其余全可选。可接受的理由是这份仓库的权威校验本来就在执行侧：`validateAgentCapabilityArguments` → 该格自己的 zod `argumentSchema`（`agent-capability-catalog.ts:61-69`）。**线上 parameters 从来只是给模型看的形状，不是授权边界。** 但「模型看不出来这格必须给 noteId」确实会让首轮参数错率上升——§6 的「参数填错比例」就是盯这条的，别只看 token。
2. **同名字段跨格形状不同要有归属判据。** 实测每个动词 0～6 个（§3 最后一列）。默认取值规则要写死在投影里（建议：**取该 verb 内最严的那个形状**，并把各格差异写进 `target` 说明），不能留到运行时再说。

顺带的好处：扁平形状**不需要 `anyOf`**，§9 待验证第 2 条（部分兼容实现会拒绝 `anyOf` 根对象）这条未知直接消失。

## 5. 耦合面清单

按名字耦合的**生产文件**实测 49 个（worker 约 30 ＋ shared 约 15 ＋ desktop 4），涉及约 281 行。下面按「必须同步改」和「可不动」分开。

### 5.1 分类器词表——最危险的一条

分类器提示词在 `workers/ai-worker/src/handlers/companion-tool-intent.ts`。载荷形状**本轮已改**（[52 §4.5](./52-companion-tool-surface-description-budget-2026-10-11.md)）：`companionIntentCapabilityEntry`（`:93`）现在发 `name ＋ riskClass ＋ label（＋ discovery）`，system 里那句描述在 `:123`，改成了：

> `capabilities 给出本轮工具的 name、riskClass 与 label（label 是这一格短说法，discovery 只有一部分工具有）；candidateOperations只填其中的name，是候选而非执行授权。`

产出回到 `packages/agent-core/src/runtime/attention.ts:28-30`：`candidateOperations` **是工具名**，拿去和本轮下发的名字求交集；**名字不在面上就剔掉，并记一条歧义**，`attention.ts:39` 随即把 `toolUse: act` 降成 `uncertain`。§4.5 那 30 条两臂对照里这条「面外名字」两臂都是 **0**——所以它今天没被触发，但它是改名时最脆的一环：**合并之后分类器若还按旧名回话，每一条候选都会掉进这条歧义，每一轮动作都会被降成 uncertain**。

**这就是 2026-10-09 那次翻车的同一条链**（`companion-agent-runtime.ts:263-279` 记着：分类器一次猜测成了能力总闸，一个做不到的请求否掉了做得到的那个）。

改名而不同步改分类器提示词，等于把那次事故重演一遍。而故障形态是「她当众改口」——**要跑真实窗口才看得见，不是测试红的**。

**实施顺序因此是硬约束**：

1. 先改 `companion-tool-intent.ts` 的提示词与载荷形状（`capabilities` 要能表达 `(verb, target)`）。**这条比原稿设想的小了一截**：§4.5 落地后分类器已经不读 description，拿的是 `name ＋ riskClass ＋ label`，所以合并要给它的是**每个 target 的短说法**（现成的 `presentation.label` 改名挂到 target 上），不用再搬 57 条说明。载荷形状变了，`:123` 那句 system 描述也要同步——**它就是现在这条线的现行版本**。
2. 再改 `agent-contracts.ts:33` 的 `candidateOperations` 语义——现在是 `z.array(z.string().min(1).max(100)).max(6)`，裸名字；要扩成能带 target。
3. 最后才动暴露面。

另外注意：`max(6)` 这个上限是按「一句话最多牵涉 6 个操作」定的，与 target 无关；改成 `(verb,target)` 后要重新核对这个数字还够不够。

### 5.2 read_only 档会当场破（双向）

今天 read_only 面 = **34 个**：29 个 `read` ＋ 5 个 `reversible_low`（靠 `isCompanionAutonomousTool` 放行的自治工具）。合并后的双向错误：

| 动词 | 若声明为 read | 若声明为该动词最高风险级 |
| --- | --- | --- |
| `agent_open` | `companion_focus_graph`（reversible_low，今天**不在** read_only）**混进只读档** → 只读档获得写能力 | `open_note`／`open_page`／`open_card`（read，今天**在** read_only）**掉出只读档** → 能力丢失 |
| `agent_write` | 6 个 reversible_low 的写能力**混进只读档** | `companion_render_diagram`（read，今天在 read_only）**掉出只读档** |

而且 5 个自治工具分散在 **3 个动词**里（`write_self_note`→`agent_write`、`schedule_wake`→`agent_control`、`revise_identity`／`own_style`／`own_tags`→`agent_edit`），所以 `isCompanionAutonomousTool(name)` 必须改成按 target 判，且要改三处。

**修法**：门禁从 `definition.riskClass` 改成查 §4 的 **per-target 属性行**。这不是补丁，是合并的**前置条件**——不做这一步，合并必然在只读档出错，且错在「多给了能力」这一侧，比少给更严重。

### 5.3 steer 与回执粒度

`companion-agent-runtime.ts:288-297`：

- `steerableToolNames(definitions, "lookup"／"action")`：steer 要**点名**工具（注释：小模型对「你去调用工具」这种泛指不敏感，对「调用 `companion_search_notes`」会照做）。动词化之后点名失去粒度，要么点名 `agent_read` 再带 target，要么给每个 target 保留可点名的别名。
- `requestedActionTools`：靠 `candidateOperations ∩ riskClass!=="read"` 判「她声称的动作是否已有回执」。动词化后，一个动词的风险级不唯一（§3.1），这个判据失效；必须改成 `(verb,target)` 粒度，否则**任意一次写替这次声称作证**——正是这段注释警告的事。

### 5.4 权限与自治门（必须同步改的四处）

| 位置 | 现状 | 合并后 |
| --- | --- | --- |
| `companion-agent-registry.ts:23` | `permission !== "read_only" \|\| definition.riskClass === "read" \|\| isCompanionAutonomousTool(name)` | 查 per-target 行的 riskClass 与 autonomous |
| `contracts/companion-agent-contracts.ts:237-267` | `COMPANION_PROPOSAL_EXECUTED_TOOLS`（guided 档提案路由，6 个名字）＋ 按 `definition.riskClass`／`requiresConfirmation` 定确认门 | 查 per-target 行；提案路由集合改成 `(verb,target)` |
| `companion-agent-runtime.ts:310` | `capabilitySnapshot.offeredTools: {name, toolVersion, riskClass}[]` **随 run meta 落库** | 落库形状要变（多 target 维），**已落库的历史快照仍是旧形状**，读侧要能同时读两种 |
| `isVisionGatedCompanionTool` | 按名字 | 按 target（image 类） |

### 5.5 呈现、账本与提示词

- `COMPANION_AGENT_TOOL_LABELS`（状态 chip 文案，`companion-agent-rail.tsx` 消费，17 处引用）：按名字。合并后 chip 要按 `(verb,target)` 取 label，否则界面文案退回泛称。
- `companion-tool-call-ledger.ts`、`agent.tool` SSE 事件：**建议写入解析后的 `sourceName`**，这样账本与历史读侧不需要 name→(verb,target) 别名投影（用户提的那个顾虑可以直接消掉）。
- 提示词里直接用工具名的地方：`companion-here-and-now.ts`、`goal-handoff-instructions.ts`、`companion-dialogue-content.ts`、`renderCompanionSelfNotes`（`companion-autonomy.ts` 里明着叫她「按 key 用 `companion_read_self_notes` 展开」）。**这些是提示词，不是代码**——改名后必须逐处核对，漏一处就是「她说的名字手里没有」。
- `collectAgentCapabilitySceneGuidance(names, level)`（`agent-capability-catalog.ts:44-60`）：按名字取指引并去重。合并后要按 target 聚合，去重逻辑（现在靠 `seen` 集合避免重复进 prompt）需保留。

### 5.6 实际需要改的文件（约 15 个）

`agent-capability-catalog.ts`（加动词投影）、`agent-capability-definition.ts`（per-target 行形状）、`companion-agent-registry.ts`、`contracts/companion-agent-contracts.ts`、`agent-contracts.ts`（`candidateOperations` 语义）、`agent-core/src/runtime/attention.ts`、**`companion-tool-intent.ts`（分类器提示词与载荷形状，§5.1，第一件要改的）**、`companion-agent-runtime.ts`、`companion-step-plan.ts`、`companion-here-and-now.ts`、`companion-dialogue-content.ts`、`goal-handoff-instructions.ts`、`companion-autonomy.ts`、`companion-tool-call-ledger.ts`、`companion-agent-rail.tsx`。

**不必改**：`companion-tool-execution.ts`（46 分支）、`companion-tool-execution-run.ts`、台账守卫测试、执行族各域文件。

## 6. 对照实测判据

合并引入一个新失败模式：**target 选错**。这不是类型检查能证明的事，必须发对照样本。

用现有 `live-tests/probe*` 改一版对照，同一批代表场景跑**旧（57 名）与新（6 动词）两版**，比四个数：

| 指标 | 判据 | 为什么盯它 |
| --- | --- | --- |
| **该调没调的比例** | 新版不得高于旧版 | 动词抽象度变高，最可能的退化是「不知道该按哪个动词」而干脆不调 |
| **target 选错的比例** | 新版需给出可接受上限（建议先测基线再定） | 合并新增的失败模式，必须量化而不是假设它低 |
| **参数填错的比例** | 新版不得高于旧版 | 判别式分支让 schema 变长，参数更易错 |
| **read_only 档越权次数** | **必须为 0** | §5.2 的破口；这条是硬判据，不是比例 |

样本要覆盖 §3 里风险级不齐的三个动词（`agent_control`、`agent_write`、`agent_open`），以及 `agent_read` 里语义最相近的几组（`read_memory` vs `recall_memory` vs `read_self_notes`；`read_note` vs `read_source`）——**最像的那几组才是 target 选错的高发区**。

> **这四条已经在 6.5 实跑过一轮**（只做了 `agent_read` 族，三条可比的指标出了数，`read_only 越权` 因该族全 read **未被触及**），实测不通过已回滚，见 §6.5。

## 6.5 试点**已经做完并回滚**（2026-10-11，实测不通过）

按 §4.4 的扁平形状把 `agent_read` 真装到下发面上跑了真实模型（16 条只读请求，同一 harness、同一判据，基线是合并前跑的那一遍）：

| | 该调没调 | 选对格子 | 参数合法 | **编造面外名** |
| --- | --- | --- | --- | --- |
| 合并前（57 个名字） | 0 | **0** | 0 | **0** |
| 合并后（一个 `agent_read` ＋ 16 个 target） | 0 | **14/16 错** | 14/16 不合法 | 14 条写成 `companion_read` |

模型不是不会填 target——单独看几条，它填得又快又对（`target=learning_stats`、`target=current_page`、`target=note` 带真 id）。它是**记不住工具叫什么**：16 格里 14 次把名字写成 `companion_read`（把格子后缀丢了、动词前缀留着）。执行侧对这种名字的处置是现成的、也是对的：`boundedToolCallIdentity` → `getCompanionAgentTool` 认不出 → **「未注册的工具，操作已阻止」**。也就是说合并一落地，读类能力在线上有约八成概率直接不可用。

这正是 §5.1 早就画出来的那条链（名字对不上 → `attention.ts:29-30` 剔掉并记歧义 → `:39` 把 act 降 uncertain）换了个出口：分类器那侧现在不看 description，名字漂移的代价从"降级"变成"被门禁挡掉"。

**试点覆盖到哪儿（如实记）**：这一轮装上的三件东西是——①§4.4 的扁平参数（模型面前就是 `target` 枚举 ＋ 属性并集），②per-target 的只读暴露（`companionFaceSourceNames`，把 §5.2 那条前置条件真的做掉了），③下发面上 16 格折成 `agent_read`。三件都随回滚下线。**没覆盖两件**：`read_only 越权次数`（全 read 的族测不到它，见 §6 表下的说明），以及 **§5.1 那条分类器链**——试点直接驱动 agent 步，`companion-tool-intent.ts` 的提示词与 `TASK_VERSION` **没跟着改**（全程只到 13，那是 §4.5 的）。所以即使四个指标全过，分类器词表这一条也仍要单独验；这一轮的失败发生在比分类器更前面的地方（模型自己叫不出名字）。

**处置**：下发面**不折叠**，回滚到 57 个格子名。只留下本轮量出来的形状结论与这份 harness：`(agent_read, target) → 格子` 的解析口随之下线（并行改动方已从活动上下文压缩里撤掉对它的使用），下发面回到 57 个格子名。§4.4 的扁平形状因此**只剩理论价值**：它省 15%，但真实模型驱动不了 16 路判别式。

要重新按下合并，前置条件不是再改 schema，而是先回答"怎么让模型稳定叫出名字"：可走的路是**少量动词**（3～4 个而不是 1 挑 16）、或给每格留可点名的别名并同时下发（那就不是合并）、或换更强的模型并把这个 16 路判别当回归门常驻。这三条都不像省 565 token 的样子。

## 7. 试点建议：先做 `agent_read`（**已执行，未通过，见 §6.5**）

> 本节是**当初**的实施建议。`agent_read` 试点已于 2026-10-11 按此执行，实测未通过并已回滚（§6.5）。以下保留原文，供将来重提时对照条件，**不作为当前推进指令**。

若决定实施，**不要一次收 6 个动词**。先做 `agent_read`：

- 16 个 target，**风险级全部是 read**——§5.2 那类破口不存在。
- 语义同质、参数最像，target 词表好设计。
- 收益立刻可验：16 个名字 → 1 个，switch 分支与名字耦合在这一族上先消掉。
- 失败代价最低：读错了没有副作用。

试点通过（§6 四个指标达标）再按这个顺序推进——**这次试点没通过，所以后面这个顺序没有启动**：

1. `agent_search`（3 个 target，全 read）——可以和 `agent_read` 同批。
2. `agent_edit`（7 个，全 reversible_low）——需先做自治工具的 per-target 判据（3 个自治工具在这里）。
3. `agent_open`、`agent_write`——必须先完成 §5.2 的 per-target 权限矩阵。
4. `agent_control`（6 consequential ＋ 5 reversible_low）——**最后做**，它同时需要 per-target 确认门与提案路由。

## 8. 明确不做

- **不在 provider 层伪造 `resource_` 前缀。** 声明层没登记的话，权限、账本、chip 文案、场景指引四张表全对不上。用户的这个判断是对的，本方案不采用该做法。
- **不按本轮意图摘工具。** 2026-10-09 已经撤掉（`companion-agent-runtime.ts:263-279`），合并不得以任何形式把它带回来。
- **不并后台目标面**（note／card／method／delivery）。实测只有 12 个工具 / 2,304 token，不紧急；而且它们的语义是「accepted ＋ 产物核对」，硬塞进 `agent_write` 会把「已接受 ≠ 已完成」这条判据弄丢。
- **不并 `agent_calculate`／`agent_web_search`**——本来就是通用形状。

## 9. 源码依据与待验证事项

**已读并作为判据的源码：**

- `packages/shared/src/agent-capability-catalog.ts`（唯一索引；`executor` 按组赋；`collectAgentCapabilitySceneGuidance` 去重）
- `packages/shared/src/agent-capability-definition.ts`（`defineAgentCapability` 与 `sceneGuidance`）
- `packages/shared/src/companion-agent-registry.ts`（暴露面视图与 read_only 过滤）
- `packages/shared/src/contracts/companion-agent-contracts.ts`（权限档只有三个；风险级四个；`COMPANION_PROPOSAL_EXECUTED_TOOLS`；确认门）
- `packages/shared/src/companion-autonomy.ts`（`COMPANION_AUTONOMOUS_TOOLS` 7 个）
- `packages/shared/src/agent-tool-parameters.ts`（序列化形状；属性级 description 会出去）
- `packages/shared/src/contracts/agent-contracts.ts:33`（`candidateOperations` 是字符串数组，上限 6）
- `packages/agent-core/src/runtime/attention.ts:14,28-29,39`（分类器词表与 `act → uncertain` 降级）
- `workers/ai-worker/src/handlers/companion-agent-runtime.ts:263-297,310`（工具面只由声明决定；steer；`requestedActionTools`；能力快照落库）
- `workers/ai-worker/src/handlers/companion-tool-intent.ts:100-136`（**分类器提示词与载荷形状**）
- `workers/ai-worker/src/handlers/companion-tool-execution.ts`（1,356 行，46 个 `case "`）
- `workers/ai-worker/src/handlers/companion-step-plan.ts:270-295`
- `workers/ai-worker/src/handlers/__tests__/companion-tool-executor-ledger.test.ts`（守卫按 `case "名字"` 的调用形状对表）
- `workers/ai-worker/src/lib/model-tokenizers.ts`（真 tokenizer 只有 deepseek）

**待验证（本文未测、实施前必须补）：**

1. `candidateOperations` 的 `max(6)` 上限与 `(verb,target)` 语义是否相容（§5.1）。
2. ~~判别式 union 在目标 provider 上的实际接受度~~ → **若按 §4.4 走扁平形状，这条不再是前置**（不需要 `anyOf`）。只有仍选 `anyOf` 时才要先验：`anyOf` ＋ `const`／`enum` 的 `target` 是标准形状，但**未在真实 provider 上跑过**，部分兼容实现会拒绝 `anyOf` 根对象。
3. §6 的四个指标基线：需先跑旧版拿基线，才能给新版定上限。**新增一条要量的**：扁平形状下「参数填错比例」——wire 不再逐支强制 `required`（§4.4 代价 1）。
4. 落库的 `capabilitySnapshot.offeredTools` 历史形状能否同时读两种（§5.4）。
5. ~~`companion-tool-intent.ts` 的分类器任务版本与提示词缓存的联动~~ → **已处理并验证**：§4.5 落地时 `TASK_VERSION` 12→13，`promptVersion` 随载荷一起走；现役 `companion-note-generation-routing-probe`（6/6）与 `companion-note-formatting-probe`（8/8）在新载荷下重跑全绿，未见检查点或重放异常。**但这两组探针测的是路由族，不是全量分布**——合并真正落地时还要按 §6 重新采一批。

**结论（2026-10-11 试点实测后定稿）**：**已实施、已回滚，不推荐重试**。§6.5 的量测把「技术上成立」这条划掉了：真实模型在 16 路 target 上 14 次编造工具名，线上一律被门禁挡掉。原结论成立条件仍是「合并＝投影」＋「门禁改 per-target」这两条；缺任一条，要么在只读档出错（§5.2，且错在「多给了能力」一侧），要么退回成一次高风险重构。

与上一版结论的差别只有一处：**形状选扁平（§4.4）而不是 `anyOf`，token 就不是零收益而是 −15%（试点族 −23.5%）**，所以本文可以从「只为可维护性」升级为「可维护性 ＋ 说明体量」。而代价也写清楚了：wire 不再逐支强制 `required`、同名字段跨格形状要有归属判据。这两条能不能接受，要由 §6 的「参数填错比例」定，不是由 token 定。

**推进顺序已终止**：`agent_read` 试点是这个顺序的第 0 步，它没过（§6.5），后面的 `agent_search`／`agent_edit`／`agent_open`／`agent_write`／`agent_control` 都**没有启动**。要重启，先解 §6.5 末尾那条前置——「怎么让模型稳定叫出名字」，而不是再调 schema；且这族里的 `read_only 越权次数` 指标至今没被真正测过（全 read 的族测不到它），届时必须补测。

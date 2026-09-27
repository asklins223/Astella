# W7-1 · 制卡简化的刀切设计（一次生成＋一次批量检查）

> 日期：2026-09-26
>
> 状态：**W7-1 的刀切计划件。合同、刀a（任务定义＋组装＋确定性 provider）、刀b（job 接线）、刀c 的增量改写都已落；未做＝真模型 provider 与质量对比样本（入口切换与旧链删除归 W7-7）。**
>
> 依据：39 §8.6、39c §6.1–6.2、§16.28；已落地的前置：公共内核（W3-1）、竖向样例的任务形状（W3-3）、漏斗判定/落库两半（W3-2）、候选持久化与审核页合同（现网 V2）。

## 0. 一句话结论

**新链只有两次语义调用**：`card_generate_v3`（同一次生成里选目标＋出候选草稿）→ 服务端程序校验与身份计算 → `card_content_check_v3`（一次批量内容检查，逐候选可保留/需修改/依据不足，grounding 级支持报告合并在内）→ 服务端落库与状态。有界修复、投机 pedagogy、独立 Planner 一概不进新链（39c §9 的处置清单在 W7-7 执行删除）。

## 1. 合同（已落）

`packages/shared/src/card-generation-v3-contracts.ts`：
- `cardGenerateV3OutputSchema`：`planIntent`（**不**复用 `cardPlanResultV2Schema`——落地时改的，理由在 §2 落地记录第 1 条）＋ `objectiveProposals`（**提案**形状，无 strategy——整批分配是服务端职责，contracts:404-414 的教训）＋ `candidates`（草稿：objectiveDraft/presentationDraft/hints，全部哈希与身份服务端算）。
- `cardContentCheckV3OutputSchema`：逐候选 `{verdict: keep|rewrite|insufficient, issues, grounding}`——grounding 级支持报告**合并进这一次批量检查**（审核页的"可保留"门槛要 binding plan hash，组装消费的是 grounding 合同，不再单独跑一遍 Grounding Critic）。

## 2. 刀a：任务定义与程序校验（本轮范围）

- 两个 `AiTaskDefinition`（`mode: "structured"`，照 W3-5 assess 任务的预算形状）落在 worker 侧新模块 `card-generation-v3/tasks.ts`；确定性 provider 先行（生成任务的确定性版本 = extractAtomsDeterministic＋DeterministicAuthoringProvider 的合成），真模型归每波末尾批。
- 程序校验复用 `buildCandidatePrecheck`＋`runCandidateDeterministicGatesV2`（不写第二份）；生成输出经合同解析＋"`objectiveLocalId` 必须指向提案"（superRefine 已钉）。
- 计划行由服务端组装：planRevisionId/planVersion（current+1）/previousPlanRevisionId/inputSnapshotHash/cardContentEpoch/planHash（`computeCardPlanHashV2`）——**先写 plan 行再写候选行**（候选行的 plan 列全部 NOT NULL）。
- 判据：单测——合同拒绝越引用候选/带候选的 no_cards；确定性任务跑通两任务且**模型调用计数恰为 2**；程序校验拒坏草稿。

**落地记录（2026-09-26，刀a 已落）**——实施时改了/定了下面这些，按本文件自己的规矩写回这里：

1. **生成输出不复用 `cardPlanResultV2Schema`，改成轻量的 `planIntent`**。那份 planner 合同的重字段（`activationHardMax`／`objectives[].strategy`／`practiceForm`／`sourceAtomIds`／`changeContext`／`existingActions`／`atomDecisions`）**恰恰全是服务端的事**：要模型原样交出 `sourceAtomIds` 就得让它引用它看不见的原子 id，要它交 `existingActions` 就得让它决定已有卡的归档。让它交一份轻的、服务端补成完整的 `CardPlanV2`，才配得上"整批分配是服务端职责"那句教训。
2. **端口只有一条**：`complete({ prompt, input })`。确定性那一版与真模型那一版实现同一个端口，因此两条路共用同一段 execute（组提示 → 取文本 → 按合同解析 → 程序校验）。输入必须带**真 `blockId`**（不只序号）：依据按块挂、原子按块抽，只给序号时"这一句出自哪一块"就只活在提示词里，落不了地——这是量出来的，不是设计出来的。
3. **"复用不写第二份"落地成一次上移**：`buildCandidatePrecheck` 与 `runDeterministicGroundingContract` 原住在 4 200 行的 V2 处理器里（V3 要用得 import 整份处理器）。两者都是纯逻辑，已移到 `packages/shared/src/card-generation-v2-pipeline/candidate-precheck.ts`（该目录的边界声明就是"不做网络、不做 DB I/O"），V2 处理器改为 import 它，本地副本删掉。grounding 报告的 `reportHash` 配方也提成一份（`computeGroundingReportHashV2`），因为 V3 盖章之后要用同一配方重算。
4. **程序校验分两级，各判各的**：草稿级只判**必须看整批**的两件（重复 `objectiveLocalId`、超本 run 候选上限）；依据是否越界**不在草稿级判**——那条判据已由 `runCandidateDeterministicGatesV2` 的 `evidenceSpanGate` 承担（冻结 code `evidence_not_in_sealed_scope`），在组装之后跑。写一条用例钉住"草稿级不判它"，防止下一轮有人把那份判据复制回去。
5. **组装**（`plan-assembly.ts`）：整批分配复用 `allocateStrategies`／`allocatePracticeForms`，并把分配结果**覆盖**到候选的 `presentation.strategy`（模型自选的那一份不作数）；`rubricHash` 丢弃重算、身份两个 uuid 与 `candidateRevisionHash` 全服务端算；**顺序不能倒**——`candidateRevisionHash` 的闭包里就有 `planHash`，所以先出计划再出候选。零模型调用。
6. **`sourceAtomIds` 按块定位**：候选的依据 id → sealed 清单的 `blockId` → 该块里 learnability 最高那一句原子。一个块可以有好几句，**每块只挂一条**：把整块的原子都挂上，"这批覆盖了多少原子"这类读数会虚高。定位不到的候选**剔除并留因**，不拿不相干的原子凑数。
7. **零候选的两条路都出得来一份合法计划**：模型直接说 no_cards ⇒ 它给的理由码折进冻结词表（折不进时按服务端自己的读数说：正文里有可学原子却说没有 ⇒ `no_pedagogically_useful_transformation`；确实没有原子 ⇒ `no_learnable_objective`）；模型说要出卡但**全被剔除** ⇒ 也是 no_cards_recommended（`author_candidates` 的 objectives 是 min(1)，硬塞空数组会让整批发不出去），剔除原因带回给作业层——是 `no_cards_recommended` 还是 `needs_attention` 由刀b 判，这里不替它决定。
8. **检查那一份由服务端盖章**：模型给的 `candidateRevisionId/Hash`、`evidenceSetHash`、`inputHash`、`reportHash` 一律不采信（审核页门槛读的是 binding plan hash，而 binding plan 按候选身份闭包算——错了 id 就能把结论挂到别的候选上）。**漏一张不等于那张通过**：批量检查没给结论的候选补一条 `check_missing`（hard）并判 `insufficient`；判了 insufficient 却一条硬问题都没给，补 `insufficient_without_hard_issue`，不让报告带着空 `hardIssues` 落库。
9. **量到并修掉一处既有缺陷**（不在 V3 里）：`runDeterministicGroundingContract` 交回的 `answerUnits`/`rubricSupport` 是空数组，而 `groundingCriticReportV2Schema` 要求两者 **min(1)**——V2 主管线从不按合同解析这份报告，所以一直没暴露；V3 的确定性那一版第一次跑就红。修法是逐单元按候选填（依据在不在范围内这个读数它本来就已经算过），不是放宽合同。
10. **本刀无表、无迁移、无 HTTP 路由**：调用方只有单测（生产接线在刀b）。
11. 读数：worker 全量 **884 条／884 通过／0 失败**（改前基线 870＋本刀 14 条），`typecheck` 真退出码 0；shared 的读数与 **11 发变异各红在哪一条**记在 39d §19 同日那行（那份台账是数，这里不重复一遍）。


## 3. 刀b：job 接线

新 jobType `card_generation_simplified_v1` 进 outbox 分发，五段：短事务（装载快照＋已有目标摘要＋fence）→ 事务外生成 → 短事务（plan＋候选落库，复用 `insertAuthoredCandidatesBatched`）→ 事务外批量检查 → 短事务（质量报告＋状态：全部 keep ⇒ `review_ready`；有 rewrite ⇒ 增量改写一轮（只重做受影响候选，无再检查循环）；零候选 ⇒ `no_cards_recommended`；全不足 ⇒ `needs_attention`）。**入口选择**：run 创建请求带 `useSimplifiedChain: true`（沿用 0066 已有的 execution_mode 思路，但落在 v2 表的新列或 jobType 二选一，实施时定）。判据：一次性库集成——确定性 provider 下端到端 2 次调用到 review_ready；零候选路径；检查失败不重跑生成；候选出现在审核页且可"保留"。

**落地记录（2026-09-26，刀b 已落）**——实施时改了/定了下面这些：

1. **入口选了 jobType，没有给 v2 表加列**。生产侧唯一的入队点（`generation-run-service.ts`）按 `CARD_GENERATION_CHAIN` 决定投哪一种 jobType：**未设＝完全回到改前行为**（仍投 `card_generation_plan`），设成 `simplified_v3` 才投 `card_generation_simplified_v1`。选它的理由是"能整体撤掉"：W7-7 切入口时这个开关与旧 jobType 一起消失，不留下"表上有一列没人写"的残骸。
2. **分发点仍在 V2 处理器的 switch 里，用动态 import 引 V3 的 handler**——V3 要复用 V2 的落库件，静态互相 import 是个环。为此从 V2 处理器改为公开的只有真正被用到的五个（`fenceV2OutboxLease`／`insertBindingPlanRow`／`insertEvent`／`loadV2RunInputs` 等＋`PendingOutboxJob` 类型）；一度顺手导出、后来核实没有调用方的四个（`loadSealedEvidence`／`loadCommittedFirstRevisions`／`insertEventsBatched`／`groundingContractToQualityReport`）已改回私有。
3. **五段之间只有短事务，模型调用全在事务外面**；三处写事务在提交前都过 `fenceV2OutboxLease`（丢租约＝一个字的写都不许留下）。段 1 的状态门只放 `queued/planning/authoring/checking`——**`checking` 必须在里面**，否则"检查失败"这一类批次永远接不上（这一条是被变异 A 逼出来的：把 `checking` 拿掉，重投那条立刻红）。
4. **`modelCalls` 记的是"本发之内"的调用数**，不是这一批的总账：半途失败过的批次，生成记在 `simplified_plan_committed`、检查记在 `simplified_completed`，两个数相加才是真付过的钱。这是把"报 N 次调用"落到库里时最容易骗人的一处，所以两条事件的数各钉一次——把完成事件写死成 2（变异 C）会红在重投那一条。
5. **`rewrite` 这一档今天不假装能改写**（改写合同还没有，那是刀c）：判 rewrite 的候选 `quality_state` 停在 `authored`（审核页判"可保留"看 `passed`，所以它既不算通过也没被抹掉），报告与 issues 照实落库；只要还有 passed 的候选 run 就 `review_ready`，一张都不剩才 `needs_attention`。
6. **质量报告是 V3 自己的一份合并形状**（`gate_version='card-content-check-v3'`，报告体里带着逐候选的 grounding 与 issues），不复用 V2 的 `groundingContractToQualityReport`——那一份只映射 grounding 一维，而这一版把两道 Critic 合成了一次检查。
7. 读数台：`npm run test:card-generation-v3:postgres` ＋ CI 点名列一步（单文件，outbox 认领是全局的）。§16 那行"制卡族·一次性库"自此多一份：**四份 → 五份**（旧那句 40/40 是它当时那四份的数，没有替我这一份背书；本刀那份在一次性库上 5/5 连跑两遍、跑完六张表零残留）。

## 4. 刀c：增量改写与入口切换

改写走增量（rewrite 候选各自一次改写调用＋只重检该候选）；质量对比样本（短长材料、无来源/矛盾材料——39 §8.6 末段的比较义务）在切入口之前跑；入口切换与旧链删除归 W7-7，不在本任务。

**落地记录（2026-09-26，刀c 的"增量改写"这一半已落；质量对比样本仍未做）**——实施时定了下面这些：

1. **改写交回的还是生成那一种草稿**（`cardCandidateRewriteV3OutputSchema = { rewrites: [candidateDraft…] }`）：不新造第二套内容形状，服务端组装也走 `plan-assembly.ts` 里刚抽出来的那一段 `buildCandidateRevisionV3`——首稿与改写共用同一次身份/哈希计算，差别只有 `revision + 1` 与 `derivedFrom` 追加一条。
2. **一轮为限**：`rewrite` 命中几张就有几次改写调用，然后**只对这些候选**做一次重检；重检之后还判 rewrite 的不再改写，停在 `authored` 等人工（39c §6.1 取消"自动修复—再检查循环"这句的落点）。
3. **调用数如实涨**：一条走了改写的批次在完成事件里记 `modelCalls=4`（生成 1＋检查 1＋改写 1＋重检 1）并带 `rewriteCalls`。§16.28 的"刚好 2 次"是**普通成功路径**的数，多付的要看得见——这条被变异 F/G/H 各自钉过。
4. **改写不换题型、不丢证据闭包**：`presentation.strategy` 沿用整批分配过的那一份（模型想换也不算数）；模型漏填 `evidenceRefIds` 的 rubric 单元沿用上一版，补完之后 `rubricHash` 重算。第二条是 V2 修复链踩过的账（清空证据 ⇒ 重检必被 `no_evidence_reference` 拒）。
5. **谱系要能连着看**：断言写成"第二次改写之后 `derivedFrom` 是 `[1, 2]`"，不是只写"指回上一版"——只验一跳时，把展开写成覆盖（丢掉前序祖先）在 1→2 这一跳上完全等价，变异抓不住（实犯一次，补了第三跳才红）。
6. **旧修订不可变**：被替换的那一版只 `publish_state='superseded'`，不覆盖不删；审核页读的是 `DISTINCT ON (candidate_id) … ORDER BY revision DESC`，所以看不见旧版是正常的、不需要额外过滤。
7. **确定性那一版不会改写内容**（它把原稿交回去，重检仍判同档 ⇒ 那张停在 `authored`）。这是把"离线这一档没有语义判断能力"摆明，而不是偷偷造一条捷径；真模型那一版换的只是 `deterministic.ts` 里那一个函数。
7b. **改写这一档今天只有任务、没有入口**（2026-09-27 数出来的，别把它当成"接线已完成"）：`card_candidate_rewrite_v3` 在 `tasks.ts` 有定义、handler 会处理、集测里手工认领跑通过，但**全仓没有任何一处 `insert` 把它投进 outbox**——审核台上"改写这一张"那一发今天投的还是旧链的 `card_generation_regenerate_candidate`。同一次数的更大一圈：入口总控 `CARD_GENERATION_CHAIN` 只有一个读者（`generation-run-service.ts:433` 那发初次规划），审核台的四发与"再生成一次"那一发共五处都直接投旧 jobType，而总控函数是模块私有的（没 export），那五处**问不到它**。⇒ 翻开关只翻了一半不叫切换：W7-7 的完成判据现在是一条常驻守卫在管（`packages/shared/src/card-generation-chain-entry-inventory.test.ts`——旧链入口清单只能变短、改写任务什么时候接上入口就把那条删掉），不靠这份文档被人记住。
8. **质量对比样本没做**：39 §8.6 末段那句"切入口之前比较质量与成本"要真模型才比得了，登记为欠账，与真模型 provider 同一批（每波末尾那一次真跑）。
9. **真模型没接线期间，生产拿不到这条链**（2026-09-27 补的 L1 护栏）：`resolveCardGenerationV3Providers()` 在 `NODE_ENV=production` 且没显式 `V3_ALLOW_DETERMINISTIC_PROVIDERS=1` 时直接拒——否则把 `CARD_GENERATION_CHAIN=simplified_v3` 打开就会整批跑占位候选，而完成事件记的是 `modelCalls=2`，读数与真跑过模型一模一样。值配错（例如写了 `llm`）抛的也是**不可重试**那一类：配置缺失不该被 outbox 按 15/30/60/120/240s 退避连试六轮（V2 在 2026-09-17 为同一形状记过事故）。这一格不改变"真模型仍未接线"这件事，只保证没接线时生产跑不出东西。
10. **这条链现在跑在公共任务内核上**（2026-09-27 一天之内先量到"没接"、同日附刀三接完；原始事实留在下面，因为它是这一格存在的原因）：当时 `runAiTask(` 在 `card-generation-v3/` 里零调用点，四发模型调用都是 `task.execute(...)` 直调，于是任务声明的 `budget` **一格都不执行**——`maxAutoRetries: 1` 一次都不重试、`stepTimeoutMs`／`taskDeadlineMs` 也没人拿去组成超时信号（内核才是 `AbortSignal.timeout(min(两者))` 的那个"人"），唯一生效的闸是分发点那份整条管道预算与租约丢失；而不合合同抛的是裸 `Error` ⇒ 分发点判成**可重试** ⇒ outbox 退避重投最多 6 次、段 3 之前每次重新付生成那一发。"合同说重试 1 次"与"实际最多 6 次"同时为真。**接线落点**：`handler.ts` 里 `runV3TaskOnKernel` ＋ 一处 `runOnKernel` 闭包（输入快照身份与租约只有一份来源，四发不各写一遍——写四遍就会有第四遍和第一遍不一样那一天），四发全走内核；`verifyAttempt` 接 `renewV2OutboxLease`（**不另起第二份租约判据**），`currentActiveTransaction` 接 `currentWorkerWorkspaceTransaction`（这个端口必填：做成可选就等于让"忘记核对"成为可以通过的形状），`permissionLevel: "server"` 与另外三个内核消费点同一取值。接上之后量到两件没接之前看不见的：**① `maxModelCalls: 1` 会安静地吃掉那一次重试**——内核在**发出下一次之前**检查调用数预算，于是 `maxAutoRetries: 1` 那一发根本没机会花，回执还把它报成 `timeout`／"model call budget reached"：一次合同形状失败被读成一次超时。三份各写一遍的默认合成一份 `V3_TASK_DEFAULT_BUDGET`，`maxModelCalls: 2`＝首次＋那一次结构修复（与 `run-critic`／`teaching-explain`／语音转写同一取值），另加一条单测钉"预算自洽"（`maxModelCalls ≥ 1 + maxAutoRetries`，顺带一条"单步上界不许大于整任务上界"）。**② 分类从此有落点**：`output_shape` 抛**不可重试**（那一次补采样已经在进程内花掉了，队列再重投只是把同一笔钱再烧一遍），其余留在可重试那一侧（被 abort／整条管道预算那两档由分发点自己改判）。读数四格在 `card-generation-v3-simplified-postgres.integration.ts`（现 12 条）：不合合同 ⇒ `paid` 恰好两发＋判不可重试＋零计划行；真分发点那一头读到 `failed`／`attempts=1`／`next_attempt_at` 空／run `needs_attention`；**跑完才发现租约易主** ⇒ 内核在提交前挡下（消息带 `lease_lost`），且迟到的失败过不了 token CAS、写不动新主人的行。变异四支各归一句：N1 把 `maxModelCalls` 改回 1 ⇒ 单测与集测各红一条；N3 把分类写反 ⇒ 红在分类那一句；N4 摘掉 `verifyAttempt` ⇒ 红在**归因**那一句（那时说话的是段 3 那道 `fenceV2OutboxLease`，即"已经跑完模型、进了事务"之后的一端）。**内容合同这一刀的完整清单（2026-09-27 已把主干跑到"生产代码全编译、只剩夹具"，因窗口余量不足整体回滚，下轮一次做完）**：
① 合同加 `cardGenerateV3CandidateContentSchema`（`answerForm` 只留 prose/bullets/steps/pairs 四种产出型；
判分点用 `partIndexes`（1 起）指答案片段，**不指 unit id**；不交任何 id／`*Hash`／`relations`）；
② 新增 `card-generation-v3/expand-content.ts`：内容→`learningObjectiveDraftV2`＋`presentationDraft`
（`au-N`/`ru-N` 按顺序发；`answerUnitIds` 只保留指得到片段的，**悬空引用直接丢**并计数；
`relations` 一律空；`preferredTaskIntents` 由判分点 facet 去重导出；`strategy`/`transformationKind`
放合法占位，等 `plan-assembly.ts` 整批分配覆盖；`steps` 只有一段时退回 `bullets`，别让整发红在片段数上）；
③ 生成腿与改写腿的 parse 都改成"先校验内容、再展开"，任务输出类型换成
`cardGenerateV3DraftOutputSchema`（服务端内部形状），下游程序校验／组装／落库**一行不改**；
④ 确定性 provider 改为交内容（它本来就是为了搭脚手架才去调 V2 author，去掉那一层反而更短：
`prose` ＋ 一句命题 ＋ 一条判分点 ＋ 两级提示）；⑤ 提示词的合同表把 roots 换成内容 schema，
`draft-ids.ts` 那套补 id 的模块随之删除（被展开器取代）。**两处已知会红的夹具**：
`card-generation-v3.test.ts:384`、`:425`（`candidateDraft()`／`generateJson()` 得产出内容形状）。
两个坑记牢：`instanceof z.ZodObject` 跨包恒假（shared 与 worker 各一份 zod），类型分派只能读
`_def.typeName`，否则会渲染出**空表**；合同表递归深度上限别设 4——它正好把 `rubric.units[]` 截掉，
表看着全而模型照样撞。

**仍欠**：真模型 provider 没接线（花钱，等用户点头），所以 §8.6 的质量对比照旧是欠账；单步超时今天只有内核自己的用例在保，这条链上没量过真慢调用。**两腿都量过了**（同日下一格）：检查那一发同样交回不合合同的形状时，`paid` 是 `generate,check,check`——生成不重付（计划已落库）而检查有那一次补采样，分类同样不可重试，候选只剩一种 `quality_state='authored'`（「没检查」不等于「检查没通过」），run 停 `checking`；用户可见的那件事实是**这一批还占着这篇笔记**（`note_generation_in_flight`），要等分发点判成 `needs_attention` 才放开，所以"不可重试终结"对用户是"可以再点一次生成"。**提示词的族规（三发真模型换来的）**：模型必须自己填的**每一层**都要在提示词里现出来——必填键清单、每个枚举的取值、判别式的字面量取值，一律由 `contractSheetV3` 从合同 schema 现取（判必填用 `safeParse(undefined)`，判节点类型只能读 `_def.typeName`：`instanceof z.ZodObject` 跨包恒假，第一次就产出了**空表**，而空表比缺一格更坏，它看起来像"已经说清楚了"）。三发各撞一层就是这条规矩的形状：`knowledgeForm:"…"`（词没列）→ `objectiveDraft:{…}`（键没列）→ `preferredTaskIntents[0]`（再往里一层没列，那九个取值里模型要挑一个，它一个都没见过）。认不出的**结构**类型不许静默跳过，要打印"形状未展开（X）"；标量叶子不占行。现在的表是 40 行／提示词 3919 字符／未展开 0。**真模型那一版的接线形状已经定下来了**（2026-09-27 数过约束，下一手直接照这一句做，别再从头扫）：outbox 表 `card_generation_run_outbox_v2` 只有 `workspace_id/run_id/job_type/payload`——**没有 user_id**，而分发点是在**认领之后、段 1 之前**调 `resolveCardGenerationV3Providers()` 的，那里拿不到 run 的主人；治理上下文与 `ai_audit_log` 那一份审计都要按 (workspace, user) 解析（V2 的四发是在事务外先解析再传进来的，`buildCardGenerationProviders` 的 `governance` 参数就是为这件事存在的）。⇒ 落点是**分发点**先按 run 的主人解析治理上下文再带 transport 进来：`resolveCardGenerationGovernance(workspaceId, runId)` 早就存在并且正是干这件事的（它现读 `card_generation_runs_v2.user_id`，没有主人就直接拒），四步治理出口搬成 `resolveGovernedCardGenerationProvider` 后两条链各调一次。——**更正上一版的说法**：我当时写"要把 `user_id` 补进 `loadV2RunInputs` 那份 SELECT"，那是没找到现成那一位就自己开第二条路；本仓库对"这个 run 属于谁"已经有一个答案了，不复用就会漂移。provider 那一侧**只复用 house 的四步**（`resolveAIGovernanceContext` → `resolveProviderSelection` → `createProvider` → `createGovernedProvider`，审计 operation 记 `card_generation_v3`），**不复用 `CardGenerationProviderRuntime.chatJson`**——它自带 2 次退避重试与 per-job 调用预算，而这两件事现在归内核（两条来源会把一次合同形状失败放大成 3×2=6 发）。真模型那一次花钱的对比（§8.6 的质量样本）需要用户点头，接线本身不需要。

11. **下一刀不是提示词，是合同里的"服务端 id"（2026-09-27 五发真模型之后改的判）**：第五发的违例是
`objectiveDraft.rubric.units[0].rubricUnitId` 缺失。V3 的既有设计是"身份与哈希一律服务端算"
（`rubricHash`／`candidateRevisionId`／`planHash` 都这样），但 `learningObjectiveDraftV2Schema` 把
`canonicalAnswer.*.unitId`、`rubric.units[].rubricUnitId`、`rubric.units[].answerUnitIds[]`、
`relations[].relationId/fromAnswerUnitId/toAnswerUnitId` 都当**模型必填**——模型既不知道这些串该长什么样，
也不该被要求发明它们。所以别再往提示词里加说明（第四五发已经演示：补一层就撞下一层）。
**这一刀的完整形状**（三条都做了才算做完，缺一条会更坏）：① V3 侧在按合同解析**之前**给这些格子补
确定性的服务端 id（`rubricUnitId` 那族带唯一性 refine，重复即红）；② **引用要重指**——`answerUnitIds`／
`relations[].from/toAnswerUnitId` 是模型自己起的名字，补 id 之后必须把引用一起换过去，否则过了 schema
校验却留下悬空引用（schema 抓不到，`runCardGenerateV3ProgramChecks` 那类整批判据也抓不到，只有落库后的
投影才会炸）；③ 提示词的合同表要跟着变：这些格子从"必填"里去掉，并说明"服务端会补 id，你只用同一名字
互相引用"。做完再发**一发**验 `review_ready`。
另一件同时欠着的：`ChatResult` 只有 `{content, usage}`，没有 `finishReason`，所以端口分不清"输出被
`max_tokens` 截断"与"模型给了段坏 JSON"（第四发就是靠"没有任何 zod 路径＋Unterminated string"人工认出来的）。
补 `finishReason` 是 provider 层的一刀，补之前不许靠猜 `completionTokens` 造伪判据。

## 5. 与其他任务的边界

- 审核页（W7-2）消费的候选合同不变——新链产出与 V2 同表同形状，"保存到卡组 / 保存并开启复习"的组合命令（W7-2）不受影响。
- 伴星入口（W7-9）依赖本任务的提案接口：情境制卡携带同一材料版本与目标范围调用同一生成任务。
- 一次回答/一次需求消费的调度语义（W7-5/W7-8）不在本任务。

---

## 7. W7-7 刀二的分诊表：旧链那份网里，哪些随链删、哪些必须先改接（2026-09-27 逐条读用例名与断言）

**为什么先做这张表**：刀二看起来是"删 6 000 行"，实际不是。旧链的十份集测里有一批用例
测的**不是四阶段链本身**，而是激活、幂等、租约、配额、可见性、reveal 闸门——它们今天
只是"借那条链跑一遍"。跟着链一起删，等于把与链无关的产品判据也删了；不删而直接翻入口，
它们整片红（2026-09-27 实测：入口一翻，`e2e-subset` 25 条红，其中至少 12 条与链无关）。
所以顺序只能是：先按这张表把"必须活下来的"改接到新链，再删链，最后删开关。

### 7.1 随旧链一起删（断言的就是四阶段独有的东西）

| 用例／文件 | 为什么只能随链走 |
| --- | --- |
| **（2026-09-27 刀二第①步已删）** `card-generation-v2-postgres`（V2 纵切）、`-plan-commit-postgres`、`-pedagogy-stage-postgres`、`-bounded-repair-postgres`、`-per-candidate-commit-postgres` 五份整文件 | 断言对象全是四阶段独有的东西：纵切那条管道本身、投机 pedagogy 与双 Critic（39c §9 点名要删）、有界修复循环（39c §6.1 取消自动修复）、逐候选各一次提交（新链一次生成出一批，没有逐候选 author 循环）。同步清掉的注册面：CI 点名单里 plan-commit 那一步、`integration-run-registration` 待办清单里那两行（清单 7→5）、`check-a1-landed.sh` ⑥ 那三条指向已删文件的签名；`insertRepairedCandidateV2` 的注释改口——它那格用例没了，这条不变量如今只有 0253 索引本身在执法 |
| `card-generation-v2-llm-natural-activation`（真实四阶段全旅程） | 同上；它的"全旅程"那一半在 V3 那份集测里已有对应格。**这一份要单独删**：它第 86 行自己把 `CARD_GENERATION_V2_LLM` 写成 `"true"`（摘环境变量拦不住），跑它＝付费，2026-09-27 我把它抄进批次名单就造成过一次未经点头的真模型尝试 |
| e2e 里的 C04（Atom 重复决策）、C05/C06/C08/C09（planner 怎么切目标）、C13（pedagogy hard fail 词表）、C14（deck gate 合并/drop） | **已删（同日第②步的头一刀，7 格 136 行）**：判据对象是 planner/Critic 的中间产物，新链不产出这些结构。**C20b 不在这一批里**——它在刀一之后已经改成判"换一批"那一档（`mode=replan`，走默认档），是幸存判据不是旧链判据；当时那张表把它列进来是错的，这里改口。删后这份 37 条变 **30 条**（29 过／1 跳过，跳过那条仍是 C48 的受限角色前提），`tsc` 0（没有留下没人用的 helper）。 |
| **同一份文件剩下的活儿（每条都先量过原因）** | 那一晚按原因搬走 **6 条**：C22（它判的是"幂等重放没有多入队一枚 job"，旧写法却按 `job_type='card_generation_plan'` 过滤——**那条旧链字面量正是它搬不过去的唯一原因**，去掉过滤之后判据反而更准）、C17／C23+C25／C30／C46（这四条红在"夹具拿不到候选"，与各自要判的东西无关，换成正文 `DUAL_CHAIN_CONTENT` 即过；顺手删掉两条因此没人读的正文常量——`tsc` 抓到就说明该删）、C02（本来就在默认档上绿）。搬完这份是 **30 条／18 走默认档／12 仍钉旧档／0 失败**，摘档处数 12→**20**（棘轮同步抬到 18，往回钉就红）。**剩下 12 条分四类**：① 判旧链独有结构的 **C01 与 C10**（`pipeline.route.light` 那个轻链路路由分类器）加 **§10.5**（旧链"置了付费开关但没密钥要 fail-closed"那道闸，新链对应的是 provider 档）——这三格随链删；② **C07 与 C12 同日各自有了结论**：C12 **搬完了**——量到新链对同一篇注入正文交回的是一条干净的 ACID 候选，注入那半句被共享门 `prompt_injection` 挡下并记在段 3 事件的 `gateRejected` 里，所以判据从旧链的"整批 0 passed"改写成"注入文本不许进任何候选正文＋事件必须点名 `prompt_injection`"（后半句专防零人群的绿），变异＝短路那道门 ⇒ 只有 C12 红；C07 **判给旧链随链删**——新链的确定性作者永远整句照录，永远不会"丢掉限定条件"，旧链那句 `passed === 0` 靠的是被 39c／39d 去掉的那一腿语义 Critic，在新链上没有可读对象；真实缺口是"边界条件被丢掉"这类质量只能靠 §8.6 那次真模型对比来量。 ③ **长正文那一格查出一件真缺口，同日已补**：旧链把源文本塞进提示词前有规模上限（`V2_SOURCE_CONTENT_MAX_CHARS`）并在事件流留痕，简化链的 block 列表没人截、也没人记——长笔记整篇进 prompt，既更贵也没留痕。补法是把旧链那份发射器导出给简化链段 3 用，再加一个按 ordinal 给额度的 `capV3PromptBlocks`；那一格换到默认档之前红、补完绿（改前改后天然对拍），反向的"没截断就不许留痕"也变异证过。**这一格已搬，摘档处数 19。** ④ **C21／C24／C16／长正文重跑／C47／C48 六条还没查到落点**（C16 的用例签名跨行，C24 的两发正文各有用途，别照②③的办法硬套）。 |

### 7.2 摘档实测（2026-09-27）：十份一起摘掉是 41 条红，所以按份量、按份量

把十份集测头上那行 `CARD_GENERATION_CHAIN = "v2"` 全部拿掉，在一次性库上逐份跑默认档（简化链），
逐份的通过数就是这份与旧链的耦合度：

| 文件 | 默认档实测 | 处理 |
| --- | --- | --- |
| `card-generation-v2-redaction-quota` | **2/2** | ✅ 今天已摘档：它测的是依据遮蔽（tombstone＋eligibility 前移）与 §22.6 配额，与哪条链出几张卡无关 |
| `card-generation-v2-live-progress` | 6/8 → **已搬 6 条（整份 8/8）** | 部分摘：红的那两条是"作者循环里的 tick 落盘"与"重投同一 run 不新增 authored 事件"——都是旧链的逐候选写盘形状；租约 fence、终态退役、外层回滚不影响读数那几条是机制，改接到新链的写入点后整份可摘 |
| `card-generation-v2-c-cases` | 2/3 → **已搬 2 条（整份 3/3）** | 红的是 C38（PREPARE 后 target-equivalent 修订），它读的是旧计划的修订谱系 |
| `card-generation-v2-e2e-subset` | 13/36 → **已搬 8 条** | 同日改成**按用例分档**：文件头仍钉 `v2`，`beforeEach` 每发复位，8 条与链无关的（C03/C33/C32/C36/C5/§17.5/C18/C45）在开头摘掉档位走默认档。搬动本身要有读数，所以加了一格**分档探针**：同一文件里连开两条 run，复位那条必须是 `card_generation_plan`、摘档那条必须是 `card_generation_simplified_v1`——没有它，"已搬走"只是注释里的主张。剩下 28 条按 §7.1/§7.2 分：判 planner 中间产物的随链删，判激活/幂等/reveal 的逐条改接。13 条已经在默认档上过（含 C33 SSE 白名单、C32 跨空间伪造 runId、C03 零候选、C45 开启复习那一档等）；红的那 23 条按 §7.1/§7.2 分：判 planner 中间产物的随链删，判激活/幂等/reveal 的逐条改接 |
| `card-generation-v2-plan-commit` | 0/4 | 全删（对象是旧 plan 提交形状） |
| `card-generation-v2-pedagogy-stage-postgres` | 0/3 | 全删（投机 pedagogy＋双 Critic 结算等式） |
| `card-generation-v2-bounded-repair-postgres` | 0/3 | 全删（有界修复链本身） |
| `card-generation-v2-per-candidate-commit-postgres` | 0/3 | 全删（逐候选各一次提交；新链一批一次提交） |
| `card-generation-v2-postgres`（V2 纵切） | 0/1 | 全删 |
| `card-generation-v2-llm-natural-activation` | 0/1（且单独跑会挂到超时） | 这份要真 provider 配置，不在今天这张网里跑；随链删 |

**规则**：一份文件只有在默认档上**逐条量过全绿**才摘档；摘档的提交说明里写清它是量过的（不是"应该无关"）。
**当天做完的**：把上面那张表从"整份能不能摘"改成"逐条能不能摘"——文件头钉 `v2`、`beforeEach` 每发复位、与链无关的条目在开头摘档位。已搬到默认档的共 **18 条**（redaction-quota 整份 2、e2e 8、live-progress 6、c-cases 2），搬完这四份各自 8/8、37/37、3/3、2/2，十份一起跑 **82/82**（不含 `llm-natural-activation`——它要真 provider 配置，单独跑会挂到超时，不在这张网里）。
**审核台那两条已真搬过去（同日稍后）**：C15／C20 现在走默认档，判据从名字改回它该判的事——派的 job 认逐候选那一发（`card_candidate_refine_v3`，`mode` 分 recheck／rewrite），留痕事件认 `card_candidate.rewritten` 且**要求 `reason` 是用户反馈那一档**，C15 认检查腿的 `card_generation.simplified_completed`。夹具换成正面写明原因的一份正文：原来那份在新链上被我们自己的 `front_leaks_answer` 闸门整批剔除，用例红在「needs a candidate」，红点与它要判的东西无关。`e2e-subset` 37/37。这两格顺带补上新链缺的一层覆盖——此前 refine 两档只有手工插 outbox 行的集测，现在是从真实审核动作打进去的。

**C20b 也搬过去了（同日稍后）**：「换一批」这一发的判据本来就几乎全是链无关的——两版计划、新版本指向旧 revision、`plan_hash` 变了、**旧候选整批 supersede**、run 指向 v2、终态在 review_ready/needs_attention 里；只有留痕事件的名字各条链不同（旧链 `card_generation.replan_completed`，新链整批那一发的 `simplified_completed`）。搬过去之后新链第一次拿到**从真实审核动作打进重排路径**的覆盖（此前 `mode:"replan"` 只有手工插 outbox 行那一格）。

**到目前为止搬到默认档的判据总数：19 条**（`e2e-subset` 11：C03/C33/C32/C36/C5/§17.5/C18/C45/C15/C20/C20b；`live-progress` 6 条机制格；`c-cases` 2 条对象谱系格）。`redaction-quota` 那 2 条因整网顺序耦合钉回 v2（见上面那条缺陷记录），不算已搬。

**另记一条网的缺陷**：`redaction-quota` 单独跑 2/2（连跑两次都量过），但十份连着跑时 C31 红在 `Missing expected rejection: activation must be rejected after redaction` —— 它与排在它前面的文件有状态耦合。已重新钉回 v2，并把这句写在文件头上：**钉档在这里不是结论，是「还没单独证明它能扛住整网顺序」的记号**。**这条耦合当天只量到排除项，没定位到原因**：前面接 `e2e-subset` 或 `live-progress` 各一次都不红；"两个文件共用写死的 workspace" 这个猜测被否掉（本目录 10 份全用 `randomUUID()`）。**随后钉住它的是否定，不是原因**：把它左边那八份文件逐对配对跑过（每对之前重建一次性库）——`e2e-subset`、`live-progress`、`plan-commit`、`pedagogy-stage`、`bounded-repair`、`per-candidate-commit`、`postgres` 纵切、`c-cases`——**八对全部 0 复现**。加上单跑两次 2/2、整网十份里一次绿一次红，今天能说的只是：**这是一发未定位的间歇不稳定**。"与排在它前面的文件有状态耦合"那句推测撤回；C31 的遮蔽与激活都是同步服务调用，所以"等异步消费者"那半句也撤回。钉档已撤（当天稍后）：那次之后又在整网红一次，累计 2/20（单跑 10 次全绿、八对配对 0 复现、整网两绿两红），而我加的两条前置自证都通过 ⇒ 排除"读不到该修订的 binding plan"这一条走法，剩两种待测：条目在但 `bindingEntryEvidenceSnapshotIds` 抽不出 snapshotId；或候选压根不在 `candidateByRev` 里（`activation-service.ts:409` 的 `if (c)` 一假整道门跳过）。一次观察既证不了因、也不够正当化长期防护，所以摘档＋留自证；下一手是在那两处各加一格前置，不是再猜第三个因。

**同日结掉：因找到了，而且不是"夹具偶发"，是门读错了行。** 那条修订上本来就同时挂着**两份** binding plan 行——链第一次生成写一份（v3 `card-generation-v3/handler.ts:904`、v2 `handlers/card-generation-v2-handler.ts:2803` 都调同一只 `insertBindingPlanRow`），夹具为 C31 再手写一份（引用已被遮蔽的那份证据）。这张表只有 `binding_plan_id` 是唯一键，`candidate_revision_id` 上是普通索引，所以多行并存是常态：重检、按反馈改写也各写一份，谁都不删旧行。而 §13.1 那道门把多行收敛成一行用的是 `new Map(rows.map(...))`——**最后一行胜出，且没有 ORDER BY**——"读到哪一份"于是由物理布局决定：读到链写的那一份（证据都还可用）就整段放行，激活成功返回，报出来只有那句不交代原因的 `Missing expected rejection`。当时两条前置自证都通过，正因为缺陷的形状不是"读不到"而是"读错行"。**改法**：三处读点统一按"候选行自己点名的那一份"取（`activation-service.ts:445` 资格门、`:936` 映射 canonical bindings、`:1680` 算 equivalence hash；一份一份按 `(created_at, id)` 升序取回再交给 `:151` 的 `pickCurrentBindingPlanV2`）。点名在生产里总是解析得到：worker 插 plan 的同一步就把该 hash 写进 `card_generation_candidates_v2.evidence_binding_plan_hash`（v3 `handler.ts:907`）。没有点名（历史行、手写夹具）才退到排序后的最后一行，仍是确定的。**新格守卫**：把干净的那一份**插在最后**再投一发激活，仍然必须拒；变异自证＝把门改回不看点名 ⇒ 只红这一格，且红在它自己那句「后插的那一份干净 plan 不许把候选点名的那一份（证据已遮蔽）遮掉」，还原即绿。反方向不必再加一格：同文件前半段 §15.7 那次**成功**激活走的就是同一套点名读取。**读数**：`redaction-quota` 单跑 2/2；制卡族十份在一次性库 `ailearn_c31fix` 上顺序整跑 **82 条／81 过／0 失败／1 跳过**（跳过那条是 C48 的受限角色前提，不是新红）；api `tsc` 退出码 0，api 全量 **1773 条里 1 红**在 `note-visibility-read-sites`（`round-target.ts:52`，并行会话在途那份，与本刀无关）；worker `tsc` 0；shared **500/500**。**教训一条**：它"只在整网红"是真的，但成因不是顺序耦合，是那一发多跑了链内的一枚 job、于是同一条修订上多出第二份 plan 行——配对二分量不到，因为需要的不是"前面某份文件"而是"同一份文件里多一次生成"。


**试搬审核台那四条的实测（同日，随后回退）**：C15／C20／C20b 摘档后各红在三处不同的地方——`C15/C20 needs a candidate`（夹具用的是短正文笔记，简化链那侧的确定性作者对它的产出与旧 planner 不同，拿不到 `revision = 1` 的主体）、`C20b must record card_generation.replan_completed event`（断的是旧链的事件名；新链重排那一发写的是 `simplified_plan_committed` 与 `simplified_completed`）。结论：**刀一接上 refine/replan 只是把路径建好，这四条要搬还得先改夹具与事件名**，不是删一行钉档就行；回退之后 `e2e-subset` 回到 37/37。搬这四条属于刀二，落点就是上面三条读数。

合计 23/64 通过——这也说明 §7.1 那张"随链删"的清单是主体，先把该删的删掉比先改接更省事，
但**顺序不能反**：先删链会让那 41 条一起变成"没人测了"，所以先摘得动一份是一份，
剩下判中间产物的那批随链删，判机制的那批改接。

### 7.3 分诊时报过的一条"洞"——复核后收回（2026-09-27）

第一版这里写的是"新链没有任何实时进度写入点 ⇒ 默认档上『生成中』那一屏是死的"。**那句说过头了**，
按实测改口：0249 那张表存在的理由写在 `helpers.ts:151-159` 里——旧链整条管道跑在**一个事务**里，
候选行要到提交才可见，所以 `authoring` 期间回候选表数出来的读数**恒为 0**，才需要 worker 另写一份。
新链不是那个形状：段 3 把计划与候选**先提交**（状态推进到 `checking`），段 4 才发检查那一发，
所以 `checking` 这一大段时间里 `readGenerationProgressV2` 从候选表就数得出 `authored`；
而 `planning` 那一段（真模型约 30–50 s）读数确实是 0/0/0/0——但那是**真 0**：`plannedCards` 出自
计划行的 `result->>'recommendedCardCount'`，那一刻计划还不存在。写一份"0 张"的读数不会让屏幕
更有信息量，只会多一个可以被质疑的来源。

结论：新链**不需要**补那张表的写入点；`live-progress` 那 8 条用例测的是"旧链那种长事务里怎么把
读数挤出去"的机制（含写侧核租约、终态退役、外层回滚不影响读数），随旧链一起退场。
要留的是读侧那半句：`LIVE_PROGRESS_STATUSES` 与那个 JOIN 上还挂着"陈旧读数自动不可见"这条判据——
如果哪天新链又出现"长时间持有但未提交的进度"，得重新判断，而不是默认那张表还活着。
（这一条从"待修的洞"改成"随链退场 + 一条读侧保留判据"，是把没量过的话写成了量过的话的当场纠正。）

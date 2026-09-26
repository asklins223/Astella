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

## 5. 与其他任务的边界

- 审核页（W7-2）消费的候选合同不变——新链产出与 V2 同表同形状，"保存到卡组 / 保存并开启复习"的组合命令（W7-2）不受影响。
- 伴星入口（W7-9）依赖本任务的提案接口：情境制卡携带同一材料版本与目标范围调用同一生成任务。
- 一次回答/一次需求消费的调度语义（W7-5/W7-8）不在本任务。

# 方案 44 实施日志

> 这份文档是 `44-unified-context-window-and-compaction-2026-10-05.md` 的**实施过程记录**：
> 按轮次记下补了什么、查出了什么、以及每一步的验证范围。
> AGENTS.md 要求「实现记录和排障经过留在任务或测试附近，避免重新堆进这份入口文档」，
> 所以这些过程性内容从方案正文搬到了这里；**方案的判断与状态仍以正文 §11 为准**。

---
---

## 人工评阅改成「填表 → 并入」，而不是手改 JSON

原来那一步是「打开 `samples.json` 手改三个字段」——一条样本就是一坨嵌套对象，
手改容易改错行，而且看不出自己评的是哪一条。现在产物里多一份 `worksheet.md`：
每条样本一小节，**评阅标准与原始回答直接印在旁边**，下面一张三格表
（内容错误 / 同类返工 / 重复解释），填完存回同一目录，跑 `--apply-worksheet` 并入报告。

`-` 与 `0` 的区别在表头就写明了：**`0` 是「评了，确实没有」，`-` 是「没评」**，
后者会被汇总成缺测，不会被当成零。

回填这条路本身也踩了两个坑，都是「看起来做了、其实没生效」那一类：

- 正则只匹配纯数字，于是占位行 `| - | - | - |` 直接把整节跳过——**填了也应用不上**。
- 切分用 `/^## /m`，结果把**回答正文里的 markdown 标题**（模型很爱写
  `## 适用条件` 这类小节）也当成了一节：12 条样本被切成 20 节，后 8 节全落空。
  改成只认本表自己生成的节标题（`## <taskId> · <arm>`）。

实测整条回填：填 2 条 → `applied: 12`（全部识别）→ 报告写 `contentErrors（2/12 条有读数）`
并继续拒绝对其余 10 条下结论。**部分评分被如实报成部分，没有被补成全 0。**

## 对照 runner 的闸门已实测（无需凭据即可验的那一半）

真实对照跑不起来的原因只有两个，而两个入口都已实测：

- **不带 `--real-model`** → 静默退出 0，什么都不做（默认不花钱）。
- **带 `--real-model` 但没有 `REAL_MODEL_BATCH=1`** → `AssertionError: 真实对照需要 REAL_MODEL_BATCH=1`。
- **两个开关都给了但没有凭据** → 一条指明要配置什么的错误：
  `agent_turn capability 未解析到可用平台…请配置 TOKENRHYTHM_API_KEY，或用 EVAL_PROVIDER/EVAL_MODEL/EVAL_API_KEY 显式指定`。

也就是说：**从「按下去」到「真正发出第一个请求」之间的每一处失败都是可读的**，
不会在用户第一次运行时炸成一坨堆栈。剩下需要凭据的只有真实请求本身。

## 真库清点：哪些集成测试「从来没跑通过」

2026-10-06 全仓清点：155 个集成测试文件里 **20 个从未跑通过任何一条用例**。
**其中没有一个属于方案 44**（逐一 grep 过表名与概念；唯一疑似命中是
`notes.context_budget_key`，那是另一条既有特性）。所以这份记录留在这里，
不写进方案正文——它属于仓库的夹具卫生，不是本方案的缺口。

最要紧的两条横切发现：

- **`dev-disposable-db.sh` 打印的四个变量不足以跑通仓库。** 另有 8 个别名变量
  （`RATE_LIMIT_TEST_*`、`RLS_TEST_*`、`QUEUE_TEST_*`、`DATABASE_URL_TEST_ADMIN` 等）
  是某些文件的第五个入口条件，缺了在 import 阶段就抛——10 个文件 0 用例执行，
  而报错长得像「这个测试坏了」，实际只是入口没打开。
- **「需要超户连接」是一个自相矛盾的类别。** 9 个文件里 6 个在模块顶层用受限角色种
  `users`（撞 RLS），3 个要在同一条连接里 `SET LOCAL ROLE`。其中 2 个的断言**依赖 RLS
  生效**（必须在受限角色下量），而种子**又需要超户**——单靠调环境变量解不开，必须改夹具。
  它们从没跑通过，所以「那个跨用户隔离能力好不好」目前**是未知**，不是「已验证通过」。

另外两个容易被误判的形状：

- 报 24 红的那个文件**实际只有 1 条真红**——一条用例留下在途 run 触发并发上限，
  把后面 23 条全堵死。**级联噪声不是 23 个缺陷。**
- 用硬编码 UUID 且不清理的夹具**第一次绿、之后永久红**；看到它红，第一反应该是
  「它上次留了行」，而不是「代码坏了」。

还有一条贯穿性的：**通过率高的用例在往库里漏 active job**（当时 80 条），
直接堵死两个断言「active job 必须恰好为 0」的结构性用例——它们自己写明了
「requires an isolated database」，要求是对的，但仓库没有任何机制保证跑测时库是干净的。

---

## 逐轮补齐记录

第二轮补上的（同样只到「代码可查」，没有运行证据）：

- **读取端沿接续链回溯**（[companion-dialogue-store](../../workers/ai-worker/src/handlers/companion-dialogue-store.ts)）：
  `readConversationSummaryChain` 从链头沿 `parent_summary_id` 回溯，把
  `summarizeSummaryChain`（纯函数，可脱离数据库验收）算出的**真实覆盖起点**与
  **链上缺口**带回调用方。此前只取最新一份，等于把更早的覆盖索引丢掉——会话看起来
  「有摘要」，实际中间那段没人读过。
- **注入上限按用途重估**（§4.4）：`renderConversationSummary` 从固定 600 字符改为
  容量装配，且**丢的是可选项**——「里面的数字可能已经变了」这条安全声明与收尾标签
  永远保留（旧实现用 `slice` 砍整块，那句声明本身可能被砍掉，砍掉之后几周前的一个
  数字会被当成当前事实读回去）。覆盖缺口非空时会明确告诉模型「那部分你没读过」。
- **回执落库**（0383 迁移、[companion-context-receipts](../../workers/ai-worker/src/handlers/companion-context-receipts.ts)）：
  `composeAgentContext` 早就在产出 included / empty / budget_omitted，此前只
  `logger.info`。现在逐条回执与完整请求的预算读数一起落到 `companion_turn_runs`，
  只记 id、状态、字符数与水位。**「窗口放大后触发变少」与「预算从来没接上」从此在数据上
  分得开。**

第三轮补上的：

- **跨会话找回**（[companion-summary-retrieval](../../workers/ai-worker/src/handlers/companion-summary-retrieval.ts)
  与只读工具 `companion_recall_past_conversation`）：新会话按需在**别的**会话里检索
  以前聊过的话题，返回带来源身份的命中（conversationId + 覆盖区间 + 来源哈希），需要原文
  再带 conversationId + fromSeq 取回那一段。范围校验落在**会话**上而不是只落在消息上；
  只认覆盖完整且经过校验的摘要；命中条数与原文条数都有界，被截断时标 `truncated`。
  当前会话被显式排除——它的尾部与摘要**已经在上下文里**，再给一遍只是重复烧窗口。

第四轮补上的是一条**守卫**，把「所有实际调用入口」从一句声明变成被检查的性质：

- [context-governance-boundary-guard](../../apps/api/src/__tests__/context-governance-boundary-guard.test.ts)
  断言生产代码里出现 `createProvider(` 的文件必须同时出现 `createGovernedProvider(`。
  压力闸接在包装器上才「天然覆盖」；也正因为是天然覆盖，哪天有人为了图省事直接拿裸
  provider 发一次模型调用，同意、政策、PII、审计与预算闸会**一起**被绕过，而没有任何
  测试会红。现在会红。
  它查的是结构事实（「这个文件是不是在造裸 provider」——绕过就发生在那一步），
  不是运行期覆盖证明；`integration-tests/` 与 `scripts/` 整棵树按目录排除（离线评测与
  实库夹具本来就没有工作区与 actor 可供治理）。

第五轮补上的是**压缩执行本身**（44 §5.2／§5.4）：

- [companion-compaction](../../workers/ai-worker/src/handlers/companion-compaction.ts)：折叠规则与
  「至多一次」的发送器。折叠的做法是把**已经被一份校验过的摘要盖住**的回放尾部折掉，
  让那段只由摘要代表；折的单位是整条消息、以 seq 为界，尾部之后的一切（当前请求、工具
  调用与工具结果）原样保留。
- 折叠是**无损**的，这也是它不需要另造一套围栏的原因：原文一直躺在
  `companion_messages`，摘要先提交后折叠且必须带 `sourceSha256`，而 run 的交接快照保存的
  仍是折叠**之前**的形态——崩溃恢复只会拿到更多上下文。
- [companion-turn-providers](../../workers/ai-worker/src/handlers/companion-turn-providers.ts)：
  三个 provider 槽（主链路／思考档重试／跨模型兜底）各自的理由与治理边界收在一处，闸只挂主档。
- 编排侧只剩调用点：agent loop 的整段取回与流式两条发送路径都过 `sendWithBoundedCompaction`，
  对话层提供 `replayFold`（它才知道每条尾部消息的 seq 与当前覆盖到哪）。

为守住神文件棘轮，同轮把 `runtimePolicy` 文本块移入 `companion-step-plan.ts`
（与 `partitionPersonaPatch`／`planStepSteer` 同族：纯拼装、不碰运行时），
companion-agent-runtime 1534 → 1473、companion-dialogue 1523 → 1488。

第六轮补上的是**失效传播的读侧**（44 §3.3「读取与提交均检查当前有效性」）：

- [0384 迁移](../../../apps/api/src/db/migrations/0384_summary_context_revision.sql) 给会话加
  `context_revision`、给摘要加 `verified_context_revision`。`companion_messages` 上的
  UPDATE/DELETE 把修订号 +1；**追加不动**——追加若也 +1，所有摘要会在第一条新消息
  到达时全部失效，而摘要器是周期跑的，那是对现状的倒退而不是治理。
- 读取侧因此变成 O(1) 的精确判定：链头与**每一个祖先**都要 `verified_context_revision`
  等于会话当前的修订号，对不上就排除。此前 `readConversationSummary` 的注释写着
  「content-verified」，实际只查了三列非空——`coverage_source_hash` 在读路径上从未被
  复核过，消息被改写后旧摘要照样注入，用它那句「更早那段对话」把已经不存在的内容
  重新说一遍。传递来源也一起检查：链头那份摘要已经把祖先的内容写进自己身上了。
- 写入侧在同一事务里 `FOR SHARE` 读修订号、提交前复核；期间有人改写就整份作废。

第七轮补上的是**失败冷却与无进展状态**（44 §5.4 后半）：

- [compaction-cooldown](../../packages/agent-core/src/context/compaction-cooldown.ts)：纯判定，
  时钟由调用方传入。它区分两件事——**冷却**是时间问题，过了就再来；**无进展**是这条路
  在当前输入上走不通（多半是必要内容本身超了硬上限），加时间也没用，于是它是终局条件。
- 键绑定 **(会话, 来源哈希, 模型路由)**：换会话、来源重算或换模型都让上一次失败不再适用。
- 状态落在 [0385 迁移](../../../apps/api/src/db/migrations/0385_context_compaction_state.sql)
  与 [agent-host 的 compaction-state](../../../packages/agent-host/src/compaction-state.ts)——
  冷却是**跨轮次**的记忆，只存在内存里的话下一轮又是「第一次尝试」。表上只记计数、原因、
  时间与输入 token 数，不记原文。
- 编排侧：折之前先问一句「该不该折」；冷却期内照原样重发，让闸按 `over_trigger_line` 处理，
  而不是硬折一次。

第八轮补上的是**取回入口的闭合回路**与**跨会话找回的另两条来源**：

- §5.5 的闭合此前只做了一半：摘要块会告诉模型「更早还有 N 段没被摘要盖住」，但**没有
  任何工具能把那一段取回来**。现在 `companion_read_history` 接受可选 `fromSeq`，
  直接按会话范围从库里读**原文**；摘要块把工具名与参数一并写出来——只说有洞而不给
  入口，等于把认知边界推给日志。
- [context-retrieval-closure](../../workers/ai-worker/src/handlers/__tests__/context-retrieval-closure.test.ts)
  把「闭合」变成可检查的性质：摘要块点名的工具必须真实存在，且**真的带 fromSeq 参数**。
  最常见的坏形态是提示词里教她传一个不存在的参数——单测全绿，线上她只会假装读过。
- §3.2 要求的跨会话连续性由「可检索历史、有效记忆、**方法**、**目标快照**」共同提供。
  `companion_recall_past_conversation` 现在一次给全三样：会话摘要、`listAgentMethods`
  的标题与触发条件（正文仍按 id+revision 另行展开）、`listAgentLongGoals` 的在办目标。
  后两者本就是本人范围的窄口读取，这里只是摆到同一个结果里，而不是再造检索通道。

第九轮起进入**阶段 3**（后台经验应用与产出）：

- **专业任务读相关经验**（§6.1）：[relevant-methods](../../workers/ai-worker/src/agent/relevant-methods.ts)
  按关键词从现役方法里选出与本次任务相关的目录，接进
  [execution-context](../../workers/ai-worker/src/agent/execution-context.ts) 的
  `generationInstructions`——制卡、拓展、速看、演示与持续目标从此走同一套经验体系。
  只给标题与适用条件（正文仍按 id+revision 另行展开），判不出相关就一条都不给：
  塞一条不相干的做法比不给更糟。目录块写清「只是合作指引、不改事实、不授予权限、
  适用条件对不上就别用」。
- **失败运行也能贡献经验**（§6.2）：[failure-learning](../../packages/agent-core/src/runtime/failure-learning.ts)
  把「没跑成」分成临时供应商故障、结果待核对、确定不适用、用户取消四类。
  前两类里的临时故障与用户取消**不成规则**——不是「不值得记」，是「记下来就是错的」；
  确定不适用与待核对则留下带适用条件的候选。`propose` 不再硬要求 `completed`。
- 两处判据都抽成纯函数（`classifyAgentRunFailure` / `planAgentMethodProposal`）：
  它们要挡的两种坏形态（把失败一律拒掉、把抖动也收成规则）都不会报错，只能靠判据钉住。

第十轮补上的是**采用与阅读的分野**（§6.3「阅读次数不能直接记成采用或有帮助」）：

- [0386 迁移](../../../apps/api/src/db/migrations/0386_method_use_stage.sql) 给每条使用记录
  一个**阶段**：`offered`（目录被提供）／`read`（正文被阅读）／`adopted`（被实际采用）。
- 统计口径随之按阶段收紧：`offered_count`、`consulted_count`（只算 read+adopted）、
  `adopted_count` 三个独立计数，`last_consulted_at` 也只看真正的阅读。
- 数据库层挡住「没读过就评价」：`CHECK (feedback IS NULL OR stage IN ('read','adopted'))`
  ——没读过正文的人判不了这条做法好不好。
- 专业任务装配时判出相关方法就记一次 `offered`（同一上下文版本只留一行），
  所以「她看见过」与「她读过」从此查得到差别。

这一条正是上一轮改动**逼出来**的：加上目录注入之后，原来 `count(*) AS consulted_count`
的口径会把 offer 一起算成阅读。它在只有一种行的时候恰好不出错，多出一种行就立刻说谎。

第十一轮补上的是**同源去重**（§6.4「不得把模型重述或后台反思再次包装成独立佐证」）
与两处验证缺口：

- [evidence-origins](../../packages/agent-core/src/context/evidence-origins.ts)：按**原始来源**
  归并依据。一次运行会派生出记忆、摘要、日记、候选，它们全列进 `evidence` 看上去就是
  「多方印证」，实际只有一个出处。
  **归并的是计数，不是存储**——`evidence` 保完整派生关系，归并回执另存
  `evidence_origins`（0387）。这一版是**改正**：上一版把去重做在存储上（同源只留最具体的
  一条），那会删掉 §6.4 头一句明确要求保存的东西——`ailearn_propagate_playbook_evidence_change`
  正是按 `evidence @> [{"memoryId": …}]` 找派生方法，记忆引用被折掉之后，
  用户遗忘或纠正一条记忆就**不再传递**到派生经验。方案原话是「保存完整派生关系，
  识别共同原始来源……只算同源依据」：前面是存，后面才是算。
- 多条依据归并后只剩一个出处、却仍声称 `supported` 时降为 `tentative`——那正是
  「同源包装成多方印证」的形状。**单条依据声称 `supported` 不受影响**：一条可核对的
  具体事实本来就能支撑一条有边界的做法（§6.2 的反面同样成立，不能凭「只有一条」判它没依据）。

验证缺口（都不是本轮引入，但都会让已有的测试白写）：

- `packages/agent-host` 没有 `test` 脚本，它的测试此前不跑；已补上。
- `make verify` 与 `main-ci.yml` 的目标里**没有** agent-core 与 agent-host——
  而上下文预算解析、完整请求计量、压缩冷却、失败学习都在 agent-core，方法的
  版本/来源/采用记录都在 agent-host。两个目标都已加上。

第十二轮补上的是**冲突并存**（§6.4「用户控制或固定的条目不由后台擅自覆盖；冲突按
现役合同并存、标争议或另提修订」）：

- 原来的形状是 `ON CONFLICT … DO UPDATE … WHERE NOT user_controlled`。条件不成立时
  `RETURNING` 什么都不给，函数返回 `null`——**与「这次没有可用依据」长得一模一样**。
  后台提炼撞上用户已经确认的方法时，候选悄无声息地消失，调用方也无从知道。
- 方案给的三条路里选**并存**：先按原键写，被用户控制（或已停用）挡住时落到一个
  **稳定**的 `<key>:alternate` 键上。稳定是关键——重复提炼更新同一行，不堆行。
- 没有选「标争议」：那会让用户已确认的方法变成 `source_changed` 而不可采用，
  等于后台一次提炼就能让用户的确认失效——那是「擅自覆盖」的另一种形状。
- 返回值带 `outcome`（created／updated／coexisting），调用方分得开这三种结果；
  只有两个键都被挡住时才返回 `null`，那时确实什么都没写。

第十三轮补上的是**效果评价的入口与边界**（§6.3）：

- 0386 的 `CHECK (feedback IS NULL OR stage IN ('read','adopted'))` 会挡住「没读过就评价」，
  但它报出来是一条约束错误——读的人不知道自己做错了什么。现在 `feedback` 先按 `useId`
  锁行判定，给一条可读的 `method_use_not_read`。
- **评价是效果，不是采用。** §6.3 把它们并列（「实际用于步骤/参数/表达，**以及**后续效果」），
  所以记录反馈时**不**顺手把 `stage` 提升成 `adopted`——那会把「他评价过」记成「他采用了」，
  正是这一节要挡的混淆。
- 使用记录 DTO 补上 `stage`，三种阶段在界面上分得开。

**`adopted` 目前仍然没有写入方，这是有意的。** 现有能观察到的信号只有「读过正文」
（`method_read` 被调用）与「用户评价」两样：前者是阅读，后者是效果，都不能证明这条做法
真的塑造了某一步的步骤、参数或表达。拿「读过之后运行完成了」去顶替，就是在编一个
§6.3 明确不承认的信号。宁可让这一档空着。

第十四轮起准备阶段 4 需要的**可采数据**：

- [experience-comparison](../../packages/ai-quality/src/experience-comparison.ts)：§8.5 的
  同批对照协议。样本记录模型路由、prompt 版本、方法版本、材料版本、难度、完成范围、
  等待与用量；报告按**冷启动／持续使用分开**出，并固定带上「这份报告没有证明什么」
  （不证明越用越好、不把使用次数/记忆条数/输入变短当改善、不用自评与沉默当正反馈）。
- 更有用的一半是**拒绝下结论**：两组的任务不是同一批、完成范围差得多、路由或提示词
  不一致、同一道题材料版本不同、用量缺失超过门槛——任一条成立就不给差值
  （`deltas: null`），并把原因逐条写出来。这类报告真实的失效方式不是算错，
  而是**样本撑不住时照样给出一个方向**，所以判据写在给数字之前。

第十五轮把 §8 的清单变成**可自检的账**：

- 21 条清单项（本轮的 8.5 补上后共 25 条）此前都是 `- [ ]`，三种状态混在一起：
  代码侧已经能验的、需要环境才能验的、以及其实应该改掉的。读的人分不出「还欠什么」
  与「已经有什么」。
- 每条现在必须带一个归属：``证据：`用例名` ``／`待环境：<命令>`／`待窗口：<场景>`。
- [plan-44-acceptance-ledger-guard](../../apps/api/src/__tests__/plan-44-acceptance-ledger-guard.test.ts)
  逐条核对：`证据` 里的每个用例名必须在仓库里真的存在（**它已经抓到两处我写错的
  用例标题**）；`待环境` 必须是能跑的命令，不是「以后再看」；`待窗口` 必须写出
  在窗口里做什么、看什么，「需要人工验证」不算。
- 当前分布：25 条里 17 条有代码侧证据，10 条待环境（给了具体 npm 命令），
  5 条待窗口（给了具体场景）。

这条守卫只证明「每一项都被认领过」，**不证明效果**：测试通过不等于体验好，
待环境与待窗口的那些在本轮之后仍然是空的。

第十六轮把阶段 4 的对照从「协议」推到**可执行**：

- [experience-comparison-runner](../../../workers/ai-worker/scripts/experience-comparison-runner.ts)：
  冻结题库、两臂各跑一遍（顺序交叉，抵消后跑更热这类顺序效应）、走真实 provider，
  产出 §8.5 形状的样本并调用同一个汇总器。与 `companion-persona-ab-eval` 同一套闸门：
  默认不跑，要 `REAL_MODEL_BATCH=1` 显式打开。
- **两臂只差「经验」这一件事**被钉成不变量（[runner 单测](../../../workers/ai-worker/src/__tests__/experience-comparison-runner.test.ts)）：
  用户消息一字不差、系统提示去掉目录块后逐字相同；不相关时两臂真的相同。
  这条最容易悄悄破——为「让有经验那臂更好发挥」多补一句要求，差值就不归因于经验。
- **没评的项记 null 而不是 0**（[汇总器](../../../packages/ai-quality/src/experience-comparison.ts) 已改）：
  内容错误、同类返工、重复解释要人来看；压缩语义损失这次根本没触发折叠。记 0 会让
  报告看起来「一次都没出错」，而事实是这一项没评。报告逐项公开「测到多少条」，
  缺测就不给那项差值。
- 脚本**不自动打分**：只产出原始回答与 null 字段，等人工按评阅标准填。

顺带修掉一个真实的召回缺陷：做法目录的相关性原先从**任务**一侧取词，长中文句子
（"把牛顿第二定律讲清楚，带上它的适用条件"）的重叠 2-gram 会在前半句就把词额用光，
真正对得上的「适用条件」根本没进词表——明明相关的做法一条都选不出来。
改为**从方法这一侧取词**去任务里找命中：方法标题短且聚焦，既准又不会耗尽。

第十七轮两件事：补上一个**读取侧漏接**，以及把方法步骤真正从运行里提炼出来。

- **跨会话检索原本不认会话内容修订号**（44 §3.3）。0384 的有效性过滤只加在了会话内的
  接续链读取上，而跨会话找回读的是**同一批**摘要、只认 `status`。于是消息被改写或删除
  之后，那份摘要在本会话里会被挡住，换个会话去找「以前聊过什么」又把它讲了出来。
  现在两处读路径共用同一个判据，并有守卫钉住（[context-validity-filters-guard](../../../workers/ai-worker/src/handlers/__tests__/context-validity-filters-guard.test.ts)）。
- **方法步骤来自这次真实运行**（44 §2 的既有缺口：[method-steps](../../packages/agent-core/src/context/method-steps.ts)）。
  原来按能力目录生成，同一类任务每次得到的步骤完全一样——那其实没有从这次运行里提炼到
  任何东西。现在：步骤只取**真正走通**的那条路径（按实际顺序，同一能力反复调用只算一步，
  因为那是返工不是两步做法）；没走通的与**改走了什么**写进 exceptions；`outcome_unknown`
  不算走通——它可能已经产生副作用，写进步骤等于把一次没确认的结果说成做法；一次都没走通
  就不硬凑一条做法。

顺带：把一条读源码文本的测试从行为测试文件里挪进名字带 `guard` 的文件——
仓库约定要打开失败列表的人一眼分得出「行为红了」和「文本形状变了」。这条判据本轮抓到了我。

第十八轮补上一条**接线本身的证据**：

- [context-compaction-wiring](../../../workers/ai-worker/src/handlers/__tests__/context-compaction-wiring.test.ts)：
  不 mock 闸、不 mock 折叠、不 mock 折叠规则——用真实的 `createGovernedProvider` + 真实闸选项
  + 真实 `boundedStepSender` + 真实 `foldReplayUnderSummaryCoverage`，只把 provider 换成
  mock（不花钱、不起 HTTP）。
  之前 `context-governor` 的单测验闸、`companion-compaction` 的单测验折叠，**两边各自都绿，
  中间那句「闸说该压 → 折 → 重发」没有任何测试真的走过**。它可以整条断掉——比如闸抛的
  错误类型与折叠捕获的不一致——而两边单测照样全绿。
- 判据做了自证：把折叠改成什么也不折，判据确实变红；恢复后再绿。断言里能看到
  「第一次发出去之前就被闸拦下」和「重发的那次只剩当前请求」，不是只数调用次数。

第十九轮补上**带围栏的新交接快照提交**（阶段 2 明确列出的一项）：

- 交接快照的注释写的是「**exact** context handed to one dialogue run」，而它在 agent loop
  **之前**就提交了。压缩发生在 loop 里——没有这份轨迹，那句话在有压缩的那一轮**是假的**：
  从快照上看不出哪一段被折、哪份摘要顶替、那次判定是过了触发线还是被拒绝。
- [0389](../../../apps/api/src/db/migrations/0389_handoff_snapshot_compaction_trace.sql) +
  `recordCompanionContextCompactions`：**带围栏**把同一行推进到下一个版本。围栏是
  「run 仍在 accepted/running/waiting_for_confirmation **且**版本号正好是读到的那一版」——
  版本对不上说明别处推进过了，迟到结果不许覆盖。
- `modelMessages` **仍然是折叠前**的完整上下文。恢复时多给上下文永远比少给安全；
  变的只是多出 `compactions`，只记区间、顶替它的摘要哈希与那一轮的水位，**不记正文**。
- 轨迹没写成**不是交付失败**：回复照常收尾，快照本身仍然可用，只是这一折没进轨迹。
  「记」与「落」放在同一个 `CompactionTraceRecorder` 里，就是因为围栏与「不阻塞交付」
  这两条规则只有一个主人。写口做成可注入的，这条性质才能在**不连库**的情况下被测到——第一版直接调真 store，单测挂在那儿等数据库。
- **提交点必须紧跟 loop、在任何分支之前**（这是本轮查出的第二个错）。围栏允许
  `waiting_for_confirmation` 时写——提议确认那一步同样可能折过——而那个分支自己会提前
  return；提交点排在分支之后，那一步折掉的内容就永远进不了审计。围栏允许的状态和
  真正会走到的分支必须对得上，否则围栏写得再严也没用。判据做了自证：把提交点挪到分支
  之后，守卫确实变红。

顺带把「定成下游唯一看到的文本」抽成 `finalizeCompanionReplyText`：剥信封 → 渲染占位符
→ 目录外的键留痕，**三步顺序本身就是契约**（换序会让已下发的前缀与校验后的全文分叉，
判成 `stream_full_text_diverged`）。抽出来后 `companion-dialogue` 1495 行，
神文件清单没有新增（这条判据在本轮抓到过它）。

第二十轮做了三件事：改掉索引里一条已经过时的状态声明、核对 0388 的 SQL 是否真的对得上
列，以及——把一个**我猜出来的约束**变成从事实推导出来的。

- **索引回写**：`README.md` 里 44 那条仍写着「阶段 1 与阶段 2 的摘要链已实施，其余未实施」。
  文档状态词不能证明实现，过时的声明比没有更糟。现在如实写成：四个阶段代码侧已接通并有
  判据，但 §8 **尚无一条**真实模型/实库/窗口证据，0382–0389 从未在实库上跑过。
- **0388 的 `status` 取值集合原先是我猜的**。这一列此前**根本没有** CHECK 约束
  （0170 建表时只有 `NOT NULL DEFAULT`），我在 0388 里第一次加上它——集合却是照着读侧
  认领的状态想出来的。给生产表加一个猜出来的取值约束，风险是**一个拼错的 status 让摘要
  静默变得不可见**：读侧认不出来，界面也不报错，只表现为「她怎么忘了那件事」。
  现在的集合 = 「代码里真的写过的」（摘要器只写 `candidate`）∪「读取侧真的认领的」
  （`candidate`/`confirmed`，漏一个那份摘要就凭空消失）∪ `stale`（触发器写的），
  并有判据逐字核对这三处。判据做了自证：从集合里删掉一个已认领的值，守卫变红。
- 核对 0388 引用的每个列都真实存在（`conversation_summaries.derived_memory_id`、
  记忆侧的 `dismissed_at`/`archived_at`/`revision`/`epistemic_status`…），`superseded`
  确实是合法取值（0360 加的）。文本形状守卫看不见列名写错，这一步是手核的。

第二十一轮：**第一次在真实数据库上跑**，结果抓出一个 0389 完全跑不起来的 bug。

- 用 `scripts/dev-disposable-db.sh` 起了一次性可丢弃库，0382–0389 全部迁移**干净应用**，
  每张新表、每个新列、每个触发器与函数都确认存在。
- 0388 的触发器真跑通了：建一份 `confirmed` 摘要与它派生的记忆 →
  `dismissed_at` 一置 → 摘要变 `stale` → **读取侧认领数归 0**（`stale` 落在
  `('candidate','confirmed')` 之外，所以它立刻不再被注入）。
- 0389 的围栏函数真跑通了：版本 1 + run 在跑 → 放行；版本对不上 → 拒；run 结束 → 拒。
  同一条 UPDATE 重跑一次（模拟迟到结果），**写不进去，快照停在版本 2**。

**查出的 bug**：0337 加的约束叫 `companion_context_handoff_snapshots_snapshot_version_check`
（内容 `snapshot_version = 1`），把版本钉死在 1。0389 只 DROP 了
`…_snapshots_version_check` 这个**不存在的**名字，于是新加了一条冗余的 `>= 1`，
而拦路的那个一动没动——`recordCompanionContextCompactions` 每次调用都会撞约束。
上一轮那七条判据全绿：名字对得上、语句读得懂、SQL 语法完全正确。

**教训（比这个 bug 本身重要）**：文本形状的判据看不见「名字相近的旧约束」。
约束冲突只能靠真库。两边都 DROP（避免换个名字再踩）、重建一条 `>= 1`，并在迁移里
把这个坑连同原约束名写在注释里。

- 新增 [plan44-invalidation-fencing-postgres.integration.ts](../../../apps/api/src/integration-tests/plan44-invalidation-fencing-postgres.integration.ts)
  （`npm run test:plan44:postgres`）：这两条不再是文本断言，而是建行、真跑 UPDATE、看结果。

第二十二轮把上一轮的做法推到剩下四个迁移：0382／0384／0386／0387 也用真库跑**行为**，
不再只确认它们能干净应用（`npm run test:plan44-coverage:postgres`）。

四条都通过，其中两条值得单说：

- **0384：新消息（INSERT）不推进会话内容修订号，改写或删除才推进。**
  这是整个 0384 读取侧过滤的地基：INSERT 每来一条就把所有摘要判成失效的话，
  摘要永远追不上新消息，过滤会变成「什么都读不到」。反向也不会——旧来源改了却不被发现。
  这一条在文本断言里看不见，它只存在于触发器的 `TG_OP` 判定里。
- **0387：四条同源依据 + `independentCount: 1` 放行；声称 5 条独立佐证被拒。**
  这正是 §6.4 归并后的形状，而且 `evidence` 里那四条引用一条不少地留着——
  折掉它们会让遗忘/纠正的传播断链（第十二轮那个改正）。

0386 顺带验到一件我上一轮只靠代码保证的事：`offered` 档在**数据库层**也收不到评价，
所以哪怕将来有人绕过那层服务直接写库，`「目录提供」冒充「用过」`这条仍然拦得住。

过程中自己踩了两次：消息的 `kind` 写成了不存在的 `'user_message'`（真实取值是
`'text'`），以及两条用例共用行 id。都是夹具错、不是实现错，但第一次跑两个都红，
看不出断言到底过没过——已改成每条用例自带 id。

第二十三轮拿 0385（压缩冷却状态）跑真库，**又查出两个 bug**，两个都是「单测全绿、
真库从未跑过」的典型。

- **Date 参数从未真正写进过库。** `recordCompactionAttemptState` 把 `Date` 对象直接
  交给 drizzle 的字符串参数序列化器，它不接受 Date 实例，会抛
  `The "string" argument must be of type string`。也就是说**冷却状态一次都没写成功过**——
  §5.4 的失败冷却与无进展状态整个是死的。现在转成 ISO 串并显式 `::timestamptz`。
- **计数会被并发抹平。** 原来的形状是「SELECT 读 → JS 里算 next → UPSERT 写 next 的
  绝对值」。唯一索引挡住了「各插一行」，但挡不住**同一行上的丢失更新**：两次并发的
  尝试都读到 0，都算出 1，都写 1。实测就是 `attempts = 1` 而不是 2。
  后果不是「少记一次」：`MAX_COMPACTION_ATTEMPTS` 的全部意义就是「反复失败会停下来」，
  计数被抹平意味着重试的一方会一直以为自己还有额度，于是每轮都折、每轮都等，
  情况一点没变——正是 §5.4 明令禁止的那条路。并发不是假设：闸拦下之后 fold + 重发
  可能与下一次心跳重叠，两个 job 也可能拿到同一个 run。
  现在 `attempts` 由 SQL 自增，无进展判定也对照**行上真实的** `last_input_tokens`。
  纯判定仍留给「这一轮该不该折」——它决定折不折，而「记一次」必须由数据库说了算。

判据（[plan44-compaction-cooldown-postgres.integration](../../../workers/ai-worker/src/integration-tests/plan44-compaction-cooldown-postgres.integration.ts)，
`npm run test:plan44-cooldown:postgres`）跑的是真实的两次并发写入，并做了自证：
把自增改回绝对值，守卫立刻变红。

第二十四轮：**四个缺陷，全部是「单测全绿、真库从没跑过」**。这一轮开始用子代理并行做
系统性核对，结果比预期严重得多。

- **P0：`readConversationSummaryChain` 的递归 CTE 有两处语法错误**（本轮我加的
  「传递来源有效性」被**追加**进迭代项，而不是合并进去，于是 WHERE 之后又出现一段
  `JOIN chain … WHERE …`；锚点项带 `ORDER BY … LIMIT 1` 也没加括号）。真库报
  `syntax error at or near "UNION"`。
  影响不是「摘要链坏了」：它被 `companion-dialogue.ts:545` 在**每轮对话装配**时无条件调用，
  而那个 catch 只 warn 之后 **`throw err` 重抛**——伴星对话整轮直接失败。
- **P1：`readPastConversationMessages` 取了 `companion_messages.page_context`**，
  那一列只存在于 `companion_turn_runs`。真库报 `column m.page_context does not exist`。
  §3.2 跨会话「取回原文」每次调用都抛（关键词检索那半是好的）。
- **P1：`upsertAgentMethodCandidate` 查了不存在的 `assistant_memory_items.source_run_id`**。
  这一整条写入路径**一次都没成功执行过**，而当时所有单测都是绿的。库里其实**没有**
  「记忆派生自哪次运行」这样的列；真实的来源在 `source_event_id`（摘要器写的是
  `summary:<会话>:<运行>`）。现在按它归并，并把列的知识留在存取层。
- **P2：我第八轮的「冲突并存」对**停用**用错了语义**。用户控制 = 「这条归我管」，
  停用 = 「别再给我这条」。照旧并存的话每次提炼都造一份孪生候选，停用就变成需要反复
  清理的事。停用现在彻底不并存（这正是既有集成测试期望的口径）。

**两条机制，不是逐个修**（子代理的建议，我采纳）：

- [plan44-sql-parses-postgres](../../../apps/api/src/integration-tests/plan44-sql-parses-postgres.integration.ts)
  把方案 44 的 SQL 交给**真实 parser**（`EXPLAIN`，只解析不执行、不写数据、不碰真实数据）。
  前两个缺陷的单测都是**源码文本断言**——文件里那段文字确实在，测试因此全绿，
  而查询根本无法解析。守卫做了自证：把括号去掉，它报出与原始缺陷**逐字相同**的错误。
- 子代理用 psql 逐列核对了方案 44 涉及的全部文件与 0382–0389 八个迁移：
  表名全部真实，迁移引用的列全部真实。**同类「引用不存在列」的缺陷已清零**
  （唯一剩余的一处正是上面那条 P1，已修）。

第二十五轮把子代理铺开做真库验证，并**顺手修掉了自己交付里一个从未生效的授权**。

- **0385 的表在真库上根本没有 worker 权限**，`agent_context_compaction_state` 上
  `ailearn_worker` 一条权限都没有——所以 §5.4 的压缩冷却与无进展状态**在真实环境里
  一直是死的**（`permission denied for table …`），而迁移里那句
  `GRANT … TO ailearn_worker` 明明写着。
  根因是 `infra/postgres/roles.sql` 里那句 `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA
  public FROM ailearn_api, ailearn_worker` **在迁移之后**跑，会把各条迁移里逐表写的
  GRANT 一并抹掉；该文件下面每个 `DO $$ … GRANT …` 块都在补这个漏，0385 的表漏了。
  现在补上。顺带记一笔：这道仓库自带的「API privilege matrix」守卫在我第一次补时
  立刻拦住了我——它要求 `ailearn_api` 对每张未列入例外的表都有完整 CRUD 且没有
  TRUNCATE/REFERENCES/TRIGGER，我顺手多写的 `REVOKE … FROM ailearn_api` 正好违反。
- **SQL 解析守卫从 2 条扩到自动发现 56 条**（跳过 13 条无法独立解析的片段），
  不再手写清单。每条送去 `EXPLAIN`，只解析不执行。
- 子代理跑了 22 个真库集成测试文件：agent 域 6 个全绿，companion 域多数全绿，
  **没有再出现**前几轮那类 SQL 语法错／引用不存在的列／Date 无法序列化。

第二十六轮：子代理铺开验证查出一个**阻断产品的 P0**，与方案 44 无关但在同一条伴星链路上。

- **从没打开过伴星设置的用户，第一句话必然失败。** `reserveCompanionProviderCall` 的预留
  语句是 `INNER JOIN user_companion_account_state`，没有这一行 ⇒ UPDATE 命中 0 行 ⇒
  `AGENT_BUDGET_EXCEEDED`。而这一行**没有任何东西会替新用户建**：`users` 表无 trigger；
  对话链路上唯一的创建点是 `PATCH /me/companion`（用户主动改设置），而
  `CompanionPresence` 挂载时只 GET、不建行。API 建 run 用的
  `getCompanionAccountEpoch` 对无行用户返回 0，所以**建 run 不要求它存在**——
  两边自洽不起来，就是这个缺陷。
- 修法选**在 API 侧建 run 的入口建行**，而不是把 worker 改成
  `LEFT JOIN + COALESCE(global_enabled,true)`：这一行是「把伴星整体关掉」的载体，
  fail-open 会让 global-off 形同虚设；而 worker 侧**根本建不了行**——`ailearn_worker`
  在这张表上只有 SELECT（0075 注释明写「有意不 GRANT」），要让它建行就得把全局开关的
  写权限交给 worker，比 LEFT JOIN 更糟。
- 三个取值每一个都有依据（[ensureCompanionAccountState](../../../apps/api/src/modules/companion-conversation/turn/companion-account-epoch.ts)）：
  - `global_enabled = true` **显式写**，不靠列默认——把「用户还没表达关闭意图」误记成
    「用户关闭了伴星」，比原缺陷更糟；显式写也防着将来有人改 DEFAULT 时静默翻成回退。
  - `epoch = 0` 与 `getCompanionAccountEpoch` 对无行用户返回的 0 一致，两边对不上
    刚建的 run 会当场被闸门作废。
  - `revision = 0`（不是 1）：`GET /me/companion` 无行时返回 revision 0，客户端缓存的
    base revision 就是 0，写 1 会让用户**第一次改设置撞 409**——等于把一个 P0 换成另一个。
  - `diary_enabled_since = now()`：裸 INSERT 留 NULL，而日记调度（0333）要求它非空才进队列，
    那样从不改设置的用户**永远进不了日记**——一个更隐蔽的半吊子修复。
- 回归测试走**真的 `createCompanionTurn`**，内含一段原样跑
  `reserveCompanionProviderCall` 那条 `UPDATE … FROM` 的断言（命中 1 行）——
  那就是 P0 的判据本身。经反证：把生产那一行注释掉，它立刻红。
- 顺带记录一个**同一隐患的别处**：`apps/api/src/agent/runtime.ts:13` 的 `ensureIdentity`
  用裸 `INSERT … (user_id)`，同样留下 `diary_enabled_since = NULL`。不在本次范围、未改动，
  值得单独排一次。

第二十七轮：**§5.5 的取回闭环第一次在真库上被整条跑通**，并顺手清掉三个真库夹具缺陷。

- [plan44-past-excerpt-postgres](../../../apps/api/src/integration-tests/plan44-past-excerpt-postgres.integration.ts)
  走完「跨会话摘要 → 覆盖区间 → 按区间取回原文」这条闭环：真库建会话与消息，
  走**生产里那个被修好的 `readPastConversationMessages`**，断言正文按同一份投影还原、
  用户消息的选区上下文确实从 `companion_turn_runs` 取到了，以及跨用户读不到别人的对话。
  上一轮只验到「SQL 能解析」，这一轮验到「取回的内容是对的」。
- 三个夹具缺陷（**都不是生产缺陷**，但都会让人以为功能坏了）：
  - `formal-answer-fixture` 一条 INSERT 插两个 user，撞 `sec02_users_self_insert`
    （`CHECK id = app.user_id`，逐行判 ⇒ 第二行 42501 回滚）。拆成「每个 user 一个
    事务、GUC 设成自己」——这正是生产注册路径的形状。`companion-dialogue` 由此 7/10 → **10/10**。
  - `companion-note-visibility` 同形状的错，之前是在模块顶层抛错、收集用例前进程就死，
    显示成 0 pass 的假红。现 **2/2**。
  - 第三处（`cross-module-same-process-drill`）根因**不同**：那个事务根本没设 `app.user_id`，
    `id = NULL` 为假。一行 `set_config` 即可。
- 顺带记一条容易误判的事：**受限角色下 `DELETE FROM users` 是静默空操作**——
  `users` 没有 DELETE 策略（删用户走工作区解散），RLS 下 DELETE 无匹配策略返回 0 行而
  **不报错**。看到「清理没报错」不等于「清干净了」。

第二十八轮把 SQL 解析守卫的覆盖从 56 条推到 **62 条，跳过从 13 条降到 1 条**。

上一轮留下的 13 条里，最要紧的是 5 个「返回 SQL 片段的函数」——`companionHistoryCondition()`、
`tzSubquery()`、`visibleCompanionCardSourceCondition()`、`visibleCompanionDueReviewCondition()`、
`summarizerJobKey()`。它们拼的是 WHERE 条件，正是最容易写坏的一类，而当时**完全没被验证**。
做法是把它们的**函数体与调用实参内联**回外层语句再送去 `EXPLAIN`。

做法是**源码层面的函数体内联**：找函数声明 → 抠形参表与函数体 → 按调用点实参绑定 → 原样展开。
现在覆盖 **64 条（去重 63），跳过 0 条、失败 0 条**。上一轮「跳过」里剩下的那条
（`visibleCompanionDueReviewCondition()` 返回的是**另一个函数**的返回值，两层转手）
需要跨模块展开才能拿到判据本体——它现在也被验到了。

内联这一步本身会造假绿，所以有两处专门盯着：过程中真的出现过一次
`noteVisibleSqlText` 返回普通模板字面量、被当成文本占位符 `'x'` 填进去，
于是**整条可见性判据根本没被验证却仍报「解析通过」**——正是这条守卫要防的东西。
为此加了 `PLAN44_SQL_DUMP`（逐条打印真正送进 parser 的 SQL）供人工核对，
并补了一条自证：内联片段少一个右括号时，必须报 `syntax error` **且跳过数为 0**——
证明内联机制会**报**缺陷，而不是静默吞掉。

守卫的自证也扩到三条：递归 CTE 漏括号、引用不存在的列、故意写坏的语句，
三者都由同一个 `runScan` 判定，并分别归到「语法错误」与「列/表不存在」两类。
**自证顺带抓出分类器自己的一个真 bug**：`column m.page_context does not exist`
（**不带引号**，而这正是生产上的原样报错）原先会被正则漏掉、错分成「占位符判断不了」——
分类器自己生病了，就没人能靠它判断别人。

第二十九轮清掉最后一个真库夹具缺陷，拿到一条比修复本身更值得记的教训：
**夹具缺陷会互相遮挡。**

`cross-module-same-process-drill` 原本 13/13 全红在 `before` hook（没设 `app.user_id`）。
把那处补上之后，**后面又露出四处从来没被执行过的夹具缺陷**：

- §4 没种 `jobs` 租约行 → `no longer owns its lease`（同文件 §6/§6c 早就种了，只有 §4 漏）；
- §4 没种 `user_companion_account_state` → `provider budget exhausted or turn obsolete`
  ——**症状离病因隔了三层**：报错说预算用完，真因是少种了一行；
- §6c 的测试专用 DDL 用错角色 → `permission denied for schema public`（`ailearn_api`
  在 `public` 上没有 CREATE，这不是 RLS，补 GUC 补不了）；
- §6c 用 API 角色读一张 worker 私有表。

顺带一处侥幸：`workspaces`/`workspace_members` 的 tenant guard 在 GUC 为 NULL 时走
「无租户」那一支，**本来也会过**——也就是说这个夹具原本是靠一个 NULL 分支蒙对的。
现在把 `app.workspace_id` 也设上，让它走正常那一支。

结论不是「修好一处」而是：**一个夹具从没跑通，就等于它下面的一切都还没被验证过**。
这与前面几轮反复出现的形状完全一致——只是这一次发生在测试自己的地基上。

第三十轮补上对照 runner 自己的一个缺口：**它没有覆盖 §8.5 点名的场景**。

§8.5 写的是「至少覆盖公式条件保留、讲解偏好及本次例外、新材料方法复用、失败替代和撤回」，
而我上一轮交的题库是三道泛化题目，只对得上第一条。**协议写得再严，跑的题不对，等于没覆盖。**

- 题库改成六道，每道**逐条对应**一个场景，并带上 `rubric`（这题评阅时看什么）。
  评阅标准写在题上而不是评审说明里——否则同一条样本换个评审人就评出不同结论。
- 「讲解偏好」「本次例外」「撤回」这三类**单轮判断不出来**：它们要靠第二轮对第一轮的
  回应。所以 `turns` 是多轮的，runner 也改成按 turns 铺消息，而不是只发 `goal` 那一句。
- 报告新增 `scenarioCoverage`：按 §8.5 的固定清单核对**覆盖了哪些、漏了哪些**，
  漏的写进 refusals。漏了不说，报告会被读成「整体改善」——而它其实只在最容易的那两个
  场景上成立。
- 判据：`六道题逐条对上「至少覆盖」的场景清单，一个都不少`——题库少一个场景就红。

第三十一轮做了一次全仓真库清点：**155 个集成测试文件里 37 个红，其中 21 个从未跑通过任何一条用例。**

这条清点的依据是上一轮那条教训——**一个夹具从没跑通，就等于它下面的一切都还没被验证过**。

- 21 个「从未跑通」里有 **13 个是同一个原因**：模块顶层（或第一条用例之前）插 `users` 时撞
  `sec02_users_self_insert`（`CHECK id = app.user_id`）。进程在收集用例之前就死，
  所以显示成「0 pass 1 fail」——比「N 条红」更隐蔽，因为它连**哪条坏了**都看不出来。
- **已核实这 21 个都不含方案 44 的表或概念**（唯一的疑似命中是
  `notes.context_budget_key`，那是另一条既有特性，与本方案的 context budget 无关）。
  因此**没有动它们**：修它们属于扩大范围，不是我该顺手做的。
- 剩下的红里有几条是**设计上就需要超户连接**（文件自己要 `SET LOCAL ROLE` 量 RLS，
  而 `ailearn_migrator` 虽然 BYPASSRLS 但不是超户、也不是任何角色成员），以及
  若干硬编码 UUID 撞唯一键、`DELETE FROM users` 在受限角色下静默空操作之类的夹具问题。

所以这一轮**只报告、不修**：把「哪些从来没被验证过」这件事说清楚，比在没有判断的情况下
动 13 个不相干的文件要有用得多。

方案 44 自己涉及的那些夹具，现在逐个跑通并记在这里（**实测**，不是推断）：

| 套件 | 结果 | 验的是什么 |
| --- | --- | --- |
| `test:plan44:postgres` | 2/2 | 0388 失效传播、0389 快照围栏（含迟到结果） |
| `test:plan44-coverage:postgres` | 4/4 | 0382 覆盖区间、0384 修订号、0386 使用阶段、0387 证据归并 |
| `test:plan44-sql:postgres` | 5/5 | 63 条 SQL 过真实 parser（0 跳过）+ 4 条自证 |
| `test:plan44-excerpt:postgres` | 2/2 | §5.5 取回原文整条闭环 + 跨用户隔离 |
| `test:plan44-cooldown:postgres` | 3/3 | 0385 冷却（含两次并发写入） |
| `companion-conversation-postgres` | 18/18 | 建 run 入口补账号状态行（P0 判据本身） |
| `companion-dialogue-postgres` | 10/10 | 每轮装配、读数目录、曝光账 |
| `companion-agent-postgres` | 13/13 | agent 回合链路（无回归） |
| `companion-model-budget-postgres` | 6/6 | 预算闸（无回归） |
| `agent-growth-postgres` | 21/21 | 方法链：同源归并、冲突并存、停用、纠正传播 |
| `cross-module-same-process-drill` | 13/13 | 跨模块同进程整链路 |
| `companion-note-visibility-postgres` | 2/2 | 笔记可见性 |

### 为什么早期没有把压缩接进交互回路

已核对并**有意没做**：`committedMessages` 是一份**冻结且内容校验过**的交接快照
（`companion-context-handoff` 带 hash 与来源版本复核）。在 loop 里就地折叠回放会
让「落库的那份快照」与「实际发出去的那份」分叉，破坏它自己的校验合同；正经做法要么
是重新提交一份带围栏的新快照，要么走模型摘要并自带租约与事务。两者都要新写路径，
且都改在用户等待中的交互链路上——在没有真实窗口证据之前改它，代价是「改坏之后没有
测试能看出来」。因此当前行为仍是 §5.4 的兜底：压不动就带着有效上下文继续，并把
`over_trigger_line` 记进 run。

**尚未实现**（不要按已交付对待）：

- 压缩执行目前只接在**伴星 agent loop**。持续目标与专业生成（制卡/拓展/速看/演示）
  没有接上，而且**持续目标这条路按现状不能照搬**（2026-10-05 核对）：
  它的请求是 `[{user: 目标}, ...run.messages]`，而 `run.messages` 只是
  `role/content/toolCalls`——**没有会话 seq**。会话摘要盖住的是用户可见的对话，不是
  这条循环自己的回合；拿它去折 `run.messages`，折掉的正是摘要从没覆盖过的那几轮，
  也就是 §5.1 禁止的「静默丢掉用户的要求」。
  正确做法要么是把循环回合按 seq 落到会话、让摘要能覆盖它们，要么是该工作上下文
  **自己**的摘要（goal-scoped compaction），两者都是新路径，不是一处 `catch`。
  专业生成那边更简单：它只有一段装配好的 instructions，没有可折的消息数组，
  压力来自字符预算而非可折叠的回放。
- 跨会话找回已覆盖会话摘要、方法目录与持续目标。**记忆**（`assistant_memory_items`）走的是
  另一条既有通道 `companion_recall_memory`，两者尚未合成一条统一的找回入口。
- 跨来源事件/经历索引、摘要待补取区间与原文取回入口的闭合回路（§5.5 后半）。

## 2026-10-06 复核：四条「测试全绿但线上不成立」的缺陷

复核方式是**先复现、再改**，每条都落到具体行。四条都不是类型检查或单测能挡住的
（改动后单测与 typecheck 依然全绿，所以判据只能落在「真实链路上成不成立」）。

### ① 折叠恒不可达，且不可折时硬失败

- 折叠判据 `seq <= coverage.throughSeq` 用的是读侧锚定 `coverage_through_seq < historyStartSeq`
  给出来的边界，而回放尾部的 seq 全部 `>= historyStartSeq`。两者**结构性不相交**，
  `foldedSeqs` 恒空、`receipt` 恒 null。
- 连带两处：`folded == null` 时原样抛出（触发线以上、硬上限以下本该继续发送，见 §5.4）；
  冷却拒绝分支重发前不消耗额度，闸必然再拦一次，而那次抛出在 try 之外。
- 修法（用户口径：触发线以上发送，且本轮一并改装配边界）：读侧不再要求摘要完全早于
  可见尾部——覆盖伸进回放窗口时，那段由摘要代表、可以折；折不动时消耗额度后原样重发，
  闸按 `over_trigger_line` / `compaction_budget_spent` 放行并落回执。

### ② `unmeasured` 按份 push，13 条即崩

- 合同 `.max(12)`，push 却是每 part 一条；生产路径真的 `Schema.parse`。13 张图或
  13 个 reasoning 句柄 → ZodError → 这一轮按可重试内部错误挂掉，而它本来装得下。
- 修法：按**种类**去重（该字段的语义就是「哪类载荷无法精确计量」）。成本不丢——
  `raw.multimodal` 仍按每个 part 的地板价累加。

### ③ 冷却有读无写

- `record()` 实现完整（真写 `agent_context_compaction_state`），但
  `withBoundedContextCompaction` 只调 `decide()`，全仓没有 `record()` 调用点 →
  表恒空 → 判定恒 `first_attempt`。
- 修法：折前消耗额度、折后（含折不动）记一笔；`record` 的读数由端口自己从最近一次
  压力判定取——**重发之后**的计量才是「有没有进展」的依据，让调用方传数字就会有人在
  折前取值，于是每次都记「没变小」。

### ④ 摘要提交把「没推进」报成成功

- CAS 的 `WHERE` 条件对，但 `tx.execute` 的行数被丢，`return true` 无条件执行——
  指针没动也记 `summarizer completed` 与成功指标。
- `FOR SHARE` 之间不冲突，两个并发提交能同时通过父围栏（清理路径用的是 `FOR UPDATE`，
  所以改成 `FOR UPDATE` 不引入新的冲突类型）。
- 手动路径 `source_run_id` 为 NULL，而唯一索引是 NULLS DISTINCT，冲突目标根本不触发
  → 连点两次插出两份同区间摘要，接续链分叉、读到的那支之外谁也看不见。
- 修法：提交语句抽到 `upsertCommittedSummary`，一条语句带两条围栏（同区间不重复提交、
  父版本比较），带 `RETURNING` 并**按行数**判成败；锁改 `FOR UPDATE`；反向引用改成认
  刚提交的那一行 id（原来按 `source_run_id IS NOT DISTINCT FROM` 匹配，NULL 会把手动
  路径写过的每一行都指向同一条记忆）。

### 与前文结论的关系

前面「为什么早期没有把压缩接进交互回路」那段仍然成立，但边界要说清：折的是
**这一次请求**（`applyCompactedMessages` 只换请求对象），run 的交接快照仍是折叠前的形态，
崩溃恢复只会拿到更多上下文。持续目标与专业生成那两条路**仍未接**，理由不变。

证据：`test:plan44-summary-commit:postgres`（本轮新增，5 条，实库）、
`test:plan44:postgres`（2）、`test:plan44-coverage:postgres`（5）、
`test:plan44-sql:postgres`（5）、`test:plan44-cooldown:postgres`、
`companion-dialogue-postgres` + `companion-runtime-recovery-postgres`（16）；
单测 agent-core 122 / ai-worker 1361；六个包 `npm run typecheck` 全绿。
以上实库运行都跑在 `scripts/dev-disposable-db.sh` 起的一次性库上，不写开发库 `ailearn`。

仍未取得：真实模型接续样本（折完语义是否没丢）、小窗口路由下的实测触发、
冷却跨轮次的窗口观察。

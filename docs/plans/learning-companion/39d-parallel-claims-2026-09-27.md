# 并行分工登记（2026-09-27，DSH 这一路）

> 这份**不另立进度账**。39d 台账仍是唯一的状态与证据出处；这里只登记
> 「谁在动哪些文件」「哪几件事已经有人做了、别重复」「哪几处仍没人认领」，
> 让并行的几个会话不撞车。做完一件就在下面划掉，并把证据回填 39d 对应行。

## 0. 为什么要有这份

方案 39 的实施台账里已经出现两次真实浪费：

- 台账自己写了**「避让登记（防止并行会话重复劳动）」**，说明这个问题被撞到过；
- `route-contract-postgres.integration.ts` 因为 W7-3 把 `/resume` 的 `noteId` 改成
  必填而一直红着，而那个文件当时是**干净**的、没人认领——一个会话把 schema 改了，
  另一个会话的用例就替它背了红。

所以规则很简单：**动手前先在这里查一眼；动过的文件立刻登记；发现别人的活儿
已经做了一半，就补完它而不是重做。**

## 1. DSH（本次）已认领并完成

| 项 | 落点 | 状态 |
| --- | --- | --- |
| **§16.22 读侧：争议未决的目标不进任何一处到期读数** | `packages/shared/src/review-consumable-target.ts`（共享判据，唯一执法点） | 已完成，5/5 绿 + 三次变异自证 |
| 伴星侧接线（`s.user_id` 传进判据） | `workers/ai-worker/src/handlers/companion-here-and-now.ts` | 已完成 |
| **补齐另外三处同族读点**（见下 §1.1） | `stats/service.ts` / `companion-thought.ts` / `companion-this-turn-facts.ts` | 已完成，各自带变异自证 |
| worker 对争议表的**只读**授权 | `infra/postgres/roles.sql`（授权清单 + 期望矩阵两处） | 已完成，`roles.sql` 自检通过 |
| 回归测试（六处读数一起钉） | `apps/api/src/integration-tests/disputed-objective-due-queue-postgres.integration.ts`（新）+ `test:dispute-read-side:postgres` | 已完成 |
| **§16.37(a) 揭示后的降级：按 `locked_at` 为界接上 exposure 读侧** | `run-processing-tick.ts` + 守卫改写 + 新行为集测 | 已完成，2/2 行为 + 7/7 守卫，两次变异自证（见 §3.3.1） |
| **§16.39(a) 守卫：闲聊那一圈不留正式学习记录** | `workers/ai-worker/src/integration-tests/companion-agent-postgres.integration.ts` | 已完成，12/12 绿 |
| 顺手补：W7-3 留在树上的红用例 | `apps/api/src/integration-tests/route-contract-postgres.integration.ts` | 已补 `noteId`，4/4 绿 |
| 顺手补：L23 读数对账夹具撞 0287 唯一索引 | `stats-pending-review-equals-queue-postgres.integration.ts` | 改成三条排程各属一个目标，2/2 绿，并加了"剩下的是**哪一条**"的断言 |
| 跑批脚本自身的三处 bug（日志互相覆盖、指向已删除的路径、组名带 `/` 建不出目录） | `scripts/verify-stage-one.sh` | 已修 |
| 跑批脚本的**并行会话护栏**（一次性库被两个会话共用 → 假红／整组卡死 40 分钟） | `scripts/verify-stage-one.sh` | 已加按库名取锁，抢不到就退出码 3 并提示换 `STAGE_ONE_DB` |
| 阶段一门槛**一键跑批** | `scripts/verify-stage-one.sh`（新） | 已完成 |
| 一次性库脚本漏印 `DATABASE_URL` | `scripts/dev-disposable-db.sh` | 已修 |

### §16.22 那条为什么落在共享判据上

写侧的闸早就有（`scheduleBlockedByDisputeV2`，由 `run-processing-tick` 调用，
位置在 `consume_pending` 之前），但它只挡**再排一条继任**。已经排好的那行仍是
`pending` 且照样到期；撤销只有一条路——用户勾「结束并暂不安排」，
`holdObjectiveFromReviewV2` 才把它改成 `dismissed`。**不结争议就永远到期。**

而四处到期读数此前**一条 dispute 都不读**。结算页已经写着「复核之前这次不推进
复习」，同一件事在队列里又到期冒出来：文案与行为自相矛盾。

判据必须与写侧**同一份语义**，不能硬判 `status='open'`：
`decideDisputedObservationV2` 在复核结论是 `upheld` 时返回 `use_as_is`——
这是 §16.22 防死循环的刻意设计。把「有争议」简化成「开着争议」会在这一档误杀，
等于把规则读反。翻成 SQL 就是一行：

```
活争议（closed_at IS NULL）且 recheck_outcome IS DISTINCT FROM 'upheld' → 挡住
```

### 两次变异自证

| 变异 | 预期红 | 实测 |
| --- | --- | --- |
| 整条 `NOT EXISTS` 换成 `(1=1)` | 「开争议后从各处一起消失」红 | 红在「『queue』这一处读到 2，应为 1」✅ |
| 去掉 `upheld` 豁免（判据按得太宽） | 「upheld 必须放行」这个负对照红 | 红在「『queue』这一处读到 1，应为 2」✅ |
| 只摘掉 `objectiveReviewDueCount` 一处判据 | 「六处一起消失」红在**那一处** | 红在「『homeObjectiveDue』这一处读到 2，应为 1」✅ |

> 第一版变异我写成把整段替换成一行 `-- 注释`，结果 SQL 变成 `and ( AND …)`
> ——语法错误，四条用例一起红。那次"证明"什么也没证明。**变异自证必须确认红在
> 正确的断言上，而不是红在一个语法错误上。**

### 1.1 第一刀只盖住了 7 处里的 4 处（已补齐）

改完共享判据之后复查，发现**到期读数一共七处**，第一刀只接上了四处。剩下三处
是各自手抄的判据，于是争议未决的目标照样会被算进去——我那刀当时是**半截的**：

| 漏掉的一处 | 位置 | 漏掉的后果 |
| --- | --- | --- |
| `objectiveReviewDueCount` | `apps/api/src/modules/stats/service.ts`（`objectiveDueRows` 那条查询） | **公开合同字段**（`stats-overview-contracts.ts:29`）。与同一份 `/stats/overview` 响应里的 `pendingReviewDueCount` 答的不是同一件事——同一份响应里两个"到期"不一致。桌面端目前只渲染 `pendingReviewCount`，所以还不到屏幕上，但 `workspace-collab-postgres.integration.ts:526` 就在断言它。 |
| 主动气泡素材 | `workers/ai-worker/src/handlers/companion-thought.ts`（`ready_reviews` / `due_soon_reviews` / `due_titles` / `soon_titles` 四处） | 伴星会把一张**正被质疑**的卡的 cue 主动念出来。 |
| 本轮事实 | `workers/ai-worker/src/handlers/companion-this-turn-facts.ts`（`LEFT JOIN review_schedules`） | 把争议中的卡报成"已逾期"。判据放在 **ON** 而不是 WHERE：卡本身还要留着（用户问到它），只是不接排期。 |

三处都补了共享判据，各自带一次变异自证。**教训记在这里**：改一处"共用判据"时，
先数清它到底该盖住几处——`review-consumable-target.ts` 头注列的是"四处读者"，
而实际到七处，那份名单本身就少算了三处。


## 2. 硬依赖：0296 必须先于共享判据落地（⚠️ 撤 W5-5 之前先看这条）

`packages/shared/src/review-consumable-target.ts` 的判据里现在写着
`assessment_disputes_v2`。那张表来自 **0296**（`apps/api/src/db/migrations/0296_assessment_disputes_v2.sql`），
而 0296 与 `run-disputes.ts`、`assessment-dispute-rules-v2.ts`、
`assessment-disputes-postgres.integration.ts` **当时都还是未提交的新增（`??`）**。

这意味着一个真实的顺序耦合：

- **0296 先落地、本判据后落地** —— 正常，队列四条读数都跑得通；
- **有人回退／重做 W5-5 的争议链、连带把 0296 撤掉** —— 队列、首页、看板、
  伴星到期读数**全部立刻报错**（`relation "assessment_disputes_v2" does not exist`），
  而且报错发生在**每一次**到期读数上，不是某一条边角路径。

SQL 里没有 `IF EXISTS` 形式的 FROM，所以这个顺序没法在判据内部自我保护。
**要撤 W5-5 争议链时，同一次提交里必须把这条 `NOT EXISTS` 一起去掉**，
否则复习队列会整片红掉，而症状看上去像"队列坏了"，与真正的病因隔了三层。

## 3. 无人认领项（已核实到 file:line，可直接接手）

> 2026-09-27 20:2x 更新：3.3 已由 DSH 收口（见 3.3.1），3.4 已由 W7 那一路接手续上（见 §7）。

3.1 仍然是 DSH 不该动的：它的**正确改法本身是一个产品决定**（「暂不安排」到底按目标执法还是按材料执法），而 W7 那一路正在接。

### 3.1 §16.38「新卡不能绕过目标排除」— 归 W7-3

台账已记为未落，这里把**精确形状**补齐，免得再花一次勘察时间：

- `apps/api/src/modules/card-generation-v2/activation-service.ts` **干净**，可以动。
- 闸**确实被调用**（`:556` `ensurePendingReviewScheduleV2` + `:567` 处理 `held`），
  但 `create_new` 分支 `:903` 是 `const objectiveId = randomUUID()` ——
  **拿一个刚 mint 出来的 uuid 去问排除表，结构上永远问不到**。
  同一处 `:908` 的 `semanticIdentityClassId` 也挂在 candidateId 上，所以
  semantic fingerprint 同样匹配不到任何既有目标。
- `semantic_replace`（`:1814`）委托给 `create_new`，**知道**旧的
  `intent.replacedObjectiveId` 却也没查。
- 另两种 intent（`presentation_update:1315` / `target_equivalent_update:1753`）
  返回既有 objectiveId，闸是生效的——所以这是**同一条闸对四条 intent 的不一致**，
  不是"闸没写"。
- 覆盖为零：`card-generation-v2-activation-service.test.ts` 里 `held` / `hold`
  一次都没出现，跨目标逃逸没有任何用例会红。

**改法不是纯技术决定**：排除**故意**只按 objectiveId 执法
（`0295:17-20`、`evidence.ts:114-116`、`review-authorization-rules-v2.ts:51-53`
三处都明写"按笔记匹配会误停其他目标"）。所以两条路：

- (a) 让 `create_new` 先匹配并复用同篇笔记里已有的适用目标（§4.2 本来就这么要求：
  「同一篇笔记已有目标时，新的轮次先匹配和复用适用目标」）——复用之后闸自然生效；
- (b) 在 `create_new` 里显式查一次「本篇笔记的目标是否已被排除」——那是**新的产品规则**。

**建议 (a)**，且它顺带修掉另一个问题：现在同篇笔记的同一个概念每次制卡都长出一个
全新目标。走 (a) 时要记得 §4.2「仅改题面或显示名不另建目标」。

### 3.2 §16.22 的**界面那一半** — 归 W5-5

读侧已经修好（§1），但台账说的"最大成片缺口是界面那一半"仍在：
争议入口与理由展示、「结束并暂不安排」、立/解除排除按钮、回放入口、暂停入口。
`learning-run-surface.tsx:282` 已经有 `assessment_disputed` 的文案映射，
所以**文案先到了、行为后到**——现在读侧补上之后两者终于一致了。

注意 `ReviewSurface.tsx` 当时在途，界面那半要等它落定。

### 3.3 §16.37(a) 揭示后的降级 — 整块落在 W5-1

台账已经查清：合同层没有 `cancel_assessment` 这条命令、
`learning_assessments.status` 没有 `cancelled` 档、跨目标提示与「条件未知」终态
零实现。

**另有一条更急的**（台账 §W6-3 行记的"三条长得像已经做了"之一）：
`run-processing-tick.ts` 的 `hasHintExposure` 只读 `learning_task.hint_requested` 事件，
**完全不读 `learning_exposures_v2`**（该文件里 `learningExposuresV2` 出现 0 次）。
今天揭示路径与评估路径不相交所以没出事，但谁给 `hasHintExposure` 加上 exposure
读侧，§16.37(a) 当场反向而**没有一条测试会红**。

#### 挡住这一处的理由，2026-09-27 实测**不成立**

`learning-run-locked-answer-exposure-guard.test.ts`（纯守卫，2026-09-27 19:46 新增）
明写**不要**动这一处，理由是"锁定的凭据只有 `runtime_epoch` 与 `revision`，
两者都不是时间戳……在补上『锁定时刻』这一列（数据面＋契约）之前**不能**动"。

**"锁定时刻"这一列已经在数据面上了**，不需要补：

| 事实 | 出处 |
| --- | --- |
| `learning_artifacts.locked_at timestamptz` 已存在 | `packages/shared/src/db-schema/learning-runs.ts:353` |
| 锁定行**强制**非空：`CHECK (status <> 'locked' OR locked_at IS NOT NULL)` | 同上 `:367`，库上实测一致 |
| `learning_exposures_v2.exposed_at timestamptz` 已存在 | 库上实测（13 列之一） |

所以 §14.1.1 加粗那句「**以回答锁定先后为界，而不是评分返回时间**」
在数据面上已经有表示：`exposed_at < locked_at`。判据是：

> 这次评估所评的那件产物的 `locked_at` 之前，有没有落在本人身上的 exposure。

- 揭示在**锁定之前** → 这次作答确实带着帮助，`evaluated` 取 `practice_only`；
- 揭示在**锁定之后** → 不降级，**这正是 §16.37(a) 要保住的那一条**。

也就是说：把 exposure 读侧接上去**不会**反向，前提是判据按 `locked_at` 截断，
而不是"这个 run 期间出现过任何 exposure"。

**为什么仍然不是 DSH 这一刀**：那份守卫的最后一条是**元判据**——它在内存里给
`hasHintExposure` 塞一句 exposure 读，然后断言"守卫读不到"就判失败（`:95-108`）。
"给 `hasHintExposure` 加读侧"是被那条测试**明确设计成要变红**的。要动它，
得先由写下这条守卫的人（或你）确认前提已改、这条不变量作废。
DSH 这一路只把证据摆出来，不替对方拆自己的守卫。

### 3.3.1 §16.37(a) 已由 DSH 收口（2026-09-27，晚于你看到的上面那段）

**那份守卫的前提是错的，已按实测改掉并接上读侧。** 落地：

| 落点 | 做了什么 |
| --- | --- |
| `run-processing-tick.ts` `hasHintExposure` | 第二个读侧接上 `learning_exposures_v2`；判据是「以 `locked_at` 当作"现在"，套规划期同一个 24h 窗口」，`gapMs >= 0` 那一格就是 §16.37(a) |
| `ASSESSMENT_REVEAL_WINDOW_MS` | 与规划期那份相等，并有一条守卫钉住两份相等（不相等会出现"出题算近期、锁定不算"） |
| `learning-run-locked-answer-exposure-guard.test.ts` | 从"不许加读侧"改写成"**要加，但必须有界**"；元判据改成对**无边界读侧**灵敏 |
| `learning-run-reveal-before-lock-postgres.integration.ts`（新） | 行为判据：揭示在锁定前 ⇒ 降级、0 canonical；揭示在锁定后 ⇒ 仍 `demonstrated`、1 canonical |

**两次变异自证**（真库 + 桩 Critic，不打真模型）：

| 变异 | 预期红 | 实测 |
| --- | --- | --- |
| 整条 exposure 读侧摘掉 | 「锁定前揭示要降级」红 | 红 ✅ |
| 只去掉 `gapMs >= 0` | 「锁定后揭示不得降级」红 | 红在"§16.37(a) 反向"那句 ✅ |

**这一份行为测试自己踩过的坑，记下来免得别人再踩**：`seedV2Fixture` **不造**
evidence binding，也不给快照写 `block_id`；于是 Critic 输入那道 fail closed 闸
（`task rubric has no frozen evidence` → `evidence snapshot unavailable`）先把 run
按在 checkpoint 上——两条用例于是**一条断言"不是 demonstrated"、一条断言"是
demonstrated"，互相反驳却都绿**。补齐要四样：正文块、依据快照（带 `block_id`
与两个真哈希）、资格行、绑定行；而依据快照**不可改**（库上 `immutable_v2_row`
触发器挡 UPDATE，挡得对），只能一开始就按正确形状插。

### 3.4 争议这套能力**客户端一行都没有** — 归 W5-5，卡住三个阶段一案例

> **2026-09-27 20:4x：这一格已由 W7 那一路接手续上并落定**（见本文 §7：
> 桌面四条通道 + 结果载荷投影 `assessmentId` + 结算纸面外的便签，9/9 绿）。
> 下面保留原始勘察记录——**「文案承诺了一个不存在的入口」这个形状本身**值得留着，
> 下一处同形状的缺口多半还是从「先有文案、后有入口」开始的。

这是 DSH 这一路查 §16.22 界面缺口时顺带查出来的，比"界面那一半没做"更硬：

- 服务端整条链已经齐了。`run-dispute-routes.ts` 提供
  `POST …/disputes`（开）、`/disputes/supplement`（补说明）、`/disputes/recheck`
  （落一次复核结论）、`/disputes/correction`（写更正）、`/disputes/close`
  （结束，可选顺带暂不安排）、`GET …/disputes`（读回这一份与它的更正），
  并且 `server.ts:380` 已经 `register(learningDisputeRoutes)`。
- **桌面端对这套路由的调用数是 0。** 整个 `apps/desktop-client/src` 里
  提到 dispute 的只有一处，是 `learning-run-surface.tsx:282` 的一句**文案映射**：

  > `assessment_disputed: "上次的判定你提了异议，复核之前这次不推进复习；也可以现在结束争议、把这一项暂不安排。"`

  这句话向用户**承诺了一个不存在的入口**。用户点不到"结束争议"，
  也没有任何地方能看见争议的理由（§14.2 明写"界面要能念出理由"，
  路由文件的头注也是这么写的）。

后果直接落在阶段一门槛上：**§16.11（无来源观点与争议答案）、§16.22、
§16.25（系统误判与用户补答）三条都要求用户能提出/查看/更正争议**，
而今天用户连"提出"都做不到——这三条按现状**无法验收**，与实现质量无关。

接的时候要过的四道（都验证过是干净的，可以直接动）：
`apps/desktop-client/src/main/desktop-gateway.ts`（照 `startLearningRun` 的
`ensureConnected` + `this.request(..., true, true, requestId)` + zod `safeParse` 形状）、
`desktop-ipc.ts`（`DESKTOP_IPC_CHANNELS` + 输入 zod）、
`src/preload/index.ts`（命名空间挂到 `window.ailearn`）、
`learning-run-surface.tsx`（结算影响卡那一格）。

界面按 AGENTS.md 的 HUD 硬约束做：暖纸纸签、有物件感，**伴星常驻不被挤掉**。

### 3.5 §16.13 失权那份集测的夹具撞了列类型（DSH 已修，等它跑完）

`note-learning-round-access-revoked-postgres.integration.ts`（干净文件）四条全红，
同一个因：

```
column "source_block_ordinals" is of type integer[] but expression is of type text[]
```

`tx.array([0])` 推成 `text[]`，而那一列已经改成 `integer[]`。已改成
`` `${'{0}'}`::int[] ``。**这条是 W5-6 §16.13「失权后不能靠旧快照继续学习」
的正控制**——正控制红着，后面三条"读不到"就都是空断言。

修完之后这份档**变慢了**（`createRound` 那个夹具给了
`budgets.maxWallClockSeconds: 600`），所以它不是原来那种 60 秒内出结果的档。
DSH 修的是夹具类型错，不是让这份档变慢的原因——原来它是在 `before` 阶段就炸了，
根本走不到那里。

另一份同族的红：`note-learning-round-artifact-postgres.integration.ts` 有一条
「确定性：同输入两次生成的 HTML 逐字节相同」红，且整档以 error 收尾。
**未诊断**（那一份 DSH 这一轮没查到底，不猜）。

## 4. 顺手交给别人的两条（不属 DSH 这一刀，但会挡路）

| 现象 | 位置 | 说明 |
| --- | --- | --- |
| `assessment-disputes-postgres.integration.ts` 的夹具已经跟不上 schema | 该文件整体 | 至少三处：`learning_tasks.ordinal` 这一列**已经不存在**（现为 `sequence` / `prompt` / `target_summary`）；`learning_runs` 新增 NOT NULL 的 `target_fingerprint`；两条相邻 `${}` 之间**漏了逗号**（`$4 $5`）。跑起来是 `42601 syntax error`，整档 11 条红。DSH 这一路的同名夹具是自己照当前 schema 重写的，没抄它。 |
| ~~`stats-pending-review-equals-queue` 撞新唯一索引~~ | 同名集成档 | **已由 DSH 修好**（见 §1）。留在这里是为了说明它红过的原因：同一个目标插 3 条 pending 排程，0287 之后不合法。 |

## 5. 给后来者的四条操作提醒

1. **一次性库是整份共享的，并行跑会互相污染。** 实测 2026-09-27：两个会话同时跑
   `note-learning-round-artifact-postgres`，进程 CPU 时间几乎不动、整组卡住 40 分钟——
   症状像用例死锁，真因是抢同一个库（它的前提就是"库里只有自己的夹具"，
   所以第二个不是"红"，是**假红**）。`scripts/verify-stage-one.sh` 现在按库名取锁，
   抢不到直接退出码 3 并提示换名；手工跑时请各自 `STAGE_ONE_DB=ailearn_自己名字`。
2. **跑集成测试时四个 `DATABASE_URL_*` 不能全指超户。**
   夹具写走 `DATABASE_URL` / `DATABASE_URL_MIGRATOR`（超户），
   被测路径要走 `DATABASE_URL_API` / `DATABASE_URL_WORKER`（受限角色）。
   全指超户时 RLS 那一族会**集体假通过**——RLS 根本没生效，那比红更坏。
   `scripts/verify-stage-one.sh` 已经把这四个分开设好。
3. **改了 `infra/postgres/roles.sql` 的 worker 授权，要同时改两处**：
   授权清单数组**和**期望矩阵。脚本自带自检，漏一处会在
   `applying role grants` 那一步抛 `Worker privilege matrix mismatch: <表名>`。
4. **变异自证要确认红在正确的断言上。** 第一版把判据整段换成一行 `-- 注释`，
   SQL 变成 `and ( AND … )` 语法错误，四条用例一起红——那证明的是"我改了文件"，
   不是"这条用例钉住了这条规则"。换判据时保持它仍是**合法布尔表达式**
   （例如换成 `(1=1)` 而不是注释），红点才会落在断言上。

## 6. W7 这一路（接手方，2026-09-27 20:0x 起）

> 范围＝39d 台账 §12 的 **W7 整波**（制卡与长期安排）。§1–§5 是 DSH 那一路的，
> 这里只登记**认领**，不重复它的内容。两条并行的纪律照旧：动过的文件立刻登记；
> 发现别人的活儿做了一半就补完，不重做。

### 6.1 已认领（请避开）

| 项 | 落点 | 状态 |
| --- | --- | --- |
| **W7-3 刀三 · 排除的读侧投影**：把「还挡着没有」装进目标详情与列表**同一个字段**（`personal.reviewHold` / `reviewHold`），批量一次查好 N 个 | `packages/shared/src/learning-objective-surface-contracts.ts`、`apps/api/src/modules/learning-objectives/surface-service.ts`、`apps/api/src/modules/review/objective-review-holds.ts`（新增批量读 `liveHoldsForObjectivesV2`） | 已落，三包 `tsc` 各 0 |
| **W7-3 刀三 · 五层接线**：`/reviews/v2/objectives/hold` 与 `/resume` 从渲染层到 HTTP | `packages/shared/src/desktop-ipc-contracts.ts`、`desktop-gateway.ts`、`desktop-ipc.ts`、`src/preload/index.ts`、`objective-state-copy.ts` | 已落（**屏上那一颗按钮还没接**，见 6.2） |
| **§16.38 新卡绕过目标排除**（§3.1 划给 W7-3 的那一格） | `apps/api/src/modules/card-generation-v2/activation-service.ts` | 认领，尚未动手 |

### 6.2 请 DSH 避让的三处，以及为什么

`desktop-gateway.ts` / `desktop-ipc.ts` / `src/preload/index.ts` 这三个文件
**已经有 W7-3 的改动在里面**（`reviewHoldObjective` / `reviewResumeObjective`
两条通道与它们各自的方法）。DSH §3.4 要接争议那套，落点也是这三个文件。

**请在现有改动之上追加，不要整文件覆盖。** 冲突点具体是：
- `desktop-ipc.ts`：`requireAnyM2Route` 附近新增的 `OBJECTIVE_REVIEW_ACTION_ROUTES` 常量，
  以及 `reviewDefer` handler 后面新接的两条 handler；
- `desktop-gateway.ts`：`deferReview` 后面新加的两个方法与它们上方的 import；
- `preload/index.ts`：`review` 命名空间里多出来的 `holdObjective` / `resumeObjective`。

这三处是**纯追加**（新方法、新常量、新命名空间成员），不改动既有行为，
所以覆盖回去反而会把它们删掉。W7 这一路在 DSH 把争议接线落定之前**不再动这三个文件**。

### 6.2b 接手基线那笔（`e76ce2d4`）带进来三条**别人的红**，请 DSH 认领

封存工作树里的在途工作是对的（不封存才容易丢），但它**连格式债与半成品一起封了进来**。
接手方这一轮把三处量了出来，逐条定位到 file:line，**都不是 W7 引入的**：

| # | 现象 | 落点 | 归因 |
| --- | --- | --- | --- |
| 1 | `teaching-explain.test.ts` 两条红红在断言 `note_teaching_explain_v1@v1`，实到 `@v2:failed` | `apps/api/src/modules/note-learning-rounds/teaching-explain.test.ts:155` 与另一处 | **实现**（`teaching-explain.ts`）在基线那笔里 +16 行把任务版本从 `@v1` 提到 `@v2`（个人纸签来源那一族），**用例没跟上**。测试文件本身自基线父提交起未被任何人改动 |
| 2 | `ledger-table-structure` 报 4 行表格被裸竖线撑坏 | W5-6 那格（台账第 213 行）＋ §19 的 W5-6 刀一–刀七／W5-1 主体刀一／W5-6 补测三行 | 那四行是 DSH 的内容，随基线那笔进的历史。修法在判据消息里：裸竖线写 `\|`，或把并掉的那根补回去 |
| 3 | `card-generation-desktop-contracts.test.ts` 一条红红在 `qualityIssues` 必填而夹具没跟上 | `packages/shared/src/card-generation-desktop-contracts.test.ts:146` | 接手前就在红的那一条（交接里已记「qualityIssues 变必填」） |

另有一处**格式债**随基线进了历史：`packages/shared/package.json` 的 `exports` 表在
`fdef3e44` 那笔里同时带进了 DSH 的三条登记（`personal-relation-decisions` /
`personal-relation-decision-rules-v2` / `help-condition-rules-v2`）——单文件追加的
共享清单按路径拆不开。`apps/api/package.json` 与 `migrations/meta/_journal.json`
同理，在 `b3e72aa6` 那笔里带进了 DSH 的两条 `:postgres` 脚本与迁移 `0302`。

### 6.3 一条顺序耦合，写在这里免得踩

`reviewHold` 是**必填**字段（不是 `.default(null)`）。理由是它同时出现在
`learningObjectiveSurfaceV3Schema.personal` 与 `objectiveListItemV3Schema` 上，
给默认值会让"忘了投影"和"真的没排除"在类型上长得一样——而漏投影的后果是
屏上对一个已恢复的目标仍然说"暂不安排"，且没有任何一条测试会红。
代价是每个构造这两份形状的夹具都要补 `reviewHold: null`；
`apps/api/src/__tests__/rl-{legacy-cleanup,shadow-read,surface-e2e}.test.ts` 已补。
**新写夹具的人请照这条来。**


## 7. DSH 第二路（2026-09-27 20:2x 起）：争议的客户端那一半

> 接 §3.4 那一格。§1–§6 是前一轮的登记，本节只登记这一刀的范围、落点与**给别人的发现**。

### 7.1 已认领并完成

| 项 | 落点 | 状态 |
| --- | --- | --- |
| 争议的**桌面合同**（四条通道 + 命令/回执 + 状态到话术的唯一映射） | `packages/shared/src/assessment-dispute-rules-v2.ts`（追加，未动原有六条规则） | 已落，shared typecheck 0 |
| IPC 接线（通道、输入 zod、四条 handler、preload 命名空间） | `desktop-ipc-contracts.ts` / `desktop-gateway.ts` / `desktop-ipc.ts` / `preload/index.ts` | 已落，**全部纯追加**，W7-3 那两笔改动原样保留 |
| 结果载荷投影 `assessmentId`（界面拿不到 id 就**没有任何办法**开一份争议） | `learning-run-v2-contracts.ts`（可选格）+ `run-service.ts` 的 `loadResultAssessmentV2` | 已落，带变异自证 |
| 界面：结算纸面外的一张**便签**（理由念得出来、结束并暂不安排、补充说明） | `assessment-dispute-strip.tsx`（新）+ `objective-flow.css` + `learning-run-surface.tsx` 挂载点 | 已落，9/9 绿 |
| 判据 | `assessment-dispute-rules-v2.test.ts`（+5）／`learning-run-result-assessment-id-guard.test.ts`（新，2/2 带变异自证） | 已落 |

**避让**：§6.2 点名要避让的三个文件，本刀全部是**追加**——
`desktop-ipc.ts` 新增常量与四条 handler 挂在 `reviewResumeObjective` 之后、
`desktop-gateway.ts` 新增四个方法挂在 `resumeObjectiveForReview` 之后、
`preload/index.ts` 新增 `assessmentDispute` 命名空间。`review` 命名空间**一个字没动**。

### 7.2 顺手查清、但**故意没动**的一处：§16.36 的 cancel_assessment 到不了服务端

`apps/desktop-client/src/renderer/src/components/surfaces/learning-run-surface.tsx`
的 `tsc` 报**两行**「Function lacks ending return statement」（`:510`、`:554`）。
这一刀动手前就在红（`git stash` 验过），成因不是渲染层写错，而是
**W5-1 的 `cancel_assessment` 只接了三处、漏了三处**：

| 位置 | 状态 |
| --- | --- |
| `run-service.ts:1955` 的 `case "cancel_assessment"` | ✅ 已接 |
| `run-action-availability.ts:93` 宣告 `allowedActions` | ✅ 已接 |
| `learning-run-contracts.ts:832` 的 `LearningRunActionV1` | ✅ 已接（**只是 TS type，不是 wire**） |
| **`learningRunActionSchema`（zod，V2 请求的 `action` 字段用它）** | ❌ 没有这一档 |
| **`run-routes.ts:117` 的 `isV2ActionAllowed` 没有这一档** | ❌ 没有 |
| 渲染层那颗按钮 | ❌ 没有 |

所以今天这一发**根本发不出去**：`run-routes.ts:490` 的
`parseBody(app, learningRunActionRequestV2Schema, …)` 在 zod 那一层就把它拒了，
`applyAction` 那个 case 永远进不去。

**为什么现有守卫没抓到**：`learning-run-cancel-assessment-guard.test.ts:115`
量的是 `contracts` 里那一行 `| { kind: "cancel_assessment"; assessmentId: string }`——
那是 **TS union**，不是 zod。两侧都合法地"有这一档"，中间那层 wire 没有，
于是四条判据全绿。**建议 W5-1 把判据换成量 `learningRunActionSchema`
（zod）与 `isV2ActionAllowed` 的 switch**——那才是实际执法的那两处。

本刀**没有**顺手补：补 zod 那一档而不补屏上那颗按钮，会让一个够不到的命令
多一处声明；补两处又落在 W5-1 正在动的面上。按 §0 的纪律，发现别人的活儿
做了一半就**登记**而不是插手。

### 7.3 桌面全量测试当前的 36 条红，**没有一条是本刀的**

`vitest run` 现在的分布（2026-09-27 20:3x，`/opt/homebrew/bin/node` 跑得起来；
DSH 自带 node 跑不了——rollup 原生模块签名与它对不上）：

| 簇 | 归属 | 症状 |
| --- | --- | --- |
| `WorkspaceLibrarySurface.*`（20）／`search-surface`（3）／`room-primary-action-presentation`（2） | **W7-3 `df1d82a7`** | ZodError `personal.reviewHold` Required——正是 §6.3 提醒过的那条"新写夹具的人请照这条来" |
| `CardGenerationSurface.*`（9） | W5-2／W7-7 | `suspect_claim` 形状（`qualityIssues` 那几行） |
| `notebook-surface.objective-action`（2） | W7-3 在途的 `notebook-surface.tsx` | 断言"只有开始学习"而屏上多了「暂不安排这个目标」 |

本刀新增的 `assessment-dispute-strip.test.tsx` **9/9 绿**，
`learning-run-result-assessment-id-guard.test.ts` **2/2 绿**（带变异自证）。

## 8. DSH 第二路 · 第二刀（2026-09-27 20:5x 起）：接上那份交出去的集成档，露出一个真缺陷

### 8.1 已认领并完成

| 项 | 落点 | 状态 |
| --- | --- | --- |
| §4 交出去的那份**整档红着**的争议集成档 | `apps/api/src/integration-tests/assessment-disputes-postgres.integration.ts` | **11/11 红 → 12/12 绿** |
| 结算闸「任意取一条活争议」（真缺陷） | `apps/api/src/modules/learning-runs/run-disputes.ts` | 已修，带变异自证 |

claims §4 记的漂移清单**只列了三处，实测远不止**。补在这里免得再有人照那份清单去改：

| # | 漂移 | 症状 |
| --- | --- | --- |
| 1 | `learning_task_variants` **整张表换过形状** | `run_id`／`prompt` 两列没有了，`input_schema` → `input_schema_hash`，另有一批**无默认值的 NOT NULL** 列（`purpose`／`template_trust_ceiling`／`interaction`／四个 hash…） |
| 2 | `loo_v2_kind_fields_chk` 新增 `note_version_id` 非空 | `origin_kind='note'` 缺它 → **23514**，在 `before` 段就炸，11 条一起红 |
| 3 | `learning_artifacts_task_locked_unique_idx` | 一个 task 只许一件 locked 产物 ⇒ 补答那件必须挂**另一个 task** |
| 4 | `learning_tasks` 新增 `prompt`／`target_summary` NOT NULL | 原夹具只给 `ordinal`+`intent` |
| 5 | `learning_runs.target_fingerprint` NOT NULL | claims 记的那条，仍然成立 |
| 6 | 两条相邻 `${}` 之间漏逗号 | claims 记的那条，仍然成立（`42601`） |

**教训**：claims §4 那份清单是照当时的快照写的，六条里只对上了两条。
`39d-implementation-task-breakdown` §19 早就记过同一件事——"子代理给的清单里
`round-reducer.test.ts:79` **差一行**"。**坐标会腐烂，量出来的东西不会**：
下一刀请直接 `information_schema` 拉当前列，别照抄任何一份漂移清单。

### 8.2 那个真缺陷：闸的结论是**任意的**

`liveDisputeForObjectiveV2` 是 `limit(1)` 且**没有 orderBy**。一个目标上可以同时挂着多条
活争议（同一次学习评了多道题、用户对其中两道提了异议；§9.1 也明写"一个目标可能同时被
笔记与卡片授权覆盖"），返回哪一条**由查询计划决定**——实测同一份数据两次跑拿到不同的行。

后果**两个方向都错**：
- 恰好读到 `upheld` 那一条 ⇒ **放行**，而另一条 `undetermined` 还挂着 ⇒ 违反 §14.2
  「待复核时**不持续放大结论**」，一份没有结论的争议被当成翻篇；
- 恰好读到 `recheck_corrected`（更正尚未应用）那一条 ⇒ **挡住**，而其实全部已有结论
  ⇒ 用户看到"复核之前这次不推进复习"，却再没有入口能解开。

改成**合取**：任何一条仍在 withholds 就挡。变异自证——退回"只看第一条"时
**恰好只有新加的那条用例红**，其余 11 条仍绿。

### 8.3 ⚠️ 本轮最重要的发现：**争议的"系统那一半"根本没有生产者**

§7 那一刀让用户**能**开争议了。于是下面这件事从"潜伏"变成"当下"：

| 动作 | 服务层 | HTTP 路由 | **生产调用方** |
| --- | --- | --- | --- |
| 一次重新检查 | `completeDisputeRecheckV2` | `POST …/disputes/recheck` | **零**（只有测试在调） |
| 标记更正已应用 | `markCorrectionAppliedV2` | `POST …/disputes/correction/apply` | **零** |

`run-dispute-routes.ts` 把这两条端点注册好了，**没有任何代码去调它们**。

所以今天一个用户提了异议之后，实际发生的是：

```
开异议 → hasLiveDispute=true, recheckOutcome=null
       → decideDisputedObservationV2 ⇒ withhold_conclusion
       → 排期被挡（且 suspendsArtifactReuse，产物对本人暂停复用）
       → **永远**
```

唯一的出口是用户手动「结束这份异议」（§7 那一刀已经接上）。§14.2 写的
"**系统**基于原题、原回答和依据进行一次重新检查，并展示维持／修正／仍无法判断的理由"
——那一步今天不存在。

**为什么本刀不补**：它要一次真实的模型调用，而 §8.7／§15.5 的公共运行基础（W2）按执行
计划**仍是"部分"**，现在自己写一套执行循环就是 §15.5 明写要避免的"各写一套"。
**这是 W5-5 与 W2 的顺序问题，不是本刀能顺手带走的。**

**但它有一个已经可以处理的当务之急**：屏上那颗「我不同意这次判定」现在按下去，
代价是**用户自己的复习被无限期挡住且没有自动出口**。建议 W5-5 在补模型调用之前，
先决定 §9.1 那条"仅提醒这一次／持续安排"的读侧怎么表现——**至少要让屏上说得出来**
（"这次先不推进复习，复核还没做"），而不是让用户以为系统正在处理。

### 8.4 顺带修掉一条**从未被真跑过**的用例逻辑

"读侧把理由与更正一起交回"那条把复核结论写成 `undetermined`，随后又去写更正。
而 `run-disputes.ts` 要求更正的前提是 `recheckOutcome === "corrected"`——
**那个状态组合产品上不存在**（§14.2：`undetermined`＝维持争议、不强行选一方，
没有可更正的东西）。服务层挡得对，测试错。因为整档此前 11 条全红，这段逻辑
**一次都没被执行过**。

---

## 9. 给 W7 那一路：`activation-service.ts` 把可见性棘轮顶红了（2026-09-27 晚）

`note-visibility-read-sites.test.ts` 那条「返回正文的目标读点都带上『跟着来源笔记判』」
现在红着，**归属是 W7**，不是别人的：

```
modules/card-generation-v2/activation-service.ts: 9 处目标读点没带判据，豁免只给了 7 个
→ 1238 / 1418 / 1546 / 1979 / 2252 (from(learningObjectivesV2))
+ 734 / 1270 / 1498 / 1569 (from(learningObjectiveRevisionsV2))
```

成因是 §6.1 认领的那一刀（`reuse_existing_objective`）给 `activation-service.ts` 增加了
目标读点，而 `OBJECTIVE_SYSTEM_LEVEL_READS` 里的豁免数还停在 7。

**请你们自己改，不要由别人代改。** 理由是那条判据的棘轮方向是**只许变短**
（同一条用例的另一半就在断言「豁免比实际需要的多」）：为了让它绿而把豁免调大，
需要有人真读一遍那 9 处到底该不该带可见性判据——那是产品判断，不是抄个数字。

`activateCardCandidatesV2` 那一族（约 10 条红，`suspect_claim` 形状）与本条无关，
归属 W5-2／W7-7，两条路自行认领。

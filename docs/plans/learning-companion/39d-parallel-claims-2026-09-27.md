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
| **§16.22 读侧：争议未决的目标不进任何一处到期读数** | `packages/shared/src/review-consumable-target.ts`（共享判据，唯一执法点） | 已完成，5/5 绿 + 两次变异自证 |
| 伴星侧接线（`s.user_id` 传进判据） | `workers/ai-worker/src/handlers/companion-here-and-now.ts` | 已完成 |
| worker 对争议表的**只读**授权 | `infra/postgres/roles.sql`（授权清单 + 期望矩阵两处） | 已完成，`roles.sql` 自检通过 |
| 回归测试（四处读数一起钉） | `apps/api/src/integration-tests/disputed-objective-due-queue-postgres.integration.ts`（新）+ `test:dispute-read-side:postgres` | 已完成 |
| **§16.39(a) 守卫：闲聊那一圈不留正式学习记录** | `workers/ai-worker/src/integration-tests/companion-agent-postgres.integration.ts` | 已完成，12/12 绿 |
| 顺手补：W7-3 留在树上的红用例 | `apps/api/src/integration-tests/route-contract-postgres.integration.ts` | 已补 `noteId`，4/4 绿 |
| 顺手补：L23 读数对账夹具撞 0287 唯一索引 | `stats-pending-review-equals-queue-postgres.integration.ts` | 改成三条排程各属一个目标，2/2 绿，并加了"剩下的是**哪一条**"的断言 |
| 跑批脚本自身的三处 bug（日志互相覆盖、指向已删除的路径、组名带 `/` 建不出目录） | `scripts/verify-stage-one.sh` | 已修 |
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
| 整条 `NOT EXISTS` 换成 `(1=1)` | 「开争议后从四处一起消失」红 | 红在「『queue』这一处读到 2，应为 1」✅ |
| 去掉 `upheld` 豁免（判据按得太宽） | 「upheld 必须放行」这个负对照红 | 红在「『queue』这一处读到 1，应为 2」✅ |

> 第一版变异我写成把整段替换成一行 `-- 注释`，结果 SQL 变成 `and ( AND …)`
> ——语法错误，四条用例一起红。那次"证明"什么也没证明。**变异自证必须确认红在
> 正确的断言上，而不是红在一个语法错误上。**

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

## 3. 仍然没人认领的三处（已核实到 file:line，可直接接手）

这三处都不是 DSH 这一刀的范围：前两处的**正确改法本身是一个产品决定**，
第三处要动三个正在被别人改的文件。

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
`run-processing-tick.ts:998-1011` 的 `hasHintExposure` 只读
`learning_task.hint_requested` 事件，**完全不读 `learning_exposures_v2`**。
今天揭示路径与评估路径不相交所以没出事，但谁给 `hasHintExposure` 加上 exposure
读侧，§16.37(a) 当场反向而**没有一条测试会红**。建议先补一条会红的用例再改实现。
该文件当时在途。

### 3.4 争议这套能力**客户端一行都没有** — 归 W5-5，卡住三个阶段一案例

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

## 4. 顺手交给别人的两条（不属 DSH 这一刀，但会挡路）

| 现象 | 位置 | 说明 |
| --- | --- | --- |
| `assessment-disputes-postgres.integration.ts` 的夹具已经跟不上 schema | 该文件整体 | 至少三处：`learning_tasks.ordinal` 这一列**已经不存在**（现为 `sequence` / `prompt` / `target_summary`）；`learning_runs` 新增 NOT NULL 的 `target_fingerprint`；两条相邻 `${}` 之间**漏了逗号**（`$4 $5`）。跑起来是 `42601 syntax error`，整档 11 条红。DSH 这一路的同名夹具是自己照当前 schema 重写的，没抄它。 |
| ~~`stats-pending-review-equals-queue` 撞新唯一索引~~ | 同名集成档 | **已由 DSH 修好**（见 §1）。留在这里是为了说明它红过的原因：同一个目标插 3 条 pending 排程，0287 之后不合法。 |

## 5. 给后来者的三条操作提醒

1. **跑集成测试时四个 `DATABASE_URL_*` 不能全指超户。**
   夹具写走 `DATABASE_URL` / `DATABASE_URL_MIGRATOR`（超户），
   被测路径要走 `DATABASE_URL_API` / `DATABASE_URL_WORKER`（受限角色）。
   全指超户时 RLS 那一族会**集体假通过**——RLS 根本没生效，那比红更坏。
   `scripts/verify-stage-one.sh` 已经把这四个分开设好。
2. **改了 `infra/postgres/roles.sql` 的 worker 授权，要同时改两处**：
   授权清单数组**和**期望矩阵。脚本自带自检，漏一处会在
   `applying role grants` 那一步抛 `Worker privilege matrix mismatch: <表名>`。
3. **变异自证要确认红在正确的断言上。** 第一版把判据整段换成一行 `-- 注释`，
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

### 6.3 一条顺序耦合，写在这里免得踩

`reviewHold` 是**必填**字段（不是 `.default(null)`）。理由是它同时出现在
`learningObjectiveSurfaceV3Schema.personal` 与 `objectiveListItemV3Schema` 上，
给默认值会让"忘了投影"和"真的没排除"在类型上长得一样——而漏投影的后果是
屏上对一个已恢复的目标仍然说"暂不安排"，且没有任何一条测试会红。
代价是每个构造这两份形状的夹具都要补 `reviewHold: null`；
`apps/api/src/__tests__/rl-{legacy-cleanup,shadow-read,surface-e2e}.test.ts` 已补。
**新写夹具的人请照这条来。**


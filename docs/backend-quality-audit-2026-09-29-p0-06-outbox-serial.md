# P0-6 评估：learning run outbox 的串行 tick

> 2026-09-29。审计条目原文是「评估 outbox 串行改造」——**评估**，不是直接改。
> 本文给出证据、可行方案与**必须由产品决定的那一个点**，以及本次已经落地的缓解。

## 1. 现状

`apps/api/src/modules/learning-runs/run-processing-tick.ts:184` 的主循环：

```ts
while (processed + failed < maxCommands) {
  const claimedRows = await db.execute(sql`
    SELECT * FROM public.ailearn_claim_run_processing(
      ${workerId}, ${LEASE_SECONDS * 1000}, 1, ${now.toISOString()}   // ← p_max = 1
    )`);
  const row = claimedRows[0];
  await processClaimedCommand(row, workerId);      // ← 一次一条，await 到完成
}
```

**严格串行**，且 `assessment_requested` 分支会在事务外做一次 Critic HTTP：

| 量 | 值 | 出处 |
| --- | --- | --- |
| outbox 租约 | 120s | `run-processing-tick.ts` `LEASE_SECONDS` |
| Critic 单次尝试超时 | 55s | `run-critic.ts:203` `CRITIC_ATTEMPT_TIMEOUT_MS` |
| Critic 整任务预算 | 110s | `run-critic.ts:208` `CRITIC_TASK_DEADLINE_MS` |
| HTTP 总超时 | 300s | `public-json-http.ts` |

**最坏情况**：一条 assessment 命令占住 tick 110s。这期间任何其它 run 的命令都排不进来，
`oldest_pending_age_seconds`（P0-12 已补的指标）会同步抬高。

## 2. 这个串行**不是疏忽**，是 B#1/R1 修出来的

`run-processing-tick.ts:170-180` 的注释写得很清楚：原来一次 claim 一批行、
全部打同一个 `lease_expires_at = now+120s`，而批内串行且 assessment 分支做数十秒 HTTP，
**批内靠后的行轮到时租约已经过期**，另一个实例会重领并重跑同一命令（重复计费 + 重复副作用）。
0150 的 mark 带 lease CAS 只防"迟一拍实例的置位覆盖"，不防重复执行。

改成 `p_max=1`（逐条领取）之后，**每条行在处理前才被 claim，租约在处理时点是新鲜的**。
这条修复是对的，不该动。

## 3. 但它顺带制造了单点

`p_max=1` 解决了租约过期，代价是把"批内并发"降成了"全局并发 1"。
于是**跨 run 之间也完全没有并行度**——而不同 run 之间的命令本来就没有依赖。

### 关键证据：表上**没有**同 run 的串行约束

`0117_learning_run_processing_outbox.sql` 的约束只有：

- `UNIQUE (workspace_id, run_id, idempotency_key)` —— 只防重复投递，**不防同 run 并发处理**
- `CHECK (command_type IN ('assessment_requested', 'commit_requested'))`

也就是说：**同一个 run 的两条命令可以同时处于 pending**。现在靠串行循环"恰好"让它们一个一个跑。
这层顺序是**代码约定**，不是数据库保证——代码里有多处显式依赖它
（`run-processing-tick.ts:953` 「与 `end(abandonLockedEvidence)` 串行」、`:1375` 「会钉住 tick 的整条串行链」）。

**所以：有界并发可以做，但必须是「跨 run 并行、同 run 串行」。**
直接给整个循环套 `Promise.all` 会让同一个 run 的两条命令同时跑，那是会出错的。

## 4. 方案（需要产品决定的一个点）

```
claim p_max = N（而不是 1）
  → 按 run_id 分组
  → 组与组之间并发（上限 K）
  → 组内仍严格按 claim 顺序串行
```

**好消息：claim 函数本身已经支持 N。**
`0121_learning_run_processing_claim.sql:47-48` 的实现是 `LIMIT p_max FOR UPDATE SKIP LOCKED`，
形参 `p_max integer DEFAULT 50`。也就是说传 50 就能一次领 50 条，
**SQL 侧不需要为"能领多条"做任何改动**。现在的 `p_max=1` 纯粹是调用点传的值。

需要改的地方：

1. tick 主循环的 claim 改成传 `p_max = N`（一行）
2. **但要保证不重复取同一 run** —— 这是唯一需要写新 SQL 的地方
   （`DISTINCT ON (run_id)` 或在 tick 侧分组时容忍同 run 多条再串起来）
3. tick 主循环改为分组并发
4. **`maxCommands` 的语义要重新定**：现在它是「本 tick 最多处理几条」，
   改成并发后它会变成「本 tick 最多领几组 / 几条」

### ⚠️ 必须由产品/架构决定的点

**同 run 到底要串行到什么程度？** 三种可能的合同，选错了不是性能问题而是正确性问题：

| 方案 | 含义 | 风险 |
| --- | --- | --- |
| A. 同 run 全串行（保守） | 同一 run 的命令永远不并发 | 与现状一致，最安全；并行度上限 = 活跃 run 数 |
| B. 同 run 按 command_type 串行 | assessment 与 commit 可并行 | 需要逐个 command_type 核对状态机依赖 |
| C. 同 run 全并行 | 放弃 run 内顺序 | **不安全**，`end/abandon` 与迟到的 Critic 结果会互相覆盖 |

**本文只推荐 A。** B 需要逐条核对状态机（至少 `:953`、`:1375` 两处显式串行依赖），
C 已经能从上面两条注释看出会错。

在这个问题被回答之前，本次**不改并发度**。

## 5. 本次已经落地的缓解：P0-14 熔断器

熔断器装在 `postJsonToPublicEndpoint`（全部 provider 的唯一出口，worker 与 API 进程共用）。
它把「上游已经挂了，但每条命令仍要等满 55s 超时」变成「第一次连续失败到阈值后，后续**一个包都不发**」。

对上表的直接效果：

| 场景 | 改前单条 assessment | 改后 |
| --- | --- | --- |
| 上游正常 | ≤ 55s | 不变 |
| 上游 5xx / 不通，前 4 次 | 各 55s | 各 55s（阈值未到） |
| 上游 5xx / 不通，第 5 次起 | 各 55s | **≈ 0ms**（`CircuitOpenError` 直接抛） |

也就是说**故障态下最坏的一批**——正是把 outbox 钉住的那种——被压到接近零。
阈值 5 次 / 冷却 30s（`packages/shared/src/circuit-breaker.ts`），
指标 `ailearn_ai_circuit_open_total{host,reason}` 可观测。

熔断不解决「上游慢但没挂」（那种仍会等 55s），而那要靠 §4 的分组并发。

## 6. 现在能读到的数

P0-12 已补的三个指标就是为这件事准备的，配上以后不需要再猜：

- `ailearn_learning_run_processing_outbox_depth{command_type}` —— 积压
- `ailearn_learning_run_processing_oldest_pending_age_seconds` —— **串行卡住时这个会直接跳上去**
- `ailearn_learning_run_processing_tick_duration_seconds` —— 单次 tick 耗时

建议的告警口径：`oldest_pending_age_seconds` 持续 > 120s（即一个租约周期）超过若干分钟
⇒ 串行链被卡住，去看同期 `ailearn_ai_circuit_open_total` 是否非零。

## 7. 结论

- 串行是 B#1/R1 的**正确**修复，不该回退。
- 有界并发可行，但必须是**跨 run 并行、同 run 串行**；表上没有约束保护这层顺序，所以
  实现必须自己在分组里保证。
- **缺一个产品决定**：同 run 要串行到什么程度（§4 的 A/B/C）。推荐 A。
- 在那之前，本次只落 P0-14 熔断这一条缓解，并把分析写在这里，
  让后续拿到 outbox 积压告警的人能直接接着做。

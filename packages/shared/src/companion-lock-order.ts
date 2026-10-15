import { sql, type SQL } from "drizzle-orm";

/**
 * 伴星事件写入的**取锁顺序规约**：同一事务里，`companion_turn_runs` 必须先于
 * `companion_conversations`。
 *
 * ## 这条规约挡的是哪次事故
 *
 * dev 库 2026-10-14 实测两例 `deadlock detected`（postgres 容器原始日志），用户那一轮
 * 直接 `INTERNAL_ERROR`、run 被标 failed，界面表现是"她没回"。成因是同一件事的两种取锁序：
 *
 *   A 序：先 `UPDATE companion_conversations` 拿 `next_event_seq` 计数器，
 *         再 `INSERT companion_stream_events`——而这张表的 AFTER INSERT 触发器
 *         `companion_archive_process_event` 会顺手 `UPDATE companion_turn_runs`
 *         的 process_timeline。于是在**看不见的地方**又拿了一次 run 行锁。
 *   B 序：先 `UPDATE companion_turn_runs` 做活性检查，再回去拿 conversations 的计数器。
 *
 * A、B 并发即 AB-BA。
 *
 * ## 为什么统一到「turn_runs 先」而不是反过来
 *
 * 1. 逐事务核对后（**不能按行号判断**——`persistFailedPartial` 行号上 conv 在前，
 *    但事务第一句是 `SELECT … FOR UPDATE` 锁 run，实为 B 序），B 序是多数：流式增量、
 *    思考流、状态帧、取消、失败留档等十余处；A 序只有六处。统一到 B 序改动面最小。
 * 2. 触发器把「INSERT 事件」与「锁 run」焊在了一起，而 INSERT 必须发生在拿到 seq 之后。
 *    所以任何写事件的路径**天生**会在 INSERT 时碰 run 行；把 run 行锁提到最前面，
 *    触发器那次 UPDATE 就落在自己已持有的锁上，不再等待别人。
 * 3. 语义上也更顺：先确认这一轮还活着，再动会话计数器。
 *
 * ## 怎么用
 *
 * 事务体**第一句**调 `lockCompanionRunForEventWrite(tx, runId)`（锁单轮）或
 * `lockCompanionConversationWaitingRuns(tx, conversationId)`（锁该会话所有待确认的轮，
 * 用在"还不知道具体哪些 run 会被终结"的回收路径上）。
 * 已经天然 B 序的（事务第一句就是 `UPDATE companion_turn_runs`）不需要调。
 *
 * 判据守卫：`apps/api/src/__tests__/companion-event-lock-order-guard.test.ts`
 * 逐处钉住顺序；它另有一条棘轮——新增"写会话计数器"的文件必须登记进它的清单。
 *
 * 锁强度用 `FOR NO KEY UPDATE`：与普通 `UPDATE` 互斥（2026-10-14 在 dev 库实测——
 * 一方持有 FOR NO KEY UPDATE 时，另一方的普通 `UPDATE` 会等满），因此足以挡住触发器
 * 那次 UPDATE；同时它不锁 key 列，不会把按主键的点查一起挡住。
 */
export interface CompanionLockOrderExecutor {
  execute(query: SQL): PromiseLike<unknown>;
}

/** 锁住**某一轮**的 run 行。事务体第一句调用；run 行不存在时拿不到锁（0 行），无害。 */
export async function lockCompanionRunForEventWrite(
  tx: CompanionLockOrderExecutor,
  runId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT id FROM companion_turn_runs WHERE id = ${runId} FOR NO KEY UPDATE
  `);
}

/**
 * 锁住**某个会话下所有待确认的 run 行**。
 *
 * 用在"要终结哪些 run 由后续语句才查得出来"的回收路径（`reclaimExpiredCompanionProposals`）
 * 与"先校验会话、再回收"的建言路径（`createCompanionProposalInTransaction`）：
 * 这两处都还没拿到具体 runId，只能按会话取一个**超集**——它覆盖
 * `terminateProposalSideEffects` 会碰的全部行（那些 run 的 waiting_proposal_id
 * 必然指向本会话的 proposal），代价是同会话待确认的行被多锁一会儿，可接受。
 */
export async function lockCompanionConversationWaitingRuns(
  tx: CompanionLockOrderExecutor,
  conversationId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT id FROM companion_turn_runs
    WHERE conversation_id = ${conversationId} AND waiting_proposal_id IS NOT NULL
    FOR NO KEY UPDATE
  `);
}

/**
 * 锁住**某个会话下所有"还活着"的 run 行**：待确认的 + 四种 active 状态的。
 *
 * `lockCompanionConversationWaitingRuns` 只覆盖 `waiting_proposal_id IS NOT NULL`，
 * 但 `turn-service` 除了 reclaim 要碰待确认的 run，还要把**正在跑的那一条**
 * 置为 superseded 并写它的 last_event_seq——那条 run 的 waiting_proposal_id 是
 * NULL，前一个 helper 锁不到它。
 *
 * 用在 `createCompanionTurn`：它第一句就拿会话行锁（整条建轮路径的串行化点，
 * 不能后移），于是必须**先把 run 锁齐**再拿会话锁，否则就是「先会话后 run」的
 * A 序——与所有流式路径（先 run 后会话）并发即 AB-BA。这正是 2026-10-14 那两例
 * 死锁的同一形状；上一轮审计按行号看 turn-service 以为它是 B 序，漏了建轮路径
 * 开头的会话 `FOR UPDATE`。
 *
 * 行数受 partial unique index 限制（同会话至多一条 active run）+ 几条待确认的，
 * 不会随历史增长。
 */
export async function lockCompanionConversationLifecycleRuns(
  tx: CompanionLockOrderExecutor,
  conversationId: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT id FROM companion_turn_runs
    WHERE conversation_id = ${conversationId}
      AND (
        waiting_proposal_id IS NOT NULL
        OR status IN ('accepted', 'running', 'waiting_for_confirmation', 'cancel_requested')
      )
    FOR NO KEY UPDATE
  `);
}

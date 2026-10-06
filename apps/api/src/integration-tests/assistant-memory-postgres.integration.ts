/**
 * P8 记忆 + Orchestrator 接线集成测试（真实 postgres）。
 *
 * 覆盖：记忆 upsert（sourceEventId 去重）→ confirm（候选→确认）→ softDelete
 * （审计保留 + canonical 解耦）→ list（默认不含候选）；Run 结算触发
 * proactive deliver（Policy allowed → system_event 入队 dedupe）。
 *
 * 运行：DATABASE_URL_API="postgres://astella:astella_dev@127.0.0.1:5432/astella"
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/assistant-memory-postgres.integration.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres, { type TransactionSql } from "postgres";
import { randomUUID } from "node:crypto";
import { createLearningRunForTest, seedV2Fixture } from "./helpers/v2-card-fixture.ts";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const CONN = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });

const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  upsertMemory,
  correctMemory,
  confirmMemory,
  deleteMemory,
  listMemories,
  listMemoryRevisions,
  MemoryGlobalScopeRejectedError,
} = await import("../modules/companion-conversation/memory/memory-service.ts");
const { deliver } = await import("../modules/companion-conversation/delivery/delivery-service.ts");
const { submitArtifact } = await import(
  "../modules/learning-runs/run-service.ts"
);
const { runLearningRunProcessingTick, closeStructuredSolutionSql } = await import(
  "../modules/learning-runs/processing/run-processing-tick.ts"
);

after(async () => {
  await sql.end({ timeout: 2 });
  await closeStructuredSolutionSql();
  await closeDatabase();
});

async function seed() {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "遗忘曲线表明复习间隔决定长期记忆",
    publicSummary: "遗忘曲线",
    front: { cue: "遗忘曲线", prompt: "什么是遗忘曲线？" },
  });
  return {
    workspaceId: fixture.workspaceId,
    userId: fixture.userId,
    cardId: fixture.cardId,
    keyPointId: fixture.objectiveId,
    cleanup: fixture.cleanup,
  };
}

test("P8 记忆：upsert 去重 → confirm → softDelete → list 不含候选/已删", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    const item = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "goal",
        content: "希望先掌握遗忘曲线",
        sourceEventId: "goal:1",
        userStated: true,
        candidate: false,
      }, now),
    );
    assert.equal(item.userStated, true);
    // 同 sourceEventId upsert → 更新不新建。
    const again = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "goal",
        content: "希望先掌握遗忘曲线（更新）",
        sourceEventId: "goal:1",
        userStated: true,
      }, now),
    );
    assert.equal(again.memoryItemId, item.memoryItemId);
    let countN = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_memory_items WHERE workspace_id = ${seeded.workspaceId}`;
      countN = rows[0].n;
    });
    assert.equal(countN, 1, "sourceEventId 去重");

    // 候选记忆：list 默认不含。
    const candidate = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "learning_context",
        content: "模型推断的候选上下文",
        sourceEventId: "evt:2",
        candidate: true,
      }, now),
    );
    const withoutCandidates = await withWorkspaceTransaction(scope, (tx) =>
      listMemories(tx, scope, {}),
    );
    assert.equal(withoutCandidates.some((m) => m.memoryItemId === candidate.memoryItemId), false);
    // confirm → 参与 list。
    const confirmed = await withWorkspaceTransaction(scope, (tx) =>
      confirmMemory(tx, scope, candidate.memoryItemId, now),
    );
    assert.ok(confirmed);
    assert.equal(confirmed.userConfirmed, true);
    const withCandidates = await withWorkspaceTransaction(scope, (tx) =>
      listMemories(tx, scope, {}),
    );
    assert.ok(withCandidates.some((m) => m.memoryItemId === candidate.memoryItemId));

    // softDelete：审计保留（deletedAt 非空）+ list 不含。
    const deleted = await withWorkspaceTransaction(scope, (tx) =>
      deleteMemory(tx, scope, item.memoryItemId, now),
    );
    assert.equal(deleted, true);
    const afterDelete = await withWorkspaceTransaction(scope, (tx) =>
      listMemories(tx, scope, {}),
    );
    assert.equal(afterDelete.some((m) => m.memoryItemId === item.memoryItemId), false);
    let tombstoneDeletedAt: string | null = null;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT deleted_at FROM assistant_memory_items WHERE id = ${item.memoryItemId}`;
      tombstoneDeletedAt = rows[0]?.deleted_at ?? null;
    });
    assert.ok(tombstoneDeletedAt, "soft delete 保留审计");
  } finally {
    await seeded.cleanup();
  }
});

test("作者词表用 0360 的 user/extractor/companion/maintenance，不写已迁移的 model/background", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();
    // 候选这条是回归的关键：`source_type='model_inferred'` 且 `user_stated=false`，
    // 0360 的 BEFORE 触发器**不会**改写 author_type，所以落库的值就是应用层写的那一个。
    // 旧词 `model` 会在这里撞 `assistant_memory_items_author_type_check`。
    const candidate = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "preference",
        content: "模型推断的候选偏好",
        sourceEventId: "author:candidate",
      }, now),
    );
    assert.equal(candidate.authorType, "extractor");

    // 同 sourceEventId 走 update 分支：那一支曾经各写一份旧词，两处都要钉住。
    const recandidate = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "preference",
        content: "模型推断的候选偏好（更新）",
        sourceEventId: "author:candidate",
      }, now),
    );
    assert.equal(recandidate.memoryItemId, candidate.memoryItemId);
    assert.equal(recandidate.authorType, "extractor");

    // summary 这条：0360 的触发器也会落到 'maintenance'，所以这里钉的是最终形状，
    // 不是"应用层写了什么"——两处一致正是要防的分叉。
    const summary = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "episodic",
        content: "摘要里整理出来的片段",
        sourceEventId: "author:summary",
        sourceType: "summary",
      }, now),
    );
    assert.equal(summary.authorType, "maintenance");
    const resummary = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "episodic",
        content: "摘要里整理出来的片段（更新）",
        sourceEventId: "author:summary",
        sourceType: "summary",
      }, now),
    );
    assert.equal(resummary.authorType, "maintenance");

    // 用户自己说的那条不受影响：仍然是 'user'，且有 author_id。
    const stated = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "preference",
        content: "用户自己说的偏好",
        sourceEventId: "author:stated",
        userStated: true,
        candidate: false,
      }, now),
    );
    assert.equal(stated.authorType, "user");

    // 最后问一次库：这次写入没有留下词表外的任何一行。
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_memory_items
        WHERE workspace_id = ${seeded.workspaceId}
          AND author_type NOT IN ('user', 'extractor', 'companion', 'maintenance')`;
      assert.equal(rows[0].n, 0, "有行落在 0360 的作者词表之外");
    });
  } finally {
    await seeded.cleanup();
  }
});

test("记忆适用条件与有效期写入当前版，并随修订保留在历史版", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const validFrom = new Date("2026-09-30T09:00:00.000Z");
    const firstValidUntil = new Date("2026-10-15T09:00:00.000Z");
    const nextValidUntil = new Date("2026-10-18T09:00:00.000Z");
    const item = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "goal",
        content: "在截止前复习完数据库索引",
        sourceEventId: `validity:${randomUUID()}`,
        sourceSpeaker: "user",
        sourceBasis: "direct_statement",
        appliesWhen: "数据库索引复习",
        validFrom,
        validUntil: firstValidUntil,
        userStated: true,
      }),
    );
    assert.equal(item.sourceSpeaker, "user");
    assert.equal(item.sourceBasis, "direct_statement");
    assert.equal(item.appliesWhen, "数据库索引复习");
    assert.equal(item.validFrom, validFrom.toISOString());
    assert.equal(item.validUntil, firstValidUntil.toISOString());

    const revised = await withWorkspaceTransaction(scope, (tx) =>
      correctMemory(tx, scope, item.memoryItemId, {
        content: "在新截止日前复习完数据库索引",
        expectedRevision: item.revision,
        appliesWhen: "新一轮数据库索引复习",
        validUntil: nextValidUntil,
      }),
    );
    assert.ok(revised);
    assert.equal(revised.revision, item.revision + 1);
    assert.equal(revised.validFrom, validFrom.toISOString(), "未修改的开始时间应保留");
    assert.equal(revised.validUntil, nextValidUntil.toISOString());

    const revisions = await withWorkspaceTransaction(scope, (tx) =>
      listMemoryRevisions(tx, scope, item.memoryItemId),
    );
    assert.ok(revisions);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].appliesWhen, "数据库索引复习");
    assert.equal(revisions[0].validFrom, validFrom.toISOString());
    assert.equal(revisions[0].validUntil, firstValidUntil.toISOString());
    assert.equal(revisions[0].sourceSpeaker, "user");
    assert.equal(revisions[0].sourceBasis, "direct_statement");
  } finally {
    await seeded.cleanup();
  }
});

test("E15：记忆删除不影响 canonical 事实；对话删除保留 inbox 历史", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const now = new Date();

    // 记忆 + canonical 事实（declared_unable Run 结算）并存。
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "e15-create-1",
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
          idempotencyKey: "e15-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`e15-worker:${randomUUID()}`, 10);
    }
    // FORCE RLS 表裸查：同事务 context（set_config is_local=true：事务结束
    // 自动恢复，不污染连接池）。
    let canonicalBeforeCount = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}`;
      canonicalBeforeCount = rows[0].n;
    });
    assert.equal(canonicalBeforeCount, 1);

    // 删除记忆（soft delete）：canonical 事实保持不变（解耦）。
    const item = await withWorkspaceTransaction(scope, (tx) =>
      upsertMemory(tx, scope, {
        kind: "interaction_note",
        content: "关于该 Run 的记忆",
        sourceEventId: "run.completed:" + run.runId,
        candidate: false,
      }, now),
    );
    await withWorkspaceTransaction(scope, (tx) => deleteMemory(tx, scope, item.memoryItemId, now));
    let canonicalAfterCount = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM canonical_learning_event_outbox WHERE run_id = ${run.runId}`;
      canonicalAfterCount = rows[0].n;
    });
    assert.equal(canonicalAfterCount, 1, "记忆删除不影响 canonical 学习事实");

    // 对话删除（保留 inbox 历史语义）：FORCE RLS 表——set_config 必须在所有
    // 裸 SQL 之前且同事务。
    const sessionId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status, next_message_seq, next_event_seq, next_generation, summary_version)
               VALUES (${sessionId}, ${seeded.workspaceId}, ${seeded.userId}, 'journey', '测试', 'placeholder', 'active', 1, 1, 1, 0)`;
    });
    await withWorkspaceTransaction(scope, (tx) =>
      deliver(tx, scope, {
        assistantSessionId: sessionId,
        kind: "system_event",
        payloadRef: { kind: "system_event", systemEventId: "e15-evt" },
        dedupeKey: "e15-delivery",
        expiresAt: new Date(now.getTime() + 60_000),
      }, now),
    );
    let deliveryCountBefore = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_deliveries WHERE workspace_id = ${seeded.workspaceId}`;
      deliveryCountBefore = rows[0].n;
    });
    assert.ok(deliveryCountBefore >= 1);
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`DELETE FROM companion_conversations WHERE id = ${sessionId}`;
      const deliveryAfter = await tx`SELECT assistant_session_id FROM assistant_deliveries WHERE dedupe_key = 'e15-delivery'`;
      assert.ok(deliveryAfter.length >= 1, "delivery 保留（会话删除不破坏 inbox 历史）");
    });
  } finally {
    await seeded.cleanup();
  }
});

test("P8 Orchestrator：Run 结算触发 proactive deliver（Policy allowed + dedupe）", async () => {
  const seeded = await seed();
  try {
    const scope = { workspaceId: seeded.workspaceId, userId: seeded.userId };
    const run = await withWorkspaceTransaction(scope, async (tx) =>
      createLearningRunForTest(tx, {
        ...scope,
        request: {
          originV2: { kind: "card", cardId: seeded.cardId, objectiveId: seeded.keyPointId },
          goal: "stabilize",
          idempotencyKey: "mm-run-create-1",
        },
      }),
    );
    const taskId = run.activeTaskId!;
    const variant = run.activeTask!.activeVariant;
    await withWorkspaceTransaction(scope, async (tx) =>
      submitArtifact(tx, {
        ...scope,
        runId: run.runId,
        taskId,
        request: {
          version: 1,
          variantId: variant.variantId,
          variantRevision: variant.revision,
          runRevision: run.revision,
          taskRevision: run.activeTask!.revision,
          inputSchemaHash: variant.inputSchemaHash,
          payload: { kind: "declared_unable", reasonCode: "cannot_recall" },
          idempotencyKey: "mm-submit-1",
        },
      }),
    );
    for (let round = 0; round < 6; round += 1) {
      await runLearningRunProcessingTick(`mm-worker:${randomUUID()}`, 10);
    }
    // Policy（online/moderate 默认）允许 → system_event 入队。
    let deliveryRows: { kind: string; state: string; dedupe_key: string }[] = [];
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      deliveryRows = await tx`SELECT kind, state, dedupe_key FROM assistant_deliveries WHERE workspace_id = ${seeded.workspaceId}`;
    });
    assert.equal(deliveryRows.length, 1);
    assert.equal(deliveryRows[0].kind, "system_event");
    assert.equal(deliveryRows[0].state, "queued");
    assert.equal(deliveryRows[0].dedupe_key, `run.completed:${run.runId}`);
    // 重复 tick：dedupe 不新增。
    for (let round = 0; round < 2; round += 1) {
      await runLearningRunProcessingTick(`mm-worker:${randomUUID()}`, 10);
    }
    let afterRetickN = 0;
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      const rows = await tx`SELECT count(*)::int AS n FROM assistant_deliveries WHERE workspace_id = ${seeded.workspaceId}`;
      afterRetickN = rows[0].n;
    });
    assert.equal(afterRetickN, 1, "dedupe 不重复入队");
  } finally {
    await seeded.cleanup();
  }
});

/**
 * 42 阶段 1 E：账号级（跨空间）记忆的**写入守卫**，对着真实 Postgres 验。
 *
 * 单测能证明"那条写语句没发出去"，这里要证明的是**四件一起没变**：源行、副本、
 * revision、只追加历史；再加一件正向的——普通全局偏好仍会真的铺到第二个空间，否则
 * "什么都拒"也能让全部负向断言变绿。基线取在合法修订**之后**（主会话首轮复跑就栽在
 * 拿修订前的副本修订号当基线这件事上）。
 */
interface SideWorkspace {
  workspaceId: string;
  cleanup: () => Promise<void>;
}

/** 同一用户的第二个空间：跨空间铺开与副本同步都要有"别的空间"才成立。 */
async function seedSideWorkspace(userId: string): Promise<SideWorkspace> {
  const workspaceId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, ${`side-${workspaceId.slice(0, 8)}`}, ${userId})`;
    await tx`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  });
  return {
    workspaceId,
    cleanup: async () => {
      await sql`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    },
  };
}

/**
 * FORCE RLS 表裸查：set_config 必须与查询同事务（同本文件其余用例的形状），
 * `is_local=true` 让它在事务结束时自动恢复，不污染连接池。
 *
 * 事务句柄用 postgres.js 自己导出的 `TransactionSql`（同本目录 rls-policies / users-rls
 * 那几份的写法），不另造别名：别名迟早和安装版本对不上，而对不上的表现是
 * "类型红了但运行没问题"。
 */
type ScopedQuery = TransactionSql;

async function memoryRows<T>(
  scope: { workspaceId: string; userId: string },
  run: (tx: ScopedQuery) => Promise<T[]>,
): Promise<T[]> {
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
    return run(tx);
  });
  // `sql.begin` 的返回类型是 `(T extends Promise<infer R> ? R : T)[]`，与这里的 `T[]` 形同
  // 而实不同：回调已声明成 `Promise<T[]>`，那次解包在这一格上不会发生，故直接收窄。
  //
  // 顺带把 postgres 的 `Result` 摊成**普通数组**再交出去：直接把它交给 `deepEqual` 比
  // `[]` 会失败（`Result(0) []` 与 `[]` 不是同一个东西，主会话复跑就栽在这里），
  // 而这层辅助函数的调用方要的本来就是"一组行"。
  return [...rows] as unknown as T[];
}

/** 一条账号级记忆在两个空间里的完整可见状态：正文、范围、修订号与只追加历史。 */
async function accountMemoryState(
  source: { workspaceId: string; userId: string },
  copy: { workspaceId: string; userId: string },
  memoryItemId: string,
) {
  const [sourceRow] = await memoryRows(source, async (tx) => await tx`
    SELECT content, scope, revision, applies_when
      FROM assistant_memory_items WHERE id = ${memoryItemId}::uuid`);
  const [copyRow] = await memoryRows(copy, async (tx) => await tx`
    SELECT content, scope, revision, applies_when
      FROM assistant_memory_items
     WHERE global_key = ${memoryItemId}::uuid AND deleted_at IS NULL`);
  const history = await memoryRows(source, async (tx) => await tx`
    SELECT revision, content, applies_when FROM assistant_memory_item_revisions
     WHERE memory_id = ${memoryItemId}::uuid ORDER BY revision`);
  return { source: sourceRow, copy: copyRow, history };
}

test("42-E：账号级写入守卫拒绝本地材料；源行、副本、revision 与历史都不变", async () => {
  const seeded = await seed();
  const side = await seedSideWorkspace(seeded.userId);
  const home = { workspaceId: seeded.workspaceId, userId: seeded.userId };
  const other = { workspaceId: side.workspaceId, userId: seeded.userId };
  try {
    // 正向对照：普通的一般偏好照常写成账号级，并且真的铺到第二个空间。
    // 没有这一格，"守卫把所有 global 都拒掉"也能让后面全部通过。
    const account = await withWorkspaceTransaction(home, (tx) =>
      upsertMemory(tx, home, {
        kind: "preference",
        content: "习惯晚上九点之后写笔记",
        sourceEventId: `account:${randomUUID()}`,
        scope: "global",
        userStated: true,
        candidate: false,
      }),
    );
    assert.equal(account.scope, "global");
    const copies = await memoryRows(other, async (tx) => await tx`
      SELECT id FROM assistant_memory_items
       WHERE user_id = ${seeded.userId}::uuid AND global_key = ${account.memoryItemId}::uuid
         AND deleted_at IS NULL`);
    assert.equal(copies.length, 1, "账号级偏好没有铺到第二个空间：正向对照失效");

    // 先做一次**合法**修订：它会推进源行与副本的修订号、并留下一行历史。
    // 后面要比的是"拒绝没有改动任何东西"，所以基线必须取在这次修订**之后**。
    const revised = await withWorkspaceTransaction(home, (tx) =>
      correctMemory(tx, home, account.memoryItemId, {
        content: "习惯晚上九点之后写笔记，白天只做采集",
        expectedRevision: account.revision,
      }),
    );
    assert.ok(revised);

    // 基线：源行、副本、历史三处的完整状态。拿修订**之前**的读数当基线，就是拿旧值
    // 比新值（主会话独立复跑首轮新用例就栽在副本修订号 1 vs 2 上）。
    const baseline = await accountMemoryState(home, other, account.memoryItemId);
    // 基线自身的正向对照：合法修订确实推进了源行、把副本同步到新正文、并追加了历史。
    assert.equal(Number(baseline.source.revision), revised.revision, "合法修订没有推进源行修订号");
    assert.equal(baseline.source.content, revised.content);
    assert.equal(baseline.copy.content, revised.content, "合法修订没有同步到副本");
    assert.deepEqual(
      baseline.history.map((row: Record<string, unknown>) => Number(row.revision)),
      [account.revision],
      "历史表里应当正好是修订前的那一版",
    );

    // 拒绝 ①：新建一条提到科目/当前书房的账号级偏好。
    await assert.rejects(
      withWorkspaceTransaction(home, (tx) => upsertMemory(tx, home, {
        kind: "preference",
        content: "正在学数据库索引优化",
        sourceEventId: `account-local:${randomUUID()}`,
        scope: "global",
        userStated: true,
        candidate: false,
      })),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "content_workspace_bound",
      "提到科目的内容竟然被写成了账号级偏好",
    );

    // 拒绝 ②：非偏好种类写成账号级。
    await assert.rejects(
      withWorkspaceTransaction(home, (tx) => upsertMemory(tx, home, {
        kind: "goal",
        content: "下个月要考日语N3",
        sourceEventId: `account-goal:${randomUUID()}`,
        scope: "global",
        userStated: true,
      })),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "kind_not_preference",
      "goal 被写成了账号级偏好：它在别的空间里根本不成立",
    );

    // 拒绝 ③：干净的正文 + 绑本地的适用条件。
    await assert.rejects(
      withWorkspaceTransaction(home, (tx) => upsertMemory(tx, home, {
        kind: "preference",
        content: "提醒我先看反例",
        appliesWhen: "复习这门课时",
        sourceEventId: `account-condition:${randomUUID()}`,
        scope: "global",
        userStated: true,
      })),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "applies_when_workspace_bound",
      "条件绑本地却挂上了账号级",
    );

    // 拒绝 ④：修订已有账号级规则，改成涉及当前书房的内容。
    await assert.rejects(
      withWorkspaceTransaction(home, (tx) => correctMemory(tx, home, account.memoryItemId, {
        content: "下个月要考日语N3",
        expectedRevision: revised.revision,
      })),
      (error: unknown) =>
        error instanceof MemoryGlobalScopeRejectedError && error.reason === "content_workspace_bound",
      "修订把本地材料写进了账号级规则",
    );

    // 四次拒绝之后，源行、副本与历史必须与**基线逐字相同**。
    // 用结构相等整块比，而不是逐项拿某个"记得住的数字"比：基线是从库里读出来的，
    // 任何一项不同（正文、scope、修订号、历史行）都会让这一格红。
    assert.deepEqual(
      await accountMemoryState(home, other, account.memoryItemId),
      baseline,
      "被拒的写入仍然改了源行、副本或只追加历史表",
    );

    // 两个空间里都不该出现任何一条"本地内容被写成账号级"的行。
    for (const scope of [home, other]) {
      const leaked = await memoryRows(scope, async (tx) => await tx`
        SELECT content FROM assistant_memory_items
         WHERE user_id = ${seeded.userId}::uuid AND scope = 'global' AND deleted_at IS NULL
           AND (content LIKE '%数据库索引%' OR content LIKE '%日语N3%'
                OR COALESCE(applies_when, '') LIKE '%这门课%')`);
      assert.equal(leaked.length, 0, `本地材料被写成了账号级：${JSON.stringify(leaked)}`);
    }

    // workspace 记忆不受这条约束：同样的本地内容照常写入（守卫只管账号级）。
    const local = await withWorkspaceTransaction(home, (tx) =>
      upsertMemory(tx, home, {
        kind: "goal",
        content: "正在学数据库索引优化",
        sourceEventId: `local:${randomUUID()}`,
        scope: "workspace",
        userStated: true,
      }),
    );
    assert.equal(local.scope, "workspace", "空间内记忆被账号级守卫拦掉了");
    assert.equal(local.content, "正在学数据库索引优化");
  } finally {
    await side.cleanup();
    await seeded.cleanup();
  }
});

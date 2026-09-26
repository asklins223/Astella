/**
 * Plan 23 W3-07：Dashboard 集成测试（真实 Postgres）。
 *
 * 自播种纯 V2 工作区（2026-08-23 起，替代被 0176 清库抹掉的手工工作区
 * 4f825f38-…）：首页非空、不进入 first_use（§25.5 关键断言）、counts 全部
 * 按 Objective 口径且与 mode 一致、primaryFocus 存在且 action 可执行、无私有泄漏。
 * 自播种 notes-only 工作区：mode = notes_without_objectives + suggestedNote 存在。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { findPrivatePayloadLeaks } from "@ailearn/shared";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

process.env.DATABASE_URL ??= testDatabaseUrl("DATABASE_URL");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [{ withWorkspaceTransaction }, { buildLearningDashboardV2 }, { seedPureV2Workspace, seedNotesOnlyWorkspace }] =
  await Promise.all([
    import("../db/client.ts"),
    import("../modules/learning-dashboard/service.ts"),
    import("./helpers/pure-v2-workspace-fixture.ts"),
  ]);

const pureV2 = await seedPureV2Workspace(sql, { objectiveCount: 3 });
const notesOnly = await seedNotesOnlyWorkspace(sql, { noteCount: 1 });

/**
 * §3.2 顺位在首页的**行为**判据（39d W4-2·补）。
 *
 * 旧的 `priorityScore` 把 `refresh`(5)／`view_successor`(6) 排在 `create_run`(3) **之后**，
 * 于是 §3.2 的第一档"需要处理的内容／权限变化"在首页永远当不了主建议。
 * 这里按服务端真条件造出那一档：一条 `pending` ＋ 已到期 ＋ **代次 0** 的安排，
 * 解析器给的是 `refresh` 而不是 `create_review_run`（`action-resolver.ts:137-140` 明写
 * 代次 < 1 不许端出复习），所以这一条同时钉住"两档不相混"。
 */
test("W3-07 §3.2 顺位：需要处理的内容排在开始学习之前，首页 hero 选它", async () => {
  const seeded = await seedPureV2Workspace(sql, { objectiveCount: 2, statementPrefix: "顺位首页" });
  try {
    const targetId = seeded.objectiveIds[0];
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${seeded.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${seeded.userId}, true)`;
      await tx`
        INSERT INTO review_schedules
          (id, workspace_id, user_id, subject_type, subject_id, status, next_review_at,
           interval_days, generation, policy_version, created_at, updated_at)
        VALUES (${cryptoRandomUUID()}, ${seeded.workspaceId}, ${seeded.userId},
                'card', ${targetId}, 'pending', now() - interval '1 hour',
                3, 0, 'precedence-fixture', now(), now())`;
    });

    const dashboard = await withWorkspaceTransaction(
      { workspaceId: seeded.workspaceId, userId: seeded.userId },
      (tx) => buildLearningDashboardV2(tx, { workspaceId: seeded.workspaceId, userId: seeded.userId }),
    );
    assert.ok(dashboard.primaryFocus, "有两条 active 目标时 hero 必须存在");
    assert.equal(dashboard.primaryFocus!.action.kind, "refresh",
      "代次 0 的到期安排必须落到 refresh（不是 create_review_run）");
    assert.equal(dashboard.primaryFocus!.objective.objectiveId, targetId,
      "§3.2 第一档「需要处理的内容／权限变化」必须排在开始学习之前");
    // 反向对照：另一条目标今天判出来的必须是"开始学习"那一档——没有这条，
    // "hero 选了 targetId"也可能是两条同种行动，顺位判据根本无从判起。
    const other = dashboard.queue.find((item) => item.objective.objectiveId !== targetId);
    assert.ok(other, "另一条目标要还在 hero 之后的清单里读得到");
    assert.ok(
      other!.action.kind === "create_run" || other!.action.kind === "create_review_run",
      `另一条该是可开一轮的那一档，实际 ${other!.action.kind}`,
    );
  } finally {
    await seeded.cleanup();
  }
});

after(async () => {
  await pureV2.cleanup();
  await notesOnly.cleanup();
  const { closeDatabase } = await import("../db/client.ts");
  await closeDatabase();
  await sql.end({ timeout: 2 });
});

test("W3-07: 纯 V2 工作区首页非空、非 first_use、focus 可行动、无泄漏", async () => {
  const dashboard = await withWorkspaceTransaction(
    { workspaceId: pureV2.workspaceId, userId: pureV2.userId },
    (tx) => buildLearningDashboardV2(tx, { workspaceId: pureV2.workspaceId, userId: pureV2.userId }),
  );
  assert.equal(dashboard.version, 2);
  assert.ok(dashboard.counts.activeObjectives >= 3, "activeObjectives >= 3");
  assert.notEqual(dashboard.mode, "first_use", "纯 V2 工作区不得进入 first_use");
  assert.ok(
    dashboard.mode === "objectives_ready" ||
      dashboard.mode === "run_in_progress" ||
      dashboard.mode === "review_due" ||
      dashboard.mode === "degraded",
    "mode 必须为 Objective 相关模式，实际 " + dashboard.mode,
  );
  assert.ok(dashboard.primaryFocus !== null, "primaryFocus 必须存在");
  const action = dashboard.primaryFocus!.action.kind;
  assert.ok(
    action === "resume_run" || action === "create_run" || action === "create_review_run",
    "primaryFocus action 必须可执行，实际 " + action,
  );
  assert.ok(dashboard.primaryFocus!.reasonCodes.length >= 1);
  assert.deepEqual(findPrivatePayloadLeaks(dashboard), []);
  const serialized = JSON.stringify(dashboard);
  assert.ok(!serialized.includes("canonicalAnswer"));
  assert.ok(!serialized.includes("scoringRubric"));
  // 数量对账：recent 不重复展示 primary item
  const recentIds = dashboard.recentObjectives.map((o) => o.objectiveId);
  if (dashboard.primaryFocus) {
    assert.ok(!recentIds.includes(dashboard.primaryFocus.objective.objectiveId), "recent 不得重复展示 primary");
  }
});

test("W3-07: notes-only 工作区 → notes_without_objectives + suggestedNote", async () => {
  const dashboard = await withWorkspaceTransaction(
    { workspaceId: notesOnly.workspaceId, userId: notesOnly.userId },
    (tx) => buildLearningDashboardV2(tx, { workspaceId: notesOnly.workspaceId, userId: notesOnly.userId }),
  );
  assert.equal(dashboard.mode, "notes_without_objectives");
  assert.ok(dashboard.suggestedNote !== null, "suggestedNote 必须存在");
  assert.ok(dashboard.suggestedNote!.title.length > 0);
  assert.deepEqual(dashboard.suggestedNote!.reasonCodes, ["notes_without_objectives"]);
  assert.equal(dashboard.primaryFocus, null);
});

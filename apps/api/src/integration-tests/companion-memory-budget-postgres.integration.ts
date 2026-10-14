/**
 * Resident memory budget and audit integration tests (real PostgreSQL).
 *
 * 常驻档的准入只有一条判据：**本轮声明的 6,400 tok**（迁移 0430 覆盖 0344 的那三行闸门）。
 * 这里的夹具因此按 token 造数——条数只是读数，不再能把第 7 条挡在外面。
 *
 * Run with DATABASE_URL_API and DATABASE_URL_WORKER set to a freshly migrated disposable database:
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/companion-memory-budget-postgres.integration.ts
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
// 正文上限只有一处声明（§9.4）：夹具按它造满载记忆，而不是自己再抄一个 200。
import { companionMemoryContentMaxLength } from "@astella/shared/companion-memory-desktop-contracts";
import { seedV2Fixture } from "./helpers/v2-card-fixture.ts";

const CONN = testDatabaseUrl("DATABASE_URL_API");
const WORKER_CONN = testDatabaseUrl("DATABASE_URL_WORKER");
process.env.DATABASE_URL_API ??= CONN;
const sql = postgres(CONN, { max: 2 });
const workerSql = postgres(WORKER_CONN, { max: 2 });
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");
const {
  getMemoryBudgetStatus,
  moveMemoryBudgetTier,
  upsertMemory,
} = await import("../modules/companion-conversation/memory/memory-service.ts");

after(async () => {
  await workerSql.end({ timeout: 2 });
  await sql.end({ timeout: 2 });
  await closeDatabase();
});

const RESIDENT_TOKEN_BUDGET = 6_400;
// SQL 侧一条记忆的 token = CEIL(octet_length(content)/3)，汉字 3 字节/字；写入端把正文钉在
// 200 字，所以**产品造得出**的最大一条就是 200 个汉字 = 600 字节 = 200 tok（全用汉字时
// token 数正好等于上限字符数）。装满 6,400 tok 需要 32 条，第 33 条才被拒——旧契约在这里
// 第 7 条就以"容量满了"回绝，而那正是这次改动要修的。
const FULL_CONTENT_TOKENS = companionMemoryContentMaxLength;
const ITEMS_TO_FILL_RESIDENT = RESIDENT_TOKEN_BUDGET / FULL_CONTENT_TOKENS;

const CJK_NUMERALS = "零一二三四五六七八九";
const cjkNumerals = (value: number) =>
  String(value).split("").map((digit) => CJK_NUMERALS[Number(digit)]!).join("");

/** 满载正文：整串都是汉字、长度正好触到写入端上限，于是每条恰好 200 tok。 */
function fullContent(index: number): string {
  const tail = `第${cjkNumerals(index)}条`;
  return "容".repeat(companionMemoryContentMaxLength - tail.length) + tail;
}

async function createMemories(
  scope: { workspaceId: string; userId: string },
  count: number,
  content: (index: number) => string = (index) => `预算测试记忆 ${index} ${randomUUID()}`,
) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const item = await withWorkspaceTransaction(scope, (tx) => upsertMemory(tx, scope, {
      kind: "preference",
      content: content(index),
      sourceEventId: `budget-test:${randomUUID()}`,
      userStated: true,
      candidate: false,
    }));
    items.push(item);
  }
  return items;
}

async function moveToResident(scope: { workspaceId: string; userId: string }, memoryItemId: string) {
  return withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
    memoryItemId,
    tier: "resident",
    actorType: "user",
    actorId: scope.userId,
  }));
}

test("resident moves fill the declared 6,400-token budget and refuse only the item that overflows it", async () => {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "resident memory budget fixture",
    publicSummary: "memory budget",
    front: { cue: "budget", prompt: "memory budget" },
  });
  try {
    const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
    const items = await createMemories(scope, ITEMS_TO_FILL_RESIDENT + 1, fullContent);

    for (const item of items.slice(0, ITEMS_TO_FILL_RESIDENT)) {
      const result = await moveToResident(scope, item.memoryItemId);
      assert.equal(result.status, "moved");
    }

    const full = await moveToResident(scope, items[ITEMS_TO_FILL_RESIDENT]!.memoryItemId);
    assert.equal(full.status, "capacity");
    if (full.status === "capacity") {
      assert.deepEqual(full.limits, { tokenEstimate: RESIDENT_TOKEN_BUDGET },
        "满额回执只能声明那一条真存在的预算；再报条数或字节就是给用户一个不存在的名额");
      assert.equal(full.current.tokenEstimate, RESIDENT_TOKEN_BUDGET);
      assert.equal(full.requested.tokenEstimate, FULL_CONTENT_TOKENS);
      assert.equal(full.current.items, ITEMS_TO_FILL_RESIDENT,
        "把 6,400 tok 装满本来就要 32 条：若这里还是 6，说明条数又悄悄变回了闸门");
      assert.equal(full.suggestedDowngrades.length, 10,
        "拒绝必须给出可以腾位的记忆（按可逆降级顺序，最多 10 条）");
      assert.ok(full.suggestedDowngrades.some((item) => item.memoryId === items[0]!.memoryItemId));
    }

    const unchanged = await moveToResident(scope, items[0]!.memoryItemId);
    assert.equal(unchanged.status, "unchanged");

    // 腾出 token 之后，被拒的那一条应当进得来——这才是"容量满了"这句拒绝的真判据。
    const downgraded = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
      memoryItemId: items[0]!.memoryItemId,
      tier: "active",
      actorType: "user",
      actorId: scope.userId,
    }));
    assert.equal(downgraded.status, "moved");
    const promoted = await moveToResident(scope, items[ITEMS_TO_FILL_RESIDENT]!.memoryItemId);
    assert.equal(promoted.status, "moved");

    const budget = await withWorkspaceTransaction(scope, (tx) => getMemoryBudgetStatus(tx, scope));
    assert.equal(budget.resident.used.items, ITEMS_TO_FILL_RESIDENT);
    assert.equal(budget.resident.used.tokenEstimate, RESIDENT_TOKEN_BUDGET);
    assert.equal(budget.resident.available.tokenEstimate, 0,
      "剩余名额由那条 token 预算算出来；读数与闸门脱钩时用户看到的还能记几条就是假的");
    assert.equal(budget.active.items, 1);

    const events = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
      return tx`
        SELECT memory_id, memory_revision, from_tier, to_tier, actor_type, actor_id
          FROM assistant_memory_budget_events
         WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
         ORDER BY created_at, id
      `;
    });
    assert.equal(
      events.length,
      ITEMS_TO_FILL_RESIDENT + 2,
      "32 promotes + 1 downgrade + 1 promote; refused and unchanged attempts are not movements",
    );
    assert.ok(events.every((event) => event.actor_type === "user" && event.actor_id === scope.userId));
    assert.ok(events.every((event) => Number(event.memory_revision) >= 1));
    assert.equal(events.some((event) => event.memory_id === items[0]!.memoryItemId && event.to_tier === "active"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("seven short memories all become resident: item count is a reading, not a quota", async () => {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "seven short resident memories fixture",
    publicSummary: "short resident memories",
    front: { cue: "seven short", prompt: "seven short" },
  });
  try {
    const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
    const items = await createMemories(scope, 7);

    for (const item of items) {
      const result = await moveToResident(scope, item.memoryItemId);
      assert.equal(result.status, "moved",
        `第 ${items.indexOf(item) + 1} 条被按条数拒了：她上下文里那截位置还空着，用户明确说过的事却记不住`);
    }

    const budget = await withWorkspaceTransaction(scope, (tx) => getMemoryBudgetStatus(tx, scope));
    assert.equal(budget.resident.used.items, 7);
    assert.ok(budget.resident.used.tokenEstimate < RESIDENT_TOKEN_BUDGET / 4,
      "七条短句本该远未触及 6,400 tok 这条线");
    assert.equal(budget.resident.available.tokenEstimate, RESIDENT_TOKEN_BUDGET - budget.resident.used.tokenEstimate);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent resident promotions serialize on the token line so only the affordable item is claimed", async () => {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "concurrent memory budget fixture",
    publicSummary: "concurrent memory budget",
    front: { cue: "budget concurrency", prompt: "budget concurrency" },
  });
  try {
    const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
    // 先把常驻档填到只剩最后一格的余量（6,200 / 6,400 tok），再让两条并发去抢那一格。
    const items = await createMemories(scope, ITEMS_TO_FILL_RESIDENT + 1, fullContent);
    for (const item of items.slice(0, ITEMS_TO_FILL_RESIDENT - 1)) {
      const result = await moveToResident(scope, item.memoryItemId);
      assert.equal(result.status, "moved");
    }

    const results = await Promise.all(items.slice(ITEMS_TO_FILL_RESIDENT - 1).map((item) =>
      moveToResident(scope, item.memoryItemId),
    ));
    assert.equal(results.filter((result) => result.status === "moved").length, 1);
    assert.equal(results.filter((result) => result.status === "capacity").length, 1,
      "两条并发不能都占住同一格 token：第二条必须被如实拒绝，而不是把预算超出去");

    const budget = await withWorkspaceTransaction(scope, (tx) => getMemoryBudgetStatus(tx, scope));
    assert.equal(budget.resident.used.items, ITEMS_TO_FILL_RESIDENT, "只有一个名额被抢到时，占用应当只前进一条");
    assert.ok(budget.resident.used.tokenEstimate <= RESIDENT_TOKEN_BUDGET,
      "并发之后常驻占用不能越过本轮声明的预算");
  } finally {
    await fixture.cleanup();
  }
});

test("worker moves are attributed to the companion and API callers cannot impersonate it", async () => {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "worker memory budget fixture",
    publicSummary: "worker memory budget",
    front: { cue: "worker budget", prompt: "worker budget" },
  });
  try {
    const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
    const [item] = await createMemories(scope, 1);
    assert.ok(item);

    const moved = await workerSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
      const rows = await tx`
        SELECT public.astella_move_companion_memory_budget_tier_v1(
          ${scope.workspaceId}::uuid, ${scope.userId}::uuid, ${item.memoryItemId}::uuid,
          'resident', 'companion', NULL::uuid
        ) AS result
      `;
      return rows[0]!.result as {
        status: string;
        memoryId?: string;
        fromTier?: string;
        tier?: string;
        revision?: number;
        residentUsage?: { items: number; tokenEstimate: number; byteCount: number };
      };
    });
    assert.equal(moved.status, "moved");
    assert.equal(moved.memoryId, item.memoryItemId);
    assert.equal(moved.fromTier, "active");
    assert.equal(moved.tier, "resident");
    assert.equal(moved.revision, item.revision);
    assert.equal(moved.residentUsage?.items, 1);
    assert.equal(moved.residentUsage?.byteCount, Buffer.byteLength(item.content));
    assert.equal(moved.residentUsage?.tokenEstimate, Math.max(1, Math.ceil(Buffer.byteLength(item.content) / 3)));

    const audit = await workerSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
      await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
      return tx`SELECT actor_type, actor_id FROM assistant_memory_budget_events WHERE memory_id = ${item.memoryItemId}`;
    });
    assert.deepEqual(Array.from(audit), [{ actor_type: "companion", actor_id: null }]);

    await assert.rejects(
      workerSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
        return tx`
          SELECT public.astella_move_companion_memory_budget_tier_v1(
            ${scope.workspaceId}::uuid, ${scope.userId}::uuid, ${item.memoryItemId}::uuid,
            'active', 'user', ${scope.userId}::uuid
          )
        `;
      }),
      (error: unknown) => typeof error === "object" && error !== null
        && "code" in error && (error as { code?: unknown }).code === "22023",
    );

    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
        await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
        return tx`
          SELECT public.astella_move_companion_memory_budget_tier_v1(
            ${scope.workspaceId}::uuid, ${scope.userId}::uuid, ${item.memoryItemId}::uuid,
            'active', 'companion', NULL::uuid
          )
        `;
      }),
      (error: unknown) => typeof error === "object" && error !== null
        && "code" in error && (error as { code?: unknown }).code === "22023",
    );
  } finally {
    await fixture.cleanup();
  }
});

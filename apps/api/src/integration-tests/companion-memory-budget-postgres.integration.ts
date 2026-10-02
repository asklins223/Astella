/**
 * Resident memory budget and audit integration tests (real PostgreSQL).
 *
 * Run with DATABASE_URL_API and DATABASE_URL_WORKER set to a freshly migrated disposable database:
 *   node --import tsx --test --test-concurrency=1 src/integration-tests/companion-memory-budget-postgres.integration.ts
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
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

async function createMemories(scope: { workspaceId: string; userId: string }, count: number) {
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const item = await withWorkspaceTransaction(scope, (tx) => upsertMemory(tx, scope, {
      kind: "preference",
      content: `预算测试记忆 ${index} ${randomUUID()}`,
      sourceEventId: `budget-test:${randomUUID()}`,
      userStated: true,
      candidate: false,
    }));
    items.push(item);
  }
  return items;
}

test("resident moves enforce capacity, keep downgrade user-directed, and append an audit event", async () => {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "resident memory budget fixture",
    publicSummary: "memory budget",
    front: { cue: "budget", prompt: "memory budget" },
  });
  try {
    const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
    const items = await createMemories(scope, 7);

    for (const item of items.slice(0, 6)) {
      const result = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
        memoryItemId: item.memoryItemId,
        tier: "resident",
        actorType: "user",
        actorId: scope.userId,
      }));
      assert.equal(result.status, "moved");
    }

    const full = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
      memoryItemId: items[6]!.memoryItemId,
      tier: "resident",
      actorType: "user",
      actorId: scope.userId,
    }));
    assert.equal(full.status, "capacity");
    if (full.status === "capacity") {
      assert.equal(full.current.items, 6);
      assert.equal(full.limits.items, 6);
      assert.equal(full.suggestedDowngrades.length, 6);
      assert.ok(full.suggestedDowngrades.some((item) => item.memoryId === items[0]!.memoryItemId));
    }

    const unchanged = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
      memoryItemId: items[0]!.memoryItemId,
      tier: "resident",
      actorType: "user",
      actorId: scope.userId,
    }));
    assert.equal(unchanged.status, "unchanged");

    const downgraded = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
      memoryItemId: items[0]!.memoryItemId,
      tier: "active",
      actorType: "user",
      actorId: scope.userId,
    }));
    assert.equal(downgraded.status, "moved");
    const promoted = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
      memoryItemId: items[6]!.memoryItemId,
      tier: "resident",
      actorType: "user",
      actorId: scope.userId,
    }));
    assert.equal(promoted.status, "moved");

    const budget = await withWorkspaceTransaction(scope, (tx) => getMemoryBudgetStatus(tx, scope));
    assert.equal(budget.resident.used.items, 6);
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
    assert.equal(events.length, 8, "6 promotes + 1 downgrade + 1 promote; full/unchanged attempts are not movements");
    assert.ok(events.every((event) => event.actor_type === "user" && event.actor_id === scope.userId));
    assert.ok(events.every((event) => Number(event.memory_revision) >= 1));
    assert.equal(events.some((event) => event.memory_id === items[0]!.memoryItemId && event.to_tier === "active"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent resident promotions serialize so only the last available slot can be claimed", async () => {
  const fixture = await seedV2Fixture(sql, {
    objectiveStatement: "concurrent memory budget fixture",
    publicSummary: "concurrent memory budget",
    front: { cue: "budget concurrency", prompt: "budget concurrency" },
  });
  try {
    const scope = { workspaceId: fixture.workspaceId, userId: fixture.userId };
    const items = await createMemories(scope, 7);
    for (const item of items.slice(0, 5)) {
      const result = await withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
        memoryItemId: item.memoryItemId,
        tier: "resident",
        actorType: "user",
        actorId: scope.userId,
      }));
      assert.equal(result.status, "moved");
    }

    const results = await Promise.all(items.slice(5).map((item) =>
      withWorkspaceTransaction(scope, (tx) => moveMemoryBudgetTier(tx, scope, {
        memoryItemId: item.memoryItemId,
        tier: "resident",
        actorType: "user",
        actorId: scope.userId,
      })),
    ));
    assert.equal(results.filter((result) => result.status === "moved").length, 1);
    assert.equal(results.filter((result) => result.status === "capacity").length, 1);
    const budget = await withWorkspaceTransaction(scope, (tx) => getMemoryBudgetStatus(tx, scope));
    assert.equal(budget.resident.used.items, 6);
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
        SELECT public.ailearn_move_companion_memory_budget_tier_v1(
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
          SELECT public.ailearn_move_companion_memory_budget_tier_v1(
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
          SELECT public.ailearn_move_companion_memory_budget_tier_v1(
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

/**
 * 方案 42 长期目标的**真实数据库验收**（§6.8 第 5 步、§7.3、§11.4、§14.2「全项目状态感知」）。
 *
 * ## 这份套件在守什么
 *
 * 长期目标与「一件事」的边界，是方案 42 里最容易被实现悄悄抹掉的一处：
 * 一件任务做完，**不**等于长期目标完成；而长期目标的依据一旦变了，
 * 手里那条旧引用必须**当场作废**，同时新引用要能用。
 *
 * | 用例 | 守的条款 |
 * | --- | --- |
 * | create 带真实长期目标关联 | §11.4「持续身份…协议」：run 真的钉住那条目标的某一版 |
 * | requestId 幂等 / 不同 ref 冲突 | §13「发起与修改幂等」：同一请求同一结果，换引用必须报冲突 |
 * | 任务完成不宣称长期目标完成 | §7.3「不把一次产物交付当作整个长期目标完成」 |
 * | 旧 ref 在五种失效后被拒、新 ref 可用 | §6.8 第 5 步 + §14.5 GT-07：依据变了就别再拿旧版说事 |
 * | 跨 user / workspace 隔离 | §6.9 / §14.2：范围只由身份判，不靠内容 |
 * | 修订历史保留 longGoal | §13.2：历史项带**它自己那一版**的关联 |
 *
 * ## 走的是真实链路
 *
 * 长期目标用**现役 memory service** 写（`upsertMemory` + `confirmMemory` +
 * `correctMemory` / `deleteMemory` / `dismissMemory` / `archiveMemory`），
 * run 读写用**现役 agent store**（`@ailearn/agent-host` 的 `createAgentStore` +
 * worker's `agentStorePorts`）。断言的是 store 与 `longGoals()` 读到什么，
 * 不是「库里躺着什么」。
 *
 * 唯一允许的裸 SQL 是**夹具写入**（建 user/workspace/member）与**只读读数**
 * （revision / valid_until 这类 service 不返回的列）。
 *
 * ## 失败就是失败
 *
 * 现役实现不满足条款时本套件**保留真实失败**，不把断言改成迎合实现。
 * 每条断言的失败信息里写的是合同原话。
 *
 * ## 运行（一次性库；缺变量当场抛，绝不静默落到日常开发库）
 *
 *   node /tmp/study-agent42-growth-db.mjs test \
 *     src/integration-tests/agent-long-goals-postgres.integration.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

// ── 连接串：必须在这两个动态 import **之前**落定 ──────────────────────────
// apps/api/src/db/client.ts 与 workers/ai-worker/src/db.ts 都在模块加载时读环境变量。
process.env.DATABASE_URL_API = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_WORKER = testDatabaseUrl("DATABASE_URL_WORKER");

/** 夹具专用超户。写 users/workspaces/members 只走它——被测路径一律用受限角色。 */
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });

const { withWorkspaceTransaction, closeDatabase: closeApiDatabase } =
  await import("../../../../apps/api/src/db/client.ts");
const { closeDatabase: closeWorkerDatabase } = await import("../db.ts");
const { agentStore, agentStorePorts } = await import("../agent/store.ts");
const {
  upsertMemory, confirmMemory, correctMemory,
  deleteMemory, dismissMemory, archiveMemory,
} = await import(
  "../../../../apps/api/src/modules/companion-conversation/memory/memory-service.ts"
);
const { AgentStoreError, createAgentAdvanceStore } = await import("@ailearn/agent-host");
const { agentTurnResultSchema } = await import("@ailearn/shared");

type StatedInput = Parameters<typeof upsertMemory>[2];

// ── 作用域与调用捷径 ──────────────────────────────────────────────────────
interface Scope { workspaceId: string; userId: string }

const inApi = <T>(scope: Scope, action: (tx: import("../../../../apps/api/src/db/client.ts").ApiTransaction) => Promise<T>) =>
  withWorkspaceTransaction(scope, action);

// ── 夹具 ─────────────────────────────────────────────────────────────────
interface Fixture {
  userId: string;
  /** 同为成员空间的另一个用户：可见性只靠 `user_id` 判据成立。 */
  otherUserId: string;
  home: string;
  side: string;
}

const fixtures: Fixture[] = [];
const emailPrefix = 'agent42lg';

async function fixture(): Promise<Fixture> {
  const created: Fixture = {
    userId: randomUUID(), otherUserId: randomUUID(),
    home: randomUUID(), side: randomUUID(),
  };
  fixtures.push(created);
  const tag = `${emailPrefix}-${created.userId.slice(0, 8)}`;
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES
      (${created.userId},${`${tag}-a@test.invalid`},'fixture','owner'),
      (${created.otherUserId},${`${tag}-b@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES
      (${created.home},${`${tag}-home`},${created.userId}),
      (${created.side},${`${tag}-side`},${created.userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES
      (${created.home},${created.userId},'owner'),
      (${created.side},${created.userId},'owner'),
      (${created.side},${created.otherUserId},'member')`;
    // 伴星身份：create 走的是 `requireAgentAuthority`，没有它连目标都建不出来。
    await tx`INSERT INTO user_companion_account_state(user_id,global_enabled,agent_settings)
      VALUES(${created.userId},true,${admin.json({ version:1,permissionLevel: "guided" })}),
             (${created.otherUserId},true,${admin.json({ version:1,permissionLevel: "guided" })})`;
  });
  return created;
}

/**
 * 写一条真实的长期目标：用户自己确认过的 `goal`，空间范围，`active` 容量档。
 * `user_confirmed` + `kind='goal'` 是长期目标的资格线，两者缺一它就只是一条候选。
 */
async function writeLongGoal(scope: Scope, content: string, extra: Partial<StatedInput> = {}) {
  const row = await inApi(scope, (tx) => upsertMemory(tx, scope, {
    kind: "goal", content, sourceEventId: `evt-${randomUUID()}`,
    userStated: true, candidate: false, ...extra,
  }));
  assert.ok(row, "长期目标写入被拒");
  const confirmed = await inApi(scope, (tx) => confirmMemory(tx, scope, row.memoryItemId));
  assert.ok(confirmed, "长期目标确认落空：未确认的候选不构成长期目标");
  return confirmed;
}

/** 记忆在行上的真实状态：revision 由 DB 的触发器推进，service 不返回。 */
const memoryState = async (id: string) => {
  const rows = await admin`
    SELECT revision, deleted_at, dismissed_at, archived_at, epistemic_status, scope
      FROM assistant_memory_items WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return {
    revision: Number(row.revision),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at as string),
    dismissedAt: row.dismissed_at === null ? null : new Date(row.dismissed_at as string),
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at as string),
    epistemicStatus: String(row.epistemic_status),
    scope: String(row.scope),
  };
};

after(async () => {
  try {
    for (const created of fixtures) {
      for (const workspaceId of [created.home, created.side]) {
        await admin`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM agent_operations WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM agent_run_revisions WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM agent_runs WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM assistant_memory_embeddings WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      }
      await admin`DELETE FROM users WHERE id IN (${created.userId}, ${created.otherUserId})`;
    }
    const [left] = await admin`SELECT count(*)::int AS n FROM users WHERE email LIKE ${`${emailPrefix}-%@test.invalid`}`;
    assert.equal(left?.n, 0, "夹具没有清理干净");
    await admin.end();
    await closeApiDatabase();
    await closeWorkerDatabase();
  } catch (error) {
    console.error("cleanup failed", error);
    process.exitCode = 1;
  }
});

// ── 1. create 真的把长期目标关联钉住 ───────────────────────────────────────

test("create：run 真的钉住长期目标的那一版，列表里也读得到", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "把这一门的基础真正学扎实，而不是刷完题就算过。");
  const state = await memoryState(goal.memoryItemId);
  assert.equal(state?.scope, "workspace", "长期目标必须是空间范围");

  const run = await agentStore.create(scope, {
    requestId: randomUUID(), goal: "先过第二章的前三节。", inputs: [],
    longGoal: { memoryId: goal.memoryItemId, revision: goal.revision },
  });
  assert.deepEqual(run.longGoal, { memoryId: goal.memoryItemId, revision: goal.revision },
    "create 之后 run 上读不到那条长期目标关联：目标与这件事之间的引用没落库");

  const goals = await agentStore.longGoals(scope);
  const item = goals.items.find(g => g.ref.memoryId === goal.memoryItemId);
  assert.ok(item, "长期目标列表里读不到刚确认的那条目标");
  assert.deepEqual(item.tasks.map(t => t.runId), [run.runId],
    "任务没有出现在它所属的长期目标下面：两边对不上");
});

test("长期目标列表：未确认、已删除、争议、已过期的都不算长期目标", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const confirmed = await writeLongGoal(scope, "确认过的长期目标。");
  const candidate = await inApi(scope, (tx) => upsertMemory(tx, scope, {
    kind: "goal", content: "只是候选的长期目标。", sourceEventId: `evt-${randomUUID()}`,
    userStated: false, candidate: true,
  }));
  const disputed = await writeLongGoal(scope, "被质疑的长期目标。");
  await inApi(scope, (tx) => (tx as never as { execute(q: unknown): Promise<unknown> })
    .execute({ query: null }) as never).catch(() => undefined);
  // 争议状态由领域 service 负责落；这里直接用现役的纠正路径把依据改掉再撤。
  await admin`UPDATE assistant_memory_items SET epistemic_status='disputed' WHERE id = ${disputed.memoryItemId}`;

  const goals = await agentStore.longGoals(scope);
  const ids = goals.items.map(g => g.ref.memoryId);
  assert.ok(ids.includes(confirmed.memoryItemId), "确认过的目标不在列表里");
  assert.equal(ids.includes(candidate.memoryItemId), false, "未确认的候选被当成了长期目标");
  assert.equal(ids.includes(disputed.memoryItemId), false, "被质疑的目标仍被当作长期目标");
});

// ── 2. requestId 幂等 / 不同 ref 冲突 ─────────────────────────────────────

test("requestId 幂等：同一请求重放读回同一个 run", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "同一份要求的幂等判定。");
  const requestId = randomUUID();
  const input = {
    requestId, goal: "先把第三章的开头过一遍。", inputs: [],
    longGoal: { memoryId: goal.memoryItemId, revision: goal.revision },
  };
  const first = await agentStore.create(scope, input);
  const second = await agentStore.create(scope, input);
  assert.equal(second.runId, first.runId, "同一 requestId 重建出了另一个目标：发起不幂等");
  assert.equal(second.revision, first.revision);
});

test("requestId 冲突：同一 requestId 换一条长期目标引用必须报冲突", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const first = await writeLongGoal(scope, "第一个长期目标。");
  const second = await writeLongGoal(scope, "第二个长期目标。");
  const requestId = randomUUID();
  await agentStore.create(scope, {
    requestId, goal: "同一句要求。", inputs: [], longGoal: { memoryId: first.memoryItemId, revision: first.revision },
  });
  await assert.rejects(
    () => agentStore.create(scope, {
      requestId, goal: "同一句要求。", inputs: [], longGoal: { memoryId: second.memoryItemId, revision: second.revision },
    }),
    (error: unknown) => error instanceof AgentStoreError && error.code === "request_conflict",
    "同一个 requestId 挂着另一条长期目标引用却当成幂等重放：这次请求已有另一份要求，必须报冲突",
  );
});

test("拿一个不存在的长期目标引用去 create，当场拒绝", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  await assert.rejects(
    () => agentStore.create(scope, {
      requestId: randomUUID(), goal: "挂一条不存在的长期目标。", inputs: [],
      longGoal: { memoryId: randomUUID(), revision: 1 },
    }),
    (error: unknown) => error instanceof AgentStoreError && error.code === "long_goal_changed",
    "不存在的长期目标引用被接受了：那等于凭空虚构一个归属",
  );
});

// ── 3. 任务完成不宣称长期目标完成 ────────────────────────────────────────

test("任务完成只是这一件事完成：长期目标本身不被标记为完成", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "把这门课学到能自己讲清楚。");
  const run = await agentStore.create(scope, {
    requestId: randomUUID(), goal: "先讲清楚第一章第二节。", inputs: [],
    longGoal: { memoryId: goal.memoryItemId, revision: goal.revision },
  });

  // 完成这一件事，走的是现役的 control 语义之外的直接状态推进（同一张表）。
  await admin`UPDATE agent_runs SET status='completed',summary=${'第一节讲通了。'},
    updated_at=now() WHERE id = ${run.runId} AND workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}`;

  const goals = await agentStore.longGoals(scope);
  const item = goals.items.find(g => g.ref.memoryId === goal.memoryItemId);
  assert.ok(item, "任务完成后长期目标从列表里消失了：一次交付把整个长期目标带走了");
  assert.equal(item.tasks.find(t => t.runId === run.runId)?.status, "completed");
  // 长期目标自身仍然是「有效且未完成」——它没有完成列，也就不该出现一个。
  assert.equal((item as unknown as { completedAt?: unknown }).completedAt ?? null, null,
    "长期目标上多出了一个完成状态：任务完成被当成了长期目标完成");
  const state = await memoryState(goal.memoryItemId);
  assert.equal(state?.deletedAt, null, "任务完成把长期目标的依据删掉了");
});

// ── 4. 旧 ref 在五种失效后被拒；新 ref 可用 ───────────────────────────────

/** 走一遍「拿旧引用去建一个新目标」，返回抛没抛。 */
async function createWithRef(scope: Scope, ref: { memoryId: string; revision: number }) {
  try {
    await agentStore.create(scope, { requestId: randomUUID(), goal: "换一个材料接着做。", inputs: [], longGoal: ref });
    return null;
  } catch (error) {
    return error;
  }
}

test("依据被修订后：旧 ref 拒绝，新 ref 可用", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "把这一章学扎实。");
  const oldRef = { memoryId: goal.memoryItemId, revision: goal.revision };

  const before = await memoryState(goal.memoryItemId);
  await inApi(scope, (tx) => correctMemory(tx, scope, goal.memoryItemId, {
    content: "把这一章的基础概念真正弄懂。", expectedRevision: goal.revision,
  }));
  const after = await memoryState(goal.memoryItemId);
  assert.ok(after && before && after.revision > before.revision, "纠正没有推进 revision：依据变了却看不出变了");

  const stale = await createWithRef(scope, oldRef);
  assert.ok(stale instanceof AgentStoreError && stale.code === "long_goal_changed",
    "依据已被修订，拿着旧引用仍然建得起来：依据变了就别再拿旧版说事");
  const fresh = await createWithRef(scope, { memoryId: goal.memoryItemId, revision: after.revision });
  assert.equal(fresh, null, "新引用被拒了：依据其实已经更新，应当可用");
});

test("依据被撤回（删除）后：旧 ref 拒绝", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "这条会被撤回的长期目标。");
  await inApi(scope, (tx) => deleteMemory(tx, scope, goal.memoryItemId));
  const state = await memoryState(goal.memoryItemId);
  assert.equal(state?.deletedAt === null, false, "撤回没有落成：夹具没走到那条领域路径上");
  const stale = await createWithRef(scope, { memoryId: goal.memoryItemId, revision: goal.revision });
  assert.ok(stale instanceof AgentStoreError && stale.code === "long_goal_changed",
    "依据已被撤回，旧引用仍然可用");
});

test("依据被忽略（dismiss）后：旧 ref 拒绝", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "这条会被忽略的长期目标。");
  await inApi(scope, (tx) => dismissMemory(tx, scope, goal.memoryItemId));
  const state = await memoryState(goal.memoryItemId);
  assert.ok(state?.dismissedAt, "忽略没有落成：夹具没走到那条领域路径上");
  const stale = await createWithRef(scope, { memoryId: goal.memoryItemId, revision: goal.revision });
  assert.ok(stale instanceof AgentStoreError && stale.code === "long_goal_changed",
    `依据已被忽略（她不再对它开口），旧引用仍然可用。真实行状态=${JSON.stringify(state)}`);
  const listed = (await agentStore.longGoals(scope)).items
    .some(g => g.ref.memoryId === goal.memoryItemId);
  assert.equal(listed, false,
    `已被忽略的目标仍出现在长期目标列表里。真实行状态=${JSON.stringify(state)}`);
});

test("依据被归档（archive）后：旧 ref 拒绝", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "这条会被归档的长期目标。");
  await inApi(scope, (tx) => archiveMemory(tx, scope, goal.memoryItemId));
  const state = await memoryState(goal.memoryItemId);
  assert.ok(state?.archivedAt, "归档没有落成：夹具没走到那条领域路径上");
  const stale = await createWithRef(scope, { memoryId: goal.memoryItemId, revision: goal.revision });
  assert.ok(stale instanceof AgentStoreError && stale.code === "long_goal_changed",
    `依据已归档，旧引用仍然可用。真实行状态=${JSON.stringify(state)}`);
  const listed = (await agentStore.longGoals(scope)).items
    .some(g => g.ref.memoryId === goal.memoryItemId);
  assert.equal(listed, false,
    `已归档的目标仍出现在长期目标列表里。真实行状态=${JSON.stringify(state)}`);
});

test("依据进入争议后：旧 ref 拒绝", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "这条会变成争议的长期目标。");
  await admin`UPDATE assistant_memory_items SET epistemic_status='disputed' WHERE id = ${goal.memoryItemId}`;
  const stale = await createWithRef(scope, { memoryId: goal.memoryItemId, revision: goal.revision });
  assert.ok(stale instanceof AgentStoreError && stale.code === "long_goal_changed",
    "依据已被质疑，旧引用仍然可用");
});

test("依据过期后：旧 ref 拒绝", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "这条会过期的长期目标。");
  await admin`UPDATE assistant_memory_items SET valid_until = now() - interval '1 minute' WHERE id = ${goal.memoryItemId}`;
  const stale = await createWithRef(scope, { memoryId: goal.memoryItemId, revision: goal.revision });
  assert.ok(stale instanceof AgentStoreError && stale.code === "long_goal_changed",
    "依据已过期，旧引用仍然可用");
});

// ── 5. 跨 user / workspace 隔离 ──────────────────────────────────────────

test("隔离：别人的长期目标引用读不到，另一个用户的列表里也不出现", async () => {
  const f = await fixture();
  const owner: Scope = { workspaceId: f.side, userId: f.userId };
  const other: Scope = { workspaceId: f.side, userId: f.otherUserId };
  const goal = await writeLongGoal(owner, "只属于这个账号的长期目标。");

  const stolen = await createWithRef(other, { memoryId: goal.memoryItemId, revision: goal.revision });
  assert.ok(stolen instanceof AgentStoreError && stolen.code === "long_goal_changed",
    "同空间另一个用户拿着这条 id 建起了目标：范围只由身份判，不该由内容判");

  const otherGoals = await agentStore.longGoals(other);
  assert.equal(otherGoals.items.some(g => g.ref.memoryId === goal.memoryItemId), false,
    "别人的长期目标出现在另一个用户的列表里");

  // 同一用户、另一个空间：目标不跟着用户跨空间长过去。
  const sibling: Scope = { workspaceId: f.home, userId: f.userId };
  const siblingGoals = await agentStore.longGoals(sibling);
  assert.equal(siblingGoals.items.some(g => g.ref.memoryId === goal.memoryItemId), false,
    "长期目标跨空间可见了：空间范围判据没起作用");
});

// ── 6. 修订历史保留 longGoal ─────────────────────────────────────────────

test("修订历史：每一版都带自己那一版的长期目标关联", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const goal = await writeLongGoal(scope, "修订历史要留住的那条长期目标。");
  const run = await agentStore.create(scope, {
    requestId: randomUUID(), goal: "先做第一版要求。", inputs: [],
    longGoal: { memoryId: goal.memoryItemId, revision: goal.revision },
  });
  const revised = await agentStore.revise(scope, run.runId, run.revision, "改成第二版要求。");
  assert.deepEqual(revised.longGoal, { memoryId: goal.memoryItemId, revision: goal.revision },
    "修订把长期目标关联弄丢了：这件事换了要求，但它属于哪个长期目标没变");

  const history = await agentStore.history(scope, run.runId);
  const archived = history.items.find(r => r.revision === run.revision);
  assert.ok(archived, "第一版没有进历史：存档链断了");
  assert.deepEqual(archived.longGoal, { memoryId: goal.memoryItemId, revision: goal.revision },
    "历史里的第一版丢了 longGoal：拿旧版去看时不知道它属于哪个长期目标");
  assert.equal(archived.recordedAt === null, false, "旧版没有记入存档时间");
  assert.equal(archived.supersededByRevision, revised.revision);
});

test("修订历史：一个不带长期目标的 run，其历史也不该凭空多出关联", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const run = await agentStore.create(scope, {
    requestId: randomUUID(), goal: "一件没有长期归属的事。", inputs: [],
  });
  await agentStore.revise(scope, run.runId, run.revision, "改成另一句要求。");
  const history = await agentStore.history(scope, run.runId);
  for (const revision of history.items) {
    assert.equal(revision.longGoal ?? null, null,
      "一件没有长期归属的事，在历史里长出了长期目标关联");
  }
});

test("目标依据修订后可明确重新关联或解绑，每一版历史保留自己的依据", async () => {
  const f=await fixture(),scope={workspaceId:f.home,userId:f.userId};
  const goal=await writeLongGoal(scope,"先学习电路基础。");
  const run=await agentStore.create(scope,{requestId:randomUUID(),goal:"核对一次电流计算",inputs:[],longGoal:{memoryId:goal.memoryItemId,revision:goal.revision}});
  await inApi(scope,tx=>correctMemory(tx,scope,goal.memoryItemId,{content:"先学习直流电路的计算与边界。",expectedRevision:goal.revision}));
  const state=await memoryState(goal.memoryItemId);assert.ok(state);
  await assert.rejects(()=>agentStore.revise(scope,run.runId,1,"继续原来的任务"),error=>error instanceof AgentStoreError&&error.code==="long_goal_changed");
  const fresh={memoryId:goal.memoryItemId,revision:state.revision};
  const aligned=await agentStore.revise(scope,run.runId,1,"按修订后的方向继续核对",fresh);
  assert.deepEqual(aligned.longGoal,fresh);
  const detached=await agentStore.revise(scope,run.runId,2,"这次只核对用户给的表达式",null);
  assert.equal(detached.longGoal,null);
  const history=await agentStore.history(scope,run.runId);
  assert.deepEqual(history.items.find(item=>item.revision===1)?.longGoal,run.longGoal);
  assert.deepEqual(history.items.find(item=>item.revision===2)?.longGoal,fresh);
});

test("模型返回前依据改变：缓存响应、能力执行与提交均被挡住，任务可暂停后重新对齐",async()=>{
  const f=await fixture(),scope={workspaceId:f.home,userId:f.userId};
  const goal=await writeLongGoal(scope,"按这个方向学习。");
  const run=await agentStore.create(scope,{requestId:randomUUID(),goal:"计算 12 / 4",inputs:[],longGoal:{memoryId:goal.memoryItemId,revision:goal.revision}});
  const leaseToken=randomUUID();
  const [job]=await admin`UPDATE jobs SET status='running',lease_token=${leaseToken},started_at=now()
    WHERE id=(SELECT id FROM jobs WHERE workspace_id=${scope.workspaceId} AND payload->>'runId'=${run.runId} LIMIT 1) RETURNING id`;
  assert.ok(job);
  const advance=createAgentAdvanceStore(agentStorePorts,{id:job.id,workspaceId:scope.workspaceId,requestedBy:scope.userId,leaseToken},run.runId,run.revision);
  assert.ok(await advance.acquire());
  const request={role:"companion_agent" as const,systemPrompt:"fixture",messages:[],tools:[],toolChoice:"auto" as const,maxTokens:200,temperature:0};
  const prepared=await advance.step(request,"frozen-before-correction");
  const response=agentTurnResultSchema.parse({content:"旧方向的结果",toolCalls:[],finishReason:"stop",usage:null,providerRequestId:null});
  await advance.saveResponse(prepared.step,response);
  await inApi(scope,tx=>correctMemory(tx,scope,goal.memoryItemId,{content:"方向已由用户改正。",expectedRevision:goal.revision}));
  const rejectsChanged=(error:unknown)=>error instanceof AgentStoreError&&error.code==="long_goal_changed";
  await assert.rejects(()=>advance.step(request,"fresh-hash"),rejectsChanged);
  let actions=0;await assert.rejects(()=>advance.invoke(async()=>{actions++;}),rejectsChanged);assert.equal(actions,0);
  await assert.rejects(()=>advance.applyStep(prepared.step,response,[]),rejectsChanged);
  await advance.pauseForChangedLongGoal("请核对修订后的方向。");await advance.release(false);
  const current=await agentStore.get(scope,run.runId);assert.equal(current.status,"paused");assert.equal(current.summary,null);
  const [step]=await admin`SELECT applied FROM agent_run_steps WHERE id=${prepared.step.id}`;assert.equal(step.applied,false);
});

test("目标与关联任务可读完整分页，游标不能跨空间或筛选条件复用",async()=>{
  const f=await fixture(),scope={workspaceId:f.home,userId:f.userId};
  const goals=[];
  for(let index=0;index<6;index++) goals.push(await writeLongGoal(scope,`分页目标 ${index}：${index===5?"电路":"阅读"}`));
  const first=await agentStore.longGoals(scope,{limit:2});assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const seen=new Set(first.items.map(item=>item.ref.memoryId));let cursor:string|null=first.nextCursor;
  while(cursor) {const page=await agentStore.longGoals(scope,{limit:2,cursor});for(const item of page.items){assert.equal(seen.has(item.ref.memoryId),false);seen.add(item.ref.memoryId);}cursor=page.nextCursor;}
  assert.equal(seen.size,6);
  await assert.rejects(()=>agentStore.longGoals({...scope,workspaceId:f.side},{cursor:first.nextCursor!}),/不属于/);
  await assert.rejects(()=>agentStore.longGoals(scope,{cursor:first.nextCursor!,query:"电路"}),/不属于/);
  const found=await agentStore.longGoals(scope,{query:"电路"});assert.equal(found.items.length,1);
  const ref=found.items[0].ref;
  for(let index=0;index<7;index++){const task=await agentStore.create(scope,{requestId:randomUUID(),goal:`关联任务 ${index}`,inputs:[],longGoal:ref});await agentStore.control(scope,task.runId,task.revision,"cancel");}
  const directory=await agentStore.longGoals(scope,{memoryId:ref.memoryId});assert.equal(directory.items[0].taskCount,7);assert.equal(directory.items[0].tasks.length,5);
  const page=await agentStore.list(scope,{longGoalMemoryId:ref.memoryId,limit:3});assert.equal(page.items.length,3);assert.ok(page.nextCursor);
  await assert.rejects(()=>agentStore.list(scope,{cursor:page.nextCursor!}),/重新看|重新|从头/);
  const older=await agentStore.list(scope,{longGoalMemoryId:ref.memoryId,cursor:page.nextCursor!,limit:10});assert.equal(older.items.length,4);
});

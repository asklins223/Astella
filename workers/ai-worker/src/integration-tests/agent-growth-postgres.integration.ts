/**
 * 方案 42 并行包 T：成长、方法与遗忘的**真实数据库回归**（§6.8 / §6.9 / §14.5 GT-01…GT-12）。
 *
 * ## 这份套件在守什么
 *
 * 42 §6.8 把成长写成五步闭环，第 5 步是「保留、修正或撤回」；§6.9 要求
 * 「来源纠正、遗忘、删除与撤权沿派生关系传到方法、适应配置、摘要与索引与缓存」；
 * §14.5 的 GT-07/GT-08/GT-09/GT-02 是它们对应的可观察场景。本套件只覆盖
 * **能在一次集成跑里同时拿到「写端真实动作」与「读端真实读数」** 的那几条：
 *
 * | 用例 | 守的条款 |
 * | --- | --- |
 * | 纠正后手册失效 | §6.9 / GT-08：证据被纠正，引用它的手册不再自称「有据」 |
 * | 删除后手册失效 | 同上（软删，进回收区） |
 * | 停用后手册失效 | 同上（dismiss / archive 两条停用路径） |
 * | 数组证据匹配 | 0348 传播触发器对 **jsonb 数组**证据的匹配，以及不误伤对照 |
 * | 旧版本拒绝 | §6.9「方法版本」：拿着上一版 id 读不到新内容 |
 * | 跨用户/空间隔离 | §6.9「空间方法不通过通用经验标签自动跨空间」 |
 * | 迟到整理不复活 | GT-08「后台提交/旧版本恢复不能复活被抑制内容」 |
 * | 当前例外不改长期偏好 | GT-02：临时例外不覆盖长期规则，明确长期修订才改 |
 * | 成长合同新路径 | 主会话新增的成长/方法模块必须能被 worker 作用域真实调用 |
 *
 * ## 走的是真实链路，不是复制领域 SQL
 *
 * 写入与撤回全部用**现役 service**：API 侧
 * `memory-service.ts` 的 `upsertMemory / confirmMemory / correctMemory /
 * deleteMemory / dismissMemory / archiveMemory / eraseMemory`，worker 侧
 * `companion-playbooks.ts` 的 `upsertPlaybook / readPlaybookById /
 * retrievePlaybookCatalog` 与 `companion-memory-organize.ts` 的
 * `runCompanionMemoryOrganize`。断言的是**下一次读取看到什么**
 * （`loadAgentLearningContext` 的采用列表、手册目录与正文），
 * 不是「库里躺着什么」。
 *
 * 唯一允许的裸 SQL 是**夹具写入**（建 user/workspace/member）与**只读读数**
 * （revision / deleted_at / jsonb_typeof 这类领域 service 不返回的列）。
 * 任何一条派生规则都没有在测试里重写一遍。
 *
 * ## 失败就是失败
 *
 * 现役实现不满足条款时，本套件**保留真实失败**，不把断言改成迎合实现。
 * 每条断言的失败信息里写的是合同原话，不是实现现状。
 *
 * ## 运行（一次性库；缺变量当场抛，绝不静默落到日常开发库）
 *
 *   bash scripts/dev-disposable-db.sh ailearn_agent42_cards_20261004
 *   cd workers/ai-worker && \
 *     DATABASE_URL_MIGRATOR='postgres://…@127.0.0.1:5432/ailearn_agent42_cards_20261004' \
 *     DATABASE_URL_API='postgres://ailearn_api:…@127.0.0.1:5432/ailearn_agent42_cards_20261004' \
 *     DATABASE_URL_WORKER='postgres://ailearn_worker:…@127.0.0.1:5432/ailearn_agent42_cards_20261004' \
 *     NODE_ENV=test \
 *     node --import tsx --test --test-concurrency=1 \
 *       src/integration-tests/agent-growth-postgres.integration.ts
 *
 * 测试文件登记由主会话收口（package.json / CI 不在本包改动范围内）。
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import type { AgentSqlExecutor } from "@ailearn/agent-host";
import type { ApiTransaction } from "../../../../apps/api/src/db/client.ts";
import type { WorkerTransaction } from "../db.ts";

// ── 连接串：必须在这两个动态 import **之前**落定 ──────────────────────────
// apps/api/src/db/client.ts 与 workers/ai-worker/src/db.ts 都在模块加载时读环境变量。
process.env.DATABASE_URL_API = testDatabaseUrl("DATABASE_URL_API");
process.env.DATABASE_URL_WORKER = testDatabaseUrl("DATABASE_URL_WORKER");

/** 夹具专用超户。写 users/workspaces/members 只走它——被测路径一律用受限角色。 */
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });

const { withWorkspaceTransaction, closeDatabase: closeApiDatabase } =
  await import("../../../../apps/api/src/db/client.ts");
const { withWorkerWorkspaceTransaction, closeDatabase: closeWorkerDatabase } =
  await import("../db.ts");
const memoryService = await import(
  "../../../../apps/api/src/modules/companion-conversation/memory/memory-service.ts"
);
const {
  upsertMemory, confirmMemory, correctMemory,
  deleteMemory, dismissMemory, archiveMemory, eraseMemory,
} = memoryService;
const { upsertPlaybook, readPlaybookById, retrievePlaybookCatalog } =
  await import("../handlers/companion-playbooks.ts");
const { runCompanionMemoryOrganize } =
  await import("../handlers/companion-memory-organize.ts");
const { loadAgentLearningContext } =
  await import("../agent/learning-context.ts");
const { createAgentMethodStore, readAgentMethod, listAgentMethods, upsertAgentMethodCandidate } =
  await import("@ailearn/agent-host");

/** `upsertMemory` 的真实返回形状——夹具直接用它，不在测试里另写一个形状。 */
type StatedMemory = NonNullable<Awaited<ReturnType<typeof upsertMemory>>>;
/** `upsertMemory` 的入参：只透出夹具要用的那几个键，其余交给 service 自己判。 */
type StatedInput = Parameters<typeof upsertMemory>[2];
type PlaybookInput = Parameters<typeof upsertPlaybook>[2];

/**
 * 0374 起，一条方法的证据要钉住来源的那一版（`memoryRevision`）——
 * 只写 `memoryId` 的来源对 `ailearn_agent_method_sources_current` 是不完整的。
 *
 * `companion-playbooks.ts` 里的证据类型目前仍只有 memoryId / eventId / note，
 * 所以这处 cast 集中在**一个地方**；主会话把该类型跟上之后删掉它即可。
 * 这里放宽的是**类型**，不是判据：断言仍然要求钉住版本的方法才算有效来源。
 */
type MethodEvidence = {
  memoryId?: string; memoryRevision?: number; eventId?: string; note?: string;
};
type MethodInput = Omit<PlaybookInput, "evidence"> & { evidence: MethodEvidence[] };

// ── 作用域与调用捷径 ──────────────────────────────────────────────────────
interface Scope { workspaceId: string; userId: string }

/** API 侧领域 service 的真实事务。 */
const inApi = <T>(scope: Scope, action: (tx: ApiTransaction) => Promise<T>) =>
  withWorkspaceTransaction(scope, action);

/** worker 侧的真实事务（设置 app.workspace_id / app.user_id，走 RLS 与真实连接池）。 */
const inWorker = <T>(scope: Scope, action: (tx: WorkerTransaction) => Promise<T>) =>
  withWorkerWorkspaceTransaction(scope, action);

/** 一次真实的「Agent 读取学习上下文」——成长是否落地的读数在这里。 */
const readAdopted = (scope: Scope) =>
  inWorker(scope, (tx) => loadAgentLearningContext(tx as AgentSqlExecutor, scope));

/** 一次真实的「手册目录」读取。目录里没有正文，这是 0348 的设计。 */
const readCatalog = (scope: Scope) =>
  inWorker(scope, (tx) => retrievePlaybookCatalog(tx, scope));

const readBody = (scope: Scope, playbookId: string, version: number) =>
  inWorker(scope, (tx) => readPlaybookById(tx, scope, playbookId, version));

/**
 * 真实的手册写入（0374 起它就是 `upsertAgentMethodCandidate`）。
 *
 * 写入口**可以合法地拒收**——来源不完整、来源已失效、或者同 key 那条
 * 已经被用户掌控/停用。夹具里的每一次调用都期望它写进去，所以拒收时
 * 直接抛出并把输入形状带进消息：静默返回一个 `null` 会让后续断言
 * 变成在一条根本没写进去的手册上判读。
 */
async function writePlaybook(scope: Scope, input: MethodInput) {
  const written = await inWorker(scope, (tx) => upsertPlaybook(tx, scope, input as PlaybookInput));
  assert.ok(written,
    `手册写入被拒（key=${input.playbookKey}，证据=${JSON.stringify(input.evidence)}）：`
    + "来源必须钉住那一版，且同 key 那条不能是用户已掌控或已停用的方法");
  return written;
}

/** 用户自己说过的一条偏好（`userStated` ⇒ 已确认、非候选、有据）。 */
const stated = (
  scope: Scope,
  content: string,
  extra: Partial<StatedInput> = {},
): Promise<StatedMemory> =>
  inApi(scope, (tx) => upsertMemory(tx, scope, {
    kind: "preference", content, sourceEventId: `evt-${randomUUID()}`,
    userStated: true, candidate: false, ...extra,
  }));

const confirm = (scope: Scope, memoryItemId: string) =>
  inApi(scope, (tx) => confirmMemory(tx, scope, memoryItemId));

// ── 夹具 ─────────────────────────────────────────────────────────────────
interface Fixture {
  userId: string;
  /** 同为 `side` 空间成员的另一个用户：可见性必须只靠 `user_id` 判据成立。 */
  otherUserId: string;
  /** 同一用户的两个空间：手册不按「通用经验」自动跨空间。 */
  home: string;
  side: string;
}

const fixtures: Fixture[] = [];
/** 每个夹具一组自己的邮箱/空间名，避免第二次 `fixture()` 撞 `users_email_idx`。 */
const emailPrefix = 'agent42t';

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
  });
  return created;
}

// ── 只读读数（领域 service 不返回、但断言需要的列） ────────────────────────
/** 记忆在行上的真实状态：revision 由 DB 的 BEFORE UPDATE 触发器推进。 */
const memoryState = async (id: string) => {
  const rows = await admin`
    SELECT revision, deleted_at, dismissed_at, archived_at, epistemic_status,
           purge_after, source_event_id
      FROM assistant_memory_items WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return {
    revision: Number(row.revision),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at as string),
    dismissedAt: row.dismissed_at === null ? null : new Date(row.dismissed_at as string),
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at as string),
    epistemicStatus: String(row.epistemic_status),
    purgeAfter: row.purge_after === null ? null : new Date(row.purge_after as string),
    sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
  };
};

/** 手册在行上的真实状态。RLS 下 admin 才是超户，所以这里读得到全貌。 */
const playbookState = async (id: string) => {
  const rows = await admin`
    SELECT workspace_id, user_id, playbook_key, version, epistemic_status,
           author, evidence, jsonb_typeof(evidence) AS evidence_type,
           jsonb_array_length(evidence) AS evidence_len, updated_at
      FROM companion_procedural_playbooks WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return null;
  return {
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    playbookKey: String(row.playbook_key),
    version: Number(row.version),
    epistemicStatus: String(row.epistemic_status),
    author: String(row.author),
    evidence: row.evidence,
    evidenceType: String(row.evidence_type),
    evidenceLength: Number(row.evidence_len),
    updatedAt: new Date(row.updated_at as string),
  };
};

const adoptedContents = (context: Awaited<ReturnType<typeof readAdopted>>) =>
  context.preferences.map(preference => preference.content);

after(async () => {
  try {
    for (const created of fixtures) {
      for (const workspaceId of [created.home, created.side]) {
        await admin`DELETE FROM companion_procedural_playbooks WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM assistant_memory_embeddings WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM assistant_memory_items WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
        await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
      }
      // user_id 上有 ON DELETE CASCADE：手册、修订、抑制墓碑、组织状态都跟着走。
      await admin`DELETE FROM users WHERE id IN (${created.userId}, ${created.otherUserId})`;
    }
    const [left] = await admin`SELECT count(*)::int AS n FROM users WHERE email LIKE ${`${emailPrefix}-%@test.invalid`}`;
    assert.equal(Number(left.n), 0, "夹具用户没清干净");
  } finally {
    await admin.end({ timeout: 2 });
    await closeApiDatabase();
    await closeWorkerDatabase();
  }
});

// ═════════════════════════════════════════════════════════════════════════
// 一、纠正 / 删除 / 停用之后，引用它的手册必须失效（§6.9、GT-08）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 造出「一条被确认的偏好 + 一条以它为证据的手册」这个最小真实组合。
 *
 * 手册必须**有据**（`supported`）才有判据意义：一份 `tentative` 的手册就算证据
 * 塌了也没从「有据」变成「没据」，断言会假通过。
 *
 * 证据必须钉住来源那一版（0374 起的写入要求）——所以这里读一次行上的
 * `revision` 再写进去。写入口拒收时 `writePlaybook` 直接抛出，不会留下
 * 「没写进去却继续往下断言」的假绿路径。
 */
async function playbookBackedBy(
  scope: Scope,
  content: string,
  options: { key: string; title?: string; extraEvidence?: string[] } ,
): Promise<{ memoryId: string; playbookId: string; version: number }> {
  const memory = await stated(scope, content);
  await confirm(scope, memory.memoryItemId);
  const pinned = await memoryState(memory.memoryItemId);
  const evidence: MethodEvidence[] = [
    { memoryId: memory.memoryItemId, memoryRevision: pinned!.revision, note: "来自这次明确反馈" },
    ...(options.extraEvidence ?? []).map(memoryId => ({ memoryId, memoryRevision: 1 })),
  ];
  const written = await writePlaybook(scope, {
    playbookKey: options.key,
    title: options.title ?? "讲机制先举例",
    triggerCondition: "讲机制、讲新概念时",
    steps: ["先给一个日常类比", "再给定义"],
    exceptions: ["用户当场要求先推导时以用户为准"],
    evidence,
    epistemicStatus: "supported",
    author: "companion",
  });
  return { memoryId: memory.memoryItemId, playbookId: written.playbookId, version: written.version };
}

test("纠正：用户改了原话，引用它的手册不再自称「有据」", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, playbookId } = await playbookBackedBy(scope, "讲机制先举例。", { key: "preference:讲机制" });

  assert.equal((await playbookState(playbookId))?.epistemicStatus, "supported", "夹具前提：手册本来是有据的");

  const before = await memoryState(memoryId);
  const corrected = await inApi(scope, (tx) => correctMemory(tx, scope, memoryId, {
    content: "讲机制直接给定义，不用举例。",
    expectedRevision: before!.revision,
    reason: "用户明确改口",
  }));
  assert.ok(corrected, "纠正失败");

  const after_ = await playbookState(playbookId);
  assert.notEqual(after_!.epistemicStatus, "supported",
    "记忆已被用户纠正，引用它的手册仍然宣称「有据」（0348 的传播没有生效）");
  assert.equal(after_!.epistemicStatus, "disputed",
    "§4.6.10：证据被纠正的手册应降级为争议（disputed），让目录如实标出「依据已被用户纠正，待核对」");
});

test("删除：进入回收区的手册依据同步失效", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, playbookId } = await playbookBackedBy(scope, "整理论文先列提纲。", { key: "preference:整理论文" });

  const deleted = await inApi(scope, (tx) => deleteMemory(tx, scope, memoryId));
  assert.equal(deleted, true, "删除失败");

  const memory = await memoryState(memoryId);
  assert.ok(memory!.deletedAt, "删除后没有 deleted_at");
  assert.ok(memory!.purgeAfter, "删除后没有 purge_after，它永远进不了现役到期清理");

  const after_ = await playbookState(playbookId);
  assert.equal(after_!.epistemicStatus, "disputed",
    "用户已经删除这条记忆（GT-08「遗忘、删除后有旧整理迟到」），手册仍以它为依据继续自称有据");
});

test("停用·忽略：dismissed 的记忆不能再给手册背书", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, playbookId } = await playbookBackedBy(scope, "整理笔记先放标签。", { key: "preference:整理笔记" });

  const dismissed = await inApi(scope, (tx) => dismissMemory(tx, scope, memoryId));
  assert.ok(dismissed, "停用失败");
  assert.ok((await memoryState(memoryId))!.dismissedAt, "行上没有 dismissed_at");

  const after_ = await playbookState(playbookId);
  assert.equal(after_!.epistemicStatus, "disputed",
    "用户已经忽略这条记忆，它派生出的手册不该继续被当作有据的经验");
});

test("停用·归档：archived 的记忆同样不能继续给手册背书", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, playbookId } = await playbookBackedBy(scope, "复习安排放早上。", { key: "preference:复习安排" });

  const archived = await inApi(scope, (tx) => archiveMemory(tx, scope, memoryId));
  assert.ok(archived, "归档失败");
  assert.ok((await memoryState(memoryId))!.archivedAt, "行上没有 archived_at");

  const after_ = await playbookState(playbookId);
  assert.equal(after_!.epistemicStatus, "disputed",
    "用户已经归档这条记忆，引用它的手册仍应降级为争议");
});

/**
 * 彻底清除（=「彻底忘掉」）走的是**物理删除**，与 0345 的回收区到期清扫同形。
 *
 * 现场实测（2026-10-04，`ailearn_api` 角色，隔离库与日常库结论一致）：
 * 这一条今天**在到达手册判据之前就断了**——0336
 * `REVOKE UPDATE, DELETE, TRUNCATE ON assistant_memory_item_revisions FROM ailearn_api, ailearn_worker`
 * （apps/api/src/db/migrations/0336_assistant_memory_revisions.sql:120）撤掉了
 * `eraseMemory`（memory-service.ts:731）第一步要用的 DELETE。
 * 因此这里保留原始报错，不把它改写成一条能过的断言。
 *
 * 即便这一条修好，0348 的传播触发器只挂在 `AFTER UPDATE` 上，硬删除同样不会让它失效。
 */
test("彻底清除：硬删除同样要让手册失效（回收区到期清扫走的是同一条路径）", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, playbookId } = await playbookBackedBy(scope, "读书先看目录。", { key: "preference:读书" });

  const erased = await inApi(scope, (tx) => eraseMemory(tx, scope, memoryId));
  assert.equal(erased, true, "彻底清除失败");
  assert.equal(await memoryState(memoryId), null, "行还在");

  const after_ = await playbookState(playbookId);
  assert.equal(after_!.epistemicStatus, "disputed",
    "证据记忆已经被物理删除（0345 到期清扫与 eraseMemory 同形），手册仍以它为依据");
});

// ═════════════════════════════════════════════════════════════════════════
// 二、数组证据匹配（0348 传播触发器的判据本身）
// ═════════════════════════════════════════════════════════════════════════

test("数组证据：手册存的是 jsonb 数组，且纠正其中任一条都会让整本手册失效", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };

  const first = await pinnedSource(scope, "讲机制先举例。");
  const second = await pinnedSource(scope, "讲机制时先给反例。");

  const written = await writePlaybook(scope, {
    playbookKey: "preference:讲机制两条",
    title: "讲机制的两条经验",
    triggerCondition: "讲机制、讲新概念时",
    steps: ["先给一个日常类比", "先给一个反例"],
    exceptions: [],
    evidence: [
      { memoryId: first.memoryId, memoryRevision: first.revision, note: "第一次反馈" },
      { memoryId: second.memoryId, memoryRevision: second.revision, note: "第二次反馈" },
    ],
    epistemicStatus: "supported",
    author: "companion",
  });

  // 写端形状：真实 service 写进去的必须是**对象数组**，不是被当成字符串的 JSON。
  const stored = await playbookState(written.playbookId);
  assert.equal(stored!.evidenceType, "array",
    "手册的 evidence 存成了非数组：0348 的三个 CHECK（steps/exceptions/evidence）都要求 jsonb array");
  assert.equal(stored!.evidenceLength, 2, "两条证据没有都写进去");
  assert.ok(Array.isArray(stored!.evidence)
    && stored!.evidence.every(entry => typeof entry === "object" && entry !== null
      && typeof (entry as { memoryId?: unknown }).memoryId === "string"),
  "证据数组的元素形状不是 { memoryId: <uuid 文本> }——这正是 0348 传播触发器的匹配面");

  // 读端形状：正文读回来仍是结构化的数组。
  // 读正文必须先走真实 confirm —— 未确认的方法本来就读不到正文（这本身是对的），
  // 拿 candidate 的版本去读只会读到 null，测不出证据数组本身。
  const adopted = await apiMethodStore.control(scope, written.playbookId, {
    expectedRevision: written.version, action: "confirm", reason: "用户确认采用这个方法。",
  });
  const body = await readBody(scope, written.playbookId, adopted.revision);
  assert.ok(body, "已确认且来源精确的方法读不到正文");
  assert.equal(body!.evidence.length, 2, "按 id 读正文时证据只剩一条或丢了");

  // 判据本体：改的是**第二条**证据。数组里的任一条塌了，整本手册的依据就不再成立。
  const target = await memoryState(second.memoryId);
  await inApi(scope, (tx) => correctMemory(tx, scope, second.memoryId, {
    content: "讲机制不用先给反例。",
    expectedRevision: target!.revision,
  }));

  const after_ = await playbookState(written.playbookId);
  assert.equal(after_!.epistemicStatus, "disputed",
    "改的是证据数组里的第二条，手册却没失效：传播触发器对 jsonb 数组的匹配判据没生效");
});

test("数组证据·对照：不引用这条记忆的手册不能被误伤", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };

  const victim = await pinnedSource(scope, "讲机制先举例。");
  const bystander = await pinnedSource(scope, "整理论文先列提纲。");

  const tied = await writePlaybook(scope, {
    playbookKey: "preference:只挂一条",
    title: "只挂一条证据",
    triggerCondition: "讲机制时",
    steps: ["先举例"], exceptions: [],
    evidence: [{ memoryId: victim.memoryId, memoryRevision: victim.revision }],
    epistemicStatus: "supported", author: "companion",
  });
  const untouched = await writePlaybook(scope, {
    playbookKey: "preference:挂的是另一条",
    title: "挂的是另一条证据",
    triggerCondition: "整理论文时",
    steps: ["先列提纲"], exceptions: [],
    evidence: [{ memoryId: bystander.memoryId, memoryRevision: bystander.revision }],
    epistemicStatus: "supported", author: "companion",
  });

  const target = await memoryState(victim.memoryId);
  await inApi(scope, (tx) => correctMemory(tx, scope, victim.memoryId, {
    content: "讲机制直接给定义。",
    expectedRevision: target!.revision,
  }));

  assert.equal((await playbookState(untouched.playbookId))!.epistemicStatus, "supported",
    "一条与被纠正记忆无关的手册被连带降级：传播判据比的是记忆 id，不是「这个用户改过偏好」");
  assert.notEqual((await playbookState(tied.playbookId))!.epistemicStatus, "supported",
    "直接引用这条记忆的手册没有失效");
});

// ─────────────────────────────────────────────────────────────────────────
// 三、四（旧目录/正文路径上的「旧版本拒绝」与「跨用户/空间隔离」）
//
// 0374 之后 `companion-playbooks.ts` 已经是 `@ailearn/agent-host` 的薄适配层：
// `retrievePlaybookCatalog` = `listAgentMethods(tx, scope, true)`，
// `readPlaybookById` = `readAgentMethod(...)`。同 key 升版、按 (user, workspace)
// 隔离、按版本拒绝这三件事因此现在只在**新合同那条读路径**上成立，
// 已由第七节的「旧版本拒绝：新合同上读正文与修订都拒绝旧 revision」、
// 「隔离：新合同的方法列表与按 id 读取同样按 user + workspace 判」
// 两条用例覆盖。这里不再保留一份走旧形状的重复断言——
// 两套断言同源不同形状时，先坏的一定是没人再跑的那套。
// ─────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════
// 五、迟到的一轮整理不能复活被撤回的经验（GT-08）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 跨过整理闸的时间：最早待处理躺满 30 天时可以做一次**有界小批**整理
 * （§4.6.3 第三句）。用真实 `now` 参数推进，不改闸的判据、不塞假状态。
 *
 * 现场实测（2026-10-04）：整理这一轮今天在**事务第二条语句**就整轮回滚——
 * `companion-memory-organize.ts:352` 把字符串直接塞进只收 bigint 的
 * `pg_advisory_xact_lock`，缺了同仓其它调用点都有的 `hashtextextended(…, 0)`
 * （对比 memory-service.ts:49、companion-memory-extractor.ts:719）。
 * 下面三条整理用例因此今天全部停在同一条真实报错上；判据本身保留原样，
 * 修好锁之后它们才继续往下走。
 */
const ORGANIZE_NOW = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);

test("整理这一轮真的跑得起来（迟到整理成立的前提）", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const memory = await stated(scope, "讲机制先举例。", { appliesWhen: "讲机制时" });
  await confirm(scope, memory.memoryItemId);

  const outcome = await runCompanionMemoryOrganize({
    workspaceId: scope.workspaceId, userId: scope.userId, now: ORGANIZE_NOW,
  });
  assert.equal(outcome.ran, true,
    `整理这一轮没跑起来（reason=${outcome.reason}）。后台整理一次都没落地，`
    + "那么「迟到整理不能复活被撤回经验」也就无从验证——这本身就是被守的行为");
  assert.equal(outcome.committed, true, "这一轮处置落地了但提交位没推进，下一轮会重复整理");
});

test("迟到整理：用户删除之后，先前起头的那一轮不能把这条经验带回来", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const memory = await stated(scope, "整理论文先列提纲。", { appliesWhen: "整理论文时" });
  await confirm(scope, memory.memoryItemId);
  assert.ok(adoptedContents(await readAdopted(scope)).length >= 1, "夹具前提：这条偏好本来就被采用");

  // 用户删除。
  const deleted = await inApi(scope, (tx) => deleteMemory(tx, scope, memory.memoryItemId));
  assert.equal(deleted, true, "删除失败");
  assert.ok((await memoryState(memory.memoryItemId))!.deletedAt, "夹具前提失败：删除没落到行上");

  // Keep real pending work so this cycle exercises organization rather than its empty gate.
  const remaining = await stated(scope, "解释公式要说清单位。", { appliesWhen: "解释公式时" });
  await confirm(scope, remaining.memoryItemId);
  // The delayed cycle re-reads current rows; it must exclude the withdrawn source.
  const outcome = await runCompanionMemoryOrganize({
    workspaceId: scope.workspaceId, userId: scope.userId, now: ORGANIZE_NOW,
  });
  assert.equal(outcome.ran, true, `迟到这一轮没跑起来（reason=${outcome.reason}）`);

  // 复活的三条判据：记忆仍是删除态、采用列表里没有它、手册目录里没有以它为证据的新条目。
  assert.ok((await memoryState(memory.memoryItemId))!.deletedAt,
    "迟到的整理把用户已经删除的记忆改回来了");
  assert.equal((await adoptedContents(await readAdopted(scope))).includes("整理论文先列提纲。"), false,
    "迟到的整理让已删除的经验重新进入下一次采用列表");
  for (const id of [outcome.movedIds, outcome.removedIds, outcome.mergedIds].flat()) {
    assert.notEqual(id, memory.memoryItemId, "迟到的整理处置了用户已经撤回的那一条");
  }

  const catalog = await readCatalog(scope);
  const evidenceMemoryIds = await Promise.all(catalog.map(async entry => {
    const body = await readBody(scope, entry.playbookId, entry.version);
    return (body?.evidence ?? []).map(item => String(item.memoryId ?? ""));
  }));
  assert.equal(evidenceMemoryIds.flat().includes(memory.memoryItemId), false,
    "迟到的整理写出了一本以用户已撤回经验为证据的手册");
});

test("迟到整理：不能把已被标记争议的手册重置回「暂定」", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, playbookId, version } = await playbookBackedBy(scope, "读书先看目录。", { key: "preference:读书" });

  // 先按 0348 的传播把依据判为争议。
  // 今天这条前置就走不下去（触发器的数组匹配判据恒假），所以本条停在
  // 「手册还没有因证据被纠正而降级」，还没走到迟到整理那一步——两处都要修。
  const target = await memoryState(memoryId);
  await inApi(scope, (tx) => correctMemory(tx, scope, memoryId, {
    content: "读书直接读正文。", expectedRevision: target!.revision,
  }));
  const disputed = await playbookState(playbookId);
  assert.equal(disputed!.epistemicStatus, "disputed",
    "前置：手册还没有因证据被纠正而降级，后续断言无从谈起");

  // 迟到的一轮整理命中同一个 key。
  const outcome = await runCompanionMemoryOrganize({
    workspaceId: scope.workspaceId, userId: scope.userId, now: ORGANIZE_NOW,
  });
  assert.equal(outcome.ran, true, `迟到这一轮没跑起来（reason=${outcome.reason}）`);

  const after_ = await playbookState(playbookId);
  assert.ok(after_, "迟到的整理把这本手册整行删掉了——手册是不可静默消失的派生产物");
  assert.equal(after_.epistemicStatus, "disputed",
    "迟到的整理把已经因用户纠正而争议的手册重写回 tentative/有据："
    + "后台提交不能复活被抑制的经验（GT-08）");
  assert.ok(after_.version >= version, "版本必须单调前进，不能被后台改回去");
});

// ═════════════════════════════════════════════════════════════════════════
// 六、当前例外不改长期偏好（GT-02）
// ═════════════════════════════════════════════════════════════════════════

test("长期规则 + 当前例外：例外不覆盖长期规则，只有明确的长期修订才改它", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };

  // 1. 明确长期要求 → 采用。
  const rule = await stated(scope, "讲机制先举例。");
  await confirm(scope, rule.memoryItemId);
  const adoptedRule = (await readAdopted(scope)).preferences;
  assert.equal(adoptedRule.length, 1, "已确认的长期规则没有被采用");
  assert.equal(adoptedRule[0].memoryId, rule.memoryItemId);
  assert.equal(adoptedRule[0].appliesWhen, null, "全局规则不该带适用条件");

  const baseline = await memoryState(rule.memoryItemId);

  // 2. 当前例外：「这次数学先推导」。它落在候选里——候选不是长期偏好，
  //    §6.8.2「一次收起、删除、短回应或沉默不升为稳定偏好」是同一条纪律。
  const exception = await inApi(scope, (tx) => upsertMemory(tx, scope, {
    kind: "preference", content: "这次数学先推导。",
    sourceEventId: `evt-${randomUUID()}`, userStated: true, candidate: true,
  }));

  const withException = await readAdopted(scope);
  assert.deepEqual(adoptedContents(withException), ["讲机制先举例。"],
    "一次性的当前例外被当成了长期偏好采用——§6.8：当前例外不覆盖长期规则");
  assert.equal((await readAdopted(scope)).preferences[0].memoryId, rule.memoryItemId);

  const ruleAfterException = await memoryState(rule.memoryItemId);
  assert.equal(ruleAfterException!.revision, baseline!.revision,
    "当前例外动了长期规则的 revision");
  assert.equal(ruleAfterException!.epistemicStatus, baseline!.epistemicStatus,
    "当前例外改了长期规则的认识状态");
  assert.ok(!(await adoptedContents(withException)).includes("这次数学先推导。"),
    "候选进了采用列表");

  // 3. 下一个场景：长期规则仍然生效。
  assert.deepEqual(adoptedContents(await readAdopted(scope)), ["讲机制先举例。"],
    "一次例外之后长期规则不再被采用");

  // 4. 明确说了长期修订（"以后数学都先推导"）→ 这才按适用范围修订长期规则。
  const revised = await inApi(scope, (tx) => correctMemory(tx, scope, rule.memoryItemId, {
    content: "讲机制先举例；数学先推导。",
    expectedRevision: ruleAfterException!.revision,
    appliesWhen: "讲机制与数学讲解时",
  }));
  assert.ok(revised, "长期修订失败");
  const revisedState = await memoryState(rule.memoryItemId);
  assert.equal(revisedState!.revision, ruleAfterException!.revision + 1,
    "长期修订没有推进 revision");

  const afterRevision = (await readAdopted(scope)).preferences;
  const revisedPref = afterRevision.find(preference => preference.memoryId === rule.memoryItemId);
  assert.ok(revisedPref, "修订之后这条规则反而不被采用了");
  assert.equal(revisedPref!.appliesWhen, "讲机制与数学讲解时",
    "长期修订没有带上修订后的适用范围——下一次的例外与修订就分不开了");
  assert.equal(revisedPref!.revision, revisedState!.revision,
    "采用列表给的是旧 revision");

  // 5. 候选仍然只是候选：没有因为长期规则被修订就自动变成长期偏好。
  assert.equal(adoptedContents(await readAdopted(scope)).includes("这次数学先推导。"), false,
    "候选被自动提升成了长期偏好");
  assert.ok(exception.memoryItemId, "夹具前提：当前例外应当是一条独立的记忆");
});

// ═════════════════════════════════════════════════════════════════════════
// 七、主会话新增的成长/方法合同（0374 + @ailearn/agent-host methods.ts）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 0374 给 §6.8 明列的字段补上了两个落点：
 * `method_state`（candidate / active / disabled / disputed）是「有效状态」，
 * `companion_method_uses` 是「实际使用关联」，`change_reason` 是可读的修订理由。
 *
 * **进目录与读正文的条件是三个一起成立**：方法 `active`（走过真实
 * `control('confirm')`）**且** 来源精确版本仍然有效
 * （`ailearn_agent_method_sources_current`）**且** 引用的能力版本没有变。
 * §6.9：「能力发生版本变化、不可用或出现反证时核对适用性，必要时停用」。
 *
 * 因此这里**不做「先写一条 tentative 方法、再放宽有效性断言」**：
 * 每条方法都走真实的 `upsertAgentMethodCandidate` → `control('confirm')`
 * 生命周期，来源里必须钉住 `memoryRevision`。写夹具、读目录、读正文、
 * 咨询记账、停用、修订全部用**现役 service**，测试内不复制领域 SQL。
 */
const methodStore = createAgentMethodStore({
  id: () => randomUUID(),
  transaction: (scope, action) => inWorker(scope, tx => action(tx as AgentSqlExecutor)),
});

/**
 * **用户侧**的方法存储：走 API 角色（`ailearn_api`）的真实事务。
 *
 * 区别不是形式：0374 刻意把 `companion_method_uses` 的 UPDATE 只授给
 * `ailearn_api`（"反馈是用户动作，不是模型动作"），worker 只有 SELECT/INSERT。
 * 所以"确认 / 修订 / 停用 / 反馈"这些**用户控制**必须用这个 store 测；
 * 用 worker store 去测反馈，得到的是授权撤销而不是产品行为。
 */
const apiMethodStore = createAgentMethodStore({
  id: () => randomUUID(),
  transaction: (scope, action) => withWorkspaceTransaction(scope, tx => action(tx as ApiTransaction as AgentSqlExecutor)),
});

/** 「可用目录」= 只含 active 且来源仍然有效的那一批。走真实读路径，不自己拼 SQL。 */
const availableMethods = (scope: Scope) =>
  inWorker(scope, (tx) => listAgentMethods(tx as AgentSqlExecutor, scope, true));

/** 走真实写入口立一条方法候选（写完是 candidate，用户还没采用）。 */
const proposeMethod = (scope: Scope, input: Parameters<typeof upsertAgentMethodCandidate>[2]) =>
  inWorker(scope, (tx) => upsertAgentMethodCandidate(tx as AgentSqlExecutor, scope, input));

/** 一条已确认、并钉住来源版本的记忆；返回它的 id 与当前 revision。 */
async function pinnedSource(scope: Scope, content: string): Promise<{ memoryId: string; revision: number }> {
  const memory = await stated(scope, content);
  await confirm(scope, memory.memoryItemId);
  const state = await memoryState(memory.memoryItemId);
  return { memoryId: memory.memoryItemId, revision: state!.revision };
}

/** 真实 propose 出来的候选方法。返回 null 就是写入口自己拒绝了这批依据。 */
async function candidateMethod(
  scope: Scope,
  options: { key: string; title: string; appliesWhen: string; content?: string },
): Promise<{ memoryId: string; methodId: string; revision: number }> {
  const source = await pinnedSource(scope, options.content ?? `${options.appliesWhen}先举例。`);
  const written = await proposeMethod(scope, {
    playbookKey: options.key, title: options.title, triggerCondition: options.appliesWhen,
    steps: ["先给一个日常类比", "再给定义"],
    exceptions: ["用户当场提出相反的说法时，以用户为准"],
    // 来源必须钉住那一版：只写 memoryId 的来源对有效性判据是不完整的。
    evidence: [{ memoryId: source.memoryId, memoryRevision: source.revision }],
    epistemicStatus: "tentative", author: "maintenance",
  });
  assert.ok(written, "写入口拒绝了一条来源完整、版本对齐的方法依据");
  return { memoryId: source.memoryId, methodId: written.playbookId, revision: written.version };
}

/** 走过真实 `control('confirm')`，让它成为 active。 */
const adopt = (scope: Scope, methodId: string, revision: number) =>
  apiMethodStore.control(scope, methodId, {
    expectedRevision: revision, action: "confirm", reason: "用户确认采用这个方法。",
  });

test("方法生命周期：candidate 必须经用户确认才 active；未确认的不进目录也读不到正文", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { methodId, revision } = await candidateMethod(scope, {
    key: "agent:讲机制", title: "讲机制先举例", appliesWhen: "讲机制时",
  });

  const listed = await methodStore.list(scope);
  const candidate = listed.items.find(item => item.methodId === methodId);
  assert.ok(candidate, "刚整理出的方法连列表都读不到");
  assert.equal(candidate.state, "candidate", "刚整理出的方法不该已经是 active");
  assert.notEqual(candidate.availability, "available",
    "未经用户确认的方法就自称可用：一次反馈不该直接升为稳定经验（§6.8.2）");
  assert.equal((await availableMethods(scope)).some(item => item.methodId === methodId), false,
    "确认之前它就出现在可用目录里了");
  assert.equal(
    await inWorker(scope, (tx) => readAgentMethod(tx as AgentSqlExecutor, scope, methodId, revision)), null,
    "确认之前就能按当前版本读出正文");

  const adopted = await adopt(scope, methodId, revision);
  assert.equal(adopted.state, "active", "用户确认之后没有变成 active");
  assert.equal(adopted.availability, "available", "已确认且来源精确的方法没有被判为可用");
  assert.ok(adopted.revision > revision, "确认没有推进版本");
  assert.equal(adopted.userControlled, true, "用户确认没有把它标成用户可控");
  assert.equal(adopted.changeReason, "用户确认采用这个方法。", "状态变化没有留下可读原因");

  assert.equal((await availableMethods(scope)).some(item => item.methodId === methodId), true,
    "已采用的方法没有进可用目录");

  const body = await methodStore.get(scope, methodId);
  assert.equal(body.revision, adopted.revision);
  assert.deepEqual(body.steps, ["先给一个日常类比", "再给定义"]);
  assert.equal(body.appliesWhen, "讲机制时");
});

test("来源必填：不钉 memoryRevision、钉错版本、或依据已死的证据，写入口一律不落这条方法", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const source = await pinnedSource(scope, "整理论文先列提纲。");

  const shape = (key: string, evidence: MethodEvidence[]) => ({
    playbookKey: key, title: "整理论文先列提纲", triggerCondition: "整理论文时",
    steps: ["先列提纲"], exceptions: [], evidence,
    epistemicStatus: "tentative" as const, author: "maintenance" as const,
  });

  assert.equal(await proposeMethod(scope, shape("agent:只写 id", [
    { memoryId: source.memoryId },
  ])), null,
  "只引用记忆 id、没有钉住那一版的依据被当成可采用的方法落库了");

  assert.equal(await proposeMethod(scope, shape("agent:钉错版本", [
    { memoryId: source.memoryId, memoryRevision: source.revision + 7 },
  ])), null,
  "钉了一个并不存在的来源版本，依据仍然被接受了");

  assert.equal(await proposeMethod(scope, shape("agent:没有来源", [])), null,
  "一条没有任何来源的方法被落库了——它没有任何可核对的依据");

  // 依据本身被删除之后，同一条 key 的迟到整理也不能把它重新立起来。
  const deleted = await inApi(scope, (tx) => deleteMemory(tx, scope, source.memoryId));
  assert.equal(deleted, true, "删除失败");
  assert.equal(await proposeMethod(scope, shape("agent:依据已删", [
    { memoryId: source.memoryId, memoryRevision: source.revision },
  ])), null,
  "用户已经删除的依据，仍被当成有效来源重新立成了一条方法");

  assert.equal((await methodStore.list(scope)).items.length, 0,
    "上面四次被拒的写入仍然在库里留下了方法行");
});

test("GT-07：已采用的方法收到反证（依据被纠正）后停止可用，并保留可读原因", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { memoryId, methodId, revision } = await candidateMethod(scope, {
    key: "agent:讲机制反证", title: "讲机制先举例", appliesWhen: "讲机制时",
  });
  const adopted = await adopt(scope, methodId, revision);
  assert.equal(adopted.availability, "available", "夹具前提：方法本应是可用的");

  // 用户改了原话 ⇒ 记忆 revision 前进，方法钉住的那一版不再是现役版本。
  const target = await memoryState(memoryId);
  await inApi(scope, (tx) => correctMemory(tx, scope, memoryId, {
    content: "讲机制直接给定义，不用举例。",
    expectedRevision: target!.revision,
  }));

  const afterCorrection = await methodStore.get(scope, methodId);
  assert.equal(afterCorrection.availability, "source_changed",
    "依据已经被用户纠正，这条已采用的方法仍然自称可用——GT-07：出现反证时要核对适用性");
  assert.equal((await availableMethods(scope)).some(item => item.methodId === methodId), false,
    "依据已失效的方法仍出现在可用目录里");
  assert.equal(await inWorker(scope, (tx) => readAgentMethod(tx as AgentSqlExecutor, scope, methodId, adopted.revision)), null,
    "按已采用时的 revision 读正文读到了依据已经失效的方法");
  assert.ok(afterCorrection.changeReason && afterCorrection.changeReason.length > 0,
    "失效之后没有留下可读原因，用户无从判断这条方法为什么不再被采用");

  // 反证之后**不能**拿同一条失效依据再确认一次：那等于把已经塌掉的版本复活。
  await assert.rejects(
    () => apiMethodStore.control(scope, methodId, {
      expectedRevision: afterCorrection.revision, action: "confirm", reason: "我还是想这么讲。",
    }),
    (error: { code?: string }) => error.code === "method_source_changed",
    "依据版本已经失效的方法被重新确认成 active——反证之后靠再点一次确认就能复活旧版本",
  );
  assert.equal((await methodStore.get(scope, methodId)).availability, "source_changed",
    "被拒绝的确认仍然把方法改回了可用");
  assert.equal((await availableMethods(scope)).some(item => item.methodId === methodId), false,
    "被拒绝的确认把失效方法放回了可用目录");

  // 正确的下一步是**按当前有效依据形成一条新方法**再确认，而不是覆活旧方法。
  const revisedSource = await memoryState(memoryId);
  const replacement = await proposeMethod(scope, {
    playbookKey: "agent:讲机制反证:第二版",
    title: "讲机制先给定义", triggerCondition: "讲机制时",
    steps: ["先给定义", "再补一个例子"],
    exceptions: [],
    evidence: [{ memoryId, memoryRevision: revisedSource!.revision }],
    epistemicStatus: "tentative", author: "maintenance",
  });
  assert.ok(replacement, "当前有效依据没能形成替代方法");
  assert.notEqual(replacement!.playbookId, methodId,
    "替代方法复用了旧方法的身份：旧方法应保持争议可查，不是被悄悄改写");

  const replacementAdopted = await apiMethodStore.control(scope, replacement!.playbookId, {
    expectedRevision: replacement!.version, action: "confirm", reason: "改按新版本讲。",
  });
  assert.equal(replacementAdopted.state, "active");
  assert.equal(replacementAdopted.availability, "available");

  // 旧方法仍然是争议且不可用；新方法可用。两者同时成立才是"替代"而不是"复活"。
  assert.equal((await methodStore.get(scope, methodId)).availability, "source_changed",
    "旧方法被新方法顶回了可用状态");
  const availableNow = await availableMethods(scope);
  assert.equal(availableNow.some(item => item.methodId === methodId), false,
    "旧方法仍出现在可用目录里");
  assert.equal(availableNow.some(item => item.methodId === replacement!.playbookId), true,
    "按当前有效依据形成的新方法没有进可用目录");
});

test("实际使用关联：一次真实咨询被记账，反馈归到同一版方法上，重复咨询不重复计数", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { methodId, revision } = await candidateMethod(scope, {
    key: "agent:使用关联", title: "讲机制先举例", appliesWhen: "讲机制时",
  });
  const adopted = await adopt(scope, methodId, revision);

  const contextId = randomUUID();
  const consultation = { kind: "agent_goal" as const, id: contextId, revision: 1, sourceKey: "goal-note-42" };
  const consulted = await inWorker(scope, (tx) =>
    readAgentMethod(tx as AgentSqlExecutor, scope, methodId, adopted.revision, consultation));
  assert.ok(consulted, "已采用的方法按当前版本读不到正文");
  assert.equal(consulted!.revision, adopted.revision, "咨询记到了方法别的版本上");

  assert.equal((await methodStore.get(scope, methodId)).consultedCount, 1,
    "这次真实使用没有进入「实际使用关联」");

  const uses = await methodStore.uses(scope, methodId);
  assert.equal(uses.items.length, 1, "使用记录读不出来");
  const use = uses.items[0];
  assert.equal(use.methodRevision, adopted.revision);
  assert.equal(use.contextKind, "agent_goal");
  assert.equal(use.contextId, contextId);
  assert.equal(use.contextRevision, 1);
  assert.equal(use.feedback, null, "刚记下的使用就已经带着反馈了");

  // 同一 (方法, 版本, sourceKey) 重复咨询不重复记账——它是"这次用了"，不是点击计数。
  await inWorker(scope, (tx) =>
    readAgentMethod(tx as AgentSqlExecutor, scope, methodId, adopted.revision, consultation));
  assert.equal((await methodStore.get(scope, methodId)).consultedCount, 1, "同一次咨询被重复计数了");
  assert.equal((await methodStore.uses(scope, methodId)).items.length, 1);

  // 反馈是**用户动作**：它必须走 API 角色。worker 角色对
  // companion_method_uses 只有 SELECT/INSERT（0374 有意撤销了 UPDATE），
  // 所以这里先证明 worker 写不进去——那是刻意的分工，不是缺陷。
  // drizzle 把 PG 的原始错误挂在 `cause` 上（顶层 `code` 是 undefined、message 只剩
  // "Failed query: …"），所以这里认 `cause.code` / `cause.message`。
  await assert.rejects(
    () => methodStore.feedback(scope, use.useId, { feedback: "helpful" }),
    (error: { code?: string; message?: string; cause?: { code?: string; message?: string } }) => {
      const cause = error.cause;
      return error.code === "42501" || cause?.code === "42501"
        || /permission denied/i.test(`${error.message ?? ""} ${cause?.message ?? ""}`);
    },
    "worker 角色写下了方法使用反馈——反馈是用户的判断，模型不该能自己打分",
  );
  assert.equal((await methodStore.uses(scope, methodId)).items[0].feedback, null,
    "worker 那次被拒的写入仍然改动了反馈字段");

  const rated = await apiMethodStore.feedback(scope, use.useId, {
    feedback: "helpful", comment: "照着做省了一步确认。",
  });
  assert.equal(rated.feedback, "helpful");
  assert.ok(rated.feedbackAt, "反馈没有落时间");
  assert.equal(rated.methodRevision, adopted.revision, "反馈记到了方法别的版本上");

  // 反馈是追加的，不覆盖"这次用了"本身。
  assert.equal(rated.contextId, contextId);

  const counted = await methodStore.get(scope, methodId);
  assert.equal(counted.helpfulCount, 1, "有帮助的反馈没有计入效果读数");
  assert.equal(counted.unhelpfulCount, 0);
  assert.ok(counted.lastConsultedAt, "最近一次咨询没有留下时间");

  // 无用的反馈同样可写，且不与有用的混算。
  const secondUse = (await methodStore.uses(scope, methodId)).items[0];
  assert.ok(secondUse.useId, "使用记录没有稳定 id");
});

test("旧版本拒绝：新合同上读正文与修订都拒绝旧 revision，且旧版仍可回看", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const { methodId, revision } = await candidateMethod(scope, {
    key: "agent:版本", title: "讲机制先举例", appliesWhen: "讲机制时",
  });
  const adopted = await adopt(scope, methodId, revision);

  assert.equal(await inWorker(scope, (tx) => readAgentMethod(tx as AgentSqlExecutor, scope, methodId, adopted.revision + 1)), null,
    "按一个不存在的版本读到了正文");
  assert.equal(await inWorker(scope, (tx) => readAgentMethod(tx as AgentSqlExecutor, scope, methodId, revision)), null,
    "拿着采用之前的版本读到了当前正文：「她读的是哪一版」这个问题就永远答不出来");

  await assert.rejects(
    () => methodStore.revise(scope, methodId, {
      expectedRevision: revision,
      title: "讲机制先举例", appliesWhen: "讲机制时",
      steps: ["先给一个日常类比"], exceptions: [], reason: "用户改写这条方法。",
    }),
    (error: { code?: string }) => error.code === "method_revision_conflict",
    "拿着旧 revision 修订成功了：并发下用户会覆盖掉别人刚刚确认的版本",
  );

  const revised = await methodStore.revise(scope, methodId, {
    expectedRevision: adopted.revision,
    title: "讲机制先举例再给定义", appliesWhen: "讲机制与数学讲解时",
    steps: ["先给一个日常类比", "再给定义"], exceptions: ["数学先推导"], reason: "用户改写这条方法。",
  });
  assert.ok(revised.revision > adopted.revision, "修订没有推进版本");
  assert.equal(revised.appliesWhen, "讲机制与数学讲解时");
  assert.equal(revised.changeReason, "用户改写这条方法。", "修订理由没有被保留下来");
  assert.equal(revised.userControlled, true, "用户改写之后它不再由用户掌控");

  // 旧版仍可回看，但不能当成当前版使用。
  const history = await methodStore.history(scope, methodId);
  assert.ok(history.items.length >= 1, "修订之后读不到上一版");
  assert.ok(history.items.every(item => item.availability === "previous_version"),
    "历史版本没有标成 previous_version");
});

test("用户停用：停用后不进目录、读不到正文，且迟到的整理不能把它顶回来", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const source = await pinnedSource(scope, "复习安排放早上。");
  const { methodId, revision } = await candidateMethod(scope, {
    key: "agent:停用", title: "复习安排放早上", appliesWhen: "复习安排时", content: "复习安排放早上。",
  });
  const adopted = await adopt(scope, methodId, revision);
  assert.ok((await availableMethods(scope)).some(item => item.methodId === methodId),
    "夹具前提：停用之前它应该在可用目录里");

  const disabled = await methodStore.control(scope, methodId, {
    expectedRevision: adopted.revision, action: "disable", reason: "这段时间不想这么安排。",
  });
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.availability, "disabled");
  assert.equal(disabled.changeReason, "这段时间不想这么安排。", "停用没有留下可读原因");
  assert.equal((await availableMethods(scope)).some(item => item.methodId === methodId), false,
    "用户停用的方法仍出现在可用目录里");
  assert.equal(await inWorker(scope, (tx) => readAgentMethod(tx as AgentSqlExecutor, scope, methodId, disabled.revision)), null,
    "已停用的方法仍能按当前版本读出正文");

  // 迟到的整理拿着仍然有效的依据来写同一个 key —— 它不能把用户停用的方法顶回来。
  const late = await proposeMethod(scope, {
    playbookKey: "agent:停用", title: "复习安排放晚上", triggerCondition: "复习安排时",
    steps: ["放到晚上"], exceptions: [],
    evidence: [{ memoryId: source.memoryId, memoryRevision: source.revision }],
    epistemicStatus: "tentative", author: "maintenance",
  });
  assert.equal(late, null, "迟到的整理覆盖了用户已经停用的方法——用户撤回之后它不该被顶回来");
  const afterLate = await methodStore.get(scope, methodId);
  assert.equal(afterLate.state, "disabled", "迟到的整理把方法状态改回去了");
  assert.equal(afterLate.title, "复习安排放早上", "迟到的整理覆盖了用户可见的内容");
});

test("晚到整理不能覆盖用户已经掌控的方法", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const source = await pinnedSource(scope, "读书先看目录。");
  const { methodId, revision } = await candidateMethod(scope, {
    key: "agent:用户掌控", title: "读书先看目录", appliesWhen: "读书时", content: "读书先看目录。",
  });

  // 用户把这条方法改写成自己的版本（revise 会置 user_controlled）。
  const revised = await methodStore.revise(scope, methodId, {
    expectedRevision: revision,
    title: "读书先看目录和序言", appliesWhen: "读书时",
    steps: ["先看目录", "再看序言"], exceptions: [], reason: "我习惯先看序言。",
  });
  assert.equal(revised.userControlled, true, "用户改写之后它不再由用户掌控");

  const late = await proposeMethod(scope, {
    playbookKey: "agent:用户掌控", title: "读书直接读正文", triggerCondition: "读书时",
    steps: ["直接读正文"], exceptions: [],
    evidence: [{ memoryId: source.memoryId, memoryRevision: source.revision }],
    epistemicStatus: "supported", author: "maintenance",
  });
  assert.equal(late, null, "后台整理覆盖了用户自己改写过的方法");

  const afterLate = await methodStore.get(scope, methodId);
  assert.equal(afterLate.title, "读书先看目录和序言", "后台整理覆盖了用户写下的内容");
  assert.deepEqual(afterLate.steps, ["先看目录", "再看序言"], "后台整理覆盖了用户写下的步骤");
  assert.equal(afterLate.changeReason, "我习惯先看序言。", "后台整理覆盖了用户留下的理由");
});

test("隔离：新合同的方法列表与按 id 读取同样按 user + workspace 判", async () => {
  const f = await fixture();
  const mine: Scope = { workspaceId: f.home, userId: f.userId };
  const mineSide: Scope = { workspaceId: f.side, userId: f.userId };
  const other: Scope = { workspaceId: f.side, userId: f.otherUserId };

  const a = await candidateMethod(mine, { key: "agent:同名", title: "我的方法", appliesWhen: "讲机制时" });
  await adopt(mine, a.methodId, a.revision);
  const b = await candidateMethod(mineSide, { key: "agent:同名", title: "我在 side 的方法", appliesWhen: "讲机制时" });
  await adopt(mineSide, b.methodId, b.revision);
  const c = await candidateMethod(other, { key: "agent:同名", title: "别人的方法", appliesWhen: "讲机制时" });
  await adopt(other, c.methodId, c.revision);

  assert.equal(new Set([a.methodId, b.methodId, c.methodId]).size, 3,
    "同一个 key 在不同用户/空间之间没有分开落行");

  const homeItems = (await methodStore.list(mine)).items.map(item => item.methodId);
  const sideItems = (await methodStore.list(mineSide)).items.map(item => item.methodId);
  const otherItems = (await methodStore.list(other)).items.map(item => item.methodId);

  assert.ok(homeItems.includes(a.methodId) && !homeItems.includes(b.methodId),
    "我的方法跨空间串到了另一个空间");
  assert.ok(sideItems.includes(b.methodId) && !sideItems.includes(c.methodId),
    "同空间另一个成员的方法串进来了");
  assert.ok(otherItems.includes(c.methodId) && !otherItems.includes(a.methodId)
    && !otherItems.includes(b.methodId), "别人的列表里出现了我的方法");

  const mineRevision = (await methodStore.get(mine, a.methodId)).revision;
  await assert.rejects(() => methodStore.get(mineSide, a.methodId),
    (error: { code?: string }) => error.code === "method_not_found",
    "按 id 读到了另一个空间的方法");
  await assert.rejects(() => methodStore.get(other, a.methodId),
    (error: { code?: string }) => error.code === "method_not_found",
    "按 id 读到了另一个用户的方法——他还在同一个空间里，判据必须落在 user_id 上");

  assert.equal((await availableMethods(mineSide)).some(item => item.methodId === a.methodId), false,
    "我在 home 的方法出现在了我在 side 的可用目录里");
  assert.equal(
    await inWorker(mine, (tx) => readAgentMethod(tx as AgentSqlExecutor, mine, a.methodId, mineRevision + 1)), null,
    "按一个不存在的版本读到了正文");
});

// ═════════════════════════════════════════════════════════════════════════
// 八、后台维护函数的真库可执行性（0362 字段名回归 + 成长合同授权回归）
// ═════════════════════════════════════════════════════════════════════════

/**
 * 这两条守的是同一类漏法：**只对着 SQL 文本做正则断言，从不在真库上执行**。
 *
 * - 0362 读 `limits.limit_items`，而 0346 的输出列是 `items` / `byte_count`
 *   ⇒ `ailearn_enforce_companion_memory_retention()` 100% 调用必抛，
 *   归档保留上限自那以后从未生效（worker 每小时一条 WARN）。
 * - `ailearn_agent_method_sources_current` 的 EXECUTE 一旦被
 *   `roles.sql` 的 `REVOKE ALL ON ALL FUNCTIONS` 清掉又没被白名单重授，
 *   整个成长合同的读取路径会静默 403。
 *
 * 两者都不是文本能看出来的，必须真跑一次。
 */
test("归档保留上限：worker 角色真跑一次回收区到期清理（0362 输出字段回归）", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const memory = await stated(scope, "归档保留上限回归用的一条记忆。");
  await confirm(scope, memory.memoryItemId);

  // 夹具直写：一条已归档、声明期限已过的行。归档保留上限按
  // `budget_tier='archived' AND deleted_at IS NULL` 统计，第一步先处理
  // `valid_until <= now()` 的那些（0362:66-75）。
  const archived = randomUUID();
  await admin.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
    await tx`INSERT INTO assistant_memory_items
      (id, workspace_id, user_id, kind, content, candidate, scope, revision,
       source_type, user_stated, user_confirmed, budget_tier, valid_until,
       source_event_id, created_at, updated_at)
      VALUES (${archived}, ${scope.workspaceId}, ${scope.userId}, 'preference',
              '已归档且声明期限已过的记忆。', false, 'workspace', 1,
              'user_stated', true, true, 'archived', now() - interval '2 days',
              ${`evt-${randomUUID()}`}, now() - interval '40 days', now() - interval '2 days')`;
  });

  const before = await memoryState(archived);
  assert.ok(before, "归档夹具没写进去");
  assert.equal(before!.archivedAt === null, true, "夹具前提：这条不该已被归档列");

  // 真实调用：与 `companion-memory-maintenance.ts:96` 走的是同一条语句、同一个角色。
  const result = (await inWorker(scope, (tx) => tx.execute(sql`
    SELECT public.ailearn_enforce_companion_memory_retention() AS evicted`))) as unknown;
  const first = Array.isArray(result)
    ? result[0] as { evicted?: unknown }
    : (result as { rows?: { evicted?: unknown }[] } | null)?.rows?.[0];
  assert.ok(Number.isInteger(Number(first?.evicted)),
    `清理没有返回整数（0362 的 record 字段名回归）：${JSON.stringify(result)}`);
  const evicted = Number(first!.evicted);

  // 到期行确实进了回收区，而不是被静默跳过。
  const after_ = await memoryState(archived);
  assert.ok(after_, "归档夹具行不见了");
  assert.ok(after_!.deletedAt,
    "已过声明期限的归档记忆没有被软删——0362 第一步没有真正执行");
  assert.ok(after_!.purgeAfter,
    "软删没有同时写 purge_after，它永远进不了回收区到期清理");
  assert.ok(after_!.purgeAfter!.getTime() > after_!.deletedAt!.getTime(),
    "回收窗口方向不对：purge_after 必须晚于 deleted_at");

  // 同源抑制墓碑：不写它，同一个来源下次抽取会把这条记忆重新记一遍。
  const [tombstone] = await admin`
    SELECT count(*)::int AS n FROM assistant_memory_source_suppressions
     WHERE user_id = ${scope.userId} AND source_event_id = ${before!.sourceEventId}`;
  assert.equal(Number(tombstone.n), 1, "淘汰没有写来源抑制墓碑，同源抽取会把这条记忆重新记一遍");

  assert.ok(evicted >= 1, "清掉了到期行却没有计数回来");
});

test("成长合同授权：来源有效性函数对两个服务角色都必须可执行", async () => {
  // 只断言**应用真的会用 SQL 调**的那个函数。
  // 另外两个是触发器函数（Postgres 在触发时调用它们，不检查调用者的 EXECUTE），
  // 对它们断言"可执行"是在断言产品并不依赖的东西——真正要守的是"触发器在"。
  const rows = await admin`
    SELECT p.proname::text AS name,
           has_function_privilege('ailearn_api', p.oid, 'EXECUTE') AS api_exec,
           has_function_privilege('ailearn_worker', p.oid, 'EXECUTE') AS worker_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ailearn_agent_method_sources_current'`;
  assert.equal(rows.length, 1, "来源有效性函数不存在（0374 未应用？）");
  assert.equal(rows[0].api_exec, true,
    "ailearn_agent_method_sources_current 对 ailearn_api 不可执行："
    + "roles.sql 的 REVOKE ALL ON ALL FUNCTIONS 清掉了迁移里的 GRANT");
  assert.equal(rows[0].worker_exec, true,
    "ailearn_agent_method_sources_current 对 ailearn_worker 不可执行：worker 读手册与方法会直接 403");

  // 触发器本身必须在位，否则上面那条授权对了也没人调用它。
  const triggers = await admin`
    SELECT t.tgname::text AS name,
           t.tgenabled,
           c.relname::text AS on_table
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal
       AND t.tgname IN ('assistant_memory_playbook_evidence_guard',
                        'assistant_memory_playbook_delete_guard',
                        'companion_method_revision_archive')`;
  const byName = new Map(triggers.map(row => [row.name, row]));
  for (const expected of ['assistant_memory_playbook_evidence_guard',
    'assistant_memory_playbook_delete_guard', 'companion_method_revision_archive']) {
    const row = byName.get(expected);
    assert.ok(row, `触发器 ${expected} 不存在（0374 未应用？）`);
    assert.notEqual(row!.tgenabled, 'D', `触发器 ${expected} 被禁用了`);
  }
  assert.equal(byName.get('assistant_memory_playbook_delete_guard')!.on_table,
    'assistant_memory_items', "硬删除触发器没挂在 assistant_memory_items 上");
  assert.equal(byName.get('companion_method_revision_archive')!.on_table,
    'companion_procedural_playbooks', "方法版本归档触发器没挂在手册表上");
});

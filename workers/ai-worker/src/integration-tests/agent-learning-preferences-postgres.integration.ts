/**
 * 已确认合作规则在真实 Postgres 上的生效与撤回（方案 42 阶段 1B 子任务 B）。
 *
 * 走的是**真实链路**：写入与撤回全部用 API 侧既有 memory service 的
 * `upsertMemory / confirmMemory / correctMemory / dismissMemory / archiveMemory /
 * deleteMemory / restoreDeletedMemory`，随后用 worker 作用域读
 * `loadAgentLearningContext`。断言的是「下一次读取看到什么」，不是库里躺着什么。
 *
 * 覆盖：明确确认才采用 → 纠正后下一次读取就是新修订 → 撤回/归档/删除不再采用 →
 * 来源抑制挡住同源自动抽取、但显式恢复仍能放回来 → 过期/未来/争议/已被替代都不采用
 * → 账号级规则沿既有跨空间准入且空间内容不被提升 → 他人不可见。
 *
 * 运行（一次性库；缺变量会当场抛，绝不静默落到开发库。package.json 不在本任务
 * 的改动范围里，所以直接跑这一条）：
 *   cd workers/ai-worker && node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/agent-learning-preferences-postgres.integration.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as query } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentStorePorts } from "@ailearn/agent-host";
import type { ApiTransaction } from "../../../../apps/api/src/db/client.ts";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { loadAgentLearningContext } from "../agent/learning-context.ts";

const tag = randomUUID();
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const workerClient = postgres(testDatabaseUrl("DATABASE_URL_WORKER"), { max: 2 });
// API 侧 service 走 `apps/api/src/db/client.ts` 的全局 db，它读这个变量。
process.env.DATABASE_URL_API ??= testDatabaseUrl("DATABASE_URL_API");

const { withWorkspaceTransaction, closeDatabase } = await import("../../../../apps/api/src/db/client.ts");
const {
  upsertMemory, confirmMemory, correctMemory,
  dismissMemory, archiveMemory, restoreMemory, deleteMemory, restoreDeletedMemory,
  MEMORY_RECYCLE_BIN_DAYS,
} = await import("../../../../apps/api/src/modules/companion-conversation/memory/memory-service.ts");

const workerDb = drizzle(workerClient);
const workerPorts: AgentStorePorts = {
  id: randomUUID,
  transaction: (scope, action) => workerDb.transaction(async tx => {
    await tx.execute(query`SELECT set_config('app.workspace_id',${scope.workspaceId},true),set_config('app.user_id',${scope.userId},true)`);
    return action(tx);
  }),
};

type Scope = { workspaceId: string; userId: string };
const inApi = <T>(scope: Scope, action: (tx: ApiTransaction) => Promise<T>) =>
  withWorkspaceTransaction(scope, action);

/** 一次真实的「Agent 读取学习上下文」。 */
const read = async (scope: Scope) => workerPorts.transaction(scope, tx => loadAgentLearningContext(tx, scope));
const contents = async (scope: Scope) => contentsOf(await read(scope));
const contentsOf = (context: Awaited<ReturnType<typeof read>>) => context.preferences.map(p => p.content);

/** 用户自己说过的一条偏好（`userStated` ⇒ 已确认、非候选、有据）。 */
const stated = (scope: Scope, content: string, sourceEventId?: string) => inApi(scope, tx => upsertMemory(tx, scope, {
  kind: "preference", content, sourceEventId, userStated: true, candidate: false,
}));

interface Fixture { userId: string; otherUserId: string; home: string; side: string }
const fixtures: Fixture[] = [];

/**
 * 一个用户两个空间（`home` / `side`），另有一个用户同为 `side` 的成员——
 * 他人可见性必须只靠 `user_id` 判据成立，而不是靠"他不在这个空间"。
 */
async function fixture(): Promise<Fixture> {
  const created: Fixture = {
    userId: randomUUID(), otherUserId: randomUUID(),
    home: randomUUID(), side: randomUUID(),
  };
  fixtures.push(created);
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES
      (${created.userId},${`agent42b-${created.userId}@test.invalid`},'fixture','owner'),
      (${created.otherUserId},${`agent42b-${created.otherUserId}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES
      (${created.home},${`agent42b-home-${tag}`},${created.userId}),
      (${created.side},${`agent42b-side-${tag}`},${created.userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES
      (${created.home},${created.userId},'owner'),
      (${created.side},${created.userId},'owner'),
      (${created.side},${created.otherUserId},'member')`;
  });
  return created;
}

after(async () => {
  try {
    for (const created of fixtures) {
      for (const workspaceId of [created.home, created.side]) {
        await admin`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
        await admin`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
        await admin`DELETE FROM workspaces WHERE id=${workspaceId}`;
      }
      // user_id 上有 ON DELETE CASCADE：记忆、版本、抑制墓碑、人格都跟着走。
      await admin`DELETE FROM users WHERE id IN (${created.userId}, ${created.otherUserId})`;
    }
    const [left] = await admin`SELECT count(*)::int AS n FROM users WHERE email LIKE ${`agent42b-%@test.invalid`}`;
    assert.equal(Number(left.n), 0, "夹具用户没清干净");
  } finally {
    await workerClient.end({ timeout: 2 });
    await admin.end({ timeout: 2 });
    await closeDatabase();
  }
});

test("确认才采用；纠正后下一次读取就是新修订，旧修订不再采用", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };

  const candidate = await inApi(scope, tx => upsertMemory(tx, scope, {
    kind: "preference", content: "讲新概念时先给一个日常类比。", sourceEventId: `evt-${randomUUID()}`,
  }));
  assert.deepEqual(await contents(scope), [], "尚未确认的候选进了长期偏好");

  const confirmed = await inApi(scope, tx => confirmMemory(tx, scope, candidate.memoryItemId));
  assert.ok(confirmed, "确认失败");
  const adopted = (await read(scope)).preferences;
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].memoryId, candidate.memoryItemId, "采用的是另一个 id");
  assert.equal(adopted[0].revision, confirmed.revision);
  assert.equal(adopted[0].scope, "workspace");
  assert.equal(adopted[0].kind, "preference");
  // 确认只翻 candidate/user_confirmed，不动认识状态——所以 tentative 这一档必须可采用。
  assert.equal(adopted[0].epistemicStatus, "tentative");

  const corrected = await inApi(scope, tx => correctMemory(tx, scope, candidate.memoryItemId, {
    content: "讲新概念时先给一个日常类比，不要直接下定义。", expectedRevision: confirmed.revision,
  }));
  assert.ok(corrected);
  assert.equal(corrected.revision, confirmed.revision + 1, "纠正没有推进修订号");

  const after = (await read(scope)).preferences;
  assert.equal(after.length, 1);
  assert.equal(after[0].revision, corrected.revision, "纠正后读到的还是旧修订");
  assert.match(after[0].content, /不要直接下定义/);

  // 旧修订进了只追加的历史表，且必须**按确切修订号**取得到。
  // 这里不能写 `ORDER BY revision` 取第一行：`confirmMemory` 改了 user_confirmed，
  // 那一改本身就是一次修订，于是表里最早那行是确认**之前**的版本，不是纠正前的。
  const [snapshot] = await admin`SELECT revision, content FROM assistant_memory_item_revisions
    WHERE memory_id=${candidate.memoryItemId} AND revision=${confirmed.revision}`;
  assert.equal(Number(snapshot?.revision), confirmed.revision,
    `纠正前的版本（修订 ${confirmed.revision}）没有留在历史表里`);
  assert.equal(String(snapshot?.content), candidate.content,
    "历史表里那一版的内容不是纠正前的那一版");
});

test("撤回、归档、删除之后不再采用；抑制挡住同源自动抽取，显式恢复仍能放回来", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const keep = await stated(scope, "这一条始终有效，用作正向对照。");
  const withdrawn = await stated(scope, "用户点过忽略的那一条。");
  const archived = await stated(scope, "用户归档起来的那一条。");
  const forgotten = await stated(scope, "用户彻底删掉的那一条。", `evt-${randomUUID()}`);
  assert.equal((await read(scope)).preferences.length, 4, "前置：四条都先被采用");

  await inApi(scope, tx => dismissMemory(tx, scope, withdrawn.memoryItemId));
  await inApi(scope, tx => archiveMemory(tx, scope, archived.memoryItemId));
  await inApi(scope, tx => deleteMemory(tx, scope, forgotten.memoryItemId));
  assert.deepEqual(await contents(scope), [keep.content], "撤回/归档/删除之后还有别的被采用");

  // 删除写下来源抑制墓碑：同源的自动抽取拿不回来，规则也就不会复活。
  await assert.rejects(
    () => inApi(scope, tx => upsertMemory(tx, scope, {
      kind: "preference", content: "同源又抽出来一次。", sourceEventId: forgotten.sourceEventId ?? undefined,
    })),
    (error: Error) => error.name === "MemorySourceSuppressedError");
  assert.deepEqual(await contents(scope), [keep.content], "抑制之后这条又出现了");

  // 读侧不判抑制：用户自己从回收区把这条放回来是合法动作，不该变成永久消失。
  assert.ok(await inApi(scope, tx => restoreDeletedMemory(tx, scope, forgotten.memoryItemId)));
  assert.ok((await contents(scope)).includes(forgotten.content), "显式恢复的规则没被采用回来");
});

test("过期、未来、争议、已被替代都不采用", async () => {
  const f = await fixture();
  const scope: Scope = { workspaceId: f.home, userId: f.userId };
  const live = await stated(scope, "当下就生效的这一条，用作正向对照。");
  const expired = await stated(scope, "上个月就该失效的那一条。");
  const future = await stated(scope, "下个月才开始的那一条。");
  const disputed = await stated(scope, "还在核对中的那一条。");
  const superseded = await stated(scope, "已经被新说法替代的那一条。");

  // 认识状态与有效期没有对外的写入口，这两段只造夹具；采用与否仍由真实查询判。
  await admin.begin(async tx => {
    await tx`UPDATE assistant_memory_items SET valid_until=now()-interval '1 day' WHERE id=${expired.memoryItemId}`;
    await tx`UPDATE assistant_memory_items SET valid_from=now()+interval '1 day' WHERE id=${future.memoryItemId}`;
    await tx`UPDATE assistant_memory_items SET epistemic_status='disputed' WHERE id=${disputed.memoryItemId}`;
    await tx`UPDATE assistant_memory_items SET epistemic_status='superseded' WHERE id=${superseded.memoryItemId}`;
  });

  assert.deepEqual(await contents(scope), [live.content], "过期/未来/争议/已被替代里至少有一条被采用了");
});

test("账号级规则经真实 API 写入铺开到第二个空间；空间内容不被提升，纠正与撤回同步过去", async () => {
  const f = await fixture();
  const home: Scope = { workspaceId: f.home, userId: f.userId };
  const side: Scope = { workspaceId: f.side, userId: f.userId };
  assert.deepEqual(await contents(side), [], "前置：第二个空间一开始是空的");

  // 空间内规则先写：它留在 home，第二个空间不该因此多出任何东西。
  const local = await stated(home, "只属于这个空间的内容。");
  assert.deepEqual(await contents(side), [], "空间内内容被提升成了账号级");

  // 账号级规则走**真实 API 写入**（upsertMemory 是记忆中心的唯一入口），不手动调
  // fanout 冒充入口：入口本身能不能把行铺过去，正是这一条要验的。
  const account = await inApi(home, tx => upsertMemory(tx, home, {
    kind: "preference", content: "跟人走的账号级偏好。", sourceEventId: `evt-${randomUUID()}`,
    scope: "global", userStated: true, candidate: false,
  }));
  assert.deepEqual(await contents(side), [account.content], "API 写入的账号级规则没有铺到第二个空间");
  const [copy] = (await read(side)).preferences;
  assert.equal(copy.scope, "global");
  assert.notEqual(copy.memoryId, account.memoryItemId, "第二个空间读到的是源行而不是副本");
  assert.notEqual(copy.memoryId, local.memoryItemId);
  assert.ok((await contents(home)).includes(local.content), "正向对照：空间内规则在自己的空间里");

  // 纠正：源行改了，副本跟着改；而且副本的修订号是**它自己**的。
  const corrected = await inApi(home, tx => correctMemory(tx, home, account.memoryItemId, {
    content: "跟人走的账号级偏好，纠正后多一句。", expectedRevision: account.revision,
  }));
  assert.ok(corrected);
  const afterCorrection = (await read(side)).preferences;
  assert.deepEqual(afterCorrection.map(p => p.content), [corrected.content], "纠正没有同步到第二个空间");
  // 若同步把 revision 直接盖成源行的值，副本就会停在 1、且没有任何历史行。
  const copyRow = await admin`SELECT revision FROM assistant_memory_items WHERE id=${copy.memoryId}::uuid`;
  assert.equal(Number(copyRow[0]?.revision), corrected.revision, "副本的修订号没有跟着自己的变更走");
  const [copyHistory] = await admin`SELECT revision FROM assistant_memory_item_revisions
    WHERE memory_id=${copy.memoryId}::uuid`;
  assert.equal(Number(copyHistory?.revision), 1, "副本没有留下自己的修订历史（说明 revision 被源行覆盖了）");

  // 撤回：源行点过忽略，副本跟着不再被采用。
  await inApi(home, tx => dismissMemory(tx, home, account.memoryItemId));
  assert.deepEqual(await contents(side), [], "撤回没有同步到第二个空间");
  assert.deepEqual(await contents(home), [local.content], "撤回之后源空间里也不该再采用它");
});

test("API 写入的账号级候选在第二个空间不被采用；确认后才采用", async () => {
  const f = await fixture();
  const home: Scope = { workspaceId: f.home, userId: f.userId };
  const side: Scope = { workspaceId: f.side, userId: f.userId };

  // 候选（未确认）经真实 API 写入：它要**铺过去**，但铺过去时仍是候选。
  const candidate = await inApi(home, tx => upsertMemory(tx, home, {
    kind: "preference", content: "账号级的候选偏好。", sourceEventId: `evt-${randomUUID()}`, scope: "global",
  }));
  assert.equal(candidate.candidate, true);
  const [copy] = (await admin`SELECT id, candidate, user_confirmed
    FROM assistant_memory_items WHERE workspace_id=${f.side} AND user_id=${f.userId} AND global_key=${candidate.memoryItemId}::uuid`);
  assert.ok(copy, "账号级候选没有铺到第二个空间");
  assert.equal(copy.candidate, true, "副本没有原样带上候选位");
  assert.equal(copy.user_confirmed, false, "副本凭空成了已确认");
  assert.deepEqual(await contents(side), [], "未确认的候选在第二个空间被采用了");

  // 源行确认：副本跟着成为已确认，第二个空间这才采用。
  const confirmed = await inApi(home, tx => confirmMemory(tx, home, candidate.memoryItemId));
  assert.ok(confirmed);
  assert.deepEqual(await contents(side), [confirmed.content], "确认后第二个空间仍不采用");
  const afterConfirm = (await read(side)).preferences[0];
  assert.equal(afterConfirm.memoryId, String(copy.id), "采用的还是铺过去的副本");
  assert.equal(afterConfirm.epistemicStatus, confirmed.epistemicStatus, "副本的认识状态与源行不一致");
});

test("源行带非默认状态时的首次铺开：副本从一开始就和源行一致，不必等下一次 UPDATE", async () => {
  const f = await fixture();
  const home: Scope = { workspaceId: f.home, userId: f.userId };
  const validFrom = new Date(Date.now() + 86_400_000);
  const validUntil = new Date(Date.now() + 172_800_000);

  // 刻意造一条"哪儿都不是默认值"的源行：candidate 与 user_confirmed 并存、
  // resident 预算层、争议中的认识状态、未来的时窗、适用条件、已固定、已归档、
  // 已点过忽略。它是 global，所以**会**被铺——副本必须照抄这一切。
  //
  // 直接用 migrator 造这行，是因为要验的是**首次铺开的 INSERT 映射**：必须保证
  // 触发铺开的那一刻还没有任何副本，否则 0371 的副本同步会先把它们对齐，这条
  // 测试就成了"同步修好了它"的假绿。（入口本身由上一条用真实 API 写入验过。）
  // `user_stated=false` + `source_type='model_inferred'` 是为了让 0360 的 BEFORE 触发器
  // 不改写下面的 author_type / epistemic_status，否则摆进去的就不是我想验的值。
  const quirky = randomUUID();
  await admin.begin(async tx => {
    await tx`INSERT INTO assistant_memory_items
        (id, workspace_id, user_id, kind, content, source_event_id, scope,
         candidate, user_confirmed, user_stated, source_type, author_type,
         epistemic_status, budget_tier, pinned, applies_when, valid_from, valid_until,
         dismissed_at, archived_at, global_key)
      VALUES(${quirky}, ${f.home}, ${f.userId}, 'preference', ${`一条处处非默认的账号级规则 ${tag}`},
              ${`evt-${quirky}`}, 'global', true, true, false, 'model_inferred', 'extractor',
              'disputed', 'resident', true, ${`讲新概念时 ${tag}`}, ${validFrom}, ${validUntil},
              now(), now(), ${quirky})`;
  });
  await inApi(home, tx => tx.execute(query`
    SELECT public.ailearn_fanout_agent_global_preference(${quirky}::uuid) AS inserted`));

  // 两边读的是同一组列，逐列比对——少比一列就等于放过一处不一致。
  const [copy] = await admin`SELECT candidate, user_confirmed, epistemic_status, author_type,
      budget_tier, pinned, applies_when, valid_from, valid_until, dismissed_at, archived_at, scope
    FROM assistant_memory_items
    WHERE workspace_id=${f.side} AND user_id=${f.userId} AND global_key=${quirky}::uuid`;
  const [source] = await admin`SELECT candidate, user_confirmed, epistemic_status, author_type,
      budget_tier, pinned, applies_when, valid_from, valid_until, dismissed_at, archived_at, scope
    FROM assistant_memory_items WHERE id=${quirky}::uuid`;

  assert.ok(copy, "非默认状态的源行没有铺到第二个空间");
  for (const column of ["candidate", "user_confirmed", "epistemic_status", "author_type",
    "budget_tier", "pinned", "applies_when", "valid_from", "valid_until",
    "dismissed_at", "archived_at", "scope"]) {
    assert.deepEqual(copy[column], source[column], `副本的 ${column} 与源行不一致`);
  }
  // 正向对照：上面那条循环不能因为"两边都是默认值/都是 null"而空转。
  assert.deepEqual(
    { candidate: source.candidate, user_confirmed: source.user_confirmed, budget_tier: source.budget_tier,
      epistemic_status: source.epistemic_status, author_type: source.author_type, pinned: source.pinned,
      archived: source.archived_at !== null, dismissed: source.dismissed_at !== null },
    { candidate: true, user_confirmed: true, budget_tier: "resident", epistemic_status: "disputed",
      author_type: "extractor", pinned: true, archived: true, dismissed: true },
    "正向对照：源行没有真的处在非默认状态，这一条循环就白跑了");
  assert.equal(new Date(copy.valid_from).toISOString(), validFrom.toISOString(), "副本的起始时间没照抄");
  assert.equal(new Date(copy.valid_until).toISOString(), validUntil.toISOString(), "副本的结束时间没照抄");

  // 归档 + 撤回 + 候选，所以两个空间都不该采用它——"不采用"的理由是状态本身，
  // 不是副本缺了状态。
  assert.deepEqual(await contents({ workspaceId: f.side, userId: f.userId }), [],
    "归档并撤回的规则在第二个空间被采用了");
  assert.deepEqual(await contents(home), [], "归档并撤回的规则在源空间被采用了");
});

test("受控铺开入口不认任意 UUID：跨用户与非法 scope 都过不去", async () => {
  const f = await fixture();
  const home: Scope = { workspaceId: f.home, userId: f.userId };
  const otherInSide: Scope = { workspaceId: f.side, userId: f.otherUserId };
  const account = await inApi(home, tx => upsertMemory(tx, home, {
    kind: "preference", content: "只属于这个用户的账号级偏好。", sourceEventId: `evt-${randomUUID()}`,
    scope: "global", userStated: true, candidate: false,
  }));
  const local = await stated(home, "一条空间内的规则。");

  // 另一个用户拿着别人的记忆 id 来铺：他**是** side 的活跃成员，校验要落在源行归属上。
  await assert.rejects(
    () => inApi(otherInSide, tx => tx.execute(query`
      SELECT public.ailearn_fanout_agent_global_preference(${account.memoryItemId}::uuid) AS inserted`)),
    (error: Error & { cause?: { code?: string; message?: string } }) =>
      error.cause?.code === "42501" && /not available to the acting user/.test(error.cause.message ?? ""),
  );
  assert.deepEqual(await contents({ workspaceId: f.side, userId: f.otherUserId }), [],
    "别人的规则被铺了过来");

  // 非法 scope 不是错误，只是不铺：workspace 级的行本来就该留在原空间。
  const [noop] = await inApi(home, tx => tx.execute(query`
    SELECT public.ailearn_fanout_agent_global_preference(${local.memoryItemId}::uuid) AS inserted`));
  assert.equal(Number(noop?.inserted ?? -1), 0, "空间内规则竟然被铺开了");
  assert.deepEqual(await contents({ workspaceId: f.side, userId: f.userId }), [account.content],
    "第二空间只保留此前合法铺开的账号级规则，空间内规则不能被提升");
});

test("同一空间里另一个用户的偏好不可见", async () => {
  const f = await fixture();
  const mine: Scope = { workspaceId: f.side, userId: f.userId };
  const theirs: Scope = { workspaceId: f.side, userId: f.otherUserId };
  const mineRule = await stated(mine, "我自己的偏好。");
  const theirsRule = await stated(theirs, "同一个空间里别人的偏好。");

  assert.deepEqual(await contents(mine), [mineRule.content], "读到了同一个空间里别人的偏好");
  assert.deepEqual(await contents(theirs), [theirsRule.content], "反向也不该看到别人的");
});

test("副本同步触发器：存在、启用、行级 AFTER UPDATE、绑定的函数真的同步回收时间", async () => {
  // 「迁移里重定义了函数」不等于「删除会走到它」。这里逐条查真库的触发器目录：
  // 缺触发器、被禁用、被限定成 UPDATE OF 某几列、绑到别的函数上，四种都会让回收时间
  // 停在原地，而表面上迁移已经应用成功。
  const [trigger] = await admin`
    SELECT t.tgenabled, t.tgtype, (t.tgattr = ''::int2vector) AS fires_on_any_column,
           p.proname, p.prosecdef,
           (pg_get_functiondef(p.oid) LIKE '%purge_after = NEW.purge_after%') AS syncs_purge_after,
           (pg_get_functiondef(p.oid) NOT LIKE '%revision = NEW.revision%') AS keeps_revision_local
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.assistant_memory_items'::regclass
       AND t.tgname = 'assistant_memory_items_sync_copies'
       AND NOT t.tgisinternal`;
  assert.ok(trigger, "账号级副本同步触发器不在库里：删除与归档都不会传到别的空间");
  assert.equal(trigger.tgenabled, "O", "触发器不是默认启用态");
  assert.equal(trigger.proname, "ailearn_sync_global_companion_memory_copies",
    "触发器绑到了别的函数上");
  assert.equal(trigger.prosecdef, true, "同步函数不是 SECURITY DEFINER，跨空间那一行会被 RLS 挡住");
  // pg_trigger.tgtype 位：bit0=ROW(1)、bit1=BEFORE(2)、bit4=UPDATE(16)、bit5=TRUNCATE(32)。
  assert.equal(Number(trigger.tgtype) & 1, 1, "不是行级触发器");
  assert.equal(Number(trigger.tgtype) & 16, 16, "不是 UPDATE 触发器");
  assert.equal(Number(trigger.tgtype) & 2, 0, "是 BEFORE 触发器：本行还没写完就被同步出去");
  assert.equal(Number(trigger.tgtype) & 32, 0, "带 TRUNCATE 事件，形状不对");
  assert.equal(trigger.fires_on_any_column, true,
    "触发器被限定成 UPDATE OF 某几列：删除写的列它不一定看得见");
  assert.equal(trigger.syncs_purge_after, true, "绑定的函数没有同步 purge_after");
  assert.equal(trigger.keeps_revision_local, true, "同步函数开始搬 revision 了");
});

/**
 * 一条账号级规则在两个空间里的真实身份（id / global_key / 来源 / 正文）。
 *
 * 只作**证据**读：停用、恢复、删除、迟到抽取这些动作的判据一律看 worker 的采用读取，
 * 这里只回答"恢复之后接回来的是不是同一条"。admin 连的是超户，只读这一组列。
 */
const globalIdentity = async (userId: string, globalKey: string) => {
  const rows = await admin`
    SELECT workspace_id, id, global_key::text AS global_key, source_event_id::text AS source_event_id, content
      FROM assistant_memory_items
     WHERE user_id=${userId} AND global_key=${globalKey}::uuid
     ORDER BY workspace_id`;
  return Object.fromEntries(rows.map(row => [String(row.workspace_id), {
    id: String(row.id),
    globalKey: String(row.global_key),
    sourceEventId: String(row.source_event_id ?? ""),
    content: String(row.content),
  }]));
};

/** 修订快照行数：写入口若动过正文，历史表就会多一行。 */
const revisionRows = async (memoryIds: readonly string[]) => {
  const [row] = await admin`
    SELECT count(*)::int AS n FROM assistant_memory_item_revisions
     WHERE memory_id = ANY(${memoryIds}::uuid[])`;
  return Number(row?.n ?? -1);
};

/**
 * 回收区状态：一条账号级规则在每个空间里那一行的 `deleted_at` / `purge_after`。
 *
 * `due` 就是 0345 `ailearn_purge_expired_companion_memory()` 的判据原样搬过来
 * （deleted_at 非空 ∧ purge_after 非空 ∧ 已到期）。这里只**读**判据、不执行清理——
 * 真正到期后的物理删除另在本任务自己的隔离库上单独验。
 */
const recycleRows = async (userId: string, globalKey: string) => {
  const rows = await admin`
    SELECT workspace_id, id, deleted_at, purge_after,
           (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= now()) AS due
      FROM assistant_memory_items
     WHERE user_id=${userId} AND global_key=${globalKey}::uuid
     ORDER BY workspace_id`;
  return rows.map(row => ({
    workspaceId: String(row.workspace_id),
    id: String(row.id),
    deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at as string),
    purgeAfter: row.purge_after === null ? null : new Date(row.purge_after as string),
    due: row.due === true,
  }));
};

/** 每一行都必须带同一个「删除时刻 + 现役回收窗口」；返回实际出现的窗口天数集合。 */
const assertRecycleWindow = (
  rows: readonly { workspaceId: string; deletedAt: Date | null; purgeAfter: Date | null; due: boolean }[],
  expectedDays: number,
) => {
  const windows = new Set<number>();
  for (const row of rows) {
    assert.ok(row.deletedAt, `workspace ${row.workspaceId} 这一行没有 deleted_at，它不在回收区里`);
    assert.ok(row.purgeAfter,
      `workspace ${row.workspaceId} 这一行 purge_after 仍是 NULL，它永远进不了现役到期清理`);
    windows.add(Math.round((row.purgeAfter.getTime() - row.deletedAt.getTime()) / 86_400_000));
  }
  assert.deepEqual([...windows].sort((a, b) => a - b), [expectedDays],
    "回收窗口不是现役的 MEMORY_RECYCLE_BIN_DAYS 天，或各行之间不一致");
};

test("从副本停用后全账号停止采用；显式恢复后两空间接回同一条规则", async () => {
  const f = await fixture();
  const home: Scope = { workspaceId: f.home, userId: f.userId };
  const side: Scope = { workspaceId: f.side, userId: f.userId };

  // 正向对照：一条空间内规则。它没有 global_key，与账号级那条不是同一条链，
  // 用来证明"停用一条"不会顺手把别的规则一起抑制掉。
  const local = await stated(home, "只属于这个空间的一条空间规则。");

  // 账号级规则走**真实 API 写入**（upsertMemory 是记忆中心唯一入口），userStated 让
  // 这一次写入自己就把确认位落成"已确认、非候选"——「完成确认」仍由写入口完成，
  // 不用 admin 摆行，也不绕过铺开。
  const account = await inApi(home, tx => upsertMemory(tx, home, {
    kind: "preference", content: "讲新概念时先给一个日常类比。", sourceEventId: `evt-${randomUUID()}`,
    scope: "global", userStated: true, candidate: false,
  }));
  assert.equal(account.scope, "global");
  assert.equal(account.userConfirmed, true, "写入之后并不是已确认");
  assert.equal(account.candidate, false, "写入之后仍是候选");

  // 基线：两个空间都在采用同一条规则，源行与副本各在一边。
  const beforeHome = await read(home);
  const beforeSide = await read(side);
  const sourceAdopted = beforeHome.preferences.find(p => p.content === account.content);
  const copyAdopted = beforeSide.preferences.find(p => p.content === account.content);
  assert.ok(sourceAdopted, "源空间没有采用这条账号级规则");
  assert.ok(copyAdopted, "第二个空间没有采用这条账号级规则");
  assert.equal(sourceAdopted.memoryId, account.memoryItemId, "源空间采用的不是源行");
  assert.notEqual(copyAdopted.memoryId, account.memoryItemId, "第二个空间读到的不是副本");
  assert.equal(copyAdopted.scope, "global");
  assert.ok(beforeHome.preferences.some(p => p.content === local.content), "正向对照：空间内规则没在自己的空间里");
  const identityBefore = await globalIdentity(f.userId, account.memoryItemId);
  assert.deepEqual(Object.keys(identityBefore).sort(), [f.home, f.side].sort(),
    "账号级规则没有铺成两行（源行 + 一个副本）");
  assert.equal(identityBefore[f.home]?.id, account.memoryItemId);

  // 停用**动作发生在第二个空间的副本上**——用户是在那个空间里点的停用。
  const archived = await inApi(side, tx => archiveMemory(tx, side, copyAdopted.memoryId));
  assert.ok(archived, "对副本的 archiveMemory 没有生效");
  assert.equal(archived.memoryItemId, copyAdopted.memoryId);
  assert.equal(archived.archived, true, "归档没有落到副本自己身上");

  assert.deepEqual(await contents(side), [], "副本停用后第二个空间还在采用它");
  assert.deepEqual(await contents(home), [local.content],
    "副本停用后源空间还在采用账号级规则（空间内对照条也不能跟着消失）");

  // 显式恢复：走的仍是 API 入口，作用在同一条副本上。
  const restored = await inApi(side, tx => restoreMemory(tx, side, copyAdopted.memoryId));
  assert.ok(restored, "对副本的 restoreMemory 没有生效");
  assert.equal(restored.memoryItemId, copyAdopted.memoryId);
  assert.equal(restored.archived, false, "恢复之后副本仍然处在归档态");

  // 恢复之后：两空间都接回**同一条**规则——id、global_key、来源与正文都还是原来那些。
  const afterHome = await read(home);
  const afterSide = await read(side);
  assert.deepEqual(afterHome.preferences.map(p => p.content).sort(), [account.content, local.content].sort(),
    "恢复之后源空间没有接回账号级规则");
  assert.deepEqual(afterSide.preferences.map(p => p.content), [account.content],
    "恢复之后第二个空间没有接回账号级规则");
  const afterSource = afterHome.preferences.find(p => p.content === account.content);
  const afterCopy = afterSide.preferences.find(p => p.content === account.content);
  assert.equal(afterSource?.memoryId, account.memoryItemId, "恢复之后接回来的是另一个源行");
  assert.equal(afterCopy?.memoryId, copyAdopted.memoryId, "恢复之后接回来的是另一个副本");
  assert.equal(afterSource?.scope, "global");
  assert.equal(afterCopy?.scope, "global");
  assert.deepEqual(await globalIdentity(f.userId, account.memoryItemId), identityBefore,
    "恢复之后源/副本的 id、global_key、来源或正文变了");
});

test("从副本删除后迟到自动抽取不复活；显式恢复后两空间接回，来源抑制仍在", async () => {
  const f = await fixture();
  const home: Scope = { workspaceId: f.home, userId: f.userId };
  const side: Scope = { workspaceId: f.side, userId: f.userId };

  // 起步是一条**模型候选**账号级偏好，带稳定 sourceEventId——它就是"迟到抽取"会带来的
  // 那一次。确认之后两个空间才都采用它。
  const sourceEventId = `evt-${randomUUID()}`;
  const candidate = await inApi(home, tx => upsertMemory(tx, home, {
    kind: "preference", content: "讲新概念时先给一个日常类比。", sourceEventId, scope: "global",
  }));
  assert.equal(candidate.candidate, true, "起步那一条不是候选");
  assert.equal(candidate.userConfirmed, false, "起步那一条已经是确认态");
  assert.equal(candidate.sourceType, "model_inferred");
  assert.deepEqual(await contents(side), [], "未确认的候选在第二个空间被采用了");

  const confirmed = await inApi(home, tx => confirmMemory(tx, home, candidate.memoryItemId));
  assert.ok(confirmed, "确认失败");
  assert.equal(confirmed.userConfirmed, true);
  assert.equal(confirmed.candidate, false);
  const sourceAdopted = (await read(home)).preferences.find(p => p.content === candidate.content);
  const copyAdopted = (await read(side)).preferences.find(p => p.content === candidate.content);
  assert.ok(sourceAdopted, "确认后源空间没有采用");
  assert.ok(copyAdopted, "确认后第二个空间没有采用");
  assert.equal(sourceAdopted.memoryId, candidate.memoryItemId);
  assert.notEqual(copyAdopted.memoryId, candidate.memoryItemId, "第二个空间读到的不是副本");

  const identityBefore = await globalIdentity(f.userId, candidate.memoryItemId);
  assert.deepEqual(Object.keys(identityBefore).sort(), [f.home, f.side].sort());
  const memoryIds = [sourceAdopted.memoryId, copyAdopted.memoryId];
  const historyBefore = await revisionRows(memoryIds);

  // 删除**动作发生在第二个空间的副本上**。
  assert.equal(await inApi(side, tx => deleteMemory(tx, side, copyAdopted.memoryId)), true,
    "对副本的 deleteMemory 没有生效");
  assert.deepEqual(await contents(side), [], "副本删除后第二个空间还在采用它");
  assert.deepEqual(await contents(home), [], "副本删除后源空间还在采用它");

  // 回收期必须**账号级**一致（42 阶段 1 N）：删除动作只发生在副本上，但每一行都得带着
  // 同一个「删除时刻 + 现役窗口」进入回收期，否则另一空间那一行永远不会被到期清理。
  const deletedRows = await recycleRows(f.userId, candidate.memoryItemId);
  assert.equal(deletedRows.length, 2, "账号级规则没有铺成两行（源行 + 一个副本）");
  assert.deepEqual(deletedRows.map(r => r.workspaceId).sort(), [f.home, f.side].sort());
  assertRecycleWindow(deletedRows, MEMORY_RECYCLE_BIN_DAYS);
  assert.ok(deletedRows.every(row => !row.due),
    "刚删掉就被判成到期：回收窗口没有真的开始算");

  // 迟到的自动抽取在**源空间**重跑同一条来源：同一个 user/kind/sourceEventId，
  // 且不是 userStated——所以走的正是现役的写端抑制，不绕过、不改判据。
  // 注意此刻旧的活跃行已经被软删，`(workspace_id,user_id,kind,source_event_id)` 的
  // 部分唯一索引**不再拦它**：唯一还挡着的就是来源抑制墓碑。
  await assert.rejects(
    () => inApi(home, tx => upsertMemory(tx, home, {
      kind: "preference", content: "同源又抽出来一次。", sourceEventId,
    })),
    (error: Error) => error.name === "MemorySourceSuppressedError",
  );
  const [lateSurvivor] = await admin`
    SELECT count(*)::int AS n FROM assistant_memory_items
     WHERE user_id=${f.userId} AND kind='preference' AND source_event_id=${sourceEventId}
       AND deleted_at IS NULL`;
  assert.equal(Number(lateSurvivor?.n ?? -1), 0, "被抑制的迟到抽取仍然落了一条活跃候选");
  assert.deepEqual(await contents(home), [], "被抑制的迟到抽取让规则复活了");
  assert.deepEqual(await globalIdentity(f.userId, candidate.memoryItemId), identityBefore,
    "被抑制的迟到抽取换了 global_key、来源或正文");
  assert.equal(await revisionRows(memoryIds), historyBefore, "被拒绝的迟到抽取仍然推进了修订历史");

  // 显式恢复（回收区），走的仍是实际入口；作用在同一个副本上。
  assert.equal(await inApi(side, tx => restoreDeletedMemory(tx, side, copyAdopted.memoryId)), true,
    "restoreDeletedMemory 没有把副本放回来");

  // 恢复之后由 worker 读：两个空间接回的是**同一条**规则。
  const backHome = await read(home);
  const backSide = await read(side);
  assert.deepEqual(backHome.preferences.map(p => p.content), [candidate.content],
    "恢复之后源空间没有接回这条规则");
  assert.deepEqual(backSide.preferences.map(p => p.content), [candidate.content],
    "恢复之后第二个空间没有接回这条规则");
  assert.equal(backHome.preferences[0].memoryId, sourceAdopted.memoryId, "接回来的是另一个源行");
  assert.equal(backSide.preferences[0].memoryId, copyAdopted.memoryId, "接回来的是另一个副本");
  assert.deepEqual(await globalIdentity(f.userId, candidate.memoryItemId), identityBefore,
    "恢复之后源/副本的 id、global_key、来源或正文变了");
  // 回收期与删除一起走、一起清：每一行都不能只清一半。
  const restoredRows = await recycleRows(f.userId, candidate.memoryItemId);
  assert.equal(restoredRows.length, 2, "恢复之后这一组不是两行了");
  for (const row of restoredRows) {
    assert.equal(row.deletedAt, null, `workspace ${row.workspaceId} 恢复之后仍留在回收区里`);
    assert.equal(row.purgeAfter, null, `workspace ${row.workspaceId} 恢复之后还带着回收时间`);
    assert.equal(row.due, false, `workspace ${row.workspaceId} 恢复之后仍被判成已到期`);
  }

  // 恢复是用户明确的动作，它不等于"以后别再从那句话里抽取"：墓碑必须还在，
  // 下一次迟到自动重建照样被现役抑制挡住。
  const [tombstone] = await admin`
    SELECT count(*)::int AS n FROM assistant_memory_source_suppressions
     WHERE user_id=${f.userId} AND kind='preference' AND source_event_id=${sourceEventId}`;
  assert.equal(Number(tombstone?.n ?? -1), 1, "手动恢复把来源抑制墓碑一起清掉了");
  await assert.rejects(
    () => inApi(home, tx => upsertMemory(tx, home, {
      kind: "preference", content: "手动恢复之后又来一次同源抽取。", sourceEventId,
    })),
    (error: Error) => error.name === "MemorySourceSuppressedError",
  );
  assert.deepEqual(await contents(home), [candidate.content], "手动恢复之后同源自动重建被放行了");
  assert.deepEqual(await contents(side), [candidate.content], "同源自动重建污染了第二个空间");
  assert.deepEqual(await globalIdentity(f.userId, candidate.memoryItemId), identityBefore,
    "被抑制的迟到重建换了 global_key、来源或正文");
});

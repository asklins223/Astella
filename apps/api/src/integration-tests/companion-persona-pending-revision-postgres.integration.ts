/**
 * 「待生效」人格版本：排队 → 生效 → 作废，以及 0356 的 run 固定锁。
 *
 * 覆盖的是三件**单元测试测不到、且错了都不会报错**的事：
 *
 *   1. **排队不动当前**。模型改一次人格，长会话里已经说过的话与正在生成的那句
 *      就分属两个版本了——「一次调用使用固定版本」当场破掉，而两边都运行正常。
 *   2. **谁把当前版本往前推，谁就作废排队**，且新版本号必须排在队尾。
 *      旧算法（当前 +1）在排过队之后会撞 `versions(user_id, revision)` 唯一键，
 *      表现为「用户纠正一次直接失败并回滚」。
 *   3. **数据库自己兜住两条不变量**：待生效必须比当前新、只能指向本账号那条
 *      版本行；run 固定的人格版本不可改写。应用层忘了复查时，这里会当场炸。
 *
 * 另外钉住一条**很容易被漏掉**的：账号被删除时，profiles 与 versions 的级联
 * 删除与 0355 新加的复合外键必须共存（否则「清除全部相关内容」会整条失败）。
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import type { PetProfileInput } from "../modules/companion-conversation/pet-profile-service.ts";

process.env.COMPANION_PET_PROFILE_V1 = "true";

const CONN = process.env.DATABASE_URL_TEST_ADMIN ?? process.env.DATABASE_URL ?? process.env.DATABASE_URL_API;
if (!CONN) {
  throw new Error("DATABASE_URL_API 未配置——persona pending 集成测试要求真实 Postgres");
}

const sql = postgres(CONN, { max: 3 });
const userA = randomUUID();
const userB = randomUUID();
const workspaceId = randomUUID();
const prefix = userA.slice(0, 8);

const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { petProfileRoutes } = await import("../modules/companion-conversation/pet-profile-routes.ts");
const {
  PetProfileCasConflictError,
  activatePetProfilePendingRevision,
  getPetProfileState,
  stagePetProfileRevision,
  upsertPetProfile,
  restorePetProfileVersion,
  listPetProfileVersions,
} = await import("../modules/companion-conversation/pet-profile-service.ts");
const { closeDatabase, withWorkspaceTransaction } = await import("../db/client.ts");

const scopeA = { workspaceId, userId: userA };
const scopeB = { workspaceId, userId: userB };
type Tx = Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0];
const inA = <T>(run: (tx: Tx) => Promise<T>): Promise<T> => withWorkspaceTransaction(scopeA, run);
const inB = <T>(run: (tx: Tx) => Promise<T>): Promise<T> => withWorkspaceTransaction(scopeB, run);

const profile = (overrides: Partial<PetProfileInput> = {}): PetProfileInput => ({
  revision: 0,
  presetId: "energetic-cat",
  name: "小伴",
  personalityTags: ["好奇"],
  speakingStyle: "简短口语",
  examples: [{ text: "要不要试试？" }],
  activeness: "moderate",
  boundaries: { allowPlayful: true, allowNudgeLearning: true, catchphrase: null },
  ...overrides,
});

let app: FastifyInstance;
let tokenA = "";
let conversationId = randomUUID();
const userMessageId = randomUUID();

before(async () => {
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      (${userA}, ${`pending-a-${prefix}@example.test`}, 'test-hash', 'owner'),
      (${userB}, ${`pending-b-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  await sql`
    INSERT INTO workspaces (id, name, owner_id, workspace_type)
    VALUES (${workspaceId}, ${`pending-${prefix}`}, ${userA}, 'collaborative')
  `;
  await sql`
    INSERT INTO workspace_members (workspace_id, user_id, role)
    VALUES (${workspaceId}, ${userA}, 'owner'), (${workspaceId}, ${userB}, 'member')
  `;
  await sql`
    INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${workspaceId}, ${userA}, 'dialogue', 'pending', 'system', 'active')
  `;
  await sql`
    INSERT INTO companion_messages (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, content_sha256)
    VALUES (
      ${userMessageId}, ${workspaceId}, ${userA}, ${conversationId}, 1, 'user', 'text',
      ${sql.json([{ type: "text", text: "在吗" }])}, ${"0".repeat(64)}
    )
  `;
  tokenA = (await issueSession(userA, workspaceId)).token;
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(petProfileRoutes);
  await app.ready();
});

after(async () => {
  await revokeSession(tokenA).catch(() => {});
  await app?.close();
  // 删除顺序：复合外键让 profiles 指向 versions，两张表都由 users 级联，
  // 所以同一条 DELETE 里必须都能删掉——这正是本文件要钉住的那条。
  await sql`UPDATE users SET personal_workspace_id = NULL WHERE id IN (${userA}, ${userB})`.catch(() => {});
  await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`.catch(() => {});
  await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`.catch(() => {});
  await sql.end({ timeout: 5 }).catch(() => {});
  await closeDatabase().catch(() => {});
});

test("排队一版修订：写下内容，当前版本一个字都不动", async () => {
  const created = await inA((tx) => upsertPetProfile(tx, scopeA, profile()));
  assert.equal(created.revision, 1);

  const staged = await inA((tx) => stagePetProfileRevision(
    tx,
    scopeA,
    profile({ revision: created.revision, speakingStyle: "更慢一点、句子更短" }),
    new Date(),
    { author: "assistant_tool", reason: "她想把语气再收一点。" },
  ));
  assert.equal(staged.profileRevision, created.revision, "排队不得移动当前版本");
  assert.ok(staged.pendingRevision > created.revision, "待生效的号必须比当前新");

  const state = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.equal(state.profileRevision, created.revision, "当前 revision 未动");
  assert.equal(state.profile?.speakingStyle, "简短口语", "当前正文未动——长会话里已生成的那句还是这一版");
  // A50：待生效版本可见，且带得上「谁排的、依据是什么、什么时候生效」。
  assert.ok(state.pending, "待生效那一版必须能被读到");
  assert.equal(state.pending.revision, staged.pendingRevision);
  assert.equal(state.pending.profile?.speakingStyle, "更慢一点、句子更短");
  assert.equal(state.pending.author, "assistant_tool");
  assert.equal(state.pending.reason, "她想把语气再收一点。");
  assert.equal(state.pending.effectiveWhen, "下一轮新发起的对话生效，当前已开始的调用保持原版本");
  assert.deepEqual(state.pending.moduleScope, ["companion"]);
  assert.ok(Date.parse(state.pending.stagedAt) > 0, "排队时间必须可解析");
});

test("排队按当前 revision 做 CAS：过期号直接冲突，且不留下任何东西", async () => {
  const before = await inA((tx) => getPetProfileState(tx, scopeA));
  await assert.rejects(
    () => inA((tx) => stagePetProfileRevision(tx, scopeA, profile({ revision: before.profileRevision - 1 }))),
    (error: unknown) => error instanceof PetProfileCasConflictError,
    "过期 revision 必须冲突，而不是把排队建立在别人的当前版本上",
  );
  const after = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.equal(after.pending?.revision, before.pending?.revision, "冲突的排队不得改变已有指针");
  assert.equal(after.profileRevision, before.profileRevision);
});

test("排队是账号级的：另一个用户读不到别人的待生效", async () => {
  const stateB = await inB((tx) => getPetProfileState(tx, scopeB));
  assert.equal(stateB.pending, null, "B 不该看到 A 的待生效版本");
  assert.equal(stateB.profileRevision, 0);

  const pointers = await sql`
    SELECT p.user_id::text AS user_id, p.pending_revision
    FROM companion_persona_profiles p
  `;
  const bRow = pointers.find((row) => row.user_id === userB);
  assert.equal(bRow ?? null, null, "B 名下不得被凭空建出一行人格档案");
});

test("激活：把排队那一版提升为当前，指针清空，那一行仍在历史里", async () => {
  const before = await inA((tx) => getPetProfileState(tx, scopeA));
  const pendingRevision = before.pending?.revision;
  assert.ok(pendingRevision, "自证样本：前面排过队了");

  const activation = await inA((tx) => activatePetProfilePendingRevision(tx, scopeA, {
    expectedRevision: before.profileRevision,
  }));
  assert.ok(activation, "激活必须成功");
  assert.equal(activation.revision, pendingRevision, "生效后当前版本号就是排队那一号");
  assert.equal(activation.profile?.speakingStyle, "更慢一点、句子更短");

  const after = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.equal(after.profileRevision, pendingRevision);
  assert.equal(after.profile?.speakingStyle, "更慢一点、句子更短");
  assert.equal(after.pending, null, "激活之后不得还挂着待生效");

  const versions = await inA((tx) => listPetProfileVersions(tx, scopeA));
  assert.ok(
    versions.some((version) => version.revision === pendingRevision && version.author === "assistant_tool"),
    "生效之后那一条仍然是历史里可查、可恢复的一行",
  );
});

test("没有排队时激活 → null（过期请求），不静默成功", async () => {
  const state = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.equal(state.pending, null, "自证样本：此刻确实没有排队");
  const activation = await inA((tx) => activatePetProfilePendingRevision(tx, scopeA, {
    expectedRevision: state.profileRevision,
  }));
  assert.equal(activation, null);
});

test("激活按当前 revision 做 CAS", async () => {
  const state = await inA((tx) => getPetProfileState(tx, scopeA));
  await inA((tx) => stagePetProfileRevision(tx, scopeA, profile({ revision: state.profileRevision, speakingStyle: "排队一版" })));
  await assert.rejects(
    () => inA((tx) => activatePetProfilePendingRevision(tx, scopeA, { expectedRevision: state.profileRevision - 1 })),
    (error: unknown) => error instanceof PetProfileCasConflictError,
  );
  const still = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.ok(still.pending, "冲突的激活不得把排队吃掉");
});

test("用户直接纠正作废排队：新号排在队尾，被顶掉的那一版仍可恢复", async () => {
  const before = await inA((tx) => getPetProfileState(tx, scopeA));
  const superseded = before.pending?.revision;
  assert.ok(superseded, "自证样本：此刻排着队");

  const written = await inA((tx) => upsertPetProfile(tx, scopeA, profile({
    revision: before.profileRevision,
    speakingStyle: "我自己写的这句",
  })));
  assert.equal(written.revision, superseded + 1, "新号必须排在队尾——旧算法会撞唯一键直接失败");
  assert.equal(written.speakingStyle, "我自己写的这句");

  const after = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.equal(after.pending, null, "用户直接纠正不必等排队那一版生效（40 §4.8.4）");
  const versions = await inA((tx) => listPetProfileVersions(tx, scopeA));
  assert.ok(
    versions.some((version) => version.revision === superseded),
    "被顶掉的那一版没有被删：它仍在历史里，可恢复",
  );
});

test("恢复旧版本同样作废排队，且不撞号", async () => {
  const before = await inA((tx) => getPetProfileState(tx, scopeA));
  await inA((tx) => stagePetProfileRevision(tx, scopeA, profile({
    revision: before.profileRevision,
    speakingStyle: "又要排队的一版",
  })));
  const staged = (await inA((tx) => getPetProfileState(tx, scopeA))).pending?.revision;
  assert.ok(staged);

  // 恢复第 1 版：那一行早就在历史里（append-only），恢复是「以它为内容再写一版」，
  // 同样排在队尾，同样把排队作废。
  const restoredRevision = await inA((tx) => restorePetProfileVersion(tx, scopeA, {
    revision: 1,
    expectedRevision: before.profileRevision,
  }));
  assert.equal(restoredRevision?.revision, staged + 1, "恢复的号也必须排在队尾");
  const after = await inA((tx) => getPetProfileState(tx, scopeA));
  assert.equal(after.pending, null, "恢复也是一次当前版本前移，必须作废排队");
  assert.equal(after.profileRevision, staged + 1);
});

test("数据库自己兜住：待生效不能不比当前新，也不能指向别人的版本行", async () => {
  let checkFailure = "";
  try {
    await sql.unsafe(`
      UPDATE companion_persona_profiles
         SET pending_revision = revision
       WHERE user_id = '${userA}'
    `);
  } catch (error) {
    checkFailure = (error as { constraint?: string }).constraint ?? (error as Error).message;
  }
  assert.match(
    checkFailure,
    /companion_persona_profiles_pending_revision_check/,
    "待生效 ≤ 当前必须被数据库拒绝，而不是靠应用层记得复查",
  );

  // 复合外键：把 A 的指针指到 B 的版本号上。要让这一句**只**撞外键，必须先让那个号
  // 大过 A 的当前版本——否则 CHECK（待生效 > 当前）会先一步拒绝，测的就不是外键了。
  const current = await sql`SELECT revision FROM companion_persona_profiles WHERE user_id = ${userA}`;
  const foreignRevision = Number(current[0].revision) + 5;
  const { revision: _ignored, ...content } = profile();
  const bVersion = await sql`
    INSERT INTO companion_persona_profile_versions (user_id, revision, examples_revision, author, action, profile)
    VALUES (${userB}, ${foreignRevision}, ${foreignRevision}, 'user', 'update', ${sql.json(content)})
    RETURNING revision
  `;
  assert.equal(bVersion[0].revision, foreignRevision);
  let fkeyFailure = "";
  try {
    await sql.unsafe(`
      UPDATE companion_persona_profiles
         SET pending_revision = ${foreignRevision}
       WHERE user_id = '${userA}'
    `);
  } catch (error) {
    fkeyFailure = (error as { constraint?: string }).constraint ?? (error as Error).message;
  }
  assert.match(
    fkeyFailure,
    /companion_persona_profiles_pending_version_fkey/,
    "指针只能落在同一账号的版本行上（复合外键带的是 user_id）",
  );
  await sql`DELETE FROM companion_persona_profile_versions WHERE user_id = ${userB} AND revision = ${foreignRevision}`;
});

test("HTTP：排队 → 待生效可见 → 生效，CAS 与坏 body 分别落 409 / 400", async () => {
  const state = await inA((tx) => getPetProfileState(tx, scopeA));
  const auth = { authorization: `Bearer ${tokenA}` };

  const bad = await app.inject({ method: "POST", url: "/companion/pet-profile/stage", headers: auth, payload: { revision: -1 } });
  assert.equal(bad.statusCode, 400, "非法 body 必须是 400");

  const conflict = await app.inject({
    method: "POST",
    url: "/companion/pet-profile/stage",
    headers: auth,
    payload: profile({ revision: state.profileRevision + 5 }),
  });
  assert.equal(conflict.statusCode, 409, "过期 revision 必须是 409");
  assert.equal(conflict.json().error, "PROFILE_CAS_CONFLICT");

  const staged = await app.inject({
    method: "POST",
    url: "/companion/pet-profile/stage",
    headers: auth,
    payload: profile({ revision: state.profileRevision, speakingStyle: "接口排的队" }),
  });
  assert.equal(staged.statusCode, 200);
  const stagedBody = staged.json() as { pendingRevision: number; profileRevision: number };
  assert.equal(stagedBody.profileRevision, state.profileRevision, "排队不动当前");
  assert.ok(stagedBody.pendingRevision > state.profileRevision);

  const pending = await app.inject({ method: "GET", url: "/companion/pet-profile/pending", headers: auth });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.headers["cache-control"], "no-store", "待生效也是私有数据");
  const pendingBody = pending.json() as {
    currentRevision: number;
    pending: { revision: number; profile: { speakingStyle: string }; effectiveWhen: string; author: string };
  };
  assert.equal(pendingBody.currentRevision, state.profileRevision);
  assert.equal(pendingBody.pending.revision, stagedBody.pendingRevision);
  assert.equal(pendingBody.pending.profile.speakingStyle, "接口排的队");
  assert.equal(pendingBody.pending.author, "user", "接口的调用方是本人，作者不得由 body 自称");
  assert.equal(pendingBody.pending.effectiveWhen, "下一轮未开始的调用生效");

  const activated = await app.inject({
    method: "POST",
    url: "/companion/pet-profile/activate",
    headers: auth,
    payload: { revision: state.profileRevision },
  });
  assert.equal(activated.statusCode, 200);
  const activatedBody = activated.json() as { profileRevision: number; profile: { speakingStyle: string } };
  assert.equal(activatedBody.profileRevision, stagedBody.pendingRevision);
  assert.equal(activatedBody.profile.speakingStyle, "接口排的队");

  const again = await app.inject({
    method: "POST",
    url: "/companion/pet-profile/activate",
    headers: auth,
    payload: { revision: activatedBody.profileRevision },
  });
  assert.equal(again.statusCode, 409, "没有排队时再点生效 → 409，不是静默成功");
  assert.equal(again.json().error, "PROFILE_NO_PENDING_REVISION");
});

test("0356：run 固定的人格版本不可改写，其他字段照常可写", async () => {
  const runId = randomUUID();
  await sql`
    INSERT INTO companion_turn_runs (
      id, workspace_id, user_id, conversation_id, user_message_id, generation, status,
      idempotency_key_hash, request_body_hash
    )
    VALUES (
      ${runId}, ${workspaceId}, ${userA}, ${conversationId}, ${userMessageId}, 1, 'accepted',
      ${`pending-pin-${prefix}`}, ${`pending-req-${prefix}`}
    )
  `;

  // 未固定时可以固定（这正是 handler 的第一次 pin）。
  await sql`
    UPDATE companion_turn_runs
       SET persona_profile_revision = 2,
           persona_examples_revision = 2,
           default_expression_version = 'pet-persona-presets-v1'
     WHERE id = ${runId}
  `;

  // 其他字段不受这道锁影响——否则 run 连状态都更新不了。
  await sql`UPDATE companion_turn_runs SET status = 'running' WHERE id = ${runId}`;

  let pinFailure = "";
  try {
    await sql.unsafe(`
      UPDATE companion_turn_runs
         SET persona_profile_revision = 3
       WHERE id = '${runId}'
    `);
  } catch (error) {
    pinFailure = (error as Error).message;
  }
  assert.match(pinFailure, /already pinned to account persona revision/, "固定之后不得被改写");

  let examplesFailure = "";
  try {
    await sql.unsafe(`
      UPDATE companion_turn_runs
         SET persona_examples_revision = 9
       WHERE id = '${runId}'
    `);
  } catch (error) {
    examplesFailure = (error as Error).message;
  }
  assert.match(examplesFailure, /already pinned/, "示例版本号同样属于固定身份的一部分");

  // 写成同一个值不算改写（幂等更新必须仍然可用）。
  await sql`
    UPDATE companion_turn_runs
       SET persona_profile_revision = 2, finished_at = now()
     WHERE id = ${runId}
  `;
  const row = await sql`SELECT status, persona_profile_revision FROM companion_turn_runs WHERE id = ${runId}`;
  assert.equal(row[0].status, "running");
  assert.equal(row[0].persona_profile_revision, 2);
  await sql`DELETE FROM companion_turn_runs WHERE id = ${runId}`;
});

test("账号被删除时 profiles / versions 的级联与复合外键共存", async () => {
  const throwaway = randomUUID();
  await sql`
    INSERT INTO users (id, email, password_hash, role)
    VALUES (${throwaway}, ${`pending-del-${prefix}@example.test`}, 'test-hash', 'owner')
  `;
  const throwawayScope = { workspaceId, userId: throwaway };
  const created = await withWorkspaceTransaction(throwawayScope, (tx) => upsertPetProfile(tx, throwawayScope, profile()));
  await withWorkspaceTransaction(throwawayScope, (tx) => stagePetProfileRevision(
    tx,
    throwawayScope,
    profile({ revision: created.revision, speakingStyle: "删账号前排的队" }),
  ));
  const pointers = await sql`
    SELECT pending_revision FROM companion_persona_profiles WHERE user_id = ${throwaway}
  `;
  assert.ok(pointers[0].pending_revision, "自证样本：删之前确实挂着待生效");

  await sql`DELETE FROM users WHERE id = ${throwaway}`;
  const left = await sql`
    SELECT
      (SELECT count(*)::int FROM companion_persona_profiles WHERE user_id = ${throwaway}) AS profiles,
      (SELECT count(*)::int FROM companion_persona_profile_versions WHERE user_id = ${throwaway}) AS versions
  `;
  assert.equal(left[0].profiles, 0, "档案随账号删除");
  assert.equal(left[0].versions, 0, "版本行随账号删除——复合外键不得把这条路堵死");
});

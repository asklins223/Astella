/** Worker 自改 → 新用户回合采用；用受限角色验证实际 SQL、RLS 与 turn 调用链。 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import { personaFromDefaultPreset } from "@astella/shared/pet-persona-merge";
import { closeDatabase, withWorkspaceTransaction } from "../db/client.ts";
import { getPetProfileState, stagePetProfileRevision, upsertPetProfile } from "../modules/companion-conversation/pet-profile-service.ts";
import { createCompanionTurn } from "../modules/companion-conversation/turn/turn-service.ts";
import { applyAssistantPersonaEdit } from "../../../../workers/ai-worker/src/handlers/companion-persona-self-edit.ts";
import { closeDatabase as closeWorkerDatabase, withWorkerWorkspaceTransaction } from "../../../../workers/ai-worker/src/db.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_TEST_ADMIN"), { max: 2 });
const userId = randomUUID(), raceUserId = randomUUID(), workspaceId = randomUUID(), conversationId = randomUUID();
const scope = { userId, workspaceId };
const base = personaFromDefaultPreset(getDefaultPersonaPreset());
const read = () => withWorkspaceTransaction(scope, tx => getPetProfileState(tx, scope));
const edit = (field: "speakingStyle" | "personalityTags" | "activeness", value: unknown, expectedRevision: number, stage = true) =>
  withWorkerWorkspaceTransaction(scope, tx => applyAssistantPersonaEdit(tx, userId, field, value,
    "合成用户明确要求长期少一点复述", { stage, expectedRevision, sourceWorkspaceId: workspaceId }));
const body = (clientMessageId: string) => ({ version: 1, clientMessageId, inputKind: "text",
  blocks: [{ type: "text", text: "嗨" }], sourceSurface: "pet" });

after(async () => {
  try {
    await admin`DELETE FROM jobs WHERE workspace_id = ${workspaceId}`;
    await admin`DELETE FROM companion_stream_events WHERE conversation_id = ${conversationId}`;
    await admin`DELETE FROM companion_turn_runs WHERE conversation_id = ${conversationId}`;
    await admin`DELETE FROM companion_messages WHERE conversation_id = ${conversationId}`;
    await admin`DELETE FROM companion_conversations WHERE id = ${conversationId}`;
    await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
    await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
    await admin`DELETE FROM users WHERE id IN (${userId}, ${raceUserId})`;
  } finally {
    await Promise.all([admin.end({ timeout: 5 }), closeDatabase(), closeWorkerDatabase()]);
  }
});

test("自改保存、采用与用户优先的完整链路", async t => {
  await admin`INSERT INTO users (id, email, password_hash, role)
    VALUES (${userId}, ${`self-edit-${userId}@example.test`}, 'test', 'owner')`;
  await admin`INSERT INTO workspaces (id, name, owner_id) VALUES (${workspaceId}, '合成人格测试', ${userId})`;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userId}, 'owner')`;
  await admin`INSERT INTO companion_conversations (id, workspace_id, user_id, kind, title, title_source, status)
    VALUES (${conversationId}, ${workspaceId}, ${userId}, 'dialogue', '合成对话', 'system', 'active')`;

  await t.test("首次写入锁定账号、排队不改变当前，同一回合的第二项自改保留第一项", async () => {
    const first = await edit("speakingStyle", "自然接眼前的话，不复述无关清单", 0);
    assert.equal(first.kind, "changed");
    const staged = await read();
    assert.equal(staged.profileRevision, 0);
    assert.equal(staged.profile, null);
    assert.equal(staged.pending?.revision, 1);
    assert.equal(staged.pending?.author, "assistant_tool");
    assert.deepEqual(staged.pending?.moduleScope, ["companion"]);
    const [version] = await admin`SELECT source_workspace_id FROM companion_persona_profile_versions WHERE user_id = ${userId} AND revision = 1`;
    assert.equal(version.source_workspace_id, workspaceId);
    assert.equal((await edit("personalityTags", ["松弛", "直率"], 0)).kind, "changed");
    const twice = await read();
    assert.equal(twice.pending?.revision, 2);
    assert.equal(twice.pending?.profile?.speakingStyle, staged.pending?.profile?.speakingStyle);
    assert.deepEqual(twice.pending?.profile?.personalityTags, ["松弛", "直率"]);
    assert.equal((await edit("personalityTags", ["松弛", "直率"], 0)).kind, "unchanged");
    assert.equal((await read()).pending?.revision, 2);
  });

  const request = { ...scope, conversationId, idempotencyKey: randomUUID(), body: body(randomUUID()) };
  let runId = "";
  await t.test("同一个持久对话中新用户回合自动采用，读取页面不会采用", async () => {
    assert.equal((await read()).profileRevision, 0);
    const result = await createCompanionTurn(request);
    runId = (result.body as { runId: string }).runId;
    assert.equal(result.statusCode, 202);
    const state = await read();
    assert.equal(state.profileRevision, 2);
    assert.equal(state.pending, null);
    assert.equal(state.profile?.speakingStyle, "自然接眼前的话，不复述无关清单");
    // Worker 在首次调用时固定版本；随后自改不能重写该 run 的身份。
    await admin`UPDATE companion_turn_runs SET persona_profile_revision = 2, persona_examples_revision = 2 WHERE id = ${runId}`;
  });

  await t.test("幂等重放、非法输入和被拒绝的并发回合都不消耗待生效版本", async () => {
    assert.equal((await edit("speakingStyle", "用短句回应，允许停在一句话", 2)).kind, "changed");
    assert.equal((await read()).pending?.revision, 3);
    assert.equal((await createCompanionTurn(request)).statusCode, 200);
    await assert.rejects(() => createCompanionTurn({ ...request, idempotencyKey: randomUUID(), body: { version: 99 } }));
    await assert.rejects(() => createCompanionTurn({ ...request, idempotencyKey: randomUUID(), body: body(randomUUID()) }),
      (error: unknown) => (error as { code?: string }).code === "RUN_ALREADY_ACTIVE");
    assert.equal((await read()).profileRevision, 2);
    assert.equal((await read()).pending?.revision, 3);
    const [pinned] = await admin`SELECT persona_profile_revision FROM companion_turn_runs WHERE id = ${runId}`;
    assert.equal(pinned.persona_profile_revision, 2);
    await admin`UPDATE companion_turn_runs SET status = 'succeeded', finished_at = now() WHERE id = ${runId}`;
    await createCompanionTurn({ ...request, idempotencyKey: randomUUID(), body: body(randomUUID()) });
    assert.equal((await read()).profileRevision, 3);
    assert.equal((await read()).pending, null);
  });

  await t.test("用户新设置优先于旧调用中的自改，也优先于待生效内容", async () => {
    assert.equal((await edit("speakingStyle", "另一种合成风格", 3)).kind, "changed");
    const current = await read();
    const saved = await withWorkspaceTransaction(scope, tx => upsertPetProfile(tx, scope,
      { ...base, revision: current.profileRevision, speakingStyle: "用户亲自写的语气" }));
    assert.equal(saved.revision, 5);
    assert.equal((await read()).pending, null);
    assert.equal((await edit("speakingStyle", "旧模型迟到的提议", 3)).kind, "conflict");
    assert.equal((await read()).profile?.speakingStyle, "用户亲自写的语气");
  });

  await t.test("模型不能覆盖用户待确认的草稿；新回合也不擅自激活用户草稿", async () => {
    await withWorkspaceTransaction(scope, tx => stagePetProfileRevision(tx, scope,
      { ...base, revision: 5, speakingStyle: "用户尚未激活的草稿" }, new Date(), { author: "user" }));
    assert.equal((await edit("speakingStyle", "抢占草稿", 5)).kind, "conflict");
    await admin`UPDATE companion_turn_runs SET status = 'succeeded', finished_at = now() WHERE conversation_id = ${conversationId}`;
    await createCompanionTurn({ ...request, idempotencyKey: randomUUID(), body: body(randomUUID()) });
    assert.equal((await read()).profileRevision, 5);
    assert.equal((await read()).pending?.profile?.speakingStyle, "用户尚未激活的草稿");
  });

  await t.test("用户明确修改表达分量时清空排队，号排在历史队尾，CHECK 不会阻断", async () => {
    const result = await edit("activeness", base.activeness === "quiet" ? "active" : "quiet", 5, false);
    assert.equal(result.kind, "changed");
    assert.equal((await read()).profileRevision, 7);
    assert.equal((await read()).pending, null);
  });

  await t.test("并发首次自改不会重复第1版，也不会丢掉另一项改动", async () => {
    await admin`INSERT INTO users (id, email, password_hash, role)
      VALUES (${raceUserId}, ${`self-edit-race-${raceUserId}@example.test`}, 'test', 'member')`;
    await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${raceUserId}, 'member')`;
    const raceScope = { workspaceId, userId: raceUserId };
    const outcomes = await Promise.all([
      withWorkerWorkspaceTransaction(raceScope, tx => applyAssistantPersonaEdit(tx, raceUserId,
        "speakingStyle", "并发保存的合成风格", "合成并发依据", { stage: true, expectedRevision: 0 })),
      withWorkerWorkspaceTransaction(raceScope, tx => applyAssistantPersonaEdit(tx, raceUserId,
        "personalityTags", ["直率"], "合成并发依据", { stage: true, expectedRevision: 0 })),
    ]);
    assert.deepEqual(outcomes.map(result => result.kind), ["changed", "changed"]);
    const state = await withWorkspaceTransaction(raceScope, tx => getPetProfileState(tx, raceScope));
    assert.equal(state.profileRevision, 0);
    assert.equal(state.pending?.revision, 2);
    assert.equal(state.pending?.profile?.speakingStyle, "并发保存的合成风格");
    assert.deepEqual(state.pending?.profile?.personalityTags, ["直率"]);
  });
});

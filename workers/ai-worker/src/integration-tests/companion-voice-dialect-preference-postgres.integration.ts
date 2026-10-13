/**
 * 账号级长期默认方言的真实读写回路（0075/0421 的授权形状 + RLS）。
 *
 * 这条链只能靠真库证明：判定与写入在 **worker**（受限角色 astella_worker），
 * 朗读时读偏好在 **API**（astella_api），两边写的还是同一行 `workspace_id IS NULL`
 * 的账号级记录。任何一侧少了 GRANT，用户在对话里说「以后都用河南话」就只会得到
 * 一句「记住了」，下一轮声音照旧——所以这里断言的是**下一次读取看到什么**。
 *
 * 覆盖：worker 首次写入 → API 读出方言并进合成选择；重复写同值不产生变更;
 * API 侧改默认方言 → worker 读得到（正文生成走这条读）；worker clear 回普通话
 * 时**不吞掉**用户另存的音色/语速描述（那是另一条独立偏好）。
 *
 * 运行（一次性库；变量缺了当场抛，绝不落到 dev 库）：
 *   cd workers/ai-worker && node --import tsx --test --test-concurrency=1 \
 *     src/integration-tests/companion-voice-dialect-preference-postgres.integration.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import type { AgentPersistentVoicePreferenceV1 } from "@astella/shared/agent-contracts";

// worker 的 db.ts 在 import 时就固定连接串，必须先设角色变量。
process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");
process.env.DATABASE_URL_API ??= testDatabaseUrl("DATABASE_URL_API");

const tag = randomUUID();
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });

const { withWorkerWorkspaceTransaction, closeDatabase: closeWorkerDatabase } = await import("../db.ts");
const { persistCompanionDialectPreference, readCompanionDialectPreference } = await import("../handlers/companion-voice-preference.ts");
const { closeDatabase: closeApiDatabase } = await import("../../../../apps/api/src/db/client.ts");
const { getStoredVoicePreference, setVoicePreference } = await import("../../../../apps/api/src/modules/companion-shell/service.ts");
const { resolveTtsSelection } = await import("../../../../apps/api/src/modules/learning-sessions/voice-providers/tts-preference.ts");
const { loadTtsEngineConfig } = await import("../../../../apps/api/src/modules/learning-sessions/voice-providers/tts-config.ts");

const scopes: Array<{ workspaceId: string; userId: string }> = [];
type Scope = { workspaceId: string; userId: string };

async function fixture(): Promise<{ workspaceId: string; userId: string }> {
  const created = { workspaceId: randomUUID(), userId: randomUUID() };
  scopes.push(created);
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES
      (${created.userId},${`dialect-${tag}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES
      (${created.workspaceId},${`dialect-${tag}`},${created.userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role)
      VALUES (${created.workspaceId},${created.userId},'owner')`;
  });
  return created;
}

const workerRead = (scope: Scope) => withWorkerWorkspaceTransaction(scope, () => readCompanionDialectPreference(scope));
const workerPersist = (scope: Scope, change: AgentPersistentVoicePreferenceV1) =>
  persistCompanionDialectPreference({ ...scope, change });
// 路由层就是这么直接调这两个 service（它们自己开事务），测试不另包一层。
const apiStored = (scope: Scope) => getStoredVoicePreference(scope.userId, scope.workspaceId);

after(async () => {
  try {
    for (const created of scopes) {
      await admin`DELETE FROM workspace_members WHERE workspace_id=${created.workspaceId}`;
      await admin`DELETE FROM workspaces WHERE id=${created.workspaceId}`;
      await admin`DELETE FROM users WHERE id=${created.userId}`;
    }
    const [left] = await admin`SELECT count(*)::int AS n FROM users WHERE email LIKE ${`dialect-%@test.invalid`}`;
    assert.equal(Number(left.n), 0, "夹具用户没清干净");
  } finally {
    await admin.end({ timeout: 2 });
    await closeWorkerDatabase();
    await closeApiDatabase();
  }
});

test("worker 保存的长期方言被 API 读出并进入合成选择，clear 不吞掉音色描述", async () => {
  const scope = await fixture();

  assert.equal(await workerRead(scope), null, "新账号没有保存过方言");
  assert.equal((await apiStored(scope)).stored, null);

  assert.equal(await workerPersist(scope, { action: "set", dialect: "河南话" }), "saved");
  const stored = await apiStored(scope);
  assert.equal(stored.stored?.dialect, "河南话");
  assert.equal(resolveTtsSelection(stored.stored, loadTtsEngineConfig()).qwenDialect, "河南话",
    "合成侧读同一行就拿到本轮默认方言");
  await admin.begin(async tx => {
    const [row] = await tx`SELECT workspace_id FROM user_learning_preferences WHERE user_id=${scope.userId}`;
    assert.equal(row.workspace_id, null, "长期方言是账号级一行，跨设备/跨空间都跟着人");
  });

  assert.equal(await workerPersist(scope, { action: "set", dialect: "河南话" }), "unchanged",
    "重复说同一个默认不产生第二次写入");

  // 用户在设置里改成四川话，并另存一条音色/语速描述：worker 下一轮要读得到新默认。
  await setVoicePreference(
    scope.userId, scope.workspaceId, "qwen", "longhua_v3.1", "声音温柔，语速偏慢", "四川话",
  );
  assert.equal(await workerRead(scope), "四川话");

  // 「以后都用普通话」清掉方言，但不碰独立的音色/语速描述与音色选择。
  assert.equal(await workerPersist(scope, { action: "clear", dialect: null }), "saved");
  assert.equal(await workerRead(scope), null);
  const after = await apiStored(scope);
  assert.equal(after.stored?.dialect, undefined);
  assert.equal(after.stored?.instruction, "声音温柔，语速偏慢");
  assert.equal(after.stored?.engine, "qwen");
  assert.equal(after.stored?.voice, "longhua_v3.1");
});

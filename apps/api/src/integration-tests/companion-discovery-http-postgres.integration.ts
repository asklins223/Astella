import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";

process.env.COMPANION_DAILY_SUMMARY_V1 = "true";
const admin = postgres(testDatabaseUrl("DATABASE_URL_TEST_ADMIN"), { max: 2 });
const restricted = postgres(testDatabaseUrl("DATABASE_URL_API"), { max: 1 });
const { companionDiscoveryRoutes } = await import("../modules/companion-conversation/discovery/discovery-routes.ts");
const { dailySummaryRoutes, maskDiaryAndExcerptsForRevokedSources } = await import("../modules/companion-conversation/daily-summary-routes.ts");
const { issueSession, revokeSession } = await import("../modules/identity/service.ts");
const { withWorkspaceTransaction, closeDatabase } = await import("../db/client.ts");

const userA = randomUUID();
const userB = randomUUID();
const workspaceId = randomUUID();
let tokenA = "";
let tokenB = "";
let app: FastifyInstance;
const envelope = (request: unknown) => ({ meta: { requestId: randomUUID() }, request });
const headers = (token = tokenA) => ({ authorization: `Bearer ${token}` });

before(async () => {
  const role = await restricted`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  assert.equal(role[0]?.rolsuper, false, "HTTP 路径必须使用受限角色");
  assert.equal(role[0]?.rolbypassrls, false);
  await admin`INSERT INTO users (id, email, password_hash, role) VALUES (${userA}, ${`discovery-a-${userA}@example.test`}, 'test', 'owner'), (${userB}, ${`discovery-b-${userB}@example.test`}, 'test', 'owner')`;
  await admin`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES (${workspaceId}, '发现簿接口回归', ${userA}, 'collaborative')`;
  await admin`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${workspaceId}, ${userA}, 'owner'), (${workspaceId}, ${userB}, 'member')`;
  tokenA = (await issueSession(userA, workspaceId)).token;
  tokenB = (await issueSession(userB, workspaceId)).token;
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(companionDiscoveryRoutes);
  await app.register(dailySummaryRoutes);
  await app.ready();
});
after(async () => {
  if (tokenA) await revokeSession(tokenA);
  if (tokenB) await revokeSession(tokenB);
  await app?.close();
  await admin`DELETE FROM companion_discovery_entries WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM companion_daily_summaries WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspace_members WHERE workspace_id = ${workspaceId}`;
  await admin`DELETE FROM workspaces WHERE id = ${workspaceId}`;
  await admin`DELETE FROM users WHERE id IN (${userA}, ${userB})`;
  await restricted.end();
  await admin.end();
  await closeDatabase();
});

test("HTTP 收藏→状态→批注→取消→再收藏：身份不重复，已有批注保留，私人内容不跨成员", async () => {
  const identity = { kind: "kept_ai_suggestion", source: "assistant_reply", sourceId: randomUUID() };
  const request = { ...identity, author: "assistant", body: "想把这段原话留给以后回看。" };
  const anonymous = await app.inject({ method: "POST", url: "/companion/discovery", payload: envelope(request) });
  assert.equal(anonymous.statusCode, 401);
  const malformed = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: { request } });
  assert.equal(malformed.statusCode, 400, "缺少 HTTP meta 仍是无效请求，网关应补齐");
  const saved = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: envelope(request) });
  assert.equal(saved.statusCode, 201, saved.body);
  const entryId = saved.json().entry.entryId;
  assert.equal(saved.json().entry.visibility, "private");
  const state = await app.inject({ method: "GET", url: `/companion/discovery/state?${new URLSearchParams(identity)}`, headers: headers() });
  assert.equal(state.json().collected, true);
  assert.equal(state.json().entryId, entryId);
  const annotation = await app.inject({ method: "POST", url: "/companion/discovery/annotate", headers: headers(), payload: envelope({ entryId, annotation: "我想再核对一下这句。" }) });
  assert.equal(annotation.statusCode, 200, annotation.body);
  const crossUser = await app.inject({ method: "GET", url: "/companion/discovery", headers: headers(tokenB) });
  assert.deepEqual(crossUser.json().entries, []);
  const uncollected = await app.inject({ method: "POST", url: "/companion/discovery/uncollect", headers: headers(), payload: envelope(identity) });
  assert.equal(uncollected.statusCode, 200, uncollected.body);
  const again = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: envelope(request) });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().entry.entryId, entryId);
  assert.equal(again.json().entry.annotation, "我想再核对一下这句。");
  const rows = await admin`SELECT count(*)::int AS n FROM companion_discovery_entries WHERE workspace_id = ${workspaceId} AND source_id = ${identity.sourceId}`;
  assert.equal(rows[0]?.n, 1);
});

async function diary(date: string, eventId: string) {
  await admin`INSERT INTO companion_daily_summaries (workspace_id, user_id, date, timezone, facts, summary, source_event_ids) VALUES (${workspaceId}, ${userA}, ${date}, 'Asia/Shanghai', '{}', '第一段。第二段。', ARRAY[${eventId}])`;
  for (let paragraph = 0; paragraph < 2; paragraph++) {
    const response = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: envelope({ kind: "diary_excerpt", source: "diary", sourceId: `${date}:v1:b0:p${paragraph}`, author: "assistant", body: `第 ${paragraph + 1} 段原话。` }) });
    assert.equal(response.statusCode, 201, response.body);
  }
}
test("同一天的摘录各自保存，删除日记清除该日期所有段落，其他日期不受影响", async () => {
  await diary("2026-10-01", "delete-source");
  await diary("2026-10-02", "keep-source");
  const response = await app.inject({ method: "POST", url: "/companion/daily/2026-10-01/delete", headers: headers(), payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  const deleted = await admin`SELECT count(*)::int AS n FROM companion_discovery_entries WHERE workspace_id = ${workspaceId} AND split_part(source_id, ':', 1) = '2026-10-01'`;
  const kept = await admin`SELECT count(*)::int AS n FROM companion_discovery_entries WHERE workspace_id = ${workspaceId} AND split_part(source_id, ':', 1) = '2026-10-02'`;
  assert.equal(deleted[0]?.n, 0);
  assert.equal(kept[0]?.n, 2);
  const stale = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: envelope({ kind: "diary_excerpt", source: "diary", sourceId: "2026-10-01:v1:b0:p0", author: "assistant", body: "已删除的原话。" }) });
  assert.equal(stale.statusCode, 404, "旧页面不能重新收藏已删除的日记");
  const invalidDate = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: envelope({ kind: "diary_excerpt", source: "diary", sourceId: "2026-13-01:v1:b0:p0", author: "assistant", body: "日期无效。" }) });
  assert.equal(invalidDate.statusCode, 404, "无效日期不应触发数据库异常");
  const otherVersion = await app.inject({ method: "POST", url: "/companion/discovery", headers: headers(), payload: envelope({ kind: "diary_excerpt", source: "diary", sourceId: "2026-10-02:v2:b0:p0", author: "assistant", body: "不属于当前版本。" }) });
  assert.equal(otherVersion.statusCode, 404);
});
test("来源撤权会遮蔽带版本与段落身份的新摘录", async () => {
  const scope = { workspaceId, userId: userA };
  const outcome = await withWorkspaceTransaction(scope, tx => maskDiaryAndExcerptsForRevokedSources(tx, scope, { eventIds: ["keep-source"] }));
  assert.deepEqual(outcome.maskedDiaryDates, ["2026-10-02"]);
  assert.equal(outcome.maskedEntries, 2);
  const book = await app.inject({ method: "GET", url: "/companion/discovery", headers: headers() });
  assert.equal(book.statusCode, 200, book.body);
  assert.equal(book.json().entries.some((entry: { source: string }) => entry.source === "diary"), false);
});

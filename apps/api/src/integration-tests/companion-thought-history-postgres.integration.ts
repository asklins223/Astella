/** 手记念想历史：真实 RLS、微秒游标、可见状态以及只读回看。使用显式一次性数据库。 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@ailearn/shared/integration-test-db-env";
import { closeDatabase } from "../db/client.ts";
import { listCompanionThoughts } from "../modules/companion-conversation/turn/thought-history.ts";

const fixture = postgres(testDatabaseUrl("DATABASE_URL"), { max: 2 });
const user = randomUUID(), other = randomUUID(), spaceA = randomUUID(), spaceB = randomUUID();
const visible = [randomUUID(), randomUUID(), ...[randomUUID(), randomUUID()].sort().reverse()];
const hidden = randomUUID(), crossSpace = randomUUID(), crossUser = randomUUID();
const list = (before?: string, limit = 30, workspaceId = spaceA, userId = user) => listCompanionThoughts({ workspaceId, userId,
  request: { version: 1, limit, ...(before ? { before } : {}) } });
before(async () => {
  await fixture`INSERT INTO users (id, email, password_hash, role) VALUES (${user}, ${`journal-${user}@example.test`}, 'test-hash', 'owner'), (${other}, ${`journal-${other}@example.test`}, 'test-hash', 'owner')`;
  await fixture`INSERT INTO workspaces (id, name, owner_id, workspace_type) VALUES (${spaceA}, '念想书房', ${user}, 'collaborative'), (${spaceB}, '念想书房', ${user}, 'collaborative')`;
  await fixture`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${spaceA}, ${user}, 'owner'), (${spaceB}, ${user}, 'owner'), (${spaceA}, ${other}, 'member')`;
  const rows = [
    [visible[0], spaceA, user, "delivered", "2026-10-05T01:00:00.000901Z", null],
    [visible[1], spaceA, user, "spent", "2026-10-05T01:00:00.000900Z", "2026-10-05T02:00:00Z"],
    [visible[2], spaceA, user, "expired", "2026-10-05T01:00:00.000899Z", null],
    [visible[3], spaceA, user, "expired", "2026-10-05T01:00:00.000899Z", null],
    [hidden, spaceA, user, "candidate", null, null],
    [randomUUID(), spaceA, user, "suppressed", "2026-10-05T03:00:00Z", null],
    [randomUUID(), spaceA, user, "expired", null, null],
    [crossSpace, spaceB, user, "delivered", "2026-10-05T03:00:00Z", null],
    [crossUser, spaceA, other, "delivered", "2026-10-05T03:00:00Z", null],
  ];
  for (const [id, workspaceId, userId, status, deliveredAt, openedAt] of rows) {
    await fixture`INSERT INTO assistant_thoughts (id, workspace_id, user_id, source, topic, dedupe_key, text, status, expires_at, delivered_at, opened_at)
      VALUES (${id}, ${workspaceId}, ${userId}, 'llm', 'journal-test', ${id}, '曾经表达的念想。', ${status}, '2026-10-06T01:00:00Z', ${deliveredAt}::text::timestamptz, ${openedAt})`;
  }
});
after(async () => {
  await fixture`DELETE FROM workspaces WHERE id IN (${spaceA}, ${spaceB})`;
  await fixture`DELETE FROM users WHERE id IN (${user}, ${other})`;
  await fixture.end(); await closeDatabase();
});

test("only expressed thoughts from this member in this space are visible, including spent and expired history", async () => {
  const result = await list();
  assert.deepEqual(result.items.map(item => item.id), visible);
  assert.deepEqual(result.items.map(item => item.status), ["delivered", "spent", "expired", "expired"]);
  assert.equal(result.items[1].openedAt, "2026-10-05T02:00:00.000Z");
  assert.equal(result.nextBefore, null);
  assert.deepEqual((await list(undefined, 30, spaceB)).items.map(item => item.id), [crossSpace]);
  assert.deepEqual((await list(undefined, 30, spaceA, other)).items.map(item => item.id), [crossUser]);
});

test("pagination preserves PostgreSQL microsecond ordering even when displayed ISO dates share the same millisecond", async () => {
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor, 1);
    seen.push(...page.items.map(item => item.id)); cursor = page.nextBefore ?? undefined;
  } while (cursor);
  assert.deepEqual(seen, visible);
});

test("cross-space, cross-member, hidden and missing cursors are rejected instead of resetting to the first page", async () => {
  for (const cursor of [crossSpace, crossUser, hidden, randomUUID()]) {
    await assert.rejects(list(cursor), (error: unknown) => (error as { code?: string }).code === "NOT_FOUND");
  }
});

test("browsing history does not consume a thought, mark it opened or create a conversation", async () => {
  const snapshot = () => fixture`SELECT id, status, opened_at, updated_at FROM assistant_thoughts WHERE workspace_id = ${spaceA} AND user_id = ${user} ORDER BY id`;
  const before = await snapshot();
  const conversations = await fixture`SELECT count(*)::int AS n FROM companion_conversations WHERE workspace_id = ${spaceA} AND user_id = ${user}`;
  await list(); await list(visible[0], 1);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await fixture`SELECT count(*)::int AS n FROM companion_conversations WHERE workspace_id = ${spaceA} AND user_id = ${user}`, conversations);
});

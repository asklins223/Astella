import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { getCompanionAgentTool } from "@astella/shared";
import type { AgentEventContext } from "../handlers/companion-read-tools.ts";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
process.env.DATABASE_URL_WORKER ??= testDatabaseUrl("DATABASE_URL_WORKER");
const { withWorkerWorkspaceTransaction, closeDatabase } = await import("../db.ts");
const { searchPastConversationMessages, searchPastConversationSummaries, readPastConversationMessages } =
  await import("../handlers/companion-summary-retrieval.ts");
const { executeReadTool } = await import("../handlers/companion-tool-execution.ts");
const scope = { workspaceId: randomUUID(), userId: randomUUID() };
const peerId = randomUUID(), otherWorkspaceId = randomUUID();
const ids = { current: randomUUID(), old: randomUUID(), summarized: randomUUID(), peer: randomUUID(), other: randomUUID(),
  paged: randomUUID(), long: randomUUID(), literal: randomUUID(), journey: randomUUID() };
const failedRun = randomUUID();
const failedQuestion = "UnsummarizedNeedle：P(A)=0 不能推出严格集合包含；最后限制：只核对原文，不重新执行旧请求。";
const longText = "🫧原文\r\n".repeat(4_000) + "最后更正：尚未提交。";
let failedMessageId = "";

async function addMessage(conversationId: string, seq: number, role: "user" | "assistant", text: string,
  workspaceId = scope.workspaceId, userId = scope.userId) {
  const id = randomUUID();
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256,created_at)
    VALUES(${id},${workspaceId},${userId},${conversationId},${seq},${role},'text',
      ${admin.json([{ type: "text", text }])},${sha256Utf8V1(text)},'2026-10-03T02:03:04Z')`;
  return id;
}

after(async () => {
  await admin.begin(async tx => {
    await tx`SET LOCAL app.allow_history_mutation = 'on'`;
    await tx`DELETE FROM companion_turn_runs WHERE id=${failedRun}`;
    await tx`DELETE FROM conversation_summaries WHERE workspace_id IN (${scope.workspaceId},${otherWorkspaceId})`;
    await tx`DELETE FROM companion_messages WHERE workspace_id IN (${scope.workspaceId},${otherWorkspaceId})`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id IN (${scope.workspaceId},${otherWorkspaceId})`;
    await tx`DELETE FROM workspace_members WHERE workspace_id IN (${scope.workspaceId},${otherWorkspaceId})`;
    await tx`DELETE FROM workspaces WHERE id IN (${scope.workspaceId},${otherWorkspaceId})`;
    await tx`DELETE FROM users WHERE id IN (${scope.userId},${peerId})`;
  });
  await admin.end({ timeout: 2 });
  await closeDatabase();
});

await admin`INSERT INTO users(id,email,password_hash,display_name) VALUES
  (${scope.userId},${`history-${scope.userId}@example.test`},'x','History owner'),
  (${peerId},${`history-${peerId}@example.test`},'x','History peer')`;
await admin`INSERT INTO workspaces(id,owner_id,name) VALUES
  (${scope.workspaceId},${scope.userId},'History retrieval fixture'),
  (${otherWorkspaceId},${scope.userId},'Other history workspace')`;
await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES
  (${scope.workspaceId},${scope.userId},'owner'),(${scope.workspaceId},${peerId},'member'),
  (${otherWorkspaceId},${scope.userId},'owner')`;
for (const [name, id] of Object.entries(ids)) {
  await admin`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
    VALUES(${id},${name === "other" ? otherWorkspaceId : scope.workspaceId},${name === "peer" ? peerId : scope.userId},
      ${name === "journey" ? "journey" : "dialogue"},${`History ${name}`},'user',${name === "old" ? "archived" : "active"})`;
}
await addMessage(ids.old, 1, "user", "The earlier exchange.");
await addMessage(ids.old, 2, "assistant", "An actual earlier answer.");
failedMessageId = await addMessage(ids.old, 3, "user", failedQuestion);
await admin`INSERT INTO companion_turn_runs(id,workspace_id,user_id,conversation_id,user_message_id,generation,status,
    idempotency_key_hash,request_body_hash,finished_at)
  VALUES(${failedRun},${scope.workspaceId},${scope.userId},${ids.old},${failedMessageId},1,'failed',
    ${"a".repeat(64)},${"b".repeat(64)},now())`;
await addMessage(ids.current, 1, "user", failedQuestion);
await addMessage(ids.peer, 1, "user", failedQuestion, scope.workspaceId, peerId);
await addMessage(ids.other, 1, "user", failedQuestion, otherWorkspaceId);
await addMessage(ids.summarized, 1, "user", "SummaryPrefixOnly");
await addMessage(ids.summarized, 2, "assistant", "An already summarized answer.");
await addMessage(ids.summarized, 3, "user", "UncoveredTailNeedle first addition");
await addMessage(ids.summarized, 4, "user", "second addition");
await addMessage(ids.summarized, 5, "assistant", "UncoveredTailNeedle answer");
await admin`INSERT INTO conversation_summaries(id,workspace_id,user_id,conversation_id,summary,status,
    coverage_from_seq,coverage_through_seq,coverage_source_hash)
  VALUES(${randomUUID()},${scope.workspaceId},${scope.userId},${ids.summarized},
    ${admin.json({ title: "SummaryPrefixOnly", keyEvents: [], followUps: [], userPreferences: [] })},'confirmed',1,2,${"c".repeat(64)})`;
for (let index = 0; index < 25; index++) await addMessage(ids.paged, 1 + index * 2,
  index % 2 ? "assistant" : "user", `complete source ${index + 1}`);
await addMessage(ids.long, 1, "user", longText);
await addMessage(ids.long, 3, "assistant", "The next complete message.");
await addMessage(ids.literal, 1, "user", "百分号 % 和下划线 _ 是原文。 ");
await addMessage(ids.journey, 1, "user", "JourneyHistoryNeedle");
await admin`UPDATE companion_messages SET created_at='2026-10-15T07:10:14.518Z' WHERE id=${failedMessageId}`;
const greetingId = await addMessage(ids.old, 4, "assistant", "The later greeting does not answer the failed question.");
await admin`UPDATE companion_messages SET created_at='2026-10-15T08:38:02.215Z' WHERE id=${greetingId}`;

const clock = { observedAt: "2026-10-15T09:03:12Z", timezone: "Asia/Shanghai", currentMessageCreatedAt: "2026-10-15T09:03:12Z" };

const read = <T>(fn: Parameters<typeof withWorkerWorkspaceTransaction<T>>[1]) => withWorkerWorkspaceTransaction(scope, fn);

test("unsummarized failed turns are discoverable with source and terminal identity; peers, other workspaces and current conversation stay excluded", async () => {
  const hits = await read(tx => searchPastConversationMessages(tx, scope,
    { query: "UnsummarizedNeedle", excludeConversationId: ids.current }));
  assert.equal(hits.length, 1);
  const hit = hits[0]!;
  assert.equal(hit.conversationId, ids.old);
  assert.equal(hit.messageId, failedMessageId);
  assert.equal(hit.sourceHash, sha256Utf8V1(failedQuestion));
  assert.equal(hit.replyStatus, "failed");
  assert.equal(hit.fromSeq, "3");
  const page = await read(tx => readPastConversationMessages(tx, scope, { conversationId: hit.conversationId, fromSeq: hit.fromSeq, clock }));
  assert.equal(page.messages[0]!.text, failedQuestion);
  assert.equal(page.messages[0]!.replyStatus, "failed");
  assert.equal(page.messages[0]!.sourceHash, hit.sourceHash);
  assert.equal(page.messages[0]!.messageId, hit.messageId);
  assert.equal(page.messages[0]!.createdAt, "2026-10-15T07:10:14.518Z");
  assert.equal(page.messages[0]!.time.localDateTime, "2026-10-15 15:10:14");
  assert.equal(page.messages[1]!.time.gapFromPreviousMs, 5_267_697);
  assert.equal(page.messages[1]!.time.gapFromPrevious, "1 小时 27 分钟 47 秒");
  for (const conversationId of [ids.peer, ids.other]) {
    const denied = await read(tx => readPastConversationMessages(tx, scope, { conversationId, fromSeq: "1" }));
    assert.deepEqual(denied.messages, []);
  }
});

test("a summarized conversation's uncovered tail remains searchable and locates all user additions before an assistant match", async () => {
  const summaries = await read(tx => searchPastConversationSummaries(tx, scope, { query: "UncoveredTailNeedle" }));
  assert.equal(summaries.length, 0);
  const hits = await read(tx => searchPastConversationMessages(tx, scope, { query: "UncoveredTailNeedle" }));
  assert.equal(hits.length, 2);
  const assistant = hits.find(hit => hit.role === "assistant")!;
  assert.equal(assistant.matchedSeq, "5");
  assert.equal(assistant.fromSeq, "3");
  const page = await read(tx => readPastConversationMessages(tx, scope, { conversationId: assistant.conversationId, fromSeq: assistant.fromSeq }));
  assert.deepEqual(page.messages.map(message => message.seq), ["3", "4", "5"]);
});

test("literal wildcard queries never become an unfiltered history scan", async () => {
  for (const query of ["%", "_"]) {
    const hits = await read(tx => searchPastConversationMessages(tx, scope, { query }));
    assert.deepEqual(hits.map(hit => hit.conversationId), [ids.literal]);
    assert.deepEqual(await read(tx => searchPastConversationSummaries(tx, scope, { query })), []);
  }
});

test("a journey conversation does not require a summary before its source can be found", async () => {
  const hits = await read(tx => searchPastConversationMessages(tx, scope, { query: "JourneyHistoryNeedle" }));
  assert.deepEqual(hits.map(hit => hit.conversationId), [ids.journey]);
});

test("the actual conversation-recall tool searches source records and retrieves the exact failed question", async () => {
  const event = { ctx: { workspaceId: scope.workspaceId }, read: { userId: scope.userId, conversationId: ids.current, conversationClock: clock },
    constraints: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() } as AgentEventContext;
  const definition = getCompanionAgentTool("companion_recall_past_conversation")!;
  const result = await executeReadTool(event, definition, { query: "UnsummarizedNeedle", limit: 1 });
  const value = result.value as { hits: Array<{ sourceKind: string; conversationId: string; fromSeq: string }>;
    searchScope: { exhaustive: boolean; sourceStatus: Record<string, string> } };
  assert.equal(value.hits.length, 1);
  assert.equal(value.hits[0]!.sourceKind, "transcript");
  assert.equal(value.hits[0]!.conversationId, ids.old);
  assert.equal(value.searchScope.exhaustive, false);
  assert.ok(Object.values(value.searchScope.sourceStatus).every(status => status === "searched"));
  const source = await executeReadTool(event, definition, { query: "UnsummarizedNeedle",
    conversationId: value.hits[0]!.conversationId, fromSeq: Number(value.hits[0]!.fromSeq) });
  const messages = source.value.messages as Array<{ text: string; replyStatus: string }>;
  assert.equal(messages[0]!.text, failedQuestion);
  assert.equal(messages[0]!.replyStatus, "failed");
  const invalid = await executeReadTool(event, definition, { query: "UnsummarizedNeedle", conversationId: ids.old });
  assert.match(invalid.safeSummary, /尚未检索/);
  assert.equal("searchScope" in invalid.value, false, "a rejected request must not claim that a search took place");
});

test("actual database paging sees the 21st row and uses source sequences across gaps", async () => {
  const page = await read(tx => readPastConversationMessages(tx, scope, { conversationId: ids.paged, fromSeq: "1" }));
  assert.equal(page.messages.length, 20);
  assert.equal(page.throughSeq, "39");
  assert.equal(page.truncated, true);
  assert.equal(page.nextFromSeq, "41");
  const last = await read(tx => readPastConversationMessages(tx, scope, { conversationId: ids.paged, fromSeq: page.nextFromSeq! }));
  assert.equal(last.messages.length, 5);
  assert.equal(last.truncated, false);
  assert.equal(last.nextFromSeq, null);
  assert.deepEqual([...page.messages, ...last.messages].map(message => message.text),
    Array.from({ length: 25 }, (_, index) => `complete source ${index + 1}`));
  const bounded = await read(tx => readPastConversationMessages(tx, scope,
    { conversationId: ids.paged, fromSeq: "1", throughSeq: "5" }));
  assert.deepEqual(bounded.messages.map(message => message.seq), ["1", "3", "5"]);
  assert.equal(bounded.nextFromSeq, null);
});

test("an oversized source message remains intact and pages the next whole message explicitly", async () => {
  const page = await read(tx => readPastConversationMessages(tx, scope, { conversationId: ids.long, fromSeq: "1" }));
  assert.equal(page.messages[0]!.text, longText);
  assert.equal(page.truncated, true);
  assert.equal(page.nextFromSeq, "3");
  const next = await read(tx => readPastConversationMessages(tx, scope, { conversationId: ids.long, fromSeq: page.nextFromSeq! }));
  assert.equal(next.messages[0]!.text, "The next complete message.");
  assert.equal(next.nextFromSeq, null);
});

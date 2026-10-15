/** Production summary handler and real PostgreSQL fences; scripted model
 * output checks orchestration, not semantic quality of an actual provider. */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { canonicalJsonV1, sha256Utf8V1 } from "@astella/shared/content-hash";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import type { ChatMessage, ChatOptions } from "@astella/shared";

delete process.env.TOKENRHYTHM_API_KEY;
delete process.env.AI_PLATFORMS_CONFIG;
process.env.MOCK_CONTEXT_WINDOW_TOKENS = "16384";
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
const { MockProvider } = await import("../lib/providers/mock.ts");
const { runCompanionSummarizer, buildSummarizerSnapshot, toSummarizerSnapshotRows } = await import("../handlers/companion-summarizer.ts");
const { withWorkerWorkspaceTransaction, closeDatabase } = await import("../db.ts");
const { readCompanionHistoryRows } = await import("../handlers/companion-dialogue-store.ts");
const originalCompletion = MockProvider.prototype.chatCompletion;
after(async () => { MockProvider.prototype.chatCompletion = originalCompletion; await admin.end({ timeout: 2 }); await closeDatabase(); });

async function fixture() {
  const scope = { userId: randomUUID(), workspaceId: randomUUID() };
  const conversationId = randomUUID(), jobId = randomUUID();
  const payload = { conversationId, userId: scope.userId };
  const longText = "EARLY_CONSTRAINT\n" + "One continuous source message, without any dropped middle.\n".repeat(900) + "LATE_CORRECTION";
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash) VALUES(${scope.userId},${`complete-summary-${scope.userId}@test.invalid`},'fixture')`;
    await tx`INSERT INTO workspaces(id,owner_id,name) VALUES(${scope.workspaceId},${scope.userId},'Complete summary fixture')`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${scope.workspaceId},${scope.userId},'owner')`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy)
      VALUES(${scope.userId},'test-v1',now(),${tx.json({ sendToExternal: false, auditLogging: true })})`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${scope.workspaceId},${scope.userId},'dialogue','Complete summary fixture','system','active')`;
    for (const [index, text] of [longText, "The old answer.", "The latest question stays native.", "The latest answer stays native."].entries()) {
      const blocks = [{ type: "text", text }];
      await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
        VALUES(${randomUUID()},${scope.workspaceId},${scope.userId},${conversationId},${index + 1},${index % 2 ? "assistant" : "user"},
          'text',${tx.json(blocks)},${sha256Utf8V1(canonicalJsonV1(blocks))})`;
    }
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,started_at,lease_token,resource_class)
      VALUES(${jobId},'companion_summarizer',${scope.workspaceId},${scope.userId},${tx.json(payload)},'running',now(),'complete-source-lease','maintenance')`;
  });
  const run = () => runCompanionSummarizer({ id: jobId, workspaceId: scope.workspaceId, requestedBy: scope.userId,
    payload, leaseToken: "complete-source-lease", signal: AbortSignal.timeout(60_000) });
  const summaries = () => admin`SELECT * FROM conversation_summaries WHERE conversation_id=${conversationId}`;
  const snapshot = () => withWorkerWorkspaceTransaction(scope, async tx => buildSummarizerSnapshot(
    toSummarizerSnapshotRows(await readCompanionHistoryRows(tx, conversationId, { beforeSeq: "3", limit: 100 })), Infinity, conversationId));
  const cleanup = () => admin.begin(async tx => {
    await tx`SET LOCAL app.allow_history_mutation = 'on'`;
    await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM conversation_summaries WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM companion_messages WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM companion_conversations WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM jobs WHERE workspace_id=${scope.workspaceId}`;
    await tx`DELETE FROM workspaces WHERE id=${scope.workspaceId}`;
    await tx`DELETE FROM users WHERE id=${scope.userId}`;
  });
  return { ...scope, conversationId, longText, run, summaries, snapshot, cleanup };
}

const output = JSON.stringify({ title: "Read the complete older exchange", topics: [], userGoals: [],
  keyEvents: [], userPreferences: ["EARLY_CONSTRAINT", "LATE_CORRECTION"], followUps: [], emotionalState: "neutral" });

test("an oversized single message is fully consumed before its whole exchange receives committed coverage", async () => {
  const f = await fixture();
  try {
    const frozen = await f.snapshot();
    const parts: string[] = [];
    MockProvider.prototype.chatCompletion = async (messages: ChatMessage[], _options: ChatOptions) => {
      parts.push(String(messages.at(-1)!.content));
      return { content: output, usage: {} };
    };
    await f.run();
    assert.ok(parts.length > 2, "the source is actually larger than the provider input window");
    assert.equal(parts.join(""), frozen.transcript, "every source character reaches a model request, in order");
    const rows = await f.summaries();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]!.coverage_from_seq), "1");
    assert.equal(String(rows[0]!.coverage_through_seq), "2", "latest completed exchange remains verbatim");
    assert.equal(rows[0]!.coverage_source_hash, frozen.sourceHash);
    assert.deepEqual(rows[0]!.coverage_manifest.uncovered, []);
  } finally { MockProvider.prototype.chatCompletion = originalCompletion; await f.cleanup(); }
});

test("a failed middle model request commits no coverage for the unprocessed suffix", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    MockProvider.prototype.chatCompletion = async () => { if (++calls === 2) throw new Error("middle part failed"); return { content: output, usage: {} }; };
    await assert.rejects(f.run(), /middle part failed/);
    assert.equal(calls, 2);
    assert.equal((await f.summaries()).length, 0);
  } finally { MockProvider.prototype.chatCompletion = originalCompletion; await f.cleanup(); }
});

test("source mutation during chunk processing invalidates the entire result at the commit fence", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    MockProvider.prototype.chatCompletion = async () => {
      if (++calls === 2) await admin.begin(async tx => {
        await tx`SET LOCAL app.allow_history_mutation = 'on'`;
        await tx`UPDATE companion_messages SET blocks=${tx.json([{ type: "text", text: "Changed source." }])},
          content_sha256=${sha256Utf8V1("Changed source.")} WHERE conversation_id=${f.conversationId} AND seq=1`;
      });
      return { content: output, usage: {} };
    };
    await f.run();
    assert.ok(calls > 2);
    assert.equal((await f.summaries()).length, 0);
  } finally { MockProvider.prototype.chatCompletion = originalCompletion; await f.cleanup(); }
});

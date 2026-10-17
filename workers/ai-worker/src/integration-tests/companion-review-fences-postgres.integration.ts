import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";

const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
process.env.DATABASE_URL = testDatabaseUrl("DATABASE_URL_WORKER");
const { withWorkerWorkspaceTransaction: transaction, closeDatabase } = await import("../db.ts");
const { readConversationSummaryChain, readParentSummary, upsertCommittedSummary } = await import("../handlers/turn/companion-dialogue-store.ts");
const { readCompanionReplayHistoryRows, companionRecentHistoryFromRows } = await import("../handlers/turn/companion-dialogue-store.ts");
const { selectCompanionInteractiveReplayWindow } = await import("../handlers/context/companion-context-handoff.ts");
const { resolveCompanionSummarizerTailAnchor } = await import("../handlers/context/companion-summarizer.ts");
const { commitCompanionMemoryEmbedding } = await import("../handlers/memory/companion-memory-embedding.ts");
const { retrieveCompanionMemoriesVector } = await import("../handlers/memory/companion-memory-vector.ts");
after(async () => { await admin.end({ timeout: 2 }); await closeDatabase(); });

async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), conversationId = randomUUID();
  await admin`INSERT INTO users(id,email,password_hash) VALUES(${userId},${`${userId}@review.test`},'fixture')`;
  await admin`INSERT INTO workspaces(id,owner_id,name) VALUES(${workspaceId},${userId},'review fixture')`;
  await admin`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
  await admin`INSERT INTO companion_conversations(id,workspace_id,user_id,title,title_source,kind,status)
    VALUES(${conversationId},${workspaceId},${userId},'review','placeholder','dialogue','active')`;
  return { workspaceId, userId, conversationId };
}
type Scope = Awaited<ReturnType<typeof fixture>>;
async function summary(f: Scope, from: number, through: number, parent: string | null = null) {
  const id = randomUUID();
  await admin`INSERT INTO conversation_summaries(id,workspace_id,user_id,conversation_id,summary,
    coverage_from_seq,coverage_through_seq,coverage_source_hash,parent_summary_id,status,verified_context_revision)
    VALUES(${id},${f.workspaceId},${f.userId},${f.conversationId},${admin.json({title:`range ${from}-${through}`})},
      ${from},${through},${"a".repeat(64)},${parent},'confirmed',1)`;
  return id;
}

test("replay pages beyond 200 rows and folds only summary-covered whole exchanges", async () => {
  const f = await fixture();
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
    SELECT gen_random_uuid(),${f.workspaceId},${f.userId},${f.conversationId},n,
      CASE WHEN n % 2 = 1 THEN 'user' ELSE 'assistant' END,'text',
      jsonb_build_array(jsonb_build_object('type','text','text','history ' || n::text)),${"a".repeat(64)}
    FROM generate_series(1,450) n`;
  const read = (coverage?: Parameters<typeof readCompanionReplayHistoryRows>[2]["coverage"]) => transaction(f, tx =>
    readCompanionReplayHistoryRows(tx, f.conversationId, { coverage }));
  const full = companionRecentHistoryFromRows(await read());
  assert.equal(full.length, 450);
  assert.equal(selectCompanionInteractiveReplayWindow(full, 10).messages.length, 450);
  const coverage = { fromSeq: "1", throughSeq: "400", sourceSha256: "hash" };
  const bounded = companionRecentHistoryFromRows(await read(coverage));
  const projected = selectCompanionInteractiveReplayWindow(bounded, 10, coverage);
  assert.deepEqual(projected.messages.map(m => m.seq), Array.from({ length: 50 }, (_, i) => String(401 + i)));
  const gaps = { ...coverage, uncovered: [{ fromSeq: "2", throughSeq: "2" }] };
  const withGaps = selectCompanionInteractiveReplayWindow(companionRecentHistoryFromRows(await read(gaps)), 10, gaps);
  assert.deepEqual(withGaps.messages.slice(0,2).map(m => m.seq), ["1", "2"], "a missing answer retains its question too");
  assert.equal(await transaction(f, tx => resolveCompanionSummarizerTailAnchor(tx, f.conversationId)), "449");
  await admin`UPDATE companion_messages SET role='assistant' WHERE conversation_id=${f.conversationId} AND seq>1`;
  assert.equal(await transaction(f, tx => resolveCompanionSummarizerTailAnchor(tx, f.conversationId)), "1",
    "a long segmented exchange must not be split at a database page boundary");
});

test("only ancestors represented by the injected head count as summary coverage", async () => {
  const f = await fixture();
  const root = await summary(f, 1, 2);
  await summary(f, 3, 4, root); // sibling content was never read by the head
  const head = await summary(f, 5, 6, root);
  const chain = await transaction(f, tx => readConversationSummaryChain(tx, f.conversationId));
  assert.equal(chain.head?.id, head);
  assert.equal(chain.depth, 2);
  assert.deepEqual(chain.gaps, [{ fromSeq: "3", throughSeq: "4" }]);
});

test("editing a parent's source invalidates descendants, preserves independent ranges and excludes invalid parents", async () => {
  const f = await fixture();
  const messageId = randomUUID();
  await admin`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,seq,role,kind,blocks,content_sha256)
    VALUES(${messageId},${f.workspaceId},${f.userId},${f.conversationId},1,'user','text','[]',${"a".repeat(64)})`;
  const root = await summary(f, 1, 2), child = await summary(f, 3, 4, root), grandchild = await summary(f, 5, 6, child);
  const independent = await summary(f, 7, 8);
  await admin`UPDATE companion_messages SET blocks='[{"type":"text","text":"corrected"}]',
    content_sha256=${"b".repeat(64)},edited_at=now() WHERE id=${messageId}`;
  const rows = await admin`SELECT id,invalidated_at FROM conversation_summaries WHERE conversation_id=${f.conversationId}`;
  for (const id of [root, child, grandchild]) assert.ok(rows.find(row => row.id === id)?.invalidated_at);
  assert.equal(rows.find(row => row.id === independent)?.invalidated_at, null);
  await admin`UPDATE conversation_summaries SET status='stale' WHERE id=${independent}`;
  assert.equal(await transaction(f, tx => readParentSummary(tx, f.conversationId)), null);
  assert.equal((await transaction(f, tx => readConversationSummaryChain(tx, f.conversationId))).head, null);
});

test("staling or deleting a parent invalidates its inherited prose before the dependency edge disappears", async () => {
  for (const action of ["stale", "delete"] as const) {
    const f = await fixture(), root = await summary(f, 1, 2), child = await summary(f, 3, 4, root);
    const grandchild = await summary(f, 5, 6, child);
    if (action === "stale") await admin`UPDATE conversation_summaries SET status='stale' WHERE id=${root}`;
    else await admin`DELETE FROM conversation_summaries WHERE id=${root}`;
    const rows = await admin`SELECT id,invalidated_at FROM conversation_summaries WHERE id IN (${child},${grandchild})`;
    assert.ok(rows.every(row => row.invalidated_at), action);
    assert.equal(await transaction(f, tx => readParentSummary(tx, f.conversationId)), null);
    await admin`DELETE FROM conversation_summaries WHERE conversation_id=${f.conversationId}`;
    assert.equal((await admin`SELECT 1 FROM conversation_summaries WHERE conversation_id=${f.conversationId}`).length, 0);
  }
});

test("an invalidated range can be regenerated instead of being blocked by the old dedupe row", async () => {
  const f = await fixture(), old = await summary(f, 1, 2);
  await admin`UPDATE conversation_summaries SET invalidated_at=now(),compaction_policy_version='review' WHERE id=${old}`;
  const saved = await transaction(f, tx => upsertCommittedSummary(tx, {
    ...f, summary: { title: "current source" }, sourceRunId: null, coverageFromSeq: "1", coverageThroughSeq: "2",
    sourceHash: "a".repeat(64), parentSummaryId: null, coverageManifest: {}, policyVersion: "review", verifiedContextRevision: "1",
  }));
  assert.ok(saved);
  assert.notEqual(saved, old);
});

test("a late embedding cannot mark an edited or deleted memory ready", async () => {
  const f = await fixture(), memoryId = randomUUID();
  await admin`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,candidate,embedding_status)
    VALUES(${memoryId},${f.workspaceId},${f.userId},'preference','old content',false,'pending')`;
  const [original] = await admin`SELECT id,revision,content FROM assistant_memory_items WHERE id=${memoryId}`;
  await admin`UPDATE assistant_memory_items SET content='new content',revision=revision+1 WHERE id=${memoryId}`;
  const embedding = JSON.stringify(Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0));
  const commit = (memory: { id: string; revision: number; content: string }) => transaction(f, tx =>
    commitCompanionMemoryEmbedding(tx, { ...f, memory, embedding, modelRevision: "review-embedding" }));
  assert.equal(await commit(original as never), null);
  assert.equal((await admin`SELECT embedding_status FROM assistant_memory_items WHERE id=${memoryId}`)[0]?.embedding_status, "pending");
  assert.equal((await admin`SELECT 1 FROM assistant_memory_embeddings WHERE memory_id=${memoryId}`).length, 0);
  const [current] = await admin`SELECT id,revision,content FROM assistant_memory_items WHERE id=${memoryId}`;
  assert.deepEqual(await commit(current as never), { semanticDismissed: false });
  assert.equal((await admin`SELECT embedding_status FROM assistant_memory_items WHERE id=${memoryId}`)[0]?.embedding_status, "ready");
  await admin`UPDATE assistant_memory_items SET deleted_at=now(),embedding_status='pending' WHERE id=${memoryId}`;
  assert.equal(await commit(current as never), null);
});

test("full ready-vector results still include a relevant newly written pending memory", async () => {
  const f = await fixture(), pendingId = randomUUID();
  const embedding = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
  for (let index = 0; index < 8; index += 1) {
    const id = randomUUID();
    await admin`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,candidate,budget_tier,embedding_status,epistemic_status)
      VALUES(${id},${f.workspaceId},${f.userId},'preference','喜欢语音讲解',false,'active','ready','supported')`;
    await admin`INSERT INTO assistant_memory_embeddings(memory_id,workspace_id,user_id,embedding,model_revision)
      VALUES(${id},${f.workspaceId},${f.userId},${JSON.stringify(embedding)}::vector,'review-vector')`;
  }
  await admin`INSERT INTO assistant_memory_items(id,workspace_id,user_id,kind,content,candidate,budget_tier,embedding_status,epistemic_status)
    VALUES(${pendingId},${f.workspaceId},${f.userId},'preference','习惯在图书馆三楼复习',false,'active','pending','supported')`;
  const result = await transaction(f, tx => retrieveCompanionMemoriesVector(tx, f, "图书馆",
    { id: "review", embeddingModelId: "review-vector", embed: async () => { throw new Error("no external call in transaction"); } },
    8, null, embedding));
  assert.equal(result.items[0]?.memoryId, pendingId);
  assert.equal(result.items.length, 8);
});

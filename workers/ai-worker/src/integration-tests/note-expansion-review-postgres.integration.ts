import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { MockProvider } from "../lib/providers/mock.ts";
import { NoteExpansionOutputError } from "../lib/non-retryable-errors.ts";
import { closeDatabase, currentWorkerWorkspaceTransaction } from "../db.ts";
import { runNoteExpansionGenerate } from "../handlers/note/note-expansion-generate.ts";
import { NOTE_EXPANSION_REVIEW_POLICY } from "../handlers/note/note-expansion-review.ts";

delete process.env.AI_PLATFORMS_CONFIG;
delete process.env.TOKENRHYTHM_API_KEY;
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 2 });
const original = MockProvider.prototype.chatCompletion;
after(async () => { MockProvider.prototype.chatCompletion = original; await admin.end(); await closeDatabase(); });
const source = "矩形的面积等于长乘宽，长为5、宽为3时面积为15。";
const generated = { drafts: [1, 2].map(index => ({ title: `矩形拓展${index}`, relationship: "从矩形的原文条件继续说明面积与边长的关系。",
  sourceReferences: [{ blockOrdinal: 7, quote: source }],
  blocks: [{ type: "heading", content: "面积" }, { type: "paragraph", content: `待核对的正文${index}` }] })) };

async function fixture() {
  const userId = randomUUID(), workspaceId = randomUUID(), noteId = randomUUID(), noteVersionId = randomUUID(), jobId = randomUUID();
  const leaseToken = randomUUID(), payload = { noteId, noteVersionId, requestId: randomUUID() };
  await admin.begin(async tx => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`expansion-review-${userId}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'Expansion review fixture',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id) VALUES(${userId})`;
    await tx`INSERT INTO user_ai_settings(user_id,consent_version,consent_at,data_policy)
      VALUES(${userId},'test-v1',now(),${tx.json({ sendToExternal: false, auditLogging: true })})`;
    await tx`INSERT INTO notes(id,workspace_id,title,created_by) VALUES(${noteId},${workspaceId},'Rectangle',${userId})`;
    await tx`INSERT INTO note_versions(id,note_id,workspace_id,version_no,content_json,content_hash,created_by)
      VALUES(${noteVersionId},${noteId},${workspaceId},1,'{}',${"a".repeat(64)},${userId})`;
    await tx`INSERT INTO note_blocks(workspace_id,version_id,ordinal,type,content) VALUES(${workspaceId},${noteVersionId},7,'paragraph',${source})`;
    await tx`UPDATE notes SET current_version_id=${noteVersionId} WHERE id=${noteId}`;
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${jobId},'note_expansion_generate',${workspaceId},${userId},${tx.json(payload)},'running',${leaseToken},now())`;
  });
  return { userId, workspaceId, noteId, noteVersionId, job: { id: jobId, workspaceId, requestedBy: userId, payload, leaseToken, signal: new AbortController().signal },
    rows: () => admin`SELECT drafts FROM note_expansion_tasks WHERE id=${jobId}`,
    cleanup: () => admin.begin(async tx => {
      await tx`DELETE FROM note_expansion_tasks WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM jobs WHERE workspace_id=${workspaceId}`;
      await tx`UPDATE notes SET current_version_id=NULL WHERE id=${noteId}`;
      await tx`DELETE FROM note_blocks WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM note_versions WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM notes WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
    }) };
}

for (const outcome of ["approve", "revise", "reject", "repair", "source-deleted"] as const) {
  test(`expansion ${outcome} reviews the draft batch before any ready artifact is saved`, async () => {
    const f = await fixture();
    let generations = 0, reviews = 0;
    MockProvider.prototype.chatCompletion = async (messages) => {
      assert.equal(currentWorkerWorkspaceTransaction(), undefined, "model generation and review stay outside workspace transactions");
      if (messages[0]?.content !== NOTE_EXPANSION_REVIEW_POLICY) {
        generations++;
        return { content: JSON.stringify(generated), usage: {} };
      }
      reviews++;
      assert.equal((await f.rows()).length, 0, "an unreviewed draft is never published");
      const data = JSON.parse(String(messages.find(message => message.role === "user")!.content));
      assert.equal(data.sourceBlocks[0].blockOrdinal, 7);
      assert.equal(data.sourceBlocks[0].text, source);
      if (outcome === "repair" && reviews === 1) return { content: JSON.stringify({ drafts: [] }), usage: {} };
      if (outcome === "source-deleted") await admin`UPDATE notes SET deleted_at=now() WHERE id=${f.noteId}`;
      return { content: JSON.stringify({ drafts: data.drafts.map((draft: { draftNumber: number }) => ({
        draftNumber: draft.draftNumber, decision: outcome === "reject" ? "reject" : outcome === "revise" ? "revise" : "approve",
        reason: "已根据原文条件独立核对这篇草稿的结论与论证。",
        revision: outcome === "revise" ? { title: `经核对的拓展${draft.draftNumber}`,
          relationship: "根据原文中的长度与宽度说明矩形面积的计算。",
          blocks: [{ type: "heading", content: "矩形面积" }, { type: "paragraph", content: "面积为5×3=15平方单位。" }] } : null,
      })) }), usage: {} };
    };
    try {
      if (outcome === "reject" || outcome === "source-deleted") {
        await assert.rejects(runNoteExpansionGenerate(f.job), NoteExpansionOutputError);
        assert.equal((await f.rows()).length, 0);
      } else {
        await runNoteExpansionGenerate(f.job);
        const [saved] = await f.rows();
        assert.equal(saved!.drafts.length, 2);
        assert.equal(saved!.drafts[0].sourceReferences[0].blockOrdinal, 7);
        assert.equal(saved!.drafts[0].blocks[1].content, outcome === "revise" ? "面积为5×3=15平方单位。" : "待核对的正文1");
        await runNoteExpansionGenerate(f.job);
      }
      assert.equal(generations, 1, "review or resuming an already-ready artifact cannot regenerate the author draft");
      assert.equal(reviews, outcome === "repair" ? 2 : 1, "a content rejection is terminal; only a malformed review gets contract repair");
    } finally { MockProvider.prototype.chatCompletion = original; await f.cleanup(); }
  });
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import postgres from "postgres";
import { testDatabaseUrl } from "@astella/shared/integration-test-db-env";
import { MockProvider } from "../lib/providers/mock.ts";
import { closeDatabase } from "../db.ts";
import { runCompanionDailySummary } from "../handlers/journal/companion-daily-summary.ts";
import { DailyDiaryOutputError } from "../lib/non-retryable-errors.ts";

process.env.AI_PLATFORMS_CONFIG = "/nonexistent/diary-writing-model-fixture.json";
const admin = postgres(testDatabaseUrl("DATABASE_URL_MIGRATOR"), { max: 1 });
after(async () => { await admin.end(); await closeDatabase(); });

async function fixture(lines = ["请核对初稿，尤其是结尾的限定。", "初稿核对。".repeat(40) + "最后确认：只存初稿，没有提交。"]) {
  const userId = randomUUID(), workspaceId = randomUUID(), conversationId = randomUUID(), id = randomUUID();
  const date = "2026-10-05", leaseToken = randomUUID();
  const mutate = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => admin.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id',${workspaceId},true),set_config('app.user_id',${userId},true)`;
    return fn(tx);
  });
  await mutate(async (tx) => {
    await tx`INSERT INTO users(id,email,password_hash,role) VALUES(${userId},${`diary-writing-${userId}@test.invalid`},'fixture','owner')`;
    await tx`INSERT INTO workspaces(id,name,owner_id) VALUES(${workspaceId},'日记正文回归',${userId})`;
    await tx`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES(${workspaceId},${userId},'owner')`;
    await tx`INSERT INTO user_companion_account_state(user_id,global_enabled,diary_enabled,diary_enabled_since)
      VALUES(${userId},true,true,'2026-10-05T00:00:00+08:00')`;
    await tx`INSERT INTO companion_persona_profiles(user_id,profile,revision)
      VALUES(${userId},${tx.json({ presetId: "custom", name: "书虫", activeness: "quiet", personalityTags: [], speakingStyle: "平实自然", examples: [], boundaries: {} })},1)`;
    await tx`INSERT INTO companion_conversations(id,workspace_id,user_id,kind,title,title_source,status)
      VALUES(${conversationId},${workspaceId},${userId},'dialogue','正文回归','system','active')`;
    for (let index = 0; index < lines.length; index += 1) {
      await tx`INSERT INTO companion_messages(id,workspace_id,user_id,conversation_id,role,seq,kind,blocks,content_sha256,created_at)
        VALUES(${randomUUID()},${workspaceId},${userId},${conversationId},${index ? "assistant" : "user"},${index + 1},'text',
          ${tx.json([{ type: "text", text: lines[index] }])},${"0".repeat(64)},'2026-10-05T11:40:00+08:00')`;
    }
    await tx`INSERT INTO jobs(id,type,workspace_id,requested_by,payload,status,lease_token,started_at)
      VALUES(${id},'companion_daily_summary',${workspaceId},${userId},${tx.json({date,timezone:"Asia/Shanghai",userId})},'running',${leaseToken},now())`;
  });
  return {
    job: { id, workspaceId, requestedBy: userId, leaseToken, payload: { date, timezone: "Asia/Shanghai", userId } },
    mutate,
    read: () => mutate(tx => tx`SELECT status,summary,blocks,failure_reason FROM companion_daily_summaries WHERE workspace_id=${workspaceId} AND user_id=${userId} AND date=${date}`),
    readMemory: () => mutate(tx => tx`SELECT content,source_event_ids FROM assistant_memory_items WHERE workspace_id=${workspaceId} AND source_event_id=${`daily-summary:${date}`}`),
    cleanup: () => mutate(async tx => {
      await tx`DELETE FROM companion_diary_generation_checkpoints WHERE job_id=${id}`;
      await tx`DELETE FROM companion_daily_summaries WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM assistant_memory_items WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM companion_messages WHERE conversation_id=${conversationId}`;
      await tx`DELETE FROM companion_conversations WHERE id=${conversationId}`;
      await tx`DELETE FROM jobs WHERE id=${id}`;
      await tx`DELETE FROM companion_persona_profiles WHERE user_id=${userId}`;
      await tx`DELETE FROM user_companion_account_state WHERE user_id=${userId}`;
      await tx`DELETE FROM workspace_members WHERE workspace_id=${workspaceId}`;
      await tx`DELETE FROM workspaces WHERE id=${workspaceId}`;
      await tx`DELETE FROM users WHERE id=${userId}`;
    }),
  };
}

function modelFixture(draft: Array<{ type: "text"; text: string }>, onDraft: (messages: Parameters<MockProvider["chatCompletion"]>[0]) => void,
  revision = draft, onRevision: () => void | Promise<void> = () => {}) {
  const original = MockProvider.prototype.chatCompletion;
  MockProvider.prototype.chatCompletion = async function (messages, options) {
    const source = String(messages[1]?.content ?? "");
    if (source.includes("<day_material>")) {
      onDraft(messages);
      return { content: JSON.stringify({ blocks: draft }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }
    if (source.startsWith("{")) {
      const input = JSON.parse(source);
      if (Array.isArray(input.candidates)) {
        const candidate = input.candidates[0];
        return { content: JSON.stringify({ selected_id: candidate.id, source_ids: candidate.source_ids, reason_summary: "这段留下了初稿的更正。" }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
      if (input.draft && typeof input.original_material === "string") {
        await onRevision();
        return { content: JSON.stringify({ blocks: revision }), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
    }
    return original.call(this, messages, options);
  };
  return () => { MockProvider.prototype.chatCompletion = original; };
}

test("a second short draft stays failed, with no published diary or draft checkpoint", async () => {
  const f = await fixture();
  let draftCalls = 0;
  const restore = modelFixture([{ type: "text", text: "今天核对了初稿，感觉很踏实。" }], () => { draftCalls += 1; });
  try {
    await assert.rejects(() => runCompanionDailySummary(f.job), DailyDiaryOutputError);
    assert.equal(draftCalls, 2, "one bounded rewrite, without accepting the second short response");
    const [row] = await f.read();
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "diary_output_invalid");
    assert.equal(row.summary, "");
    const checkpoints = await f.mutate(tx => tx`SELECT task_id FROM companion_diary_generation_checkpoints WHERE job_id=${f.job.id}`);
    assert.deepEqual(checkpoints.map(row => row.task_id), ["companion_diary_selection"]);
  } finally { restore(); await f.cleanup(); }
});

test("publication uses the revised prose; two short revisions cannot publish the unreviewed draft", async () => {
  const draft = [{ type: "text" as const, text: "今天核对的是初稿的结尾，最后的限定还需要留下。".repeat(8) },
    { type: "text" as const, text: "没有提交，只保存了初稿。这件事要记清楚。".repeat(8) }];
  for (const valid of [true, false]) {
    const f = await fixture();
    const revision = valid ? [{ ...draft[0], text: "校订后留下真实限定。" + draft[0].text }, draft[1]]
      : [{ type: "text" as const, text: "今天核对了初稿。" }];
    let revisionCalls = 0;
    const restore = modelFixture(draft, () => {}, revision, () => { revisionCalls += 1; });
    try {
      if (valid) {
        await runCompanionDailySummary(f.job);
        const [row] = await f.read();
        assert.equal(row.status, "generated");
        assert.deepEqual(row.blocks, revision);
        assert.equal(revisionCalls, 1);
      } else {
        await assert.rejects(() => runCompanionDailySummary(f.job), DailyDiaryOutputError);
        const [row] = await f.read();
        assert.equal(row.status, "failed");
        assert.equal(row.summary, "");
        assert.equal(revisionCalls, 2);
      }
    } finally { restore(); await f.cleanup(); }
  }
});

test("a source change during revision prevents publication and saving a revision checkpoint", async () => {
  const f = await fixture();
  const draft = [{ type: "text" as const, text: "今天核对的是初稿的结尾，最后的限定还需要留下。".repeat(8) },
    { type: "text" as const, text: "没有提交，只保存了初稿。这件事要记清楚。".repeat(8) }];
  const restore = modelFixture(draft, () => {}, draft, async () => {
    await f.mutate(tx => tx`UPDATE companion_messages SET content_sha256=${"1".repeat(64)} WHERE conversation_id IN
      (SELECT id FROM companion_conversations WHERE workspace_id=${f.job.workspaceId})`);
  });
  try {
    await runCompanionDailySummary(f.job);
    assert.equal((await f.read()).length, 0);
    const rows = await f.mutate(tx => tx`SELECT task_id FROM companion_diary_generation_checkpoints WHERE job_id=${f.job.id} AND task_id='companion_diary_revision'`);
    assert.equal(rows.length, 0);
  } finally { restore(); await f.cleanup(); }
});

test("quiet chat settings preserve all five diary paragraphs and the late source correction", async () => {
  const f = await fixture();
  const blocks = Array.from({ length: 5 }, (_, index) => ({
    type: "text" as const,
    text: index === 4 ? "最后仍要记清楚：没有提交，只存初稿。" : `${index} · 这段初稿的来由和具体限定值得多核对一下。`.repeat(5),
  }));
  let draftCalls = 0;
  const restore = modelFixture(blocks, (messages) => {
    draftCalls += 1;
    assert.match(String(messages[1].content), /最后确认：只存初稿，没有提交/);
  });
  try {
    await runCompanionDailySummary(f.job);
    const [row] = await f.read();
    assert.equal(row.status, "generated");
    assert.deepEqual(row.blocks, blocks);
    assert.ok(row.summary.endsWith(blocks[4].text));
    assert.equal(draftCalls, 1);
    const [checkpoint] = await f.mutate(tx => tx`SELECT task_version,output FROM companion_diary_generation_checkpoints WHERE job_id=${f.job.id} AND task_id='companion_diary_draft'`);
    assert.equal(checkpoint.task_version, 3);
    assert.deepEqual(checkpoint.output.blocks, blocks);
  } finally { restore(); await f.cleanup(); }
});

test("derived diary memory preserves a whole short exchange with exact source identities", async () => {
  const lines = ["这次候选值先用17。", "核对后改成29，17已撤销。"];
  const f = await fixture(lines);
  const draft = [{ type: "text" as const, text: "讨论从初步方案走到了核对后的结论，前后的限定需要一起留下。".repeat(8) },
    { type: "text" as const, text: "这里只保留这次对话中的经过，没有增加别的事情。".repeat(8) }];
  const restore = modelFixture(draft, () => {});
  try {
    await runCompanionDailySummary(f.job);
    const [memory] = await f.readMemory();
    assert.ok(memory);
    assert.equal(memory.content, `2026-10-05 桌宠日记：你说：${lines[0]}\n我说：${lines[1]}`);
    assert.equal(memory.source_event_ids.length, 2);
    const sources = await f.mutate(tx => tx`SELECT id FROM companion_messages WHERE workspace_id=${f.job.workspaceId}`);
    assert.deepEqual([...memory.source_event_ids].sort(), sources.map(row => row.id).sort());
  } finally { restore(); await f.cleanup(); }
});

test("long exchanges publish the diary without a clipped memory; retries cannot attach a different excerpt", async () => {
  const f = await fixture();
  const draft = [{ type: "text" as const, text: "这篇日记保留了讨论的经过以及最后的限定，不能只取最早说过的那一段。".repeat(8) },
    { type: "text" as const, text: "后来的核对与更正同样属于这一段经历。".repeat(8) }];
  const restore = modelFixture(draft, () => {});
  try {
    await runCompanionDailySummary(f.job);
    assert.equal((await f.read())[0].status, "generated");
    assert.equal((await f.readMemory()).length, 0);
    await f.mutate(tx => tx`UPDATE companion_messages SET blocks=${tx.json([{ type: "text", text: "另一个简短的讨论片段。" }])},
      content_sha256=${"2".repeat(64)} WHERE workspace_id=${f.job.workspaceId}`);
    await runCompanionDailySummary(f.job);
    assert.equal((await f.readMemory()).length, 0, "a preserved publication cannot gain a later run's excerpt");
  } finally { restore(); await f.cleanup(); }
});

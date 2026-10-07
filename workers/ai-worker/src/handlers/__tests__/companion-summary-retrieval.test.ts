import assert from "node:assert/strict";
import { test } from "node:test";
import type { SQL } from "drizzle-orm";
import {
  searchPastConversationSummaries,
  readPastConversationMessages,
  MAX_PAST_CONVERSATION_HITS,
  MAX_PAST_CONVERSATION_MESSAGES,
  type PastConversationScope,
} from "../companion-summary-retrieval.ts";

/**
 * 方案 44 §3.2／§8.3：跨会话找回。
 *
 * 这些是**范围与来源身份**的判据，SQL 形状由下面的桩查询文本直接断言——目的是让
 * 「范围校验落在会话上」「同号 seq 不碰撞」这两条在实库跑之前就已经被钉住。
 */

const scope: PastConversationScope = { workspaceId: "ws-1", userId: "user-1" };

interface StubCall { sql: string }

/**
 * 只回放查询文本、返回预置行的最小执行器。
 *
 * 断言的是**查询形状**（范围条件、排除当前会话、上限），不是结果排序——后者要实库。
 * 把 SQL 片段拍平成文本再断言，比 mock 掉 `.execute` 本身更接近真实执行体。
 */
function stubExecutor(rows: Array<Record<string, unknown>>) {
  const calls: StubCall[] = [];
  return {
    calls,
    execute(query: SQL) {
      calls.push({ sql: JSON.stringify(query.queryChunks ?? []) });
      return Promise.resolve(rows);
    },
  };
}

const summaryRow = (over: Record<string, unknown> = {}) => ({
  conversation_id: "conv-old",
  summary: { title: "复习安排", keyEvents: ["排了周五"], followUps: ["要不要换周末"], userPreferences: ["简短"] },
  coverage_from_seq: "3",
  coverage_through_seq: "18",
  coverage_source_hash: "a".repeat(64),
  updated_at: "2026-10-01T00:00:00.000Z",
  ...over,
});

test("44 §3.2：检索只在本工作区本人名下，并排除当前会话", async () => {
  const executor = stubExecutor([summaryRow()]);
  await searchPastConversationSummaries(executor, scope, { query: "复习", excludeConversationId: "conv-now" });
  const text = executor.calls[0]!.sql;
  assert.match(text, /workspace_id/);
  assert.match(text, /user_id/);
  assert.match(text, /conversation_id <>/);
  // 当前会话的尾部与摘要已经在上下文里，再给一遍只是重复烧窗口。
  assert.match(text, /conversation_summaries/);
});

test("44 §5.1：只认覆盖完整且经过校验的摘要", async () => {
  const executor = stubExecutor([summaryRow()]);
  await searchPastConversationSummaries(executor, scope, { query: "复习" });
  const text = executor.calls[0]!.sql;
  assert.match(text, /coverage_from_seq IS NOT NULL/);
  assert.match(text, /coverage_through_seq IS NOT NULL/);
  assert.match(text, /coverage_source_hash IS NOT NULL/);
  // 缺任一段的摘要在投影层被丢掉——它不能定位，也就不能取回。
  const incomplete = await searchPastConversationSummaries(
    stubExecutor([summaryRow({ coverage_source_hash: null })]), scope, { query: "复习" },
  );
  assert.deepEqual(incomplete, []);
});

test("44 §8.3：命中带来源身份，模型才能区分「这轮」与「历史」", async () => {
  const [hit] = await searchPastConversationSummaries(stubExecutor([summaryRow()]), scope, { query: "复习" });
  assert.ok(hit);
  assert.equal(hit!.conversationId, "conv-old");
  assert.equal(hit!.coverageFromSeq, "3");
  assert.equal(hit!.coverageThroughSeq, "18");
  assert.equal(hit!.sourceHash.length, 64);
  assert.equal(hit!.title, "复习安排");
});

test("44 §8.3：取回原文时范围校验落在会话上，不只落在消息上", async () => {
  const executor = stubExecutor([]);
  await readPastConversationMessages(executor, scope, { conversationId: "conv-old", fromSeq: "3" });
  const text = executor.calls[0]!.sql;
  // 只校验消息表的 workspace/user 是不够的：会话归属才是那一段的权威边界。
  assert.match(text, /companion_conversations/);
  assert.match(text, /c\.workspace_id/);
  assert.match(text, /c\.user_id/);
});

test("44 §8.3：两个会话的同号 seq 不碰撞——取回必须带会话 id", async () => {
  const executor = stubExecutor([{ seq: "3", role: "user", blocks: [{ type: "text", text: "那次我们说" }] }]);
  const excerpt = await readPastConversationMessages(executor, scope, { conversationId: "conv-old", fromSeq: "3" });
  // 查询以会话 id 为边界：conv-other 的 3 号消息不可能出现在这里。
  assert.equal(excerpt.conversationId, "conv-old");
  assert.equal(excerpt.messages[0]?.seq, "3");
  assert.match(executor.calls[0]!.sql, /m\.conversation_id/);
});

test("非法区间不读库，也不返回半截内容", async () => {
  for (const input of [
    { conversationId: "conv-old", fromSeq: "0" },
    { conversationId: "conv-old", fromSeq: "abc" },
    { conversationId: "conv-old", fromSeq: "9", throughSeq: "3" },
  ]) {
    const executor = stubExecutor([]);
    const excerpt = await readPastConversationMessages(executor, scope, input);
    assert.deepEqual(excerpt.messages, []);
    assert.equal(executor.calls.length, 0, `${JSON.stringify(input)} 不该打到库`);
  }
});

test("被上限截断时标 truncated——她必须知道后面还有没读", async () => {
  const rows = Array.from({ length: MAX_PAST_CONVERSATION_MESSAGES + 3 }, (_, index) => ({
    seq: String(index + 1), role: "user", blocks: [{ type: "text", text: "短句" }],
  }));
  const excerpt = await readPastConversationMessages(stubExecutor(rows), scope, { conversationId: "conv-old", fromSeq: "1" });
  assert.equal(excerpt.messages.length, MAX_PAST_CONVERSATION_MESSAGES);
  assert.equal(excerpt.truncated, true);
});

test("完全读完时 truncated=false，不固定插入「被截断」的声明", async () => {
  const excerpt = await readPastConversationMessages(
    stubExecutor([{ seq: "1", role: "user", blocks: [{ type: "text", text: "只有一句" }] }]),
    scope, { conversationId: "conv-old", fromSeq: "1" },
  );
  assert.equal(excerpt.truncated, false);
  assert.equal(excerpt.messages[0]?.text, "只有一句");
});

test("命中条数有界，模型不能一次把全部历史拉回来", async () => {
  const executor = stubExecutor([]);
  await searchPastConversationSummaries(executor, scope, { query: "复习", limit: 99 });
  assert.ok(MAX_PAST_CONVERSATION_HITS <= 5);
  // 上限写进查询的 LIMIT，而不是指望调用方自觉。
  assert.match(executor.calls[0]!.sql, /LIMIT/);
});

// ─── 44 §3.3：跨会话找回也要检查当前有效性 ────────────────────────────────

test("44 §3.3：跨会话检索按会话内容修订号过滤，不只认 status", async () => {
  const executor = stubExecutor([summaryRow()]);
  await searchPastConversationSummaries(executor, scope, { query: "复习" });
  const text = executor.calls[0]!.sql;
  // status 只挡得住「被遗忘/被纠正」这一类；来源被改写或删除要让修订号前进。
  assert.match(text, /verified_context_revision/);
  assert.match(text, /context_revision/);
  // 范围校验落在会话上，而不是只落在摘要行上。
  assert.match(text, /JOIN companion_conversations/);
  assert.match(text, /c\.user_id = s\.user_id/);
});

test("旧会话的长消息完整取回，尾部纠正与服务器时间不能被静默丢掉", async () => {
  const text = "🫧前文\r\n".repeat(1800) + "最后纠正：报告只是写完，还没有交。";
  const excerpt = await readPastConversationMessages(stubExecutor([
    {seq:"1",role:"user",blocks:[{type:"text",text}],created_at:"2026-10-05T03:14:00Z"},
    {seq:"2",role:"assistant",blocks:[{type:"text",text:"嗯"}],created_at:"2026-10-05T03:14:05Z"},
  ]), scope, {conversationId:"conv-old",fromSeq:"1"});
  assert.equal(excerpt.messages[0]?.text, text);
  assert.equal(excerpt.messages[0]?.createdAt, "2026-10-05T03:14:00.000Z");
  assert.equal(excerpt.throughSeq, "1", "后续消息留到下一页，而非截断首条消息正文");
  assert.equal(excerpt.truncated, true);
  const next = await readPastConversationMessages(stubExecutor([
    {seq:"2",role:"assistant",blocks:[{type:"text",text:"嗯"}],created_at:"2026-10-05T03:14:05Z"},
  ]), scope, {conversationId:"conv-old",fromSeq:"2"});
  assert.equal(next.messages[0]?.text, "嗯");
  assert.equal(next.truncated, false);
});

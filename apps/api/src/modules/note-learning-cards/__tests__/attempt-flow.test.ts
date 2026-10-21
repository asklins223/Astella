import assert from "node:assert/strict";
import { test } from "node:test";
import { listNoteLearningCardAttempts, queueNoteLearningCardAttempt, readNoteLearningCard } from "../service.ts";
import type { ApiTransaction } from "../../../db/client.ts";
const scope = { workspaceId: "workspace", userId: "learner" };
const grounding = { note: [{ blockOrdinal: 0, quote: "原文中的依据。" }] };
/** Sequential query results retain the service's transaction and write decisions. */
function transaction(results: unknown[][]) {
  const writes: Array<{ type: string; value: unknown }> = [];
  const tx = {
    select() {
      const rows = results.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ["from", "where", "limit", "orderBy", "for", "innerJoin"]) chain[method] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
      return chain;
    },
    update() { return { set(value: unknown) { writes.push({ type: "update", value }); return { where: async () => [] }; } }; },
    insert() { return { values(value: unknown) { writes.push({ type: "insert", value }); return { returning: async () => [{ id: "job" }] }; } }; },
  } as unknown as ApiTransaction;
  return { tx, writes };
}
const row = (status: string) => ({ id: "attempt", status, score: status === "completed" ? 50 : null, stars: status === "completed" ? 2 : null, summary: null, startedAt: new Date("2026-10-20T00:00:00Z"), completedAt: status === "completed" ? new Date("2026-10-20T00:10:00Z") : null });
const visible = () => [[{ id: "card", noteId: "note" }], [{ id: "note" }]];
test("history returns saved drafts but withholds all grading and reference answers until completed", async () => {
  const db = transaction([[{ noteId: "note" }], [{ id: "note" }], [row("in_progress"), { ...row("completed"), id: "finished" }], [
    { attemptId: "attempt", questionId: "question", answer: false, score: 0, feedback: { text: "尚不可见的批改" }, groundingSnapshot: grounding },
    { attemptId: "finished", questionId: "question", answer: { skipped: true }, score: 0, feedback: { kind: "skipped" }, groundingSnapshot: grounding },
  ], [{ id: "question", answer: true, rubric: ["要点"] }]]);
  const history = await listNoteLearningCardAttempts(db.tx, scope, "card");
  assert.equal(history[0]!.answers[0]!.answer, false);
  for (const key of ["score", "feedback", "referenceAnswer", "rubric"] as const) assert.equal(history[0]!.answers[0]![key], null);
  assert.equal(history[1]!.answers[0]!.referenceAnswer, true);
  assert.equal(history[1]!.answers[0]!.skipped, true);
  assert.deepEqual(history[1]!.answers[0]!.grounding, grounding);
});
test("retrying a grading or completed attempt never enqueues another job", async () => {
  for (const status of ["grading", "completed"]) {
    const db = transaction([...visible(), [row(status)]]);
    const receipt = await queueNoteLearningCardAttempt(db.tx, scope, "card", "attempt");
    assert.equal(receipt.grading, status === "grading"); assert.equal(db.writes.length, 0);
  }
});
test("missing answers block submission, while explicit skip receipts allow a complete equal-weight attempt", async () => {
  const missing = transaction([...visible(), [row("in_progress")], [{ id: "q1" }, { id: "q2" }], [{ questionId: "q1" }]]);
  await assert.rejects(queueNoteLearningCardAttempt(missing.tx, scope, "card", "attempt"), /还有题目没有保存/);
  assert.equal(missing.writes.length, 0);
  const ready = transaction([...visible(), [row("in_progress")], [{ id: "q1" }, { id: "q2" }], [{ questionId: "q1" }, { questionId: "q2" }]]);
  const receipt = await queueNoteLearningCardAttempt(ready.tx, scope, "card", "attempt");
  assert.equal(receipt.grading, true); assert.equal(ready.writes.filter((write) => write.type === "insert").length, 1);
});

test("best stars and practice count include all completed attempts, not only recent history", async () => {
  for (const bestScore of [0, 100]) {
    const db = transaction([[{ id: "note" }], [{ id: "card", noteId: "note", noteVersionId: "version", status: "active", createdAt: new Date(), updatedAt: new Date() }], [{ id: "q1", ordinal: 0, questionType: "true_false", stem: "是否如此？", answer: { correct: false }, grounding }], [row("in_progress")], [{ bestScore, completedAttemptCount: 80 }]]);
    const result = await readNoteLearningCard(db.tx, scope, "note");
    assert.equal(result.card!.bestScore, bestScore);
    assert.equal(result.card!.bestStars, bestScore === 100 ? 5 : 0);
    assert.equal(result.card!.completedAttemptCount, 80);
  }
});

test("summary-only retries retain earned scores and deduplicate an already queued retry", async () => {
  const db = transaction([...visible(), [row("completed")], []]);
  const result = await queueNoteLearningCardAttempt(db.tx, scope, "card", "attempt", true);
  assert.equal(result.grading, false); assert.equal(result.jobId, "job");
  assert.deepEqual(db.writes[0], { type: "update", value: { summary: { status: "pending" } } });
  assert.equal((db.writes[1]!.value as { payload: { summaryOnly: boolean } }).payload.summaryOnly, true);
  const pending = transaction([...visible(), [row("completed")], [{ id: "same-job" }]]);
  assert.equal((await queueNoteLearningCardAttempt(pending.tx, scope, "card", "attempt", true)).jobId, "same-job");
  assert.equal(pending.writes.length, 0);
});
test("an explicit summary refresh retains the previous text and never queues a second grading", async () => {
  const old = { text: "旧总评包含一处错误题号。" };
  const db = transaction([...visible(), [{ ...row("completed"), summary: old }], []]);
  const result = await queueNoteLearningCardAttempt(db.tx, scope, "card", "attempt", true);
  assert.equal(result.grading, false);
  assert.deepEqual(db.writes[0], { type: "update", value: { summary: { ...old, status: "pending" } } });
  assert.equal(db.writes.filter(write => write.type === "insert").length, 1);
});
test("replaying the same summary command after completion returns its original job", async () => {
  const db = transaction([...visible(), [{ ...row("completed"), summary: { text: "已经更新完成的总评。" } }], [{ id: "completed-summary-job" }]]);
  const result = await queueNoteLearningCardAttempt(db.tx, scope, "card", "attempt", true, "same-command");
  assert.equal(result.jobId, "completed-summary-job"); assert.equal(db.writes.length, 0);
});

test("a private or deleted note cannot be used to submit a card by guessing its identity", async () => {
  const db = transaction([[{ id: "card", noteId: "private-note" }], []]);
  await assert.rejects(queueNoteLearningCardAttempt(db.tx, scope, "card", "attempt"), /权限/);
  assert.equal(db.writes.length, 0);
});

test("failed generation reports a safe cause without exposing raw model or database details", async () => {
  const db = transaction([[{ id: "note" }], [{ id: "card" }], [], [{ status: "dead", lastError: "学习卡没有通过质量闸门：private generated content and SQL details" }], []]);
  const result = await readNoteLearningCard(db.tx, scope, "note");
  assert.equal(result.card, null); assert.equal(result.generating, false);
  assert.match(result.generationFailure!, /原文、答案或题型校验/);
  assert.doesNotMatch(result.generationFailure!, /private|SQL/);
});

test("the read DTO exposes how many generated questions were discarded", async () => {
  const db = transaction([
    [{ id: "note" }],
    [{ id: "card", noteId: "note", noteVersionId: "version", status: "active", omittedQuestionCount: 2, createdAt: new Date(), updatedAt: new Date() }],
    [{ id: "q1", ordinal: 0, questionType: "true_false", stem: "是否如此？", answer: { correct: false }, grounding }],
    [], [{ bestScore: null, completedAttemptCount: 0 }],
  ]);
  const result = await readNoteLearningCard(db.tx, scope, "note");
  assert.equal(result.card!.omittedQuestionCount, 2);
  assert.equal(result.card!.questions.length, 1);
});

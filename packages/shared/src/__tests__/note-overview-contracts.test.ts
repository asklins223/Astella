import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNoteOverviewTaskV1Schema,
  noteOverviewLatestTaskV1Schema,
  noteOverviewPageV1Schema,
  noteOverviewTaskV1Schema,
  noteOverviewV1Schema,
} from "../contracts/note/note-overview-contracts.ts";

const noteId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";

test("速看任务固定笔记版本并使用独立请求标识", () => {
  assert.equal(createNoteOverviewTaskV1Schema.safeParse({
    noteVersionId: versionId,
    requestId,
  }).success, true);
  assert.equal(noteOverviewV1Schema.safeParse({
    overviewId: "55555555-5555-4555-8555-555555555555",
    noteId,
    noteVersionId: versionId,
    noteVersionNumber: 3,
    body: "速览正文",
    references: [{ blockOrdinal: 2, quote: "這句来自原文的引用。" }],
    coverage: { totalBlocks: 4, textBlocksRead: 3, imageBlocksNotRead: 1 },
    generationJobId: jobId,
    sourceMessageId: null,
    conversationId: null,
    versionState: "older",
    createdAt: "2026-09-28T10:00:00.000Z",
  }).success, true);
});

test("速看任务版本和请求标识必须是 UUID", () => {
  assert.equal(createNoteOverviewTaskV1Schema.safeParse({
    noteVersionId: versionId,
    requestId: "retry request",
  }).success, false);
});

test("速览引用要可定位到具体原文块", () => {
  const base = {
    overviewId: "55555555-5555-4555-8555-555555555555",
    noteId,
    noteVersionId: versionId,
    noteVersionNumber: 3,
    body: "速览正文",
    coverage: null,
    generationJobId: jobId,
    sourceMessageId: null,
    conversationId: null,
    versionState: "current" as const,
    createdAt: "2026-09-28T10:00:00.000Z",
  };
  assert.equal(noteOverviewV1Schema.safeParse({ ...base, references: [] }).success, true);
  assert.equal(noteOverviewV1Schema.safeParse({ ...base, references: [{ blockOrdinal: -1, quote: "短句" }] }).success, false);
});

test("saved short citations and explanations remain readable through every overview response", () => {
  const overview = {
    overviewId: "55555555-5555-4555-8555-555555555555",
    noteId,
    noteVersionId: versionId,
    noteVersionNumber: 1,
    body: "联调通过，明天收尾。",
    points: [{ blockOrdinal: 2, quote: "明天继续。", explanation: "收尾。" }],
    references: [{ blockOrdinal: 2, quote: "明天继续。" }],
    coverage: { totalBlocks: 3, textBlocksRead: 3, imageBlocksNotRead: 0 },
    generationJobId: jobId,
    sourceMessageId: null,
    conversationId: null,
    versionState: "current" as const,
    createdAt: "2026-11-14T05:37:26.000Z",
  };
  const task = {
    taskId: jobId,
    noteId,
    noteVersionId: versionId,
    status: "ready" as const,
    overview,
    failureReason: null,
    createdAt: overview.createdAt,
  };

  assert.deepEqual(noteOverviewV1Schema.parse(overview), overview);
  assert.deepEqual(noteOverviewTaskV1Schema.parse(task).overview, overview);
  assert.deepEqual(noteOverviewLatestTaskV1Schema.parse({ version: 1, task }).task?.overview, overview);
  assert.deepEqual(noteOverviewPageV1Schema.parse({ version: 1, items: [overview], nextCursor: null }).items, [overview]);

  for (const field of ["quote", "explanation"] as const) {
    assert.equal(noteOverviewV1Schema.safeParse({
      ...overview, points: [{ ...overview.points[0], [field]: "" }],
    }).success, false, `empty ${field} is still invalid`);
  }
  assert.equal(noteOverviewV1Schema.safeParse({
    ...overview, references: [{ blockOrdinal: 2, quote: "" }],
  }).success, false);
});

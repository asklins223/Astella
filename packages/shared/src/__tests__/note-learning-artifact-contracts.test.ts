import assert from "node:assert/strict";
import test from "node:test";
import { createNoteDynamicArtifactTaskV1Schema, noteLearningArtifactV1Schema } from "../contracts/note-learning-artifact-contracts.ts";

const noteVersionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const anchor = {
  noteVersionId,
  startBlockOrdinal: 2,
  startOffset: 4,
  endBlockOrdinal: 2,
  endOffset: 7,
  excerpt: "原句",
  prefix: "前文",
  suffix: "后文",
};
const base = { noteVersionId, requestId };

test("局部动态讲解必须带着与原句相同的精确锚点", () => {
  assert.equal(createNoteDynamicArtifactTaskV1Schema.safeParse({
    ...base, sourceKind: "annotation", selectionAnchor: anchor,
  }).success, true);
  assert.equal(createNoteDynamicArtifactTaskV1Schema.safeParse({
    ...base, sourceKind: "annotation",
  }).success, false);
  assert.equal(createNoteDynamicArtifactTaskV1Schema.safeParse({
    ...base, sourceKind: "annotation", selectionAnchor: { ...anchor, noteVersionId: "44444444-4444-4444-8444-444444444444" },
  }).success, false);
});

test("整篇速览不能携带局部选区锚点", () => {
  assert.equal(createNoteDynamicArtifactTaskV1Schema.safeParse({ ...base, sourceKind: "overview" }).success, true);
  assert.equal(createNoteDynamicArtifactTaskV1Schema.safeParse({
    ...base, sourceKind: "overview", selectionAnchor: anchor,
  }).success, false);
});

test("互动演示可回放旧笔记的 32 位版本指纹，也接受更长的版本指纹", () => {
  const artifact = {
    artifactId: requestId,
    noteId: "33333333-3333-4333-8333-333333333333",
    noteVersionId,
    noteVersionNumber: 1,
    generationJobId: null,
    sourceMessageId: null,
    conversationId: null,
    sourceKind: "overview",
    selectionText: null,
    selectionAnchor: null,
    sourceContentHash: "a".repeat(32),
    generatorRef: "note_dynamic_artifact_v1@v3",
    title: "演示",
    subject: "概念",
    caution: "示意",
    outline: [
      { index: 0, title: "第一步", narration: "先观察", sectionLabel: "第一段", quote: "笔记原句" },
      { index: 1, title: "第二步", narration: "再尝试", sectionLabel: "第一段", quote: "笔记原句" },
    ],
    versionState: "current",
    createdAt: "2026-09-29T00:00:00.000Z",
  };
  assert.equal(noteLearningArtifactV1Schema.safeParse(artifact).success, true);
  assert.equal(noteLearningArtifactV1Schema.safeParse({ ...artifact, sourceContentHash: "b".repeat(64) }).success, true);
  assert.equal(noteLearningArtifactV1Schema.safeParse({ ...artifact, sourceContentHash: "c".repeat(7) }).success, false);
});

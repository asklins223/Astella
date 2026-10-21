/**
 * Star map topology contract tests (Plan 57).
 *
 * The map carries three node kinds only: sources, notes, and the questions of
 * a note's learning card. The retired objective/evidence nodes and their
 * semantic edges are not merely hidden — they fail to parse, so no client can
 * quietly keep drawing them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  understandingTopologySnapshotV3Schema,
  understandingNodeProjectionV3Schema,
  type NoteDeepeningSnapshotV1,
} from "../contracts/note/note-deepening-contracts.ts";

const NOTE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CARD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUESTION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function snapshotFixture(): NoteDeepeningSnapshotV1 {
  return {
    version: 3,
    workspaceId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    topologyRevision: "v3-1",
    checkpointToken: "tok-1",
    nodes: [
      {
        nodeRef: { kind: "source", sourceId: SOURCE },
        label: "光学教材",
        modality: "pdf",
        createdAt: "2026-10-19T00:00:00.000Z",
      },
      {
        nodeRef: { kind: "note", noteId: NOTE },
        label: "光学原理笔记",
        currentVersionId: NOTE,
        hasSource: true,
      },
      {
        nodeRef: { kind: "card_question", cardId: CARD, questionId: QUESTION, noteId: NOTE },
        label: "为什么受激辐射能放大光？",
        questionType: "short_answer",
        ordinal: 0,
        bestStars: 4,
        bestScore: 86,
        attemptCount: 2,
        lastAttemptAt: "2026-10-19T01:00:00.000Z",
      },
    ],
    edges: [
      { edgeId: "e1", kind: "contains_note", from: { kind: "source", id: SOURCE }, to: { kind: "note", id: NOTE }, reasonCodes: ["source_note"] },
      { edgeId: "e2", kind: "contains_question", from: { kind: "note", id: NOTE }, to: { kind: "card_question", id: QUESTION }, reasonCodes: ["note_learning_card"] },
    ],
    continuationToken: null,
    integrity: { truncated: false },
  };
}

test("一份完整的三类节点快照可以通过合同", () => {
  const parsed = understandingTopologySnapshotV3Schema.parse(snapshotFixture());
  assert.equal(parsed.nodes.length, 3);
  assert.equal(parsed.edges.length, 2);
});

test("退役的 objective / evidence 节点无法解析", () => {
  for (const node of [
    {
      nodeRef: { kind: "objective", objectiveId: CARD },
      label: "旧目标",
      publicSummary: "旧目标摘要",
      activeCardId: null,
      lifecycle: "active",
      freshness: "fresh",
      personal: {},
    },
    {
      nodeRef: { kind: "evidence", evidenceSnapshotId: CARD },
      supportSummary: "旧证据",
      sourceLabel: null,
      restricted: false,
    },
  ]) {
    assert.equal(understandingNodeProjectionV3Schema.safeParse(node).success, false);
  }
});

test("退役的关系边无法解析", () => {
  const fixture = snapshotFixture();
  for (const kind of ["sourced_from", "supported_by", "relates_to", "supersedes"]) {
    const parsed = understandingTopologySnapshotV3Schema.safeParse({
      ...fixture,
      edges: [{ edgeId: "x", kind, from: { kind: "note", id: NOTE }, to: { kind: "note", id: NOTE }, reasonCodes: [] }],
    });
    assert.equal(parsed.success, false, `${kind} 仍然能解析`);
  }
});

test("题目的星级与分数有硬边界", () => {
  const fixture = snapshotFixture();
  const node = fixture.nodes[2] as Record<string, unknown>;
  assert.equal(understandingNodeProjectionV3Schema.safeParse({ ...node, bestStars: 6 }).success, false);
  assert.equal(understandingNodeProjectionV3Schema.safeParse({ ...node, bestScore: 101 }).success, false);
  assert.equal(understandingNodeProjectionV3Schema.safeParse({ ...node, bestStars: null }).success, true);
});

test("快照不再声称有未归属目标", () => {
  const parsed = understandingTopologySnapshotV3Schema.parse(snapshotFixture());
  assert.deepEqual(Object.keys(parsed.integrity), ["truncated"]);
});

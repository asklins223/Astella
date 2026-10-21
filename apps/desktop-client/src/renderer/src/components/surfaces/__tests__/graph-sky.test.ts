import { describe, expect, it } from "vitest";
import type {
  UnderstandingEdgeProjectionV3,
  UnderstandingNodeProjectionV3,
} from "@astella/shared/note-deepening-contracts";
import {
  graphEdgeKindLabel,
  graphNodeLabel,
  graphNodeKindLabel,
  graphNodeSummary,
} from "../space/graph-sky.ts";

let uuid = 0;
function nextId(): string {
  uuid += 1;
  return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
}

function sourceNode(label = "来源", id = nextId()): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "source", sourceId: id },
    label,
    modality: "url",
    createdAt: "2026-09-01T08:00:00+08:00",
  };
}

function noteNode(label = "笔记", id = nextId(), hasSource = true): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "note", noteId: id },
    label,
    currentVersionId: nextId(),
    hasSource,
  };
}

function questionNode(
  overrides: Partial<Extract<UnderstandingNodeProjectionV3, { nodeRef: { kind: "card_question" } }>> = {},
  id = nextId(),
): UnderstandingNodeProjectionV3 {
  return {
    nodeRef: { kind: "card_question", cardId: nextId(), questionId: id, noteId: nextId() },
    label: "提取练习为什么有效？",
    questionType: "short_answer",
    ordinal: 0,
    bestStars: null,
    bestScore: null,
    attemptCount: 0,
    lastAttemptAt: null,
    ...overrides,
  };
}

function edge(
  kind: UnderstandingEdgeProjectionV3["kind"],
  from: UnderstandingNodeProjectionV3,
  to: UnderstandingNodeProjectionV3,
  edgeId = nextId(),
): UnderstandingEdgeProjectionV3 {
  return {
    edgeId,
    kind,
    from: { kind: from.nodeRef.kind, id: nodeIdOf(from) },
    to: { kind: to.nodeRef.kind, id: nodeIdOf(to) },
    reasonCodes: [],
  };
}

function nodeIdOf(node: UnderstandingNodeProjectionV3): string {
  const ref = node.nodeRef;
  return ref.kind === "source" ? ref.sourceId
    : ref.kind === "note" ? ref.noteId
      : ref.questionId;
}

describe("labels", () => {
  it("三类节点各有中文名", () => {
    expect(graphNodeKindLabel("source")).toBe("来源");
    expect(graphNodeKindLabel("note")).toBe("笔记");
    expect(graphNodeKindLabel("card_question")).toBe("学习卡题目");
  });

  it("长标签在 DOM 护栏处截断", () => {
    const long = sourceNode("长".repeat(60));
    expect(graphNodeLabel(long).length).toBe(48);
  });

  it("边类型有中文标签", () => {
    expect(graphEdgeKindLabel("contains_question")).toBe("配套题目");
    expect(graphEdgeKindLabel("contains_note")).toBe("收录笔记");
    expect(graphEdgeKindLabel("references")).toBe("正文引用");
  });

  it("边的两端用的就是节点自己的 id", () => {
    const note = noteNode();
    const question = questionNode();
    const projected = edge("contains_question", note, question);
    expect(projected.from.id).toBe((note.nodeRef as { noteId: string }).noteId);
    expect(projected.to.id).toBe((question.nodeRef as { questionId: string }).questionId);
  });
});

describe("graphNodeSummary · 三类各报各的事实", () => {
  it("题目报最佳星级；没练过就如实说", () => {
    expect(graphNodeSummary(questionNode({ bestStars: 4 }))).toBe("最佳 4 星");
    expect(graphNodeSummary(questionNode())).toBe("还没有练过");
  });

  it("来源只报中文介质，不重复卡片标题里已有的名字", () => {
    const source = sourceNode("认知科学讲义");
    expect(graphNodeSummary(source)).toBe("网页来源");
    expect(graphNodeSummary(source)).not.toContain("认知科学讲义");
  });

  it("未知介质照原样透出，不编造中文名", () => {
    const odd = { ...sourceNode(), modality: "podcast" };
    expect(graphNodeSummary(odd)).toBe("podcast来源");
  });

  it("笔记报它与来源的连接关系", () => {
    expect(graphNodeSummary(noteNode("收录笔记", nextId(), true))).toBe("已关联来源");
    expect(graphNodeSummary(noteNode("手写笔记", nextId(), false))).toBe("手写笔记");
  });
});

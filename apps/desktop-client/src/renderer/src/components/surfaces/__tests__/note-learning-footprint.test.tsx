// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteLearningFootprint } from "../notebook/note-learning-footprint.tsx";
import type { NoteAnnotationV1 } from "@ailearn/shared/note-annotation-contracts";
import type { NoteLearningArtifactV1 } from "@ailearn/shared/note-learning-artifact-contracts";
import type { NoteExpansionLinkV1 } from "@ailearn/shared/note-expansion-contracts";
import type { NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";
import type { NoteRecallRecordV1 } from "@ailearn/shared/note-recall-contracts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-4222-4222-8222-222222222222";
const ID = {
  overview: "33333333-4333-4333-8333-333333333333",
  recall: "44444444-4444-4444-8444-444444444444",
  annotation: "55555555-5555-4555-8555-555555555555",
  artifact: "66666666-6666-4666-8666-666666666666",
  expansion: "77777777-7777-4777-8777-777777777777",
};

const overview: NoteOverviewV1 = {
  overviewId: ID.overview,
  noteId: NOTE_ID,
  noteVersionId: VERSION_ID,
  noteVersionNumber: 1,
  body: "这篇笔记讲的是 Agent 如何通过工具完成外部动作。",
  references: [{ blockOrdinal: 2, quote: "Agent 通过工具连接外部能力。" }],
  coverage: { totalBlocks: 4, textBlocksRead: 4, imageBlocksNotRead: 0 },
  generationJobId: null,
  sourceMessageId: "88888888-8888-4888-8888-888888888888",
  conversationId: "99999999-9999-4999-8999-999999999999",
  versionState: "current",
  createdAt: "2026-09-29T10:00:00.000Z",
};

const recall: NoteRecallRecordV1 = {
  recallId: ID.recall,
  noteId: NOTE_ID,
  noteVersionId: VERSION_ID,
  noteVersionNumber: 1,
  sectionOrdinal: 2,
  sectionTitle: "工具",
  question: "工具帮 Agent 做什么？",
  answer: "让 Agent 使用外部能力。",
  answerTruncated: false,
  selfReport: "partly",
  reflection: "我记得要把工具当成行动入口。",
  state: "reported",
  versionState: "current",
  createdAt: "2026-09-29T11:00:00.000Z",
  hintViewedAt: null,
  revealedAt: "2026-09-29T11:01:00.000Z",
  reportedAt: "2026-09-29T11:02:00.000Z",
  sourceMessageId: null,
  conversationId: null,
  hintSourceMessageId: null,
  hintConversationId: null,
};

const annotation: NoteAnnotationV1 = {
  annotationId: ID.annotation,
  noteId: NOTE_ID,
  anchor: {
    noteVersionId: VERSION_ID,
    startBlockOrdinal: 2,
    startOffset: 0,
    endBlockOrdinal: 2,
    endOffset: 18,
    excerpt: "工具调用的边界",
    prefix: "",
    suffix: "是由权限决定的。",
  },
  explanation: "可以把它想成门禁：Agent 想做的事还要经过授权。",
  sourceMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  generationJobId: null,
  revision: 1,
  versionState: "older",
  createdAt: "2026-09-29T12:00:00.000Z",
  updatedAt: "2026-09-29T12:00:00.000Z",
};

const artifact: NoteLearningArtifactV1 = {
  artifactId: ID.artifact,
  noteId: NOTE_ID,
  noteVersionId: VERSION_ID,
  noteVersionNumber: 1,
  generationJobId: null,
  sourceMessageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  conversationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sourceKind: "annotation",
  selectionText: "工具调用的边界",
  selectionAnchor: annotation.anchor,
  sourceContentHash: "a".repeat(64),
  generatorRef: "test",
  title: "看懂工具权限",
  subject: "Agent 工具权限",
  caution: "按笔记原文解释。",
  outline: [
    { index: 0, title: "提出请求", narration: "Agent 先提出要做什么。", sectionLabel: "请求", quote: "工具调用的边界" },
    { index: 1, title: "检查权限", narration: "系统确认是否允许。", sectionLabel: "检查", quote: "工具调用的边界" },
  ],
  versionState: "current",
  createdAt: "2026-09-29T13:00:00.000Z",
};

const expansion: NoteExpansionLinkV1 = {
  expansionId: ID.expansion,
  sourceNoteId: NOTE_ID,
  sourceNoteVersionId: VERSION_ID,
  sourceNoteVersionNumber: 1,
  sourceTaskId: null,
  expandedNoteId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  expandedNoteVersionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  expandedNoteVersionNumber: 1,
  sourceMessageId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  conversationId: "12121212-1212-4121-8121-121212121212",
  otherNoteTitle: "Agent 工具权限与安全边界",
  direction: "expanded_from_here",
  createdAt: "2026-09-29T14:00:00.000Z",
};

afterEach(cleanup);

describe("note learning footprint", () => {
  it("按时间整理五类成果，并保留版本出处与重新打开动作", () => {
    const onOpenRecall = vi.fn();
    const onOpenAnnotation = vi.fn();
    const onOpenArtifact = vi.fn();
    const onOpenExpansion = vi.fn();
    const onLocateReference = vi.fn();
    const view = render(<NoteLearningFootprint
      overviews={[overview]}
      recalls={[recall]}
      annotations={[annotation]}
      artifacts={[artifact]}
      expansions={[expansion]}
      hasMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      loadingMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      onLoadMore={vi.fn()}
      onOpenRecall={onOpenRecall}
      onOpenAnnotation={onOpenAnnotation}
      onOpenArtifact={onOpenArtifact}
      onOpenExpansion={onOpenExpansion}
      onLocateReference={onLocateReference}
    />);

    expect([...view.container.querySelectorAll("[data-footprint-kind]")].map((item) => item.getAttribute("data-footprint-kind")))
      .toEqual(["expansion", "artifact", "annotation", "recall", "overview"]);
    expect(view.container.querySelector('[data-footprint-kind="annotation"] header')?.textContent).toContain("原句来自旧版本");

    fireEvent.click(view.getByRole("button", { name: "打开这次回想" }));
    fireEvent.click(view.getByRole("button", { name: "查看旧版批注" }));
    fireEvent.click(view.getByRole("button", { name: "打开这份互动讲解" }));
    fireEvent.click(view.getByRole("button", { name: "打开这篇拓展笔记" }));
    expect(onOpenRecall).toHaveBeenCalledWith(recall);
    expect(onOpenAnnotation).toHaveBeenCalledWith(annotation);
    expect(onOpenArtifact).toHaveBeenCalledWith(artifact);
    expect(onOpenExpansion).toHaveBeenCalledWith(expansion);

    fireEvent.click(view.getByText("翻开当时的答复和原文出处"));
    fireEvent.click(view.getByRole("button", { name: /回到第 3 段/ }));
    expect(view.container.querySelector(".note-footprint__full-text")?.textContent).toBe(overview.body);
    expect(onLocateReference).toHaveBeenCalledWith(2);
  });

  it("重开 AI 速览时保留每条重点及其可定位的原文", () => {
    const onLocateReference = vi.fn();
    const generatedOverview: NoteOverviewV1 = {
      ...overview,
      generationJobId: "34343434-4343-4434-8434-343434343434",
      sourceMessageId: null,
      conversationId: null,
      points: [{
        explanation: "工具让 Agent 可以调用笔记外的能力。",
        blockOrdinal: 2,
        quote: "Agent 通过工具连接外部能力。",
      }],
    };
    const view = render(<NoteLearningFootprint
      overviews={[generatedOverview]}
      recalls={[]}
      annotations={[]}
      artifacts={[]}
      expansions={[]}
      hasMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      loadingMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      onLoadMore={vi.fn()}
      onOpenRecall={vi.fn()}
      onOpenAnnotation={vi.fn()}
      onOpenArtifact={vi.fn()}
      onOpenExpansion={vi.fn()}
      onLocateReference={onLocateReference}
    />);

    fireEvent.click(view.getByText("翻开当时的重点和原文出处"));
    expect(view.getByText("工具让 Agent 可以调用笔记外的能力。")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: /原文第 3 段/ }));
    expect(onLocateReference).toHaveBeenCalledWith(2);
  });

  it("旧伴星答复在记录页按易读文字呈现，概览只露出开头", () => {
    const view = render(<NoteLearningFootprint
      overviews={[{ ...overview, body: "**一句话**：工具连接外部能力。\n\n1. 第一条需要展开才能看。" }]}
      recalls={[]}
      annotations={[]}
      artifacts={[]}
      expansions={[]}
      hasMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      loadingMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      onLoadMore={vi.fn()}
      onOpenRecall={vi.fn()}
      onOpenAnnotation={vi.fn()}
      onOpenArtifact={vi.fn()}
      onOpenExpansion={vi.fn()}
      onLocateReference={vi.fn()}
    />);
    const card = view.container.querySelector('[data-footprint-kind="overview"]')!;
    expect(card.querySelector("p")?.textContent).toBe("一句话：工具连接外部能力。");
    expect(card.querySelector(".note-footprint__full-text")?.textContent).toBe("一句话：工具连接外部能力。\n\n1. 第一条需要展开才能看。");
  });

  it("按记录类型继续找更早的内容", () => {
    const onLoadMore = vi.fn();
    const view = render(<NoteLearningFootprint
      overviews={[]}
      recalls={[]}
      annotations={[]}
      artifacts={[]}
      expansions={[]}
      hasMore={{ overview: false, recall: true, annotation: false, artifact: true, expansion: false }}
      loadingMore={{ overview: false, recall: false, annotation: false, artifact: false, expansion: false }}
      onLoadMore={onLoadMore}
      onOpenRecall={vi.fn()}
      onOpenAnnotation={vi.fn()}
      onOpenArtifact={vi.fn()}
      onOpenExpansion={vi.fn()}
      onLocateReference={vi.fn()}
    />);
    fireEvent.click(view.getByText("找更早的学习记录"));
    fireEvent.click(view.getByRole("button", { name: "再找一些回想" }));
    expect(onLoadMore).toHaveBeenCalledWith("recall");
  });
});

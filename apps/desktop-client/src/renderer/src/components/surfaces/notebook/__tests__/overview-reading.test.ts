import { expect, it } from "vitest";
import type { NoteOverviewV1 } from "@ailearn/shared/note-overview-contracts";
import { overviewReading, pointLead } from "../overview-reading";
const base: NoteOverviewV1 = { overviewId: "overview", noteId: "note", noteVersionId: "version", noteVersionNumber: 1, body: "", references: [], coverage: null, generationJobId: null, sourceMessageId: null, conversationId: null, versionState: "current", createdAt: "2026-10-01T00:00:00Z" };

it("旧速看正文能分出提要、已有重点和可核对的出处，未匹配的引文留在原说明里", () => {
  const reading = overviewReading({ ...base, body: "这篇解释复利。\n\n先记住这几件事：\n1. 利息进入本金。\n原文：“新增利息参与下一轮。”\n2. 重复计算会累积。\n原文：无法核对的旧摘录", references: [{ blockOrdinal: 3, quote: "新增利息参与下一轮。" }, { blockOrdinal: 5, quote: "另一个真实出处。" }] });
  expect(reading.gist).toBe("这篇解释复利。"); expect(reading.notes).toBe("");
  expect(reading.points[0]).toEqual({ text: "利息进入本金。", references: [{ blockOrdinal: 3, quote: "新增利息参与下一轮。" }] });
  expect(reading.points[1]?.text).toContain("无法核对的旧摘录"); expect(reading.points[1]?.references).toEqual([]);
  expect(reading.references).toEqual([{ blockOrdinal: 5, quote: "另一个真实出处。" }]);
});

it("结构化重点沿用真实锚点；长句预览加省略号，展开从完整句子开始", () => {
  const reading = overviewReading({ ...base, body: "提要。\n\n附加说明。", points: [{ explanation: "这是已有的一条解释。后面是补充。", quote: "实际引文内容。", blockOrdinal: 7 }] });
  expect(reading.points[0]?.references).toEqual([{ quote: "实际引文内容。", blockOrdinal: 7 }]);
  expect(reading.notes).toBe("附加说明。");
  expect(pointLead(reading.points[0]!.text)).toEqual({ lead: "这是已有的一条解释。后面是补充。", remainder: "" });
  const long = "**这是连续的很长的一句话**".repeat(30);
  expect(pointLead(long).lead.endsWith("…")).toBe(true); expect(pointLead(long).lead).not.toContain("**");
  expect(pointLead(long).remainder).toBe(long);
});

import { describe, expect, it } from "vitest";
import { companionDailySummaryV1Schema } from "@ailearn/shared/companion-memory-desktop-contracts";
import { diaryDiscoveryParagraphs, discoverySourceTarget } from "../companion-discovery-targets";

const daily = companionDailySummaryV1Schema.parse({ version: 1, date: "2026-10-04", revision: 2, status: "generated", generatedAt: "2026-10-04T14:00:00Z", selectionReason: null, failureReason: null, memory: null, blocks: [{ type: "text", text: "第一段原话。\n\n第二段原话。" }, { type: "text", text: "第三段原话。" }] });
describe("日记摘录的身份与返回位置", () => {
  it("不同段落和版本各自保留身份，收藏的正文就是被点击的原段落", () => {
    const paragraphs = diaryDiscoveryParagraphs(daily);
    expect(paragraphs.map(value => value.request.body)).toEqual(["第一段原话。", "第二段原话。", "第三段原话。"]);
    expect(new Set(paragraphs.map(value => value.sourceId)).size).toBe(3);
    expect(paragraphs[1]!.request).toMatchObject({ kind: "diary_excerpt", source: "diary", sourceId: "2026-10-04:v2:b0:p1", author: "assistant" });
    expect(diaryDiscoveryParagraphs({ ...daily, revision: 3 })[1]!.sourceId).not.toBe(paragraphs[1]!.sourceId);
    expect(discoverySourceTarget(paragraphs[1]!.request)).toEqual({ kind: "diary", date: "2026-10-04", revision: 2, sourceId: "2026-10-04:v2:b0:p1" });
  });
  it("旧日期身份仍能打开原日记；非法日期和缺少稳定身份的旧记录没有虚假跳转", () => {
    expect(discoverySourceTarget({ source: "diary", sourceId: "2026-10-04" })).toMatchObject({ kind: "diary", date: "2026-10-04" });
    for (const sourceId of ["2026-99-99", "2026-02-30:v1:b0:p0", "2026-10-04:v0:b0:p0"]) expect(discoverySourceTarget({ source: "diary", sourceId })).toBeNull();
    expect(discoverySourceTarget({ source: "assistant_reply", sourceId: "some-text" })).toBeNull();
    expect(diaryDiscoveryParagraphs({ ...daily, status: "not_generated" })).toEqual([]);
  });
});

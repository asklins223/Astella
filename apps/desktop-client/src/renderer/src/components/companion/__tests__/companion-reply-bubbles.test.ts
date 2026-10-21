import { describe, expect, it } from "vitest";
import { COMPANION_BUBBLE_MAX_CHARS } from "../bubble/companion-bubble-reveal";
import { companionActiveBubble, companionBubbleViews, companionReplyBubbles } from "../bubble/companion-reply-bubbles";

describe("companionReplyBubbles", () => {
  it("draws one bubble per stored message when the joined reply matches exactly", () => {
    expect(companionReplyBubbles("第一句。\n\n第二句。", ["第一句。", "第二句。"]))
      .toEqual(["第一句。", "第二句。"]);
  });

  it("keeps a streamed tail as its own bubble", () => {
    expect(companionReplyBubbles("第一句。\n\n第二句。\n\n还在流。", ["第一句。", "第二句。"]))
      .toEqual(["第一句。", "第二句。", "还在流。"]);
  });

  it("does not invent a boundary when the texts do not line up", () => {
    expect(companionReplyBubbles("第一句。第二句。", ["第一句。", "第二句。"]))
      .toEqual(["第一句。第二句。"]);
  });

  it("keeps a single message whole", () => {
    expect(companionReplyBubbles("只有一句。", ["只有一句。"])).toEqual(["只有一句。"]);
    expect(companionReplyBubbles("  只有一句。  ", [])).toEqual(["只有一句。"]);
  });

  it("is empty with no reply text", () => {
    expect(companionReplyBubbles("", ["第一句。"])).toEqual([]);
  });
});

describe("companionBubbleViews", () => {
  it("reveals bubbles in order and leaves later ones absent", () => {
    expect(companionBubbleViews(["第一句。", "第二句。"], 0)).toEqual([]);
    expect(companionBubbleViews(["第一句。", "第二句。"], 2)).toEqual(["第一"]);
    expect(companionBubbleViews(["第一句。", "第二句。"], 4)).toEqual(["第一句。"]);
    expect(companionBubbleViews(["第一句。", "第二句。"], 6)).toEqual(["第一句。"]);
    expect(companionBubbleViews(["第一句。", "第二句。"], 7)).toEqual(["第一句。", "第"]);
    expect(companionBubbleViews(["第一句。", "第二句。"], 10)).toEqual(["第一句。", "第二句。"]);
  });

  it("shows exactly one active bubble and switches only after the previous one is read", () => {
    expect(companionActiveBubble(["第一句。", "第二句。"], 0)).toBeNull();
    expect(companionActiveBubble(["第一句。", "第二句。"], 2)).toEqual({ index: 0, text: "第一" });
    expect(companionActiveBubble(["第一句。", "第二句。"], 4)).toEqual({ index: 0, text: "第一句。" });
    expect(companionActiveBubble(["第一句。", "第二句。"], 6)).toEqual({ index: 0, text: "第一句。" });
    expect(companionActiveBubble(["第一句。", "第二句。"], 7)).toEqual({ index: 1, text: "第" });
    expect(companionActiveBubble(["第一句。", "第二句。"], 10)).toEqual({ index: 1, text: "第二句。" });
  });

  it("keeps the moving preview cap inside each bubble", () => {
    const long = "长".repeat(COMPANION_BUBBLE_MAX_CHARS + 10);
    const [shown] = companionBubbleViews([long], long.length);
    expect(shown).toHaveLength(COMPANION_BUBBLE_MAX_CHARS + 1);
    expect(shown?.startsWith("…")).toBe(true);
  });
});

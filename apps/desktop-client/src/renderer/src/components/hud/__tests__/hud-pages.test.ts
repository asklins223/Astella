import { describe, expect, it } from "vitest";
import { HUD_PAGES, type HudPageId } from "../hud-pages.ts";

const EXPECTED_PAGES: readonly HudPageId[] = [
  "home",
  "space",
  "sources",
  "source-detail",
  "notes",
  "note-read",
  "note-edit",
  "note-card",
  "note-learning",
  "note-history",
  "search",
  "graph",
  "companion",
  "settings",
] as const;

describe("HUD companion surface policies", () => {
  it("keeps one exhaustive policy for every HUD page", () => {
    expect(Object.keys(HUD_PAGES)).toEqual(EXPECTED_PAGES);
    for (const page of EXPECTED_PAGES) {
      const definition = HUD_PAGES[page];
      expect(definition.id).toBe(page);
      expect(definition.companion).toMatchObject({
        mode: expect.any(String),
        seat: expect.any(String),
        framing: expect.any(String),
        interaction: expect.any(String),
        proactive: expect.any(String),
        draggable: expect.any(Boolean),
      });
    }
  });

  it("keeps the companion beside every page while task pages stay quiet", () => {
    for (const page of EXPECTED_PAGES.filter((id) => !["home", "login", "register"].includes(id))) {
      const policy = HUD_PAGES[page].companion;
      expect(policy.proactive).toBe("silent");
      expect(policy.interaction).toBe("on-demand");
      expect(policy.draggable).toBe(false);
      expect(policy.mode).not.toBe("hidden");
      expect(policy.seat).not.toBe("none");
    }
  });

  it("keeps the note-owned card companion at the normal right-hand seat", () => {
    expect(HUD_PAGES["note-card"].companion).toMatchObject({ seat: "right", mode: "ambient", interaction: "on-demand" });
  });

  it("does not register the history drawer as a HUD page", () => {
    expect(Object.keys(HUD_PAGES)).not.toContain("drawer");
  });

  it("星图提示沿笔记回到学习", () => {
    expect(HUD_PAGES.graph.subtitle).toContain("笔记");
    expect(HUD_PAGES.graph.subtitle).not.toContain("学习卡");
  });
});

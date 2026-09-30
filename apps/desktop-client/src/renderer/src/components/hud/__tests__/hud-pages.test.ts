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
  "note-learning",
  "note-history",
  "goals",
  "goal-detail",
  "generating",
  "candidate",
  "today",
  "queue",
  "assessment",
  "result",
  "search",
  "graph",
  "companion",
  "settings",
  "resumable",
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
      expect(policy.interaction).toBe(page === "assessment" ? "none" : "on-demand");
      expect(policy.draggable).toBe(false);
      expect(policy.mode).not.toBe("hidden");
      expect(policy.seat).not.toBe("none");
    }
    expect([HUD_PAGES.goals, HUD_PAGES["goal-detail"], HUD_PAGES.assessment].map((page) => page.companion.mode)).toEqual(["ambient", "ambient", "assessment"]);
    expect(HUD_PAGES.result.companion.mode).toBe("assessment");
  });

  it("uses compact fail-closed assessment policies", () => {
    expect(HUD_PAGES.assessment.companion).toMatchObject({
      mode: "assessment",
      interaction: "none",
      proactive: "silent",
      draggable: false,
    });
    expect(HUD_PAGES.result.companion).toMatchObject({
      mode: "assessment",
      framing: "bust",
      interaction: "on-demand",
      proactive: "silent",
      draggable: false,
    });
  });

  it("does not register the history drawer as a HUD page", () => {
    expect(Object.keys(HUD_PAGES)).not.toContain("drawer");
  });

  it("calls review items and graph objectives by their real names even without cards", () => {
    expect(HUD_PAGES.queue.subtitle).toContain("到期项");
    expect(HUD_PAGES.queue.subtitle).not.toContain("学习卡");
    expect(HUD_PAGES.queue.companion.starter).toContain("一项");
    expect(HUD_PAGES.graph.subtitle).toContain("学习目标");
    expect(HUD_PAGES.graph.subtitle).not.toContain("学习卡");
  });
});

// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PersonaPanel } from "../companion/companion-center-panels.tsx";
import {
  companionPersonaV1Schema,
  type CompanionMemoryItemV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../../app/room-store.ts";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";

/**
 * 伴星中心「人格」「数据与隐私」两块登记给伴星读的是什么（39d W2-7 的最后两块）。
 *
 * 两块的共同点：**只登记屏上此刻列出的那些操作**，`state` 一律是"这一行属于哪一段"。
 * 数据那一格还多一条：开发诊断段只在 DEV 构建渲染，不是给用户读的事实，一条都不进载荷。
 */

const noop = () => undefined;
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function preset(id: string, name: string, style: string) {
  return {
    presetId: id,
    name,
    personalityTags: ["稳"],
    speakingStyle: style,
    examples: [{ text: "先把结论说清，再给理由。" }],
    activeness: "moderate",
    boundaries: { allowPlayful: false, allowNudgeLearning: true, allowVoiceTags: false },
  };
}

function persona(presetId: string | null = "p-1") {
  return companionPersonaV1Schema.parse({
    version: 1,
    profile: {
      id: "55555555-5555-4555-8555-555555555555",
      userId: USER_ID,
      presetId,
      name: "小满",
      personalityTags: ["稳"],
      speakingStyle: "先给结论。",
      examples: [{ text: "先把结论说清，再给理由。" }],
      activeness: "quiet",
      boundaries: { allowPlayful: true, allowNudgeLearning: true, allowVoiceTags: false },
      revision: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    },
    profileRevision: 3,
    relationship: { familiarity: 0.4, interactionCount: 12, lastActiveAt: null },
    presets: [preset("p-1", "沉稳", "先给结论再给理由"), preset("p-2", "轻快", "短，带一点玩笑")],
    activePreset: null,
  });
}

type PersonaProps = Parameters<typeof PersonaPanel>[0];

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function sectionTitles(scope: string): (string | null)[] {
  return [...document.querySelectorAll(scope)].map((node) => node.textContent);
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 人格：登记的预设与边界就是屏上那两列", () => {
  function renderPersona(props: Partial<PersonaProps> = {}) {
    const base: PersonaProps = {
      section: { ok: true, value: persona() },
      persona: persona(),
      busy: null,
      error: null,
      notice: null,
      onPreset: noop,
      onActiveness: noop,
      onBoundary: noop,
      onReset: noop,
      onRestore: noop,
      onReloadVersions: noop,
      versions: [],
      versionsError: null,
      onRename: noop,
      onRetry: noop,
    };
    render(<PersonaPanel {...base} {...props} />);
  }

  it("预设与边界逐行与 DOM 相同，`state` 是那两段的段名", () => {
    renderPersona();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    const presetNames = sectionTitles(".cc-persona-presets strong");
    const boundaryNames = sectionTitles(".cc-switch-list strong");
    expect(presetNames.length).toBeGreaterThan(1);
    expect(boundaryNames.length).toBeGreaterThan(1);
    expect(view.items?.map((entry) => entry.label)).toEqual([...presetNames, ...boundaryNames]);
    expect(view.items?.map((entry) => entry.state)).toEqual([
      ...presetNames.map(() => "人格预设"),
      ...boundaryNames.map(() => "边界"),
    ]);
    // 段名不许是自己拼的：与屏上两个 `<h4>` 逐字比。
    expect(sectionTitles(".cc-section h3")).toContain("人格预设");
    expect(sectionTitles(".cc-section h3")).toContain(view.items?.[0].state);
  });

  it("当前预设与活跃度这两个选中项进 filters，字面取自屏上选中的那颗按钮", () => {
    renderPersona();
    const view = publishedView()!;
    const selectedPreset = document.querySelector('.cc-persona-presets button[aria-pressed="true"] strong')?.textContent;
    const selectedActiveness = document.querySelector('.cc-segments button[aria-pressed="true"]')?.textContent;
    expect(view.filters?.find((entry) => entry.label === "当前预设")?.value).toBe(selectedPreset);
    expect(view.filters?.find((entry) => entry.label === "表达分量")?.value).toBe(selectedActiveness);
  });

  it("档案读不到：只发那句状态与原因，不发任何一项", () => {
    renderPersona({ section: { ok: false, message: "档案服务不可用" }, persona: null });
    const view = publishedView()!;
    expect(view.statusLine).toBe(document.querySelector(".cc-state strong")?.textContent);
    expect(view.notice).toBe(`${view.statusLine}：档案服务不可用`);
    expect(view.items).toBeUndefined();
    expect(view.filters).toBeUndefined();
  });
});


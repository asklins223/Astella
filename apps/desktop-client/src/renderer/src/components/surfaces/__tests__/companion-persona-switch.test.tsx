// @vitest-environment jsdom

/**
 * 换人格之前的那一问：摊开"谁的什么会被换掉"，默认替你留着。
 *
 * 钉的是**默认值**而不只是"有这个框"：清零要是默认该发生的事，勾选框一出现
 * 也没用——用户会一路点下去，而她攒的东西已经没了。
 *
 * 弹层由页面持有状态、面板只渲染，所以这里直接喂 `switchTarget`；
 * 「点卡片把控制权交出去」单独立一条。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonaPanel } from "../companion/companion-center-panels.tsx";
import { companionPersonaV1Schema } from "@astella/shared/companion-memory-desktop-contracts";
import type { PersonaSwitchOption } from "@astella/shared/pet-persona-merge";
import { useRoomStore } from "../../../app/room-store.ts";
import { PET_PERSONA_PRESETS, getPresetById } from "@astella/shared/pet-persona-presets";

const noop = () => undefined;
const USER_ID = "11111111-1111-1111-8111-111111111111";
const FISH = getPresetById("hungry-fish")!;
const WORM = getPresetById("gentle-bookworm")!;

/** 计划里的那两项：她自己改的说话风格、用户改的学习提醒开关。 */
const OPTIONS: PersonaSwitchOption[] = [
  { field: "speakingStyle", label: "说话风格", origin: "assistant", current: "我刚学会一个省电的摸鱼姿势。", next: WORM.speakingStyle, changes: true },
  { field: "boundaries.allowNudgeLearning", label: "学习提醒", origin: "user", current: "false", next: "false", changes: false },
];

/** 她自己改过语气、用户改过学习提醒开关、名字被用户起过。 */
function personaWithGrowth() {
  return companionPersonaV1Schema.parse({
    version: 1,
    profile: {
      id: "55555555-5555-4555-8555-555555555555",
      userId: USER_ID,
      presetId: FISH.presetId,
      name: "大肥鱼本鱼",
      personalityTags: FISH.personalityTags,
      speakingStyle: "我刚学会一个省电的摸鱼姿势。",
      examples: FISH.examples,
      activeness: "active",
      boundaries: { ...FISH.boundaries, allowNudgeLearning: false },
      fieldOrigin: { speakingStyle: "assistant", boundaries: { allowNudgeLearning: "user" } },
      revision: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-22T00:00:00.000Z",
    },
    profileRevision: 3,
    relationship: { familiarity: 0.4, interactionCount: 12, lastActiveAt: null },
    presets: PET_PERSONA_PRESETS,
    activePreset: null,
  });
}

/** 账号从来没有人格档案：生效的是系统默认人格。 */
function personaWithoutArchive() {
  return companionPersonaV1Schema.parse({
    version: 1,
    profile: null,
    profileRevision: 0,
    relationship: { familiarity: 0, interactionCount: 0, lastActiveAt: null },
    presets: PET_PERSONA_PRESETS,
    activePreset: FISH,
  });
}

type PanelProps = Parameters<typeof PersonaPanel>[0];

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const value = overrides.persona ?? personaWithGrowth();
  return render(<PersonaPanel
    section={{ ok: true, value }}
    persona={value}
    versions={[]}
    versionsError={null}
    busy={null}
    error={null}
    notice={null}
    onPreset={noop}
    onActiveness={noop}
    onBoundary={noop}
    onReset={noop}
    onRestore={noop}
    onReloadVersions={noop}
    onRename={noop}
    onRetry={noop}
    // 弹层要四个回调齐了才渲染（页面持有状态，面板只画）。这里给齐，
    // 想验「回调没给就不画」的那条用例再显式传 undefined。
    onOverwrite={noop}
    onSwitchCancel={noop}
    onSwitchConfirm={noop}
    {...overrides}
  />);
}

function sheet() {
  return document.querySelector(".cc-switch-sheet");
}

function boxes() {
  return [...sheet()!.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
}

function confirmButton() {
  return Array.from(sheet()!.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("换"))!;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("换人格之前的那一问", () => {
  it("点卡片把控制权交给页面，不自己偷偷换掉", () => {
    const onPreset = vi.fn();
    renderPanel({ onPreset });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(WORM.name) }));
    expect(onPreset).toHaveBeenCalledWith(expect.objectContaining({ presetId: "gentle-bookworm" }));
  });

  it("清单里逐项写清是谁写的，名字不在其中", () => {
    renderPanel({ switchTarget: WORM, switchOptions: OPTIONS, overwrite: [] });
    const labels = [...sheet()!.querySelectorAll("strong")].map((n) => n.textContent ?? "");
    expect(labels.some((t) => t.startsWith("说话风格") && t.includes("她改的"))).toBe(true);
    expect(labels.some((t) => t.startsWith("学习提醒") && t.includes("你改的"))).toBe(true);
    expect(sheet()!.textContent).toContain("名字不在其中");
  });

  it("默认一个都不勾，按钮上写清会保留几项", () => {
    renderPanel({ switchTarget: WORM, switchOptions: OPTIONS, overwrite: [] });
    expect(boxes()).toHaveLength(2);
    expect(boxes().every((box) => box.checked)).toBe(false);
    expect(confirmButton().textContent).toContain("保留 2 项");
  });

  it("勾上某一项才把那项交给页面去覆盖；取消勾选又变回保留", () => {
    const onOverwrite = vi.fn();
    const { unmount } = renderPanel({ switchTarget: WORM, switchOptions: OPTIONS, overwrite: [], onOverwrite });
    fireEvent.click(boxes()[0]!);
    expect(onOverwrite).toHaveBeenCalledWith(["speakingStyle"]);
    unmount();
    const onOverwriteOff = vi.fn();
    renderPanel({ switchTarget: WORM, switchOptions: OPTIONS, overwrite: ["speakingStyle"], onOverwrite: onOverwriteOff });
    fireEvent.click(boxes()[0]!);
    expect(onOverwriteOff).toHaveBeenCalledWith([]);
  });

  it("没有自定义项时不摊勾选，只给一个换的按钮", () => {
    renderPanel({ switchTarget: WORM, switchOptions: [], overwrite: [] });
    expect(sheet()!.textContent).toContain("不会有东西被盖掉");
    expect(boxes()).toHaveLength(0);
    expect(confirmButton().textContent).toContain("温柔书虫");
  });

  it("没有可覆盖项时按钮上不出现「保留几项」这种废话", () => {
    renderPanel({ switchTarget: WORM, switchOptions: [], overwrite: [] });
    expect(confirmButton().textContent).not.toContain("保留");
  });

  it("保存中：勾选与按钮都锁住", () => {
    renderPanel({ switchTarget: WORM, switchOptions: OPTIONS, overwrite: [], busy: "preset" });
    expect(boxes().every((box) => box.disabled)).toBe(true);
    expect(confirmButton().textContent).toContain("正在换");
  });

  it("取消把控制权还给页面，不产生任何写入", () => {
    const onSwitchCancel = vi.fn();
    const onSwitchConfirm = vi.fn();
    renderPanel({ switchTarget: WORM, switchOptions: OPTIONS, overwrite: [], onSwitchCancel, onSwitchConfirm });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onSwitchCancel).toHaveBeenCalled();
    expect(onSwitchConfirm).not.toHaveBeenCalled();
  });
});

describe("谁写的：她能自己改了，屏上要看得见", () => {
  it("语气行标出「她改的」", () => {
    renderPanel();
    expect(document.querySelector(".cc-persona-identity p")?.textContent).toContain("她改的");
  });

  it("边界那颗开关标出「你改的」", () => {
    renderPanel();
    const nudge = [...document.querySelectorAll(".cc-switch-list button")].find((b) => b.textContent?.includes("学习提醒"));
    expect(nudge?.textContent).toContain("你改的");
  });

  it("预设自己写的那一项不标 —— 标了就成了噪音", () => {
    renderPanel();
    const playful = [...document.querySelectorAll(".cc-switch-list button")].find((b) => b.textContent?.includes("玩笑"));
    expect(playful?.querySelector(".cc-origin")).toBeNull();
  });

  it("还没有账号档案时表达分量与边界不再是死的 —— 改了就是第 1 版", () => {
    const fresh = personaWithoutArchive();
    renderPanel({ section: { ok: true, value: fresh }, persona: fresh });
    expect(screen.getByRole("button", { name: "活跃" }).hasAttribute("disabled")).toBe(false);
    for (const button of document.querySelectorAll(".cc-switch-list button")) {
      expect(button.hasAttribute("disabled")).toBe(false);
    }
  });
});

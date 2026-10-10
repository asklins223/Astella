// @vitest-environment jsdom

/**
 * 人格「待生效版本」在桌面端真的看得见、也真的能现在生效（40 §4.8.4 / A50）。
 *
 * ## 为什么这条值得有
 *
 * 服务端 `stagePetProfileRevision` / `activatePetProfilePendingRevision` 与三条路由
 * 早就写好了，桌面端却只有 get/versions/patch/restore/reset。结果是：
 *
 *  - 她排了一版新表达，用户在设置页**看不到**——「她改了但还没开始用」这件事
 *    完全不可见，于是它要么被当成已经生效（错的），要么被当成没发生（也是错的）；
 *  - 合同那句「回执与设置页显示当前/待生效版本和生效条件」在客户端整段落空。
 *
 * ## 这条钉住四件事
 *
 *  1. 待生效那一版**带生效条件**显示出来，且生效条件取自服务端那一格，界面不自己复述；
 *  2. 「现在生效」按**当前** revision 发起（服务端按当前版本做 CAS，传错号就每次 409）；
 *  3. 版本历史里那一版标着「待生效」——它已落库可查可恢复，只是还没被使用；
 *  4. 读不到时**不说「没有排队」**：那是一句面板并不知道的事实。
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PersonaPanel } from "../companion/companion-center-panels.tsx";
import {
  companionPersonaV1Schema,
  type CompanionPersonaPendingV1,
  type CompanionPersonaProfileVersionV1,
} from "@astella/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../../app/room-store.ts";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

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

function persona() {
  return companionPersonaV1Schema.parse({
    version: 1,
    profile: {
      id: "55555555-5555-4555-8555-555555555555",
      userId: USER_ID,
      presetId: "p-1",
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

function version(revision: number): CompanionPersonaProfileVersionV1 {
  return {
    id: `66666666-6666-4666-8666-00000000000${revision}`,
    revision,
    examplesRevision: 1,
    author: revision === 4 ? "assistant_tool" : "user",
    action: "update",
    reason: null,
    moduleScope: ["companion"],
    profile: {
      presetId: "p-1",
      name: "小满",
      personalityTags: ["稳"],
      speakingStyle: revision === 4 ? "先把证据摆出来，再说结论。" : "先给结论。",
      examples: [],
      activeness: "quiet",
      boundaries: {},
    },
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

function pending(): CompanionPersonaPendingV1 {
  return {
    version: 1,
    currentRevision: 3,
    pending: {
      revision: 4,
      profile: {
        presetId: "p-1",
        name: "小满",
        personalityTags: ["稳"],
        speakingStyle: "先把证据摆出来，再说结论。",
        examples: [],
        activeness: "quiet",
        boundaries: {},
      },
      author: "assistant_tool",
      action: "update",
      reason: "你连着三次先问证据再问结论。",
      moduleScope: ["companion"],
      stagedAt: "2026-09-23T00:00:00.000Z",
      // 生效条件由服务端提供，持久手记的下一轮新消息自动采用。
      effectiveWhen: "下一轮新发起的对话生效，当前已开始的调用保持原版本",
    },
  };
}

type PersonaProps = Parameters<typeof PersonaPanel>[0];

const noop = () => undefined;

function renderPanel(props: Partial<PersonaProps> = {}) {
  const base: PersonaProps = {
    section: { ok: true, value: persona() },
    persona: persona(),
    versions: [version(4), version(3), version(2)],
    versionsError: null,
    busy: null,
    error: null,
    notice: null,
    onPreset: noop,
    onActiveness: noop,
    onBoundary: noop,
    onReset: noop,
    onRestore: noop,
    onReloadVersions: noop,
    onRename: noop,
    onRetry: noop,
  };
  render(<PersonaPanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function activateButton(): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>(".cc-persona button")]
    .find((button) => button.textContent === "现在生效" || button.textContent === "正在应用这一版…") ?? null;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("40 §4.8.4 · 人格「待生效版本」在伴星中心看得见", () => {
  it("显示那一版的号、谁排的、以及**生效条件**", () => {
    renderPanel({ pending: pending() });
    const section = [...document.querySelectorAll(".cc-persona > .cc-section")]
      .find((node) => node.querySelector("h3")?.textContent === "待生效版本")!;
    expect(section).toBeTruthy();
    // 生效条件是服务端算出来的产品规则；界面复述一遍就一定会漂。
    expect(section.textContent).toContain("下一轮新发起的对话生效，当前已开始的调用保持原版本");
    expect(section.textContent).toContain("她调整的");
    expect(section.textContent).toContain("第 4 版");
    // 这一版的内容要能被读到，否则"她改了什么"仍然看不见。
    expect(section.textContent).toContain("先把证据摆出来，再说结论。");
  });

  it("「现在生效」按钮在，且点了就调那个动作", () => {
    const onActivatePending = vi.fn();
    renderPanel({ pending: pending(), onActivatePending });
    const button = activateButton();
    expect(button).toBeTruthy();
    fireEvent.click(button!);
    expect(onActivatePending).toHaveBeenCalledTimes(1);
  });

  it("忙碌时不许重复点", () => {
    renderPanel({ pending: pending(), busy: "activate-pending" });
    expect(activateButton()?.textContent).toBe("正在应用这一版…");
    expect(activateButton()?.disabled).toBe(true);
  });

  it("版本历史里那一版标着「待生效」，且当前版本那一版不能被误标", () => {
    renderPanel({ pending: pending() });
    const cards = [...document.querySelectorAll(".cc-persona-history .cc-version[data-pending]")];
    const pendingTags = cards
      .filter((card) => card.querySelector(".cc-tag")?.textContent === "待生效")
      .map((card) => card.querySelector("strong")?.textContent);
    expect(pendingTags).toEqual([expect.stringContaining("第 4 版")]);
  });

  it("回执里也报当前 / 待生效 / 生效条件（A50）", () => {
    renderPanel({ pending: pending() });
    const view = publishedView()!;
    expect(view.filters?.find((entry) => entry.label === "当前版本")?.value).toBe("第 3 版");
    expect(view.filters?.find((entry) => entry.label === "待生效版本")?.value).toBe("第 4 版");
    expect(view.filters?.find((entry) => entry.label === "生效条件")?.value).toBe("下一轮新发起的对话生效，当前已开始的调用保持原版本");
  });

  it("没有排队时明说没有，且没有那颗按钮", () => {
    // 「读到且没有排队」是 `{ pending: null }`，**不是**把 prop 整个置 null——
    // 后者与「还没读过」混成同一个值，面板会在第一次请求返回前就下结论。
    renderPanel({ pending: { version: 1, currentRevision: 3, pending: null } });
    expect(document.querySelector(".cc-persona")?.textContent).toContain("现在没有排队的人格版本");
    expect(activateButton()).toBeNull();
  });

  it("那一版的内容是 null ≠ 没有内容：说清是回到默认表达", () => {
    renderPanel({ pending: { ...pending(), pending: { ...pending().pending!, profile: null } } });
    const section = [...document.querySelectorAll(".cc-persona > .cc-section")]
      .find((node) => node.querySelector("h3")?.textContent === "待生效版本")!;
    expect(section.textContent).toContain("回到默认表达");
    // 关键：按钮仍在 —— "内容是回到默认" 也是一个真实排队的版本。
    expect(activateButton()).toBeTruthy();
  });

  it("读不到就说读不到，不谎称「没有排队」", () => {
    const onRetryPending = vi.fn();
    renderPanel({ pendingError: "人格服务不可用", onRetryPending });
    const section = [...document.querySelectorAll(".cc-persona > .cc-section")]
      .find((node) => node.querySelector("h3")?.textContent === "待生效版本")!;
    expect(section.textContent).toContain("待生效版本暂时读不到");
    expect(section.textContent).not.toContain("现在没有排队的人格版本");
    fireEvent.click([...section.querySelectorAll("button")].find((button) => button.textContent === "重新读取")!);
    expect(onRetryPending).toHaveBeenCalledTimes(1);
  });
});

describe("桌面端这三条通道接齐了", () => {
  // 本文件在 src/renderer/src/components/surfaces/__tests__/ 下，往上六级才是 apps/desktop-client。
  const CLIENT = resolve(import.meta.dirname, "..", "..", "..", "..", "..", "..");
  const read = (...parts: string[]) => readFileSync(join(CLIENT, ...parts), "utf8");

  it("契约 / 主进程 / preload 三处都有 pending / stage / activate", () => {
    const contracts = read("..", "..", "packages", "shared", "src", "contracts", "desktop-ipc-contracts.ts");
    const ipc = read("src", "main", "desktop-ipc-companion.ts");
    const preload = read("src", "preload", "index.ts");
    for (const channel of ["companionPersonaPending", "companionPersonaStage", "companionPersonaActivate"]) {
      expect(contracts, `契约里少了 ${channel}`).toContain(channel);
      expect(ipc, `主进程没接 ${channel}`).toContain(`DESKTOP_IPC_CHANNELS.${channel}`);
      expect(preload, `preload 没转发 ${channel}`).toContain(`DESKTOP_IPC_CHANNELS.${channel}`);
    }
  });

  it("「现在生效」传的是**当前** revision，不是待生效那一版的号", () => {
    // 服务端 `activatePetProfilePendingRevision` 按 `expectedRevision` 与当前版本做 CAS。
    // 传待生效那一版的号会让每一次点击都变成 409，面板只能显示「请刷新后重试」。
    const surface = read("src", "renderer", "src", "components", "surfaces", "companion", "companion-persona-page.tsx");
    expect(surface).toMatch(/persona\.activate\(\{[\s\S]*revision: pendingValue\.currentRevision/);
  });
});

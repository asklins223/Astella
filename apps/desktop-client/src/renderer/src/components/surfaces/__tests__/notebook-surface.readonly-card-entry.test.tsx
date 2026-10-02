// @vitest-environment jsdom

/**
 * §16.20「**没有无权执行的公共制卡按钮**」——只读成员那一格。
 *
 * 2026-09-27 的实情与更正：这一格**早就实现了**，不是"两路都未动"。
 * `notebook-surface.tsx:1431-1447` 用**服务端签发**的能力位
 * `capabilities.actionCapabilities["card_generation.start"] === "allowed"` 判门，
 * 按钮是 `disabled={!generationEnabled || startingGeneration}`，
 * 并且那句文案刻意把两件事分开（源码注释原话：「能力位被拒和开关没开是两件事：
 * 把前者说成后者，读者会以为去找管理员开功能，而真实原因是在这个空间里自己是只读身份」）。
 *
 * 缺的**只是断言**：现有三份相关测试用的全是 `"card_generation.start": "allowed"`
 * （正面那一档），`denied` 那一档在整个 renderer 里没有一处钉住——
 * 于是「把门拆掉」不会红，只会让只读成员看到一个点了必然失败的按钮。
 *
 * 这一份钉三件事：① 能力位被拒时按钮**不可点**，而不是点了撞 409；
 * ② 文案说清真实原因（只读身份），且**不**说成"功能没开放"；
 * ③ 能力位被拒**与**功能开关关掉，说的是两句不同的话。
 *
 * 夹具形状照 `notebook-surface.generation-options.test.tsx`（`window.ailearn`、
 * 顶层 `capabilities.get`、`subscriptions`、`useRoomStore.activeNoteRef`）——
 * 第一版自己另造了一套注入（`globalThis.desktopApi` + `desktop.capabilities`），
 * 结果渲染层根本读不到，四条全红。**跟着房子里已有的那一份写，别另发明。**
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { useRoomStore } from "../../../app/room-store.ts";

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

type Capabilities = {
  actionCapabilities: Record<string, string>;
  featureAvailability: Record<string, { state: string }>;
};

function stubGateway(capabilities: Capabilities, canEdit: boolean) {
  const state = { startRequests: [] as unknown[] };
  const gateway = {
    contract: { enabledRoutes: ["note.detail", "note.cardGeneration"] },
    auth: {
      getState: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { status: "authenticated" as const, workspace: { workspaceId: "w-1" } },
      })),
    },
    room: {
      getProjection: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: { primaryFocus: { state: "empty" }, activeGenerationSummary: { state: "empty" } },
      })),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "共享的那篇",
          sourceId: null,
          currentVersionId: VERSION_ID,
          permissions: { canEdit, canSave: canEdit },
          currentVersion: {
            versionId: VERSION_ID,
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "h",
            blocks: [{ ordinal: 1, type: "paragraph", content: "正文" }],
          },
        },
      })),
      cardGeneration: {
        latest: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: null })),
        start: vi.fn(async (input: { request: unknown }) => {
          state.startRequests.push(input.request);
          return { ok: true as const, workspaceEpoch: 1, data: { runId: "r-1" } };
        }),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: capabilities })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return state;
}

function mount(capabilities: Capabilities, canEdit = false) {
  const state = stubGateway(capabilities, canEdit);
  useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
  render(<NotebookSurface />);
  return state;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useRoomStore.setState({
    activeNoteRef: null,
    recentNoteId: null,
    surface: null,
    returnTarget: null,
    activeCardGenerationRunId: null,
  });
});

const DENIED: Capabilities = {
  actionCapabilities: { "note.save": "denied", "note.create": "denied", "card_generation.start": "denied" },
  featureAvailability: { card_generation_v2: { state: "enabled" } },
};
const OFF: Capabilities = {
  actionCapabilities: { "note.save": "allowed", "card_generation.start": "allowed" },
  featureAvailability: { card_generation_v2: { state: "disabled" } },
};
const ALLOWED: Capabilities = {
  actionCapabilities: { "note.save": "allowed", "card_generation.start": "allowed" },
  featureAvailability: { card_generation_v2: { state: "enabled" } },
};

const READONLY_COPY = "生成学习卡由空间所有者发起，你在这个空间是成员。";
const OFF_COPY = "学习卡生成现在没有开放。";

describe("§16.20 只读成员与公共制卡入口", () => {
  it("能力位被拒时，入口那颗按钮**不可点**，且点了不发任何请求", async () => {
    const state = mount(DENIED);
    const button = await screen.findByTitle(READONLY_COPY);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    (button as HTMLButtonElement).click();
    await waitFor(() => expect(state.startRequests).toHaveLength(0));
  });

  it("文案说清真实原因：只读身份，不是「功能没开放」", async () => {
    mount(DENIED);
    await screen.findByText(READONLY_COPY);
    // 源码注释点名的那个错：把「被拒」说成「没开」，读者会跑去找管理员开功能。
    expect(screen.queryByText(OFF_COPY)).toBeNull();
    expect(screen.queryByText("这台电脑还没有开放生成学习卡的入口。")).toBeNull();
  });

  it("能力位被拒与功能开关关掉，说的是两句不同的话", async () => {
    mount(DENIED);
    await screen.findByText(READONLY_COPY);
    cleanup();
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });

    mount(OFF);
    await screen.findByText(OFF_COPY);
    expect(screen.queryByText(READONLY_COPY)).toBeNull();
  });

  it("正控制：权限够且功能开着时，那颗按钮**不是**只读文案（这一格不许把门焊死）", async () => {
    mount(ALLOWED, true);
    await waitFor(() => {
      expect(screen.queryByText(READONLY_COPY)).toBeNull();
      expect(screen.queryByText(OFF_COPY)).toBeNull();
    });
    // 按类名取**入口那颗**，不按 title 猜：入口旁边还有一颗「调整这次」，
    // 两颗的提示里都有「生成」，`findByTitle` 会撞上两个而报不出是哪一颗。
    const entry = await waitFor(() => {
      const found = document.querySelector<HTMLButtonElement>(".notebook-card-entry");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(entry.disabled).toBe(false);
    // 次要那颗也必须同时可点——权限够的时候两档都通。
    const tweak = document.querySelector<HTMLButtonElement>(".notebook-card-entry__tweak");
    expect(tweak).not.toBeNull();
    expect(tweak!.disabled).toBe(false);
  });
});

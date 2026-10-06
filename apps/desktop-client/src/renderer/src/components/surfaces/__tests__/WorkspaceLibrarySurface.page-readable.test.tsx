// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveLibrarySurface } from "../library/WorkspaceLibrarySurface.tsx";
import { resetObjectiveLibraryView, retargetObjectiveLibraryView, writeObjectiveLibraryView } from "../run/objective-library-view-state.ts";
import { useRoomStore } from "../../../app/room-store.ts";
import type { PageReadableV1 } from "@astella/shared/companion-bridge-contracts";

/** 当前展开的纸卡与查找抽屉分开登记，隐藏卡片不冒充可见内容。 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function listItem(index: number, overrides: Record<string, unknown> = {}) {
  const id = `00000000-0000-4000-8000-00000000000${index}`;
  return {
    objectiveId: id,
    surfaceRevision: 1,
    conceptLabel: `卡 ${index}`,
    publicSummary: "质量是惯性大小的唯一量度。",
    knowledgeForm: "fact",
    cardStrategy: "why",
    lifecycle: "active",
    freshness: "fresh",
    primaryNoteId: "11111111-1111-4111-8111-111111111111",
    primaryNoteTitle: "物理笔记",
    createdAt: new Date().toISOString(),
    personalState: { state: "unvalidated", activeRunId: null },
    progress: {
      practiceTrailCount: 0,
      lastCanonicalAt: null,
      reviewDueAt: null,
      initialValidation: null,
      validationNotBefore: null,
    },
    primaryAction: { kind: "create_run", objectiveId: id, label: "开始首次验证", start: CARD_START },
    ...overrides,
  };
}

function installApi(items: Array<Record<string, unknown>>, options: { nextCursor?: string | null } = {}) {
  const api = {
    auth: {
      getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })),
    },
    objective: {
      list: vi.fn(async () => ok({
        version: 3,
        items,
        total: items.length,
        nextCursor: options.nextCursor ?? null,
        snapshotAt: new Date().toISOString(),
      })),
      get: vi.fn(async () => ok({})),
    },
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
  };
  Object.defineProperty(window, "astella", { value: api, configurable: true });
  return api;
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

function metric(label: string): string | undefined {
  return publishedView()?.metrics?.find((entry) => entry.label === label)?.value;
}

function filterValue(label: string): string | undefined {
  return publishedView()?.filters?.find((entry) => entry.label === label)?.value;
}

async function renderLibrary(items: Array<Record<string, unknown>>, options?: { nextCursor?: string | null }) {
  installApi(items, options);
  render(<ObjectiveLibrarySurface />);
  await waitFor(() => expect(publishedView()).not.toBeNull());
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "astella");
  resetObjectiveLibraryView();
  useRoomStore.setState({ pageReadableView: null, activeObjectiveId: null, activeRunId: null });
  vi.restoreAllMocks();
});

describe("学习卡收藏的可读视图与真实页面一致", () => {
  it("登记实际呈现的要点和收藏计数，不登记隐藏配置", async () => {
    await renderLibrary([listItem(1), listItem(2), listItem(3)]);
    expect(publishedView()!.pageId).toBe("goals");
    expect(metric("卡片册")).toBe("共 3 张卡");
    expect(publishedView()!.items?.map(item => item.label)).toEqual(["物理笔记"]);
    expect(publishedView()!.items?.[0].state).toBe("3 张学习卡");
    fireEvent.click(screen.getByRole("button", { name: "打开卡包：物理笔记" }));
    expect(publishedView()!.items?.map(item => item.label)).toEqual([...document.querySelectorAll(".card-collection__card-body > strong")].map(node => node.textContent));
    expect(publishedView()!.items).toHaveLength(3);
    expect(screen.queryByRole("group", { name: "筛选学习卡" })).toBeNull();
  });

  it("不同笔记的卡按真实分组顺序登记，搜索不需要先开抽屉", async () => {
    await renderLibrary([listItem(1), listItem(2, { primaryNoteId: "second-note", primaryNoteTitle: "另一篇笔记" }), listItem(3)]);
    expect(publishedView()!.items?.map(item => item.label)).toEqual([...document.querySelectorAll(".card-pack-object__caption > strong")].map(node => node.textContent));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索学习卡" }), { target: { value: "另一篇" } });
    expect(publishedView()!.items?.map(item => item.label)).toEqual(["另一篇笔记"]);
    fireEvent.click(screen.getByRole("button", { name: "打开卡包：另一篇笔记" }));
    expect(publishedView()!.items?.map(item => item.label)).toEqual(["卡 2"]);
  });

  it("过滤立即同步真实结果，清空后恢复全部学习卡", async () => {
    await renderLibrary([listItem(1), listItem(2), listItem(3)]);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索学习卡" }), { target: { value: "卡 2" } });
    fireEvent.click(screen.getByRole("button", { name: "打开卡包：物理笔记" }));
    expect(publishedView()!.items?.map(item => item.label)).toEqual(["卡 2"]);
    fireEvent.click(screen.getByRole("button", { name: "清空学习卡搜索" }));
    expect(publishedView()!.items).toHaveLength(3);
  });

  it("没有结果时登记实际搜索词与空态，清空后恢复真实清单", async () => {
    await renderLibrary([listItem(1)]);
    const input = screen.getByRole("textbox", { name: "搜索学习卡" });
    fireEvent.change(input, { target: { value: "不存在的词" } });
    expect(publishedView()!.notice).toMatch(/已载入范围内没有匹配卡片/);
    expect(filterValue("关键词")).toBe("不存在的词");
    expect(publishedView()!.items).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "清空学习卡搜索" }));
    expect(publishedView()!.filters).toBeUndefined();
    expect(publishedView()!.items).toHaveLength(1);
  });

  it("空卡库不伪造清单，入口回到笔记制作", async () => {
    await renderLibrary([]);
    expect(publishedView()!.items).toBeUndefined();
    expect(publishedView()!.notice).toContain("这里还没有学习卡");
    expect(document.body.textContent).toContain("去笔记挑一篇");
  });

  it("回到卡库保留搜索条件", async () => {
    retargetObjectiveLibraryView("ws-1"); writeObjectiveLibraryView({ query: "卡", filter: "all" });
    await renderLibrary([listItem(1)]);
    expect(filterValue("关键词")).toBe("卡");
    expect((screen.getByRole("textbox", { name: "搜索学习卡" }) as HTMLInputElement).value).toBe("卡");
  });

  it("尚未读到下一页时只报已载入卡片数", async () => {
    await renderLibrary([listItem(1)], { nextCursor: "later" });
    expect(metric("卡片册")).toBe("已载入 1 张卡");
    expect(publishedView()!.notice).toBeUndefined();
    expect(document.body.textContent).not.toContain("收藏都在这里了");
  });

  it("第一次读取没回来之前不登记，卸载时槽位让开", async () => {
    let release: (value: unknown) => void = () => undefined;
    Object.defineProperty(window, "astella", {
      configurable: true,
      value: {
        auth: {
          getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })),
        },
        objective: { list: vi.fn(() => new Promise((resolve) => { release = resolve; })), get: vi.fn() },
        room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
      },
    });
    const { unmount } = render(<ObjectiveLibrarySurface />);
    await waitFor(() => expect(document.body.textContent).toContain("正在读取学习卡"));
    expect(publishedView()).toBeNull();
    release(ok({ version: 3, items: [listItem(1)], total: 1, nextCursor: null, snapshotAt: new Date().toISOString() }));
    await waitFor(() => expect(publishedView()).not.toBeNull());
    unmount();
    expect(publishedView()).toBeNull();
  });
});

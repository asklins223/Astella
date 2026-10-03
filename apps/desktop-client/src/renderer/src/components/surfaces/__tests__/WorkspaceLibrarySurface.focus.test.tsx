// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectiveLibrarySurface } from "../library/WorkspaceLibrarySurface.tsx";
import { retargetObjectiveLibraryView } from "../run/objective-library-view-state.ts";
import { useRoomStore } from "../../../app/room-store.ts";

/** 收藏册呈现一篇笔记的多个要点，打开、查找与返回都不启动学习运行。 */

const OBJECTIVE_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000007";
const CARD_START = {
  version: 2,
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: OBJECTIVE_ID },
  goal: "stabilize",
  requestedTimeBudgetSeconds: 180,
  responsePreference: "adaptive",
} as const;

const ok = <T,>(data: T) => ({ ok: true as const, workspaceEpoch: 1, data });

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    objectiveId: OBJECTIVE_ID,
    surfaceRevision: 1,
    conceptLabel: "惯性与质量",
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
      practiceTrailCount: 0, lastCanonicalAt: null, reviewDueAt: null,
      initialValidation: null, validationNotBefore: null,
    },
    primaryAction: { kind: "create_run", objectiveId: OBJECTIVE_ID, label: "开始首次验证", start: CARD_START },
    ...overrides,
  };
}

function installApi(items: Array<Record<string, unknown>>, page: { total?: number; nextCursor?: string | null } = {}) {
  const api = {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceId: "ws-1", name: "W" }, workspaceEpoch: 1 })) },
    objective: {
      list: vi.fn(async () => ok({
        version: 3, items, total: page.total ?? items.length,
        nextCursor: page.nextCursor ?? null, snapshotAt: new Date().toISOString(),
      })),
      get: vi.fn(async () => ok({})),
    },
    room: { getProjection: vi.fn(async () => ok({ primaryFocus: { state: "empty" } })) },
    // 给 start 标注入参类型：不标的话 vi.fn 推成零参，下面读 calls[0][0] 在
    // typecheck 里是 `Tuple type '[]' has no element at index '0'`，而 vitest
    // 不做类型检查——测试照样绿着把这条类型错带进仓库。
    learningRun: {
      start: vi.fn(async (_input: {
        meta: unknown;
        commandId: string;
        request: { originV2: { cardId: string; objectiveId: string } };
      }) => ok({ runId: RUN_ID, snapshotId: "00000000-0000-4000-8000-000000000008" })),
    },
  };
  Object.defineProperty(window, "ailearn", { value: api, configurable: true });
  return api;
}

function stubRoom() {
  const invoke = vi.fn();
  // 只换 invoke；setActiveRunId / setActiveObjectiveId 用真的，这样断言
  // 「activeRunId 被写进去了」量的仍是实际行为。
  useRoomStore.setState({ invoke });
  return { invoke };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ailearn");
  retargetObjectiveLibraryView("ws-1");
  useRoomStore.setState({ activeRunId: null, activeObjectiveId: null, surface: null });
  vi.restoreAllMocks();
});

describe("学习卡包的入口与返回", () => {
  it("一个笔记是一套卡包，打开后才展开卡片，开包不会开始作答", async () => {
    const api = installApi([listItem(), listItem({ objectiveId: "second", conceptLabel: "能量守恒", primaryNoteId: "other", primaryNoteTitle: "能量笔记" })]); stubRoom();
    render(<ObjectiveLibrarySurface />);
    const pack = await screen.findByRole("button", { name: "打开卡包：物理笔记" });
    expect(screen.getByRole("button", { name: "打开卡包：能量笔记" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "翻开学习卡：惯性与质量" })).toBeNull();
    fireEvent.click(pack);
    expect(screen.getByRole("button", { name: "翻开学习卡：惯性与质量" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "翻开学习卡：能量守恒" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "物理笔记" }));
    expect(api.learningRun.start).not.toHaveBeenCalled();
  });

  it("筛选菜单即时接过焦点，Escape 合上并返回原按钮", async () => {
    installApi([listItem()]); stubRoom(); render(<ObjectiveLibrarySurface />);
    const toggle = await screen.findByRole("button", { name: "全部卡片" });
    expect(screen.queryByRole("group", { name: "筛选学习卡" })).toBeNull();
    fireEvent.click(toggle);
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "筛选学习卡" })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("打开卡包后选卡进详情，真实返回路径不偷偷开始作答", async () => {
    const api = installApi([listItem()]); const { invoke } = stubRoom(); render(<ObjectiveLibrarySurface />);
    fireEvent.click(await screen.findByRole("button", { name: "打开卡包：物理笔记" }));
    fireEvent.click(screen.getByRole("button", { name: "翻开学习卡：惯性与质量" }));
    expect(useRoomStore.getState().activeObjectiveId).toBe(OBJECTIVE_ID);
    const [action, options] = invoke.mock.calls[0];
    expect(action).toBe("open-objective"); expect(options.returnTo.label).toBe("返回学习卡");
    options.returnTo.run(); expect(invoke).toHaveBeenLastCalledWith("open-objectives");
    expect(api.learningRun.start).not.toHaveBeenCalled();
  });

  it("查找命中打开所属卡包，返回后保留卡包、关键词、阅读位置和原卡焦点", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    installApi([listItem(), listItem({ objectiveId: secondId, conceptLabel: "惯性实验" })]); const { invoke } = stubRoom(); render(<ObjectiveLibrarySurface />);
    const input = await screen.findByRole("textbox", { name: "搜索学习卡" });
    fireEvent.change(input, { target: { value: "惯性" } });
    fireEvent.click(screen.getByRole("button", { name: "打开卡包：物理笔记" }));
    const list = screen.getByLabelText("学习卡收藏内容"); list.scrollTop = 144; fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "翻开学习卡：惯性实验" }));
    expect(invoke.mock.calls[0][0]).toBe("open-objective");
    cleanup(); render(<ObjectiveLibrarySurface />);
    await waitFor(() => expect(document.activeElement?.getAttribute("data-objective-id")).toBe(secondId));
    expect((screen.getByRole("textbox", { name: "搜索学习卡" }) as HTMLInputElement).value).toBe("惯性");
    expect(screen.getByLabelText("学习卡收藏内容").scrollTop).toBe(144);
  });

  it("知识点搜索仍显示真实整包张数，清空后恢复包内所有卡", async () => {
    installApi([listItem(), listItem({ objectiveId: "second", conceptLabel: "实验" })]); stubRoom(); render(<ObjectiveLibrarySurface />);
    const input = await screen.findByRole("textbox", { name: "搜索学习卡" }), list = screen.getByLabelText("学习卡收藏内容");
    list.scrollTop = 144; fireEvent.scroll(list); fireEvent.change(input, { target: { value: "实验" } });
    expect(list.scrollTop).toBe(0);
    const pack = screen.getByRole("button", { name: "打开卡包：物理笔记" });
    expect(pack.textContent).toContain("2 张学习卡 · 找到 1 张"); fireEvent.click(pack);
    expect(document.querySelectorAll(".card-collection__card")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "清空学习卡搜索" }));
    expect(document.querySelectorAll(".card-collection__card")).toHaveLength(2);
    expect(document.activeElement).toBe(input);
  });

  it("Escape 先合包，再返回原封套；快速再打开仍可直接选卡", async () => {
    installApi([listItem()]); stubRoom(); render(<ObjectiveLibrarySurface />);
    const pack = await screen.findByRole("button", { name: "打开卡包：物理笔记" });
    fireEvent.click(pack); fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "翻开学习卡：惯性与质量" })).toBeNull();
    expect(document.activeElement).toBe(pack); fireEvent.click(pack);
    expect(screen.getByRole("button", { name: "翻开学习卡：惯性与质量" })).toBeTruthy();
  });

  it("斜线直接查找，Escape 优先清空当前关键词", async () => {
    installApi([listItem()]); stubRoom(); render(<ObjectiveLibrarySurface />);
    const input = await screen.findByRole("textbox", { name: "搜索学习卡" });
    fireEvent.keyDown(document.querySelector(".card-collection")!, { key: "/" }); expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "惯性" } }); fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe(""); expect(document.activeElement).toBe(input);
  });

  it("長笔记名与知识点保留全文，开包后的阅读标题不省略", async () => {
    const title = "主流零样本 TTS 技术范式与跨语言声学建模", note = "用一篇很长的笔记标题检验卡组排版与阅读";
    installApi([listItem({ conceptLabel: title, primaryNoteTitle: note })]); render(<ObjectiveLibrarySurface />);
    const pack = await screen.findByRole("button", { name: `打开卡包：${note}` }); expect(pack.textContent).toContain(note); fireEvent.click(pack);
    expect(screen.getByRole("button", { name: `翻开学习卡：${title}` }).textContent).toContain(title);
    expect(screen.getByRole("heading", { name: note }).textContent).toBe(note);
  });

  it("制卡入口回到笔记，不启动已有卡包的运行", async () => {
    const api = installApi([listItem()]); const { invoke } = stubRoom(); render(<ObjectiveLibrarySurface />);
    fireEvent.click(await screen.findByRole("button", { name: "做一套新卡" }));
    expect(invoke).toHaveBeenCalledWith("open-notes"); expect(api.learningRun.start).not.toHaveBeenCalled();
  });
});

describe("读取计数与搜索范围", () => {
  it("全部读完只说真实卡片与卡包数量", async () => {
    installApi([listItem(), listItem({ objectiveId: "second" })]); render(<ObjectiveLibrarySurface />);
    await waitFor(() => expect(document.querySelector(".card-collection__welcome")?.textContent).toContain("共 1 套 · 共 2 张卡"));
    expect(document.querySelector(".card-collection__search input")?.getAttribute("placeholder")).toBe("找一篇笔记，或一个知识点…");
  });
  it("还有下一页时不把目标总数当作卡片总数", async () => {
    installApi([listItem()], { total: 40, nextCursor: "cursor-2" }); render(<ObjectiveLibrarySurface />);
    await waitFor(() => expect(document.querySelector(".card-collection__welcome")?.textContent).toContain("已载入 1 张卡"));
    expect(document.querySelector(".card-collection__welcome")?.textContent).not.toContain("40");
    expect(document.querySelector(".card-collection__search input")?.getAttribute("placeholder")).toBe("找已载入的卡包或知识点");
    expect(screen.getByRole("button", { name: "再找一些卡包" })).toBeTruthy();
  });
});

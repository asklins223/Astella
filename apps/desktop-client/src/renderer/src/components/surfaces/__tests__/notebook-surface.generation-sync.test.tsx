// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import { useRoomStore } from "../../../app/room-store.ts";

/**
 * 笔记页的生成入口是状态同步，不是第二次启动：
 * - 本笔记有进行中的 run 时，按钮变成"去工作台看进度"，start 绝不被调用；
 * - 订阅事件到达时静默重读 projection，按钮跟随 run 的真实阶段；
 * - 没有 run 时才允许 start，成功后带着 runId 跳转工作台。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";
const OTHER_NOTE_ID = "11111111-1111-4111-8111-111111111112";
const OTHER_RUN_ID = "aaaaaaa2-2222-4222-8222-222222222222";

function generationSummary(status: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status,
    currentPlanVersion: 1,
    reviewDraftRevision: 1,
    sourceCapped: null,
    updatedAt: new Date().toISOString(),
    recovery: null,
    route: { kind: "note.cardGeneration", cardGenerationRunId: RUN_ID },
    ...overrides,
  };
}

function stubGateway(
  initialGenerationStatus: string | null,
  extraSummaries: object[] = [],
  options: { startRejects?: boolean; summaryOverrides?: Record<string, unknown> } = {},
) {
  const state = {
    generationStatus: initialGenerationStatus,
    projectionReads: 0,
    startCalls: 0,
    startRequests: [] as unknown[],
    eventHandlers: new Map<string, () => void>(),
  };
  const projection = () => ({
    primaryFocus: {
      state: "data",
      data: {
        objective: {
          content: { conceptLabel: "测试目标", publicSummary: "", sourceLabel: null },
          personal: { lastCanonicalAt: null },
          sources: { primaryNote: { noteId: NOTE_ID, noteVersionId: VERSION_ID } },
        },
      },
    },
    activeGenerationSummary: state.generationStatus || extraSummaries.length
      ? {
        state: "data",
        data: [
          ...extraSummaries,
          ...(state.generationStatus ? [generationSummary(state.generationStatus, options.summaryOverrides)] : []),
        ],
      }
      : { state: "empty" },
  });
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
      getProjection: vi.fn(async () => {
        state.projectionReads += 1;
        return { ok: true as const, workspaceEpoch: 1, data: projection() };
      }),
    },
    note: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          noteId: NOTE_ID,
          title: "测试笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          permissions: { canEdit: true, canSave: true },
          currentVersion: {
            versionNo: 1,
            updatedAt: new Date().toISOString(),
            contentHash: "hash",
            blocks: [{ ordinal: 1, type: "paragraph", content: "hello" }],
          },
        },
      })),
      cardGeneration: {
        start: vi.fn(async (input: { request: unknown }) => {
          state.startCalls += 1;
          state.startRequests.push(input.request);
          if (options.startRejects) {
            // 服务端早已在跑这篇的批次，只是页面那一刻没看到。
            state.generationStatus = "review_ready";
            throw new Error("note_generation_in_flight");
          }
          return { ok: true as const, workspaceEpoch: 1, data: { runId: RUN_ID } };
        }),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "note.create": "allowed", "card_generation.start": "allowed" },
          featureAvailability: {
            card_generation_v2: { state: "enabled" },
            companion_dialogue_v1: { state: "disabled" },
          },
        },
      })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn((_subscriptionId: string, handler: () => void) => {
        state.eventHandlers.set("sub-1", handler);
        return () => state.eventHandlers.delete("sub-1");
      }),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ surface: null, activeCardGenerationRunId: null, activeNoteRef: null, returnTarget: null });
});

describe("NotebookSurface · 学习卡生成状态同步", () => {
  it("服务端投影标记正文被截断时如实显示覆盖范围", async () => {
    stubGateway("checking", [], { summaryOverrides: { sourceCapped: { limit: 60_000, originalLength: 123_456 } } });
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { findByText } = render(<NotebookSurface />);
    const coverage = await findByText("仅部分正文");
    expect(coverage.getAttribute("title")).toBe("这一篇较长：本次只把前 60000 字（全文 123456 字）交给模型，其余部分这次没有参与生成。");
  });

  it("服务端没有报告截断时不显示覆盖范围提示", async () => {
    stubGateway("checking");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { container, findByTitle } = render(<NotebookSurface />);

    await findByTitle("这次生成在后台进行，来回翻看不会打断它");
    expect(container.querySelector(".notebook-card-entry__coverage")).toBeNull();
  });

  it("本笔记有进行中的 run 时，入口变成查看进度且不重复 start", async () => {
    const { state } = stubGateway("checking");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByTitle } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(entry.textContent).toContain("查看生成进度");

    fireEvent.click(entry);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
    expect(state.startCalls).toBe(0);
  });

  /**
   * 2026-09-20 实走复盘 #5：projection 曾只带「最近更新的那一个」run，
   * 于是另一篇笔记一开跑，这篇的守卫就失效——同一篇笔记可以再点一次
   * 「生成学习卡」，每点一次多一批候选卡，旧批次又不会被任何环节标成废弃。
   */
  it("另一篇笔记的在制批次排在前面时，这篇自己的批次仍然生效", async () => {
    const otherNoteRun = generationSummary("authoring", {
      noteId: OTHER_NOTE_ID,
      runId: OTHER_RUN_ID,
      route: { kind: "note.cardGeneration", cardGenerationRunId: OTHER_RUN_ID },
    });
    const { state } = stubGateway("review_ready", [otherNoteRun]);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByTitle, queryByText } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByTitle("这一批已经写好，等你逐张决定留哪些"));
    expect(entry.textContent).toContain("审核学习卡");
    expect(queryByText("生成学习卡")).toBeNull();

    fireEvent.click(entry);
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
    expect(state.startCalls).toBe(0);
  });

  it("订阅事件触发静默重读，按钮跟随 run 阶段翻转到审核", async () => {    const { state } = stubGateway("checking");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { getByTitle } = render(<NotebookSurface />);

    const entry = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(entry.textContent).toContain("查看生成进度");
    const readsAfterMount = state.projectionReads;
    await waitFor(() => expect(state.eventHandlers.has("sub-1")).toBe(true));

    state.generationStatus = "review_ready";
    state.eventHandlers.get("sub-1")?.();

    const reviewed = await waitFor(() => getByTitle("这次生成在后台进行，来回翻看不会打断它"));
    expect(reviewed.textContent).toContain("审核学习卡");
    expect(state.projectionReads).toBeGreaterThan(readsAfterMount);
    expect(state.startCalls).toBe(0);
  });

  /**
   * 2026-10-04 用户决定：入口从"按下去直接用默认档开跑"改成"按下去先开
   * 「这次想怎么练？」"。过去多数人按这一下只要的是默认档，却根本不知道自己
   * 挑走了什么——直到卡片出来了才发现方向不对，而那一批已经跑完。
   * 现在这一格只有一颗按钮，方向、数量、详略、卡型都在那张屏上，选完才开始。
   */
  it("没有 run 时入口开方案屏，选完才开始生成", async () => {
    const { gateway, state } = stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { findByRole, queryByRole, findByText } = render(<NotebookSurface />);

    const entry = await findByRole("button", { name: "生成学习卡" });
    expect(gateway.subscriptions.subscribe).not.toHaveBeenCalled();
    // 按下去之前没有任何生成任务被创建。
    expect(state.startCalls).toBe(0);

    fireEvent.click(entry);
    const dialog = await findByRole("dialog", { name: "这次想怎么练？" });
    expect(dialog).toBeTruthy();
    expect(state.startCalls).toBe(0);

    fireEvent.click(await findByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
    expect(state.startCalls).toBe(1);
    // 默认档原样发出：全选题型、8 张上限。
    expect(state.startRequests[0]).toMatchObject({
      learningGoal: "understand",
      detailThreshold: "balanced",
      quantity: { kind: "adaptive", hardMaxCards: 8 },
    });
  });

  it("这一格始终留着「再来一批」：等着挑时去看那批，旁边补一颗「重新生成学习卡」", async () => {
    // 2026-10-04 用户决定（第二次）：这一格曾被并成一颗按钮，于是"再来一批"这个
    // 决定在"有事发生"的时候整个不存在（用户只能先去进度页里找），而且正文改过
    // 之后那颗仍然读作「查看生成进度」。两颗按钮回答的是两个不同的问题。
    const { state } = stubGateway("review_ready");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { findByRole } = render(<NotebookSurface />);

    const entry = await findByRole("button", { name: "学习卡：待激活" });
    expect(entry.textContent).toContain("审核学习卡");
    expect(document.querySelectorAll(".notebook-card-entry").length).toBe(1);
    // 「调整这次」撤掉了：它按下去开的就是「重新生成学习卡」按下去开的那张方案屏，
    // 两颗同义按钮只会要用户先认出哪一颗是哪一颗。
    expect(screen.queryByText("调整这次")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "重新生成学习卡" }));
    await screen.findByRole("dialog", { name: "这次想怎么练？" });
    expect(state.startCalls).toBe(0);
  });

  it("被服务端拒绝后重读状态：方案屏上说明失败，入口翻到真实阶段，不再反复撞同一个拒绝", async () => {
    const { state } = stubGateway(null, [], { startRejects: true });
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    const { findByRole, getAllByRole, getByTitle } = render(<NotebookSurface />);

    fireEvent.click(await findByRole("button", { name: "生成学习卡" }));
    fireEvent.click(await findByRole("button", { name: "开始生成" }));

    // 拒绝留在方案屏上说，同时投影重读：入口翻到这篇笔记真实的阶段。
    await waitFor(() => expect(getAllByRole("alert").length).toBeGreaterThan(0));
    const entry = await waitFor(() => getByTitle("这一批已经写好，等你逐张决定留哪些"));
    expect(entry.textContent).toContain("审核学习卡");
    expect(state.startCalls).toBe(1);

    // 关掉方案屏再点入口，是去看那一批，不是再开一次生成。
    fireEvent.click(await findByRole("button", { name: "关闭生成方案" }));
    fireEvent.click(entry);
    expect(state.startCalls).toBe(1);
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { NotebookSurface } from "../notebook/notebook-surface.tsx";
import * as liveDocument from "../notebook/use-note-doc-live-view.ts";
import { useRoomStore } from "../../../app/room-store.ts";

/**
 * 生成入口的两条合同：
 * - 参数不再是写死的：学习目标/详略/上限/题型都由写作者选择并原样提交；
 * - 上一次生成已经结束时，选一个原因就变成"按反馈重生成"，请求带上 previousRunId
 *   与原因码（契约要求 min 1），不选原因则是普通生成。
 */

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "aaaaaaa1-1111-4111-8111-111111111111";
const PREVIOUS_RUN_ID = "bbbbbbb2-2222-4222-8222-222222222222";

function stubGateway(latestRunStatus: string | null, runVersionId = VERSION_ID) {
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
          title: "提取练习笔记",
          sourceId: null,
          currentVersionId: VERSION_ID,
          permissions: { canEdit: true, canSave: true },
          currentVersion: { versionId: VERSION_ID, versionNo: 1, updatedAt: new Date().toISOString(), contentHash: "h", blocks: [{ ordinal: 1, type: "paragraph", content: "正文" }] },
        },
      })),
      versions: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { noteId: NOTE_ID, items: [], total: 0 } })),
      cardGeneration: {
        latestRun: vi.fn(async () => (latestRunStatus === null
          ? { ok: false as const, workspaceEpoch: 1, error: { code: "not_found", message: "还没有生成记录" } }
          : {
              ok: true as const,
              workspaceEpoch: 1,
              data: {
                version: 1,
                runId: PREVIOUS_RUN_ID,
                noteId: NOTE_ID,
                noteVersionId: runVersionId,
                status: latestRunStatus,
                cardContentEpoch: 1,
                currentPlanVersion: 1,
                reviewDraftRevision: 1,
                sourceOutdated: false,
                sourceRef: { noteId: NOTE_ID, noteVersionId: runVersionId },
                recovery: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            })),
        close: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { runId: PREVIOUS_RUN_ID, status: "closed_without_activation", reviewDraftRevision: 2 } })),
        start: vi.fn(async (input: { request: unknown }) => {
          state.startRequests.push(input.request);
          return { ok: true as const, workspaceEpoch: 1, data: { runId: RUN_ID } };
        }),
      },
    },
    capabilities: {
      get: vi.fn(async () => ({
        ok: true as const,
        workspaceEpoch: 1,
        data: {
          actionCapabilities: { "note.save": "allowed", "card_generation.start": "allowed" },
          featureAvailability: { card_generation_v2: { state: "enabled" } },
        },
      })),
    },
    subscriptions: {
      subscribe: vi.fn(async () => ({ ok: true as const, workspaceEpoch: 1, data: { subscriptionId: "sub-1" } })),
      onEvent: vi.fn(() => () => undefined),
      unsubscribe: vi.fn(async () => ({ ok: true as const, data: null })),
    },
  };
  window.ailearn = gateway as unknown as typeof window.ailearn;
  return { gateway, state };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useRoomStore.setState({ activeNoteRef: null, recentNoteId: null, surface: null, returnTarget: null, activeCardGenerationRunId: null });
});

/**
 * 打开「这次想怎么练？」——按入口那颗，不按文字。
 *
 * 入口的**说法**随这篇笔记此刻的样子变（从没做过 → 生成学习卡；做过并已停 →
 * 重新生成学习卡；正文改过 → 又回到生成学习卡），而按下去开的是同一张方案屏。
 * 按类名取这一颗，测试就不必跟着文案一起改。
 */
async function openSetup() {
  await waitFor(() => expect(document.querySelector<HTMLButtonElement>(".notebook-card-entry")).toBeTruthy());
  fireEvent.click(document.querySelector<HTMLButtonElement>(".notebook-card-entry")!);
  await waitFor(() => expect(screen.getByRole("dialog", { name: "这次想怎么练？" })).toBeTruthy());
}

describe("NotebookSurface · 生成参数与反馈重生成", () => {
  /**
   * 2026-10-04 实机：「这个界面还不能滚动」——选项被裁在原地，滚轮推不动。
   *
   * 根因是那一格原本是 `<fieldset class="generation-options">`：Chromium 里 fieldset
   * 即使 `overflow: auto` 也照常算出 `scrollHeight > clientHeight`，却没有可滚的溢出
   * 区——`scrollTop` 永远停在 0（用真实 Chromium 对照 fieldset 与 div 量出来的）。
   * jsdom 不排版，所以这里钉的是**别再把 fieldset 当滚动容器**这条契约本身。
   */
  it("选项区不是 fieldset：Chromium 不让 fieldset 滚动", async () => {
    stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);
    await openSetup();

    const options = document.querySelector(".generation-options")!;
    expect(options.tagName).toBe("DIV");
    expect(options.getAttribute("role")).toBe("group");
    // 「生成中不许再改」仍要成立：过去靠 `<fieldset disabled>`，现在靠 inert。
    expect(options.hasAttribute("inert")).toBe(false);
  });

  it("生成中这一片被收起，Tab 也不再走进去", async () => {
    stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    // start 挂住不返回，这一轮就停在「正在创建任务…」。
    (window.ailearn.note.cardGeneration.start as unknown as { mockImplementation: (fn: () => Promise<never>) => void })
      .mockImplementation(() => new Promise(() => undefined));
    render(<NotebookSurface />);
    await openSetup();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => expect(document.querySelector(".generation-options")?.hasAttribute("inert")).toBe(true));
    expect(screen.getByRole("button", { name: "正在创建任务…" })).toBeTruthy();
  });

  it("参数选择进入请求，不再写死", async () => {
    const { state } = stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await openSetup();
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    fireEvent.click(screen.getByText("微调这叠卡").closest("summary")!);
    fireEvent.click(screen.getByRole("button", { name: "深入" }));
    fireEvent.click(screen.getByRole("button", { name: "4 张" }));
    // 默认全选题型（= 交给 planner 按知识形态分配），点一下即取消该题型。
    fireEvent.click(screen.getByRole("button", { name: "对比辨析" }));

    expect(screen.getByText("系统会按笔记内容挑选；关掉某一种，这次就不用它。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect(state.startRequests[0]).toMatchObject({
      learningGoal: "apply",
      detailThreshold: "deep",
      quantity: { kind: "adaptive", hardMaxCards: 4 },
    });
    expect((state.startRequests[0] as { preferredStrategies: string[] }).preferredStrategies)
      .toEqual(["recall", "cloze", "sequence", "why", "boundary", "application"]);
    // 方案确认后，请求保留选定的卡型集合。
  });

  it("上次生成已结束时，选原因即按反馈重生成并带上 previousRunId", async () => {
    const { state } = stubGateway("closed_without_activation");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await openSetup();
    fireEvent.click(screen.getByText("让这次更合心意").closest("summary")!);
    await waitFor(() => expect(screen.getByText(/上次已结束，没有保存到卡组/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "卡片太多" }));
    fireEvent.change(screen.getByLabelText("重新生成的补充说明"), { target: { value: "最多 5 张" } });

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect(state.startRequests[0]).toMatchObject({
      feedbackContext: {
        previousRunId: PREVIOUS_RUN_ID,
        reasonCodes: ["too_many"],
        optionalNote: "最多 5 张",
      },
    });
  });

  it("编辑态同样摸得到版本历史与生成设置（复盘 #15）", async () => {
    // 这两个面板的 state 一直在同一个组件里，此前只有阅读页摆出按钮，
    // 于是"边写边看有哪几版""改完设置直接再生成"都只能先退回只读。
    stubGateway(null);
    useRoomStore.setState({
      activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID, mode: "live-preview" },
    });
    render(<NotebookSurface />);
    await waitFor(() => expect(document.querySelector(".notebook-workspace[data-mode=\"live-preview\"]")).toBeTruthy());

    await openSetup();
    fireEvent.click(screen.getByRole("button", { name: "关闭生成方案" }));

    fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
    await waitFor(() => expect(screen.getByLabelText("笔记版本历史")).toBeTruthy());
    expect(screen.getByText(/还没有可列出的版本/)).toBeTruthy();
    expect(document.querySelector(".notebook-workspace[data-mode=\"live-preview\"]")).toBeTruthy();
  });

  it("没有生成记录时不显示反馈区，也不带 feedbackContext", async () => {
    const { state } = stubGateway(null);
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await openSetup();
    expect(screen.queryByText("让这次更合心意")).toBeNull();
    expect(screen.queryByRole("button", { name: "卡片太多" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect((state.startRequests[0] as { feedbackContext?: unknown }).feedbackContext).toBeUndefined();
  });
});

describe("笔记改版后的学习卡入口", () => {
  /**
   * 2026-10-04 用户决定（第二次）。上一版把这一格并成一颗按钮，正文改过之后它仍然
   * 读作「查看生成进度」／「审核学习卡」——那正是用户指着屏幕说的：「我改动了文档，
   * 却没有给我出现生成学习卡按钮？还是那一个查看生成进度／候选卡审查？这是不对的」。
   *
   * 判据是"这一版正文有没有已经做过卡"：
   *   - 旧的那批是按**别的版本**做的 → 主按钮是「生成学习卡」（按现在这一版重新做），
   *     旧的那批挪到旁边「查看旧版生成」；
   *   - 旧的那批就是按**现在这一版**做的 → 主按钮去看它，另外补一颗「重新生成学习卡」。
   */
  it.each(["review_ready", "activated"] as const)(
    "旧版那一批还在（%s）但依据的是别的版本：入口是「生成学习卡」，旧的去旁边看",
    async status => {
      const { state } = stubGateway(status, "old-note-version");
      useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
      render(<NotebookSurface />);

      const entry = await screen.findByRole<HTMLButtonElement>("button", { name: "生成学习卡" });
      expect(entry.disabled).toBe(false);
      // 按主按钮开的是方案屏（按当前正文另开一批），不是去看旧的那批。
      fireEvent.click(entry);
      await screen.findByRole("dialog", { name: "这次想怎么练？" });
      expect(state.startRequests).toHaveLength(0);

      // 旧的那批仍然摸得到。
      fireEvent.click(screen.getByRole("button", { name: "关闭生成方案" }));
      fireEvent.click(screen.getByRole("button", { name: "查看旧版生成" }));
      await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
      expect(useRoomStore.getState().activeCardGenerationRunId).toBe(PREVIOUS_RUN_ID);
      expect(state.startRequests).toHaveLength(0);
    });

  it("正文同步但尚未保存成版本时，review_ready 的那一批同样要让位给「生成学习卡」", async () => {
    const { state } = stubGateway("review_ready");
    const fragment = new Y.Doc().getXmlFragment("note");
    const useLiveDocument = liveDocument.useNoteDocLiveView;
    vi.spyOn(liveDocument, "useNoteDocLiveView").mockImplementation((...args) => ({
      ...useLiveDocument(...args),
      fragment,
      title: "提取练习笔记",
      blocks: [{ ordinal: 1, type: "paragraph", content: "已经同步的新正文，还没有保存为版本" }],
      dirty: false,
    }));
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    // 读着的正文与已存版本不是同一份 ⇒ 这一版还没有任何一批卡。
    const entry = await screen.findByRole<HTMLButtonElement>("button", { name: "生成学习卡" });
    expect(entry.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "查看旧版生成" }));
    await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
    expect(state.startRequests).toHaveLength(0);
  });

  it("正文改过而旧版还在跑：入口是「生成学习卡」但被挡住，理由写在它身上", async () => {
    stubGateway("authoring", "old-note-version");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    const entry = await screen.findByRole<HTMLButtonElement>("button", { name: "生成学习卡" });
    expect(entry.disabled).toBe(true);
    expect(entry.title).toContain("旧版笔记还在生成");
    // 正在生成时「重新生成」一颗都不摆：先停下来，而那一颗在进度页上。
    expect(screen.queryByText("重新生成学习卡")).toBeNull();
    expect(screen.getByRole("button", { name: "查看旧版生成" })).toBeTruthy();
  });

  it.each([["review_ready", "审核学习卡", "待激活"], ["activated", "查看学习卡", "已完成"]] as const)(
    "旧的那批就是按现在这一版做的（%s）：入口去看它，旁边补一颗「重新生成学习卡」",
    async (status, label, stateWord) => {
      const { state } = stubGateway(status);
      useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
      render(<NotebookSurface />);

      const entry = await screen.findByRole<HTMLButtonElement>("button", { name: `学习卡：${stateWord}` });
      expect(entry.textContent).toContain(label);
      fireEvent.click(entry);
      await waitFor(() => expect(useRoomStore.getState().surface).toBe("card-generation"));
      expect(state.startRequests).toHaveLength(0);

      // 「重新生成」是**另一个决定**，不能藏在这一颗里面：它开方案屏，不跳工位。
      fireEvent.click(screen.getByRole("button", { name: "重新生成学习卡" }));
      await screen.findByRole("dialog", { name: "这次想怎么练？" });
    });

  it("后台还在做：入口去看它，这一格不摆「重新生成」（先停止才有重新）", async () => {
    stubGateway("authoring");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    const entry = await screen.findByRole<HTMLButtonElement>("button", { name: "学习卡：生成中" });
    expect(entry.textContent).toContain("查看生成进度");
    expect(screen.queryByText("重新生成学习卡")).toBeNull();
  });

  it("上一批已经结束就没东西可看：入口是「重新生成学习卡」，方案屏里再开始", async () => {
    const { state, gateway } = stubGateway("cancelled");
    useRoomStore.setState({ activeNoteRef: { noteId: NOTE_ID, noteVersionId: VERSION_ID } });
    render(<NotebookSurface />);

    await screen.findByRole("button", { name: "重新生成学习卡" });
    // 主按钮已经是"另开一批"，旁边不再挂同义的那一颗（这一格只该出现一次这个说法）。
    expect(screen.getAllByText("重新生成学习卡")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "重新生成学习卡" }));
    await screen.findByRole("dialog", { name: "这次想怎么练？" });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => expect(state.startRequests).toHaveLength(1));
    expect(state.startRequests[0]).toMatchObject({ noteVersionId: VERSION_ID });
    expect(gateway.note.cardGeneration.close).not.toHaveBeenCalled();
    expect(useRoomStore.getState().activeCardGenerationRunId).toBe(RUN_ID);
  });
});

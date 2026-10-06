// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionChatSession } from "../../../app/companion-chat-session.tsx";
import type { GatewayResultV1 } from "@astella/shared/desktop-ipc-contracts";
import type { NoteAnnotationAnchorV1, NoteAnnotationV1 } from "@astella/shared/note-annotation-contracts";
import { CompanionHud, type CompanionHudSettings } from "../CompanionHud.tsx";
import { DEFAULT_WINDOW_LIVE2D_MODEL_ID } from "../window-live2d-contract.ts";
import { beginNoteExplanation, completeNoteExplanation, interruptNoteExplanation, progressNoteExplanation, resetNoteExplanations, useNoteCompanionExplanations } from "../note-companion-explanation";

const { chatState } = vi.hoisted(() => ({ chatState: { current: null as unknown } }));

vi.mock("../../../app/companion-chat-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../app/companion-chat-session")>();
  return { ...actual, useCompanionChat: () => chatState.current };
});

vi.mock("../../../app/companion-voice-playback", () => ({
  beginCompanionSpeechLine: vi.fn(),
  stopCompanionSpeech: vi.fn(),
  subscribeCompanionSpeech: () => () => undefined,
}));

vi.mock("../../../app/companion-voice-level", () => ({ subscribeHomeV2VoiceLevel: () => () => undefined }));

vi.mock("../use-companion-voice-input", () => ({
  useCompanionVoiceInput: () => ({
    phase: "idle",
    note: null,
    noteRevision: 0,
    supported: false,
    toggle: vi.fn(),
    cancel: vi.fn(),
    dismissNote: vi.fn(),
    subscribeLevel: () => () => undefined,
  }),
}));

vi.mock("../companion-agent-rail", () => ({ CompanionAgentRail: () => null, companionAgentRailVisible: () => false }));
vi.mock("../CompanionProposalChoice", () => ({ CompanionProposalChoice: () => null }));
vi.mock("../CompanionRunTraceView", () => ({ CompanionRunTraceView: () => null }));

const NOTE_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const NOTE_ANCHOR: NoteAnnotationAnchorV1 = {
  noteVersionId: NOTE_VERSION_ID,
  startBlockOrdinal: 2,
  startOffset: 5,
  endBlockOrdinal: 2,
  endOffset: 12,
  excerpt: "调用外部工具",
  prefix: "Agent 可以",
  suffix: "获取实时信息",
};

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "note-persistence-test",
    correlationId: "note-persistence-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function session(overrides: Partial<CompanionChatSession> = {}): CompanionChatSession {
  return {
    phase: "ready",
    failure: null,
    conversationId: CONVERSATION_ID,
    messages: [],
    liveReply: null,
    richReply: null,
    draft: null,
    interrupted: null,
    nodes: [],
    runTraces: [],
    feedSelection: null,
    feedPrompt: "先帮我速看这篇笔记",
    feedNoteAnchor: null,
    feedNoteIntent: { kind: "overview", noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID, noteTitle: "工具调用" },
    autoSendRequestId: null,
    navChips: [],
    proposalStates: {},
    mode: "conversation",
    companionName: "伴星",
    historyHasMore: false,
    historyLoadingOlder: false,
    historyOlderError: null,
    historyRevision: 0,
    assistantCue: null,
    cancelling: false,
    stopNotice: null,
    setCompanionName: vi.fn(),
    loadOlderMessages: vi.fn(async () => undefined),
    fetchAllMessages: vi.fn(async () => []),
    send: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    dismissStopNotice: vi.fn(),
    dismissLiveReply: vi.fn(),
    dismissRichReply: vi.fn(),
    dismissFeedSelection: vi.fn(),
    dismissFeedNoteAnchor: vi.fn(),
    dismissFeedNoteIntent: vi.fn(),
    setMode: vi.fn(),
    dismissNavChip: vi.fn(),
    decideProposal: vi.fn(async () => undefined),
    retryProposal: vi.fn(),
    goToRoute: vi.fn(async () => undefined),
    ...overrides,
  } as CompanionChatSession;
}

function settings(): CompanionHudSettings {
  return {
    scale: 1,
    scaleMin: 0.7,
    scaleMax: 1.3,
    pageMuted: false,
    taskActive: false,
    focusUntilTaskEnd: false,
    onScale: vi.fn(),
    onTogglePageMuted: vi.fn(),
    onToggleFocus: vi.fn(),
    onHide: vi.fn(),
    onResetPosition: vi.fn(),
  };
}

function renderHud() {
  return render(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
}

describe("伴星回答保存回笔记", () => {
  let writeOverview: ReturnType<typeof vi.fn>;
  let writeAnnotation: ReturnType<typeof vi.fn<(request: unknown) => Promise<GatewayResultV1<NoteAnnotationV1>>>>;
  let annotationVersionState: "current" | "older";

  beforeEach(() => {
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });

    writeOverview = vi.fn(async () => ok({
      overviewId: "55555555-5555-4555-8555-555555555555",
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      noteVersionNumber: 4,
      body: "速览内容",
      references: [],
      sourceMessageId: MESSAGE_ID,
      generationJobId: null,
      conversationId: CONVERSATION_ID,
      versionState: "current",
      createdAt: "2026-09-29T00:00:00.000Z",
    }));
    annotationVersionState = "current";
    writeAnnotation = vi.fn<(request: unknown) => Promise<GatewayResultV1<NoteAnnotationV1>>>(async () => ok({
      annotationId: "66666666-6666-4666-8666-666666666666",
      noteId: NOTE_ID,
      anchor: NOTE_ANCHOR,
      explanation: "工具是 Agent 调用外部能力的接口。",
      sourceMessageId: MESSAGE_ID,
      generationJobId: null,
      revision: 1,
      versionState: annotationVersionState,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
    }));
    Object.defineProperty(window, "astella", {
      configurable: true,
      value: {
        noteOverview: { write: writeOverview },
        noteAnnotation: { write: writeAnnotation },
      },
    });
    resetNoteExplanations();
    chatState.current = session();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("点速看入口就把白话请求发给伴星，不要求用户再按一次发送", async () => {
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const send = vi.fn(async () => true);
    chatState.current = session({
      autoSendRequestId: requestId,
      feedPrompt: "先读这篇笔记，用白话说清 2–3 个重点。",
      feedNoteIntent: { requestId, kind: "overview", noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID, noteTitle: "工具调用" },
      send,
    });
    renderHud();

    await waitFor(() => expect(send).toHaveBeenCalledWith({ text: "先读这篇笔记，用白话说清 2–3 个重点。" }));
    expect(screen.getByRole("textbox", { name: "给 伴星 的消息" })).toHaveProperty("value", "");
  });

  it("用户选中原文并点让伴星讲讲后，自动发送时保留原句锚点", async () => {
    const send = vi.fn(async () => true);
    chatState.current = session({
      autoSendRequestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      feedPrompt: "用白话解释这句",
      feedSelection: NOTE_ANCHOR.excerpt,
      feedNoteIntent: null,
      feedNoteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR },
      send,
    });
    renderHud();

    await waitFor(() => expect(send).toHaveBeenCalledWith({
      text: "用白话解释这句",
      selection: { text: NOTE_ANCHOR.excerpt },
      noteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR },
    }));
  });

  it("选文交接和生成期间，选文条随气泡展示并能回到原句进度", () => {
    const item = beginNoteExplanation({ noteId: NOTE_ID, anchor: NOTE_ANCHOR });
    progressNoteExplanation(item.id, "");
    chatState.current = session({ mode: "closed", phase: "sending", feedNoteIntent: null, feedNoteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR } });
    renderHud();
    expect(screen.getByText("正在处理")).toBeTruthy();
    expect(screen.getByText("伴星正在解释").closest(".companion-hud__output")).toBeTruthy();
    expect(screen.getByRole("button", { name: `查看原句解释：${NOTE_ANCHOR.excerpt}` })).toBeTruthy();
    expect(screen.queryByText("这次选文")).toBeNull();
    expect(screen.queryByText("查看所选原文")).toBeNull();
    expect(screen.queryByRole("article", { name: "笔记关联" })).toBeNull();
    expect(writeAnnotation).not.toHaveBeenCalled();
  });

  it("新解释还没有内容就停止，不把上一轮回复当作这次的残稿", () => {
    const previous = "这是上一轮对话的内容。";
    chatState.current = session({ mode: "closed", feedNoteIntent: null,
      liveReply: { messageId: MESSAGE_ID, text: previous, hasActionBlocks: false, proposalIds: [] } });
    const view = renderHud();
    act(() => {
      const attempt = beginNoteExplanation({ noteId: NOTE_ID, anchor: NOTE_ANCHOR });
      interruptNoteExplanation(attempt.id, "stopped");
      chatState.current = session({ mode: "closed", feedNoteIntent: null, stopNotice: "已停止，这次还没有生成解释。" });
      view.rerender(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
    });
    expect(screen.getByText("已停止，这次还没有生成解释。")).toBeTruthy();
    expect(screen.queryByText(previous)).toBeNull();
    expect(writeAnnotation).not.toHaveBeenCalled();
  });

  it("解释失败只留一个简短恢复入口，重试仍携带已收起的选文", async () => {
    const send = vi.fn(async () => true);
    chatState.current = session({ phase: "error", mode: "closed", failure: "模型服务暂时不可用", feedNoteIntent: null,
      feedNoteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR }, feedPrompt: "解释这句", feedSelection: null, send });
    renderHud();
    expect(screen.getByText("这段解释还没生成，原文没有改动。")).toBeTruthy();
    expect(screen.queryByText("这次选文")).toBeNull();
    expect(screen.queryByText("留在笔记里的内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试这段解释" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ text: "解释这句", selection: { text: NOTE_ANCHOR.excerpt }, noteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR } }));
    expect(writeAnnotation).not.toHaveBeenCalled();
  });

  it("伴星速看对话保留在聊天里，不替代笔记页的正式速看任务", async () => {
    const view = renderHud();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "给 伴星 的消息" })).toHaveProperty("value", "先帮我速看这篇笔记"));
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect((chatState.current as CompanionChatSession).send).toHaveBeenCalledWith({ text: "先帮我速看这篇笔记" }));

    act(() => {
      chatState.current = session({
        liveReply: { messageId: MESSAGE_ID, text: "这篇笔记讲的是工具如何让 Agent 使用外部能力。", hasActionBlocks: false, proposalIds: [] },
      });
      view.rerender(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
    });

    expect(await screen.findByText("这篇笔记讲的是工具如何让 Agent 使用外部能力。" )).toBeTruthy();
    expect(writeOverview).not.toHaveBeenCalled();
  });

  it("伴星速看回复只留在对话，不显示正式速看保存按钮", async () => {
    const view = renderHud();
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect((chatState.current as CompanionChatSession).send).toHaveBeenCalled());
    act(() => {
      chatState.current = session({
        liveReply: { messageId: MESSAGE_ID, text: "速览内容仍在对话中。", hasActionBlocks: false, proposalIds: [] },
      });
      view.rerender(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
    });

    expect(await screen.findByText("速览内容仍在对话中。" )).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试保存速览" })).toBeNull();
    expect(writeOverview).not.toHaveBeenCalled();
  });

  it("伴星可以把一个探索方向交给独立后台任务，草稿审核仍留在笔记页", async () => {
    const startedEvent = vi.fn();
    window.addEventListener("astella:note-expansion-task-started", startedEvent);
    const taskId = "55555555-5555-4555-8555-555555555555";
    const startTask = vi.fn(async (_input: {
      noteId: string;
      request: { noteVersionId: string; requestId: string; sourceMessageId?: string; conversationId?: string };
    }) => ok({
      taskId,
      noteId: NOTE_ID,
      noteVersionId: NOTE_VERSION_ID,
      focusAnchor: null,
      sourceMessageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      status: "queued" as const,
      drafts: [],
      confirmedCandidateIds: null,
      failureReason: null,
      createdAt: "2026-09-29T00:00:00.000Z",
    }));
    Object.defineProperty(window, "astella", {
      configurable: true,
      value: { noteExpansion: { startTask } },
    });
    const send = vi.fn(async () => true);
    const expansionIntent = { kind: "expansion" as const, noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID, noteTitle: "工具调用" };
    chatState.current = session({
      autoSendRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      feedPrompt: "帮我了解工具相关概念",
      feedNoteIntent: expansionIntent,
      send,
    });
    const view = renderHud();
    await waitFor(() => expect(send).toHaveBeenCalled());

    act(() => {
      chatState.current = session({
        feedNoteIntent: expansionIntent,
        liveReply: {
          messageId: MESSAGE_ID,
          text: "# Tool 与 Agent\nTool 让 Agent 使用外部能力。\n\n# 工具的权限边界\n权限决定 Agent 能调用哪些工具。",
          hasActionBlocks: false,
          proposalIds: [],
        },
      });
      view.rerender(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
    });

    fireEvent.click(await screen.findByRole("button", { name: "把这些方向整理成草稿" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    const startInput = startTask.mock.calls[0]?.[0];
    expect(startInput).toMatchObject({
      noteId: NOTE_ID,
      request: {
        noteVersionId: NOTE_VERSION_ID,
        sourceMessageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
      },
    });
    expect(startInput?.request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    await waitFor(() => expect(startedEvent).toHaveBeenCalledTimes(1));
    expect((startedEvent.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ noteId: NOTE_ID, taskId });
    expect(await screen.findByText(/进度和可编辑草稿会留在这篇笔记里/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /确认收下/ })).toBeNull();
    window.removeEventListener("astella:note-expansion-task-started", startedEvent);
  });

  async function beginAnnotationReply() {
    const item = beginNoteExplanation({ noteId: NOTE_ID, anchor: NOTE_ANCHOR });
    progressNoteExplanation(item.id, "");
    chatState.current = session({
      feedPrompt: "用大白话解释这段",
      feedSelection: NOTE_ANCHOR.excerpt,
      feedNoteIntent: null,
      feedNoteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR },
    });
    const view = renderHud();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送" })));
    expect((chatState.current as CompanionChatSession).send).toHaveBeenCalled();
    await act(async () => {
      chatState.current = session({
        feedPrompt: "用大白话解释这段",
        feedSelection: NOTE_ANCHOR.excerpt,
        feedNoteIntent: null,
        feedNoteAnchor: { noteId: NOTE_ID, anchor: NOTE_ANCHOR },
        liveReply: { messageId: MESSAGE_ID, text: "工具是 Agent 调用外部能力的接口。", hasActionBlocks: false, proposalIds: [] },
      });
      view.rerender(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
    });

    await act(async () => { void completeNoteExplanation(item.id, MESSAGE_ID, "工具是 Agent 调用外部能力的接口。"); });

    expect(writeAnnotation).toHaveBeenCalledTimes(1);
    expect(writeAnnotation.mock.calls[0]?.[0]).toMatchObject({
      noteId: NOTE_ID,
      command: {
        kind: "create",
        anchor: NOTE_ANCHOR,
        explanation: "工具是 Agent 调用外部能力的接口。",
        sourceMessageId: MESSAGE_ID,
      },
    });
    return view;
  }

  function patchChat(view: ReturnType<typeof renderHud>, patch: Partial<CompanionChatSession>) {
    act(() => {
      chatState.current = { ...(chatState.current as CompanionChatSession), ...patch };
      view.rerender(<CompanionHud motionMode="off" voiceEnabled={false} actions={[]} settings={settings()} onRunAction={vi.fn()} />);
    });
  }

  it.each(["current", "older"] as const)("保存 %s 版本的选文批注，回执只附在对应回复内", async (versionState) => {
    annotationVersionState = versionState;
    const savedEvent = vi.fn();
    window.addEventListener("astella:note-annotation-saved", savedEvent);
    const view = await beginAnnotationReply();
    await waitFor(() => expect(savedEvent).toHaveBeenCalledTimes(1));
    expect((savedEvent.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({ noteId: NOTE_ID });
    window.removeEventListener("astella:note-annotation-saved", savedEvent);
    if (versionState === "current") {
      expect((await screen.findByText("解释已贴回原句")).closest(".companion-hud__output")).toBeTruthy();
    } else {
      expect((await screen.findByText("解释已留在旧版批注")).closest(".companion-hud__output")).toBeTruthy();
      expect(screen.queryByText("解释已贴回原句")).toBeNull();
    }
    expect(screen.queryByRole("article", { name: /笔记关联|这次选文|已贴回原句|已留在旧版/ })).toBeNull();
    patchChat(view, { liveReply: null, feedNoteAnchor: null, mode: "closed" });
    expect(document.querySelector(".companion-hud__selection-context")).toBeNull();
    act(() => useNoteCompanionExplanations.setState({ activeId: null }));
    patchChat(view, { liveReply: { messageId: "next-reply", text: "开始下一段吧。", hasActionBlocks: false, proposalIds: [] } });
    expect(document.querySelector(".companion-hud__selection-context")).toBeNull();
  });

  it("回复自动收起时，保存回执一起消失，批注仍然已保存", async () => {
    vi.useFakeTimers();
    const view = await beginAnnotationReply();
    const dismissLiveReply = vi.fn(() => patchChat(view, { liveReply: null, feedNoteAnchor: null, mode: "closed" }));
    patchChat(view, { dismissLiveReply });
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("解释已贴回原句")).toBeTruthy();
    act(() => vi.advanceTimersByTime(12_000));
    expect(dismissLiveReply).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".companion-hud__output")).toBeNull();
    expect(document.querySelector(".companion-hud__selection-context")).toBeNull();
    expect(screen.queryByRole("article", { name: /笔记关联|这次选文/ })).toBeNull();
    expect(writeAnnotation).toHaveBeenCalledTimes(1);
  });

  it("保存失败在回复内重试，成功后不产生第二张状态纸", async () => {
    writeAnnotation.mockRejectedValueOnce(new Error("保存暂时不可用"));
    await beginAnnotationReply();
    const retry = await screen.findByRole("button", { name: "重试保存批注" });
    expect(retry.closest(".companion-hud__output")).toBeTruthy();
    expect(screen.getByText("解释未保存")).toBeTruthy();
    fireEvent.click(retry);
    expect(await screen.findByText("解释已贴回原句")).toBeTruthy();
    expect(writeAnnotation).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "重试保存批注" })).toBeNull();
    expect(screen.queryByRole("article", { name: /笔记关联|这次选文/ })).toBeNull();
  });

  it.each(["收起回复", "换一处选文"])("保存迟到时，%s不会被旧回执重新打开或清掉", async (action) => {
    const receipt = await writeAnnotation({});
    writeAnnotation.mockClear();
    let finishSave!: () => void;
    writeAnnotation.mockImplementationOnce(() => new Promise(resolve => { finishSave = () => resolve(receipt); }));
    const savedEvent = vi.fn();
    window.addEventListener("astella:note-annotation-saved", savedEvent);
    const view = await beginAnnotationReply();
    await screen.findByText("正在保存批注");
    const dismissFeedNoteAnchor = vi.fn();
    const nextAnchor = { ...NOTE_ANCHOR, startOffset: 13, endOffset: 20, excerpt: "获取实时信息" };
    patchChat(view, {
      mode: "closed", liveReply: null, dismissFeedNoteAnchor,
      ...(action === "换一处选文" ? { feedNoteAnchor: { noteId: NOTE_ID, anchor: nextAnchor } } : {}),
    });
    await act(async () => finishSave());
    expect(savedEvent).toHaveBeenCalledTimes(1);
    window.removeEventListener("astella:note-annotation-saved", savedEvent);
    expect(document.querySelector(".companion-hud__output")).toBeNull();
    expect(screen.queryByRole("article", { name: /笔记关联|这次选文/ })).toBeNull();
    if (action === "换一处选文") {
      expect(dismissFeedNoteAnchor).not.toHaveBeenCalled();
      expect((chatState.current as CompanionChatSession).feedNoteAnchor?.anchor).toEqual(nextAnchor);
    }
  });
});

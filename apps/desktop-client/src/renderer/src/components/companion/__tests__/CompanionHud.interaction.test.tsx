// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionChatSession } from "../../../app/companion-session/companion-chat-session";
import type { CompanionVoiceCaption, CompanionVoiceInputOptions, CompanionVoicePhase } from "../voice/use-companion-voice-input";
import { CompanionHud } from "../hud/CompanionHud";
import { beginCompanionSpeechLine } from "../../../app/companion-session/companion-voice-playback";
import { interactionProposal, interactionSession, interactionSettings } from "./companion-interaction-fixtures";
import { COMPANION_SELECTION_MAX_CHARS, COMPANION_P2_LIMITS } from "@astella/shared/companion-conversation-contracts";

const state = vi.hoisted(() => ({
  chat: null as unknown,
  voiceOptions: null as unknown,
  speechSession: null as unknown,
  /** 手摇的会话状态：测试自己把相位与字幕摆上去，看界面跟不跟。 */
  voice: { phase: "idle", caption: null } as { phase: CompanionVoicePhase; caption: CompanionVoiceCaption | null },
  refresh: (() => {}) as () => void,
}));
const voiceToggle = vi.hoisted(() => vi.fn());
const voiceCancel = vi.hoisted(() => vi.fn());
vi.mock("../../../app/companion-session/companion-chat-session", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-session/companion-chat-session")>();
  return { ...actual, useCompanionChat: () => state.chat };
});
vi.mock("../voice/use-companion-voice-input", async importOriginal => {
  const actual = await importOriginal<typeof import("../voice/use-companion-voice-input")>();
  return { ...actual, useCompanionVoiceInput: (options: CompanionVoiceInputOptions) => {
    state.voiceOptions = options;
    // toggle 就是"进入／退出对话"：退出时通知会话结束，但不碰 cancel（那是"丢掉这一轮"）。
    return { activity: state.voice.phase === "open" ? state.voice.caption ? "capturing" : "listening" : state.voice.phase === "closing" ? "transcribing" : state.voice.phase, lastTurn: null, pause: vi.fn(), resume: vi.fn(), interrupt: vi.fn(), sendNow: vi.fn(), phase: state.voice.phase, caption: state.voice.caption, note: null, noteRevision: 0, supported: true,
      toggle: () => {
        voiceToggle();
        const next = state.voice.phase === "idle" ? "open" : "idle";
        state.voice = { phase: next, caption: next === "idle" ? null : state.voice.caption };
        if (next === "idle") options.onSessionEnd?.();
        state.refresh();
      },
      cancel: () => {
        voiceCancel();
        state.voice = { phase: "idle", caption: null };
        options.onSessionEnd?.();
        state.refresh();
      },
      dismissNote: vi.fn(), subscribeLevel: () => () => undefined, modelMissing: false };
  } };
});
vi.mock("../../../app/companion-session/companion-voice-playback", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-session/companion-voice-playback")>();
  return { ...actual, stopCompanionSpeech: vi.fn(), subscribeCompanionSpeech: () => () => undefined,
    beginCompanionSpeechLine: vi.fn((...args: Parameters<typeof actual.beginCompanionSpeechLine>) =>
      state.speechSession ?? actual.beginCompanionSpeechLine(...args)) };
});
vi.mock("../../../app/companion-session/companion-voice-level", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-session/companion-voice-level")>();
  return { ...actual, subscribeHomeV2VoiceLevel: () => () => undefined };
});

function Harness({ voiceEnabled = false, blocked = false }: { voiceEnabled?: boolean; blocked?: boolean }) {
  const [, update] = useState(0);
  state.refresh = () => update(value => value + 1);
  const chat = state.chat as CompanionChatSession;
  state.chat = { ...chat, setMode: (mode: CompanionChatSession["mode"]) => { state.chat = { ...(state.chat as CompanionChatSession), mode }; state.refresh(); } };
  return <div className="desktop-app"><div className="companion-presence">
    <div className="companion-scene-anchor"><div className="window-live2d" /></div>
    <CompanionHud motionMode="off" voiceEnabled={voiceEnabled} floatingBlocked={blocked} actions={[]} settings={interactionSettings()} onRunAction={vi.fn()} />
  </div></div>;
}
const patch = (values: Partial<CompanionChatSession>) => act(() => { state.chat = { ...(state.chat as CompanionChatSession), ...values }; state.refresh(); });
const setVoice = (values: Partial<{ phase: CompanionVoicePhase; caption: CompanionVoiceCaption | null }>) => act(() => { state.voice = { ...state.voice, ...values }; state.refresh(); });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  state.chat = interactionSession();
  state.speechSession = null;
  state.voice = { phase: "idle", caption: null };
  voiceToggle.mockClear(); voiceCancel.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("production companion interaction", () => {
  it("closes a failed draft's voice queue while keeping its partial text visible", () => {
    const stop = vi.fn();
    state.speechSession = { planId: "failed-draft", mode: "voice", stop,
      feed: vi.fn(), feedSegment: vi.fn(), finish: vi.fn(), currentVisibleChars: () => null };
    const partial = "先从条件概率定义开始推导。";
    state.chat = interactionSession({ phase: "sending", liveReply: null,
      draft: { runId: "failed", text: partial }, interrupted: null });
    render(<Harness voiceEnabled />);
    expect(stop).not.toHaveBeenCalled();
    patch({ phase: "error", draft: null, liveReply: null,
      interrupted: { text: partial, message: "这次回复没有完成。" }, failure: "这次回复没有完成。" });
    expect(stop).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain(partial);
  });
  it("keeps a created note and all its material in one reply, then clears it together on close", () => {
    const dismissLiveReply = vi.fn(() => patch({ liveReply: null }));
    const dismissRichReply = vi.fn(() => patch({ richReply: null }));
    state.chat = interactionSession({ mode: "closed", dismissLiveReply, dismissRichReply,
      liveReply: { messageId: "created", text: "新笔记建好了", hasActionBlocks: false, proposalIds: [] },
      richReply: { messageId: "created", blocks: [
        { type: "quote", label: "《中国朝代历程总揽》", text: "先秦到清朝的历程。" },
        { type: "quote", label: "《中国近代史总揽》", text: "从鸦片战争到新中国成立。" },
        { type: "nav", label: "打开新笔记", route: { kind: "note", noteId: "created-note" } },
      ] },
      nodes: [{ key: "tool:one", kind: "tool", label: "查阅原文", state: "succeeded", toolName: "notes.read.read", summary: "已找到", proposalId: null }] });
    render(<Harness />);
    advance(1_000);
    const reply = document.querySelector(".companion-hud__output")!;
    expect(reply.contains(screen.getByRole("button", { name: "打开新笔记" }))).toBe(true);
    expect(reply.contains(screen.getByRole("status", { name: "小鲸 正在做的事" }))).toBe(false);
    expect(document.querySelectorAll(".companion-hud__paper")).toHaveLength(0);
    // 材料默认收在“查阅的材料”里；打开后仍在同一条回复里，不需要换页。
    expect(screen.queryByText("先秦到清朝的历程。")).toBeNull();
    fireEvent.click(screen.getByText("查阅的材料"));
    expect(screen.getByText("先秦到清朝的历程。")).toBeTruthy();
    expect(dismissLiveReply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起这次交流" }));
    expect(dismissLiveReply).toHaveBeenCalledOnce();
    expect(dismissRichReply).toHaveBeenCalledOnce();
    expect(document.querySelector(".companion-hud__output")).toBeNull();
    expect(screen.queryByRole("status", { name: "小鲸 正在做的事" })).toBeNull();
  });

  it("keeps an attachment-only delivery visible and lets its one lifetime retire the complete reply", async () => {
    const dismissLiveReply = vi.fn(() => patch({ liveReply: null }));
    const dismissRichReply = vi.fn(() => patch({ richReply: null }));
    state.chat = interactionSession({ mode: "closed", dismissLiveReply, dismissRichReply,
      liveReply: { messageId: "created", text: "", hasActionBlocks: false, proposalIds: [] },
      richReply: { messageId: "created", blocks: [{ type: "nav", label: "打开新笔记", route: { kind: "note", noteId: "created-note" } }] } });
    render(<Harness />);
    advance(10_000);
    expect(document.querySelector(".companion-hud__output")?.getAttribute("data-stage")).toBe("visible");
    expect(screen.getByRole("button", { name: "打开新笔记" })).toBeTruthy();
    expect(dismissLiveReply).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(51_000); });
    expect(dismissRichReply).toHaveBeenCalledOnce();
    expect(dismissLiveReply).toHaveBeenCalledOnce();
    expect(document.querySelector(".companion-hud__output")).toBeNull();
  });

  it("stopping a new turn before any output never freezes the preceding reply", async () => {
    const previous = "上一轮聊的是早上的太阳。";
    const cancel = vi.fn(async () => {
      patch({ phase: "ready", draft: null, liveReply: null, interrupted: null, stopNotice: "这一轮已停止。" });
      return true;
    });
    state.chat = interactionSession({ mode: "closed", cancel,
      liveReply: { messageId: "previous", text: previous, hasActionBlocks: false, proposalIds: [] } });
    render(<Harness />);
    advance(1_000);
    expect(document.querySelector(".companion-hud__output-body")?.textContent).toBe(previous);
    patch({ phase: "sending", liveReply: null, draft: null, interrupted: null });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止这一轮" })));
    expect(cancel).toHaveBeenCalledOnce();
    expect(document.querySelector(".companion-hud__output-body")?.textContent).toBe("这一轮已停止。");
    expect(document.querySelector(".companion-hud__sr-status")?.textContent).toBe("已停止这一轮。");
  });

  it("stopping preserves only the current turn's received partial reply", async () => {
    const previous = "上一轮聊的是早上的太阳。";
    const partial = "波动方程的这个解还没推导完。";
    const cancel = vi.fn(async () => {
      patch({ phase: "ready", draft: null, liveReply: null,
        interrupted: { text: partial, message: "这一轮已停止。" }, stopNotice: "这一轮已停止。" });
      return true;
    });
    state.chat = interactionSession({ mode: "closed", cancel,
      liveReply: { messageId: "previous", text: previous, hasActionBlocks: false, proposalIds: [] } });
    render(<Harness />);
    advance(1_000);
    patch({ phase: "sending", liveReply: null, draft: { runId: "current", text: partial }, interrupted: null });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止这一轮" })));
    expect(document.querySelector(".companion-hud__output-body")?.textContent).toBe(partial);
    expect(document.querySelector(".companion-hud__sr-status")?.textContent).toBe(`${partial}（已停止）`);
  });

  it("把她正在想的内容填进等待，正文一露头就整块让位", () => {
    const thought = "他问的是散射，先想清楚要不要举天空的例子。";
    state.chat = interactionSession({ mode: "closed", phase: "sending", processRunId: "current", thinking: thought });
    render(<Harness />);
    advance(1_200);
    const bubble = document.querySelector(".companion-hud__output")!;
    expect(bubble.getAttribute("data-tone")).toBe("thinking");
    expect(bubble.querySelector(".companion-hud__reply-heading")?.textContent).toContain("她在想");
    expect(bubble.querySelector(".companion-hud__output-body")?.textContent).toBe(thought);
    // 思考不是回复的一部分：正文开始露字，气泡整个换过去，不留半句想法在下面。
    patch({ draft: { runId: "current", text: "蓝光更容易被空气分子散射。" } });
    advance(1_200);
    const after = document.querySelector(".companion-hud__output")!;
    expect(after.getAttribute("data-tone")).toBe("reply");
    expect(after.querySelector(".companion-hud__output-body")?.textContent).toContain("蓝光");
    expect(after.querySelector(".companion-hud__output-body")?.textContent).not.toContain("先想清楚");
  });

  it("长期思考只把最新一行留在气泡里，不把整段想法堆高", () => {
    const thought = `先看散射。${"再想想有没有更贴切的例子，".repeat(12)}最后落到天空的颜色。`;
    state.chat = interactionSession({ mode: "closed", phase: "sending", processRunId: "current", thinking: thought });
    render(<Harness />);
    advance(1_200);
    const body = document.querySelector(".companion-hud__output-body");
    expect(body?.textContent?.startsWith("…")).toBe(true);
    expect(body?.textContent?.endsWith("最后落到天空的颜色。")).toBe(true);
    expect(body?.textContent?.length).toBeLessThan(thought.length);
  });

  it("工具已经在跑的轮次，思考收在进度上方的一行里，不盖住进度", () => {
    state.chat = interactionSession({ mode: "closed", phase: "sending", processRunId: "current",
      thinking: "该先读笔记再回答。",
      nodes: [{ key: "tool:read", kind: "tool", label: "查阅原文", state: "running", toolName: "notes.read.read", summary: null, proposalId: null }] });
    render(<Harness />);
    advance(1_200);
    expect(document.querySelector(".companion-hud__output")?.getAttribute("data-tone")).not.toBe("thinking");
    expect(document.querySelector(".companion-hud__rail-thinking")?.textContent).toContain("该先读笔记再回答。");
  });

  it("被上一条挡住时，「停掉上一条」是真能按的一颗按钮", async () => {
    const stopBlockedTurn = vi.fn(async () => undefined);
    state.chat = interactionSession({ mode: "conversation", phase: "error",
      failure: "上一条还挂着。按「停掉上一条」，这句就能立刻发出去。",
      blockedByRun: { runId: "zombie-run", generation: 7 }, stopBlockedTurn });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "停掉上一条，这句再发" }));
    await act(async () => { expect(stopBlockedTurn).toHaveBeenCalledOnce(); });
  });

  it.each(["bubble", "journal"] as const)("%s keeps complete over-limit sources and blocks button/Enter until corrected", async view => {
    const send = vi.fn(async () => true);
    const selection = "字".repeat(COMPANION_SELECTION_MAX_CHARS) + "尾部更正";
    state.chat = interactionSession({ send, feedSelection: selection });
    render(<Harness />);
    if (view === "journal") fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    const field = screen.getByRole("textbox", { name: view === "bubble" ? "给 小鲸 的消息" : "继续问 小鲸" });
    fireEvent.change(field, { target: { value: "请解释末尾" } });
    expect(screen.getAllByRole("status").some(status => status.textContent?.includes("原文超过"))).toBe(true);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter", keyCode: 13 }));
    expect(send).not.toHaveBeenCalled();
    expect((field as HTMLTextAreaElement).value).toBe("请解释末尾");
    expect((state.chat as CompanionChatSession).feedSelection).toBe(selection);
    const valid = selection.slice(0, COMPANION_SELECTION_MAX_CHARS - 10) + "已更正。";
    patch({ feedSelection: valid });
    await act(async () => fireEvent.keyDown(field, { key: "Enter", keyCode: 13 }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ text: "请解释末尾", selection: { text: valid } });
  });

  it.each(["bubble", "journal"] as const)("%s preserves an over-limit user question until edited", async view => {
    const send = vi.fn(async () => true);
    state.chat = interactionSession({ send });
    render(<Harness />);
    if (view === "journal") fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    const field = screen.getByRole("textbox", { name: view === "bubble" ? "给 小鲸 的消息" : "继续问 小鲸" });
    const text = "字".repeat(COMPANION_P2_LIMITS.serverHardMaxChars + 1);
    fireEvent.change(field, { target: { value: text } });
    expect(screen.getAllByRole("status").some(status => status.textContent?.includes("消息超过"))).toBe(true);
    await act(async () => fireEvent.keyDown(field, { key: "Enter", keyCode: 13 }));
    expect(send).not.toHaveBeenCalled();
    expect((field as HTMLTextAreaElement).value).toBe(text);
    fireEvent.change(field, { target: { value: "只解释最后这句" } });
    await act(async () => fireEvent.keyDown(field, { key: "Enter", keyCode: 13 }));
    expect(send).toHaveBeenCalledWith({ text: "只解释最后这句" });
  });
  it.each(["bubble", "journal"] as const)("%s keeps IME candidate Enter and Shift+Enter local, then sends once on ordinary Enter", async view => {
    const send = vi.fn(async () => true);
    state.chat = interactionSession({ send });
    render(<Harness />);
    if (view === "journal") fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    const input = screen.getByRole("textbox", { name: view === "bubble" ? "给 小鲸 的消息" : "继续问 小鲸" });
    fireEvent.change(input, { target: { value: "中文选字仍是草稿" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 13 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true, keyCode: 13 });
    expect(send).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("中文选字仍是草稿");
    if (view === "journal") {
      fireEvent.keyDown(input, { key: "Escape", isComposing: true });
      expect(screen.getByRole("textbox", { name: "继续问 小鲸" })).toBe(input);
    }
    await act(async () => fireEvent.keyDown(input, { key: "Enter", keyCode: 13 }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ text: "中文选字仍是草稿" });
  });
  it("returns to the conversation when sending from the task page in the journal", async () => {
    const send = vi.fn(async () => true);
    state.chat = interactionSession({ send });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    fireEvent.click(screen.getByRole("button", { name: "交给我的事 0" }));
    fireEvent.change(screen.getByRole("textbox", { name: "继续问 小鲸" }), { target: { value: "我们先聊聊晚饭吧" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送" })));
    expect(send).toHaveBeenCalledWith({ text: "我们先聊聊晚饭吧" });
    expect(screen.getByRole("button", { name: "全部对话" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("recovers rejected text into the reopened input and keeps it until the user clears it", async () => {
    let finish!: (value: boolean) => void;
    const send = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    state.chat = interactionSession({ send, feedSelection: "原文上下文" });
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "给 小鲸 的消息" });
    fireEvent.change(input, { target: { value: "解释这句话" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(screen.queryByRole("textbox", { name: "给 小鲸 的消息" })).toBeNull();
    expect(send).toHaveBeenCalledWith({ text: "解释这句话", selection: { text: "原文上下文" } });
    await act(async () => finish(false));
    // 审计 F1：失败后输入面板自己放回来，草稿就摆在眼前（不再是"字凭空消失"）。
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("解释这句话");
    // 审计 F2：草稿非空时不再按闲置自动收；清空后恢复原来的 90 秒让位节奏。
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "" } });
    advance(91_000);
    expect(screen.queryByRole("textbox", { name: "给 小鲸 的消息" })).toBeNull();
  });
  it("shares draft and quote between the two chat views", () => {
    state.chat = interactionSession({ feedSelection: "这段原文跟随同一份草稿" });
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "尚未发出的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    expect(screen.getByText("这段原文跟随同一份草稿")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "继续问 小鲸" }) as HTMLTextAreaElement).value).toBe("尚未发出的草稿");
    fireEvent.change(screen.getByRole("textbox", { name: "继续问 小鲸" }), { target: { value: "在手记里补了一句" } });
    fireEvent.click(screen.getByRole("button", { name: "返回气泡轻聊" }));
    advance(220);
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("在手记里补了一句");
  });
  it("filters actual pending confirmations without executing or losing the shared draft", () => {
    const decideProposal = vi.fn(async () => undefined);
    const pending = interactionProposal() as Extract<ReturnType<typeof interactionProposal>, { phase: "ready" }>;
    state.chat = interactionSession({ proposalStates: { pending,
      executing: { ...pending, proposal: { ...pending.proposal, status: "executing" } },
      finished: interactionProposal("succeeded"), expired: interactionProposal("pending", "2000-01-01T00:00:00Z"),
    }, decideProposal });
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "仍未发送的这句话" } });
    fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    fireEvent.click(screen.getByRole("button", { name: "待确认 1" }));
    expect(document.querySelector(".companion-history__pending")).toBeTruthy();
    expect(decideProposal).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "继续问 小鲸" }) as HTMLTextAreaElement).value).toBe("仍未发送的这句话");
    patch({ proposalStates: {} });
    expect(screen.getByText("没有等你确认的事情")).toBeTruthy();
    expect(document.querySelector(".companion-history__pending")).toBeNull();
  });
  /**
   * 2026-10-07：语音从"转成文字等你点发送"改成**说完直接进对话**。
   *
   * 那一次点击在对话里是纯粹的损失——话已经说出口了。所以这一格锁的是"界面上
   * 根本没有可编辑的东西和发送按钮"，而不是旧契约里"改完再发"。打字的草稿不受影响。
   */
  it("说完一轮直接进对话：字幕只读，没有任何东西要点", async () => {
    const send = vi.fn(async () => true);
    state.chat = interactionSession({ send });
    render(<Harness voiceEnabled />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "文字草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));
    setVoice({ caption: { text: "真实识别的文字", sending: false } });
    expect(send).not.toHaveBeenCalled();

    const voice = screen.getByRole("region", { name: "语音对话" });
    expect(within(voice).queryByRole("textbox")).toBeNull();
    expect(within(voice).queryByRole("button", { name: "发送" })).toBeNull();
    expect(within(voice).getByText("真实识别的文字")).toBeTruthy();

    await act(async () => { (state.voiceOptions as CompanionVoiceInputOptions).onTurn("真实识别的文字"); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ text: "真实识别的文字" });

    // 一轮只发一次：会话还在开着、界面一直在重渲。
    setVoice({ caption: null });
    expect(send).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "气泡轻聊" }));
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("文字草稿");
  });

  /** 退出是停止收音，发送有独立的「说好了」操作。 */
  it("会话开着时再点麦克风立即结束，不发送未完成的这一句", () => {
    state.chat = interactionSession({ send: vi.fn(async () => true) });
    render(<Harness voiceEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));
    expect(voiceToggle).toHaveBeenCalledTimes(1);
    setVoice({ caption: { text: "说到一半", sending: false } });
    expect(screen.getByRole("region", { name: "语音对话" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "结束语音对话" }));
    expect(voiceToggle).toHaveBeenCalledTimes(2);
    expect(voiceCancel).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "语音对话" })).toBeNull();
  });

  /**
   * X 那一路是明确丢掉：连同这一轮已认出的字一起清掉。
   *
   * 旧的「这次不发」只关气泡、把识别结果留在状态里，于是下一次开录又把上一句摆出来
   * （2026-10-06 窗口实测）。常驻会话更不能有这个残留——它会跟着进下一次。
   */
  it("X 关掉语音对话把这一轮丢掉，下一次是干净的一次", async () => {
    const send = vi.fn(async () => true);
    state.chat = interactionSession({ send });
    render(<Harness voiceEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));
    setVoice({ caption: { text: "不想要的一句", sending: false } });
    fireEvent.click(within(screen.getByRole("region", { name: "语音对话" })).getByRole("button", { name: "关掉语音对话" }));
    expect(voiceCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "语音对话" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));
    expect(voiceToggle).toHaveBeenCalledTimes(2);
    const again = screen.getByRole("region", { name: "语音对话" });
    expect(within(again).queryByText("不想要的一句")).toBeNull();
    await act(async () => { (state.voiceOptions as CompanionVoiceInputOptions).onTurn("这一轮的下一句"); });
    expect(send).toHaveBeenCalledWith({ text: "这一轮的下一句" });
  });

  /**
   * 她正在回答，我也能开口。
   *
   * 旧的麦克风按钮在 `phase === "sending"` 时是禁用的——那是"一句一句按"时代的合理
   * 保护。对话模式要的正相反：打断一句正在说的回复接着问下一句，而发送这条路上
   * 服务端会用新的 generation 接替旧轮。
   */
  it("她正在回答时麦克风仍然可以按，用来打断并接着问", () => {
    state.chat = interactionSession({ phase: "sending" });
    render(<Harness voiceEnabled />);
    const mic = screen.getByRole<HTMLButtonElement>("button", { name: "开始语音对话" });
    expect(mic.disabled).toBe(false);
    fireEvent.click(mic);
    expect(voiceToggle).toHaveBeenCalledOnce();
    expect(screen.getByRole("region", { name: "语音对话" })).toBeTruthy();
  });

  /** 换会话 = 这一面不再生效：语音对话收掉，但打字的草稿是另一件事，留着。 */
  it("preserves the shared text draft and cancels voice on a real conversation change", () => {
    render(<Harness voiceEnabled />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "旧空间的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "开始语音对话" }));
    setVoice({ caption: { text: "旧语音", sending: false } });
    expect(screen.getByRole("region", { name: "语音对话" })).toBeTruthy();
    patch({ conversationId: "new-conversation", mode: "conversation" });
    expect(voiceCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", { name: "语音对话" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("旧空间的草稿");
  });
  it("lets reply text expire independently of a pending confirmation and static focus", () => {
    const dismissLiveReply = vi.fn();
    state.chat = interactionSession({ mode: "closed", liveReply: { messageId: "one", text: "回复内容", hasActionBlocks: true, proposalIds: ["proposal"] },
      proposalStates: { proposal: interactionProposal() }, dismissLiveReply });
    render(<Harness />);
    advance(1_000);
    expect(document.querySelector(".companion-hud__output-body")?.textContent).toContain("回复内容");
    fireEvent.focus(screen.getByRole("button", { name: "收起伴星回复" }));
    advance(10_000);
    expect(dismissLiveReply).toHaveBeenCalled();
    expect(screen.getByRole("article", { name: "等你确认" })).toBeTruthy();
    expect((state.chat as CompanionChatSession).decideProposal).not.toHaveBeenCalled();
  });
  it("preserves a draft written before the first conversation finishes loading", () => {
    state.chat = interactionSession({ conversationId: null });
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "加载时写下的草稿" } });
    patch({ conversationId: "first-conversation" });
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("加载时写下的草稿");
  });
  it("keeps streamed speech and tool progress visible together, regardless of which arrives first", () => {
    const spoken = "我先看一下相关笔记，再把关键年代整理进新笔记。";
    state.chat = interactionSession({ mode: "closed", phase: "sending", processRunId: "current", draft: { runId: "current", text: spoken } });
    render(<Harness />);
    advance(1_200);
    const reply = document.querySelector(".companion-hud__output")!;
    expect(reply.querySelector(".companion-hud__output-body")?.textContent).toContain("我先看一下");
    const tool = { key: "tool:read", kind: "tool" as const, label: "查阅原文", state: "running" as const, toolName: "notes.read.read", summary: null, proposalId: null };
    patch({ nodes: [tool] });
    expect(document.querySelector(".companion-hud__output")).toBe(reply);
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" }).textContent).toContain("进行中");
    patch({ draft: { runId: "current", text: spoken + "我也会核对前后顺序。" }, nodes: [{ ...tool, state: "succeeded" }, { ...tool, key: "tool:create", toolName: "notes.write.create" }] });
    advance(2_500);
    expect(reply.querySelector(".companion-hud__output-body")?.textContent).toContain("我也会核对");
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" }).textContent).toContain("2 项操作");
    patch({ draft: null, nodes: [tool] });
    expect(document.querySelector(".companion-hud__output")).toBeNull();
    patch({ draft: { runId: "current", text: "这段内容我读到了。" } });
    advance(1_000);
    expect(document.querySelector(".companion-hud__output-body")?.textContent).toContain("这段内容");
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" })).toBeTruthy();
  });

  it("同一轮 liveReply 更新不重启语音会话，换轮才停", () => {
    const stop = vi.fn();
    state.speechSession = { planId: "same-run", mode: "voice", segments: [], segmentCount: 0, stop,
      feed: vi.fn(), feedSegment: vi.fn(), finish: vi.fn(), currentVisibleChars: () => null };
    const begin = vi.mocked(beginCompanionSpeechLine);
    begin.mockClear();
    const live = (text: string) => ({ messageId: "one", runId: "run-a", text,
      hasActionBlocks: false, proposalIds: [] });
    state.chat = interactionSession({ mode: "closed", liveReply: live("第一段。") });
    render(<Harness voiceEnabled />);
    advance(500);
    expect(begin).toHaveBeenCalledTimes(1);
    patch({ liveReply: live("第一段。\n\n第二段。") });
    advance(500);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    patch({ liveReply: { ...live("新的一轮。"), runId: "run-b", messageId: "two" } });
    advance(500);
    expect(begin).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("shows one light bubble at a time and switches after the first message is read", () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "44444444-4444-4444-8444-444444444444";
    const assistant = (id: string, seq: number, text: string) => ({
      version: 1 as const, id, workspaceId: conversationId, conversationId, seq,
      role: "assistant" as const, kind: "text" as const, blocks: [{ type: "text" as const, text }],
      runId, clientMessageId: null, contentSha256: "0".repeat(64),
      createdAt: "2026-10-21T11:00:00Z", editedAt: null,
    });
    const first = assistant("22222222-2222-4222-8222-222222222222", 2, "第一件事，我们先确定条件。");
    const second = assistant("33333333-3333-4333-8333-333333333333", 3, "接着，再看这个条件下会发生什么。");
    state.chat = interactionSession({ mode: "closed", messages: [first, second],
      liveReply: { messageId: second.id, runId,
        text: "第一件事，我们先确定条件。\n\n接着，再看这个条件下会发生什么。",
        hasActionBlocks: false, proposalIds: [] } });
    render(<Harness />);

    advance(500);
    let bubbles = [...document.querySelectorAll<HTMLElement>(".companion-hud__output")];
    expect(bubbles).toHaveLength(1);
    const firstText = bubbles[0]!.querySelector(".companion-hud__output-body")?.textContent ?? "";
    expect(firstText.startsWith("第一件事")).toBe(true);
    expect(firstText).not.toContain("接着");
    expect(bubbles[0]!.querySelector(".companion-hud__reply-heading")).toBeTruthy();
    expect(document.querySelector(".companion-hud__reply-foot")).toBeNull();
    expect(bubbles[0]!.querySelector(".companion-hud__output-tools")).toBeNull();

    advance(3_000);
    bubbles = [...document.querySelectorAll<HTMLElement>(".companion-hud__output")];
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.querySelector(".companion-hud__output-body")?.textContent)
      .toBe("接着，再看这个条件下会发生什么。");
    expect(bubbles[0]!.querySelector(".companion-hud__reply-heading")).toBeTruthy();
    expect(document.querySelector(".companion-hud__reply-foot")).toBeNull();
  });

  it("shows the current tool instantly, keeps stop accessible, and avoids a duplicate waiting bubble", () => {
    state.chat = interactionSession({ mode: "closed", phase: "sending", processRunId: "current",
      nodes: [{ key: "tool:one", kind: "tool", label: "查阅原文", state: "running", toolName: "notes.read.read", summary: null, proposalId: null }] });
    render(<Harness />);
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" }).textContent).toContain("进行中");
    expect(document.querySelector(".companion-hud__output")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止这一轮" }));
    expect((state.chat as CompanionChatSession).cancel).toHaveBeenCalledOnce();
    patch({ phase: "sending", processRunId: "next", nodes: [] });
    expect(document.querySelector(".companion-hud__rail")).toBeNull();
    expect(document.querySelector(".companion-hud__output")).toBeTruthy();
  });

  it("keeps tool process in its own bubble above the reply and pauses while reading", () => {
    const dismissLiveReply = vi.fn();
    state.chat = interactionSession({ mode: "closed", liveReply: { messageId: "one", text: "这里是回复", hasActionBlocks: false, proposalIds: [] }, dismissLiveReply,
      nodes: [{ key: "tool:one", kind: "tool", label: "查阅原文", state: "succeeded", toolName: "notes.read.read", summary: "已找到", proposalId: null }] });
    render(<Harness />);
    advance(1_000);
    const rail = screen.getByRole("status", { name: "小鲸 正在做的事" });
    const reply = document.querySelector(".companion-hud__output")!;
    expect(reply.contains(rail)).toBe(false);
    const process = document.querySelector(".companion-hud__rail")!;
    expect(process.parentElement).toBe(reply.parentElement);
    expect(process.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看过程" }).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "查看过程" }));
    expect(screen.getByRole("button", { name: "收起过程" }).getAttribute("aria-expanded")).toBe("true");
    expect(process.querySelector(".companion-hud__rail-steps li")).toBeTruthy();
    advance(60_000);
    expect(dismissLiveReply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "收起过程" }));
    // 审计 F5 放宽了停留预算（4–15s 起步 4s），等待窗口同步放宽；
    // 断言的仍是"过程气泡有自己的一段命、不跟回复同生共死"。
    advance(7_500);
    expect(dismissLiveReply).toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" })).toBeTruthy();
    advance(3_000);
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" })).toBeTruthy();
  });
  it("also closes an idle shortcut bubble without closing the conversation record", () => {
    state.chat = interactionSession({ mode: "closed" });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "设置与快捷操作" }));
    expect(screen.getByRole("region", { name: "伴星更多功能" })).toBeTruthy();
    advance(91_000);
    expect(screen.queryByRole("region", { name: "伴星更多功能" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "对话手记" }));
    advance(91_000);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("marks all floating content as owned and suppresses it for a foreign modal", () => {
    const view = render(<Harness />);
    expect(document.querySelector(".companion-hud--floating")?.hasAttribute("data-blocked")).toBe(false);
    view.rerender(<Harness blocked />);
    expect(document.querySelector(".companion-hud--floating")?.getAttribute("data-companion-owned")).toBe("true");
    expect(document.querySelector(".companion-hud--floating")?.hasAttribute("data-blocked")).toBe(true);
  });
});

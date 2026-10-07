// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionChatSession } from "../../../app/companion-chat-session";
import type { CompanionVoiceCaption, CompanionVoiceInputOptions, CompanionVoicePhase } from "../use-companion-voice-input";
import { CompanionHud } from "../CompanionHud";
import { interactionProposal, interactionSession, interactionSettings } from "./companion-interaction-fixtures";

const state = vi.hoisted(() => ({
  chat: null as unknown,
  voiceOptions: null as unknown,
  /** 手摇的会话状态：测试自己把相位与字幕摆上去，看界面跟不跟。 */
  voice: { phase: "idle", caption: null } as { phase: CompanionVoicePhase; caption: CompanionVoiceCaption | null },
  refresh: (() => {}) as () => void,
}));
const voiceToggle = vi.hoisted(() => vi.fn());
const voiceCancel = vi.hoisted(() => vi.fn());
vi.mock("../../../app/companion-chat-session", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-chat-session")>();
  return { ...actual, useCompanionChat: () => state.chat };
});
vi.mock("../use-companion-voice-input", async importOriginal => {
  const actual = await importOriginal<typeof import("../use-companion-voice-input")>();
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
vi.mock("../../../app/companion-voice-playback", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-voice-playback")>();
  return { ...actual, stopCompanionSpeech: vi.fn(), subscribeCompanionSpeech: () => () => undefined };
});
vi.mock("../../../app/companion-voice-level", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../app/companion-voice-level")>();
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
  state.voice = { phase: "idle", caption: null };
  voiceToggle.mockClear(); voiceCancel.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("production companion interaction", () => {
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
  it("closes input synchronously on send and recovers rejected text without opening a permanent bubble", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "气泡轻聊" }));
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("解释这句话");
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
  it("keeps tools above the reply with an independent finite lifetime", () => {
    const dismissLiveReply = vi.fn();
    state.chat = interactionSession({ mode: "closed", liveReply: { messageId: "one", text: "这里是回复", hasActionBlocks: false, proposalIds: [] }, dismissLiveReply,
      nodes: [{ key: "tool:one", kind: "tool", label: "查阅原文", state: "succeeded", toolName: "companion_read_note", summary: "已找到", proposalId: null }] });
    render(<Harness />);
    advance(1_000);
    const rail = screen.getByRole("status", { name: "小鲸 正在做的事" });
    const reply = document.querySelector(".companion-hud__output")!;
    expect(rail.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    advance(6_000);
    expect(dismissLiveReply).toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "小鲸 正在做的事" }).hasAttribute("data-leaving")).toBe(false);
    advance(3_000);
    expect(screen.queryByRole("status", { name: "小鲸 正在做的事" })).toBeNull();
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

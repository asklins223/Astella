// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionChatSession } from "../../../app/companion-chat-session";
import type { CompanionVoiceInputOptions } from "../use-companion-voice-input";
import { CompanionHud } from "../CompanionHud";
import { interactionProposal, interactionSession, interactionSettings } from "./companion-interaction-fixtures";

const state = vi.hoisted(() => ({ chat: null as unknown, voiceOptions: null as unknown, refresh: (() => {}) as () => void }));
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
    return { phase: "idle", note: null, noteRevision: 0, supported: true, toggle: voiceToggle, cancel: voiceCancel,
      dismissNote: vi.fn(), subscribeLevel: () => () => undefined };
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
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  state.chat = interactionSession();
  voiceToggle.mockClear(); voiceCancel.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("production companion interaction", () => {
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
    state.chat = interactionSession({ proposalStates: { pending: interactionProposal() }, decideProposal });
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
  it("keeps speech input separate, waits for explicit send, and preserves a text draft", async () => {
    const send = vi.fn(async () => true);
    state.chat = interactionSession({ send });
    render(<Harness voiceEnabled />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "文字草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await act(async () => (state.voiceOptions as CompanionVoiceInputOptions).onTranscript({ text: "真实识别的文字" }));
    expect(send).not.toHaveBeenCalled();
    const voice = screen.getByRole("region", { name: "语音气泡" });
    fireEvent.change(within(voice).getByRole("textbox", { name: "识别后的语音文字" }), { target: { value: "修改后的文字" } });
    await act(async () => fireEvent.click(within(voice).getByRole("button", { name: "发送" })));
    expect(send).toHaveBeenCalledWith({ text: "修改后的文字" });
    expect(screen.queryByRole("region", { name: "语音气泡" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "气泡轻聊" }));
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("文字草稿");
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
  it("preserves the shared text draft and cancels voice on a real conversation change", async () => {
    render(<Harness voiceEnabled />);
    fireEvent.change(screen.getByRole("textbox", { name: "给 小鲸 的消息" }), { target: { value: "旧空间的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "语音输入" }));
    await act(async () => (state.voiceOptions as CompanionVoiceInputOptions).onTranscript({ text: "旧语音" }));
    expect(screen.getByRole("textbox", { name: "识别后的语音文字" })).toBeTruthy();
    patch({ conversationId: "new-conversation", mode: "conversation" });
    expect(screen.queryByRole("textbox", { name: "识别后的语音文字" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "给 小鲸 的消息" }) as HTMLTextAreaElement).value).toBe("旧空间的草稿");
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

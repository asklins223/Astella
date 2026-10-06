// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanionChatProvider, useCompanionChat, type CompanionChatSession } from "../companion-chat-session";
import { useRoomStore } from "../room-store";
import { beginNoteExplanation, resetNoteExplanations, saveNoteExplanation, useNoteCompanionExplanations } from "../../components/companion/note-companion-explanation";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = { noteId: id(1), anchor: { noteVersionId: id(2), startBlockOrdinal: 0, endBlockOrdinal: 0, startOffset: 0, endOffset: 4, excerpt: "利息复利", prefix: "", suffix: "" } };
const ok = <T,>(data: T) => ({ version: 1 as const, ok: true as const, data, requestId: "test", correlationId: "test", schemaRevision: "desktop-ipc-v1" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const date = "2026-10-02T00:00:00.000Z";
const session = { status: "authenticated", workspace: { workspaceEpoch: 1 } };
let chat!: CompanionChatSession;
let api: Record<string, any>;
let streamEvent: ((event: any) => void) | null;
let messages: any[];
function Capture() { chat = useCompanionChat(); return <span />; }
async function sendQuote() {
  const attempt = beginNoteExplanation(target);
  let sending!: Promise<boolean>;
  act(() => { sending = chat.send({ text: "解释这句", selection: { text: target.anchor.excerpt }, noteAnchor: { ...target, explanationId: attempt.id } }); });
  return { sending, attempt };
}
const current = () => useNoteCompanionExplanations.getState().items[0]!;
function emit(type: string, payload: unknown) {
  act(() => streamEvent?.({ data: { kind: "companion_chat_event", conversationId: id(5), event: { runId: id(6), generation: 1, seq: 1, eventType: type, payload } } }));
}

beforeEach(() => {
  resetNoteExplanations(); streamEvent = null; messages = [];
  useRoomStore.setState({ hudPage: "note-read", activeNoteRef: { noteId: target.noteId, noteVersionId: target.anchor.noteVersionId }, pageReadableView: null });
  api = {
    auth: { getState: vi.fn(async () => ok(session)) },
    workspace: { getAiSettings: vi.fn(async () => ok({ requiresConsent: false })) },
    companion: {
      bridge: { setContext: vi.fn(async () => ok({ enabled: true, published: true, snapshot: null })), clearContext: vi.fn(async () => ok({ enabled: true, published: false, snapshot: null })) },
      chat: {
        ensureConversation: vi.fn(async () => ok({ conversation: { version: 1, id: id(5), workspaceId: id(10), userId: id(11), kind: "dialogue", title: "伴星", titleSource: "placeholder", status: "active", createdAt: date, updatedAt: date, lastMessageAt: null } })),
        listMessages: vi.fn(async () => ok({ items: messages, total: messages.length, oldestSeq: null, hasMore: false })),
        listRunNodes: vi.fn(async () => ok({ items: [], runs: [] })),
        sendTurn: vi.fn(async () => ok({ runId: id(6), generation: 1, eventCursor: 0 })),
        cancelRun: vi.fn(async () => ok({ version: 1, runId: id(6), generation: 1, status: "cancelled" })),
      },
    },
    subscriptions: { subscribe: vi.fn(async () => ok({ subscriptionId: id(7) })), unsubscribe: vi.fn(async () => ok({})),
      onEvent: vi.fn((_id: string, listener: (event: any) => void) => { streamEvent = listener; return () => { streamEvent = null; }; }) },
    noteAnnotation: { write: vi.fn(async (input: any) => ok({ annotationId: id(8), noteId: target.noteId, anchor: input.command.anchor, explanation: input.command.explanation,
      sourceMessageId: input.command.sourceMessageId, generationJobId: null, revision: 1, versionState: "current", createdAt: date, updatedAt: date })) },
  };
  Object.defineProperty(window, "astella", { configurable: true, value: api });
  render(<CompanionChatProvider><Capture /></CompanionChatProvider>);
});
afterEach(() => { cleanup(); resetNoteExplanations(); vi.useRealTimers(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "astella"); });

it("发送前置检查还没返回时立刻停止，不提交模型请求，不保存批注", async () => {
  const preflight = deferred<ReturnType<typeof ok<typeof session>>>();
  api.auth.getState.mockReturnValueOnce(preflight.promise);
  const { sending } = await sendQuote();
  await act(async () => { expect(await chat.cancel()).toBe(true); });
  expect(current()).toMatchObject({ phase: "stopped", text: "" });
  await act(async () => { preflight.resolve(ok(session)); await sending; });
  expect(api.companion.chat.sendTurn).not.toHaveBeenCalled(); expect(api.noteAnnotation.write).not.toHaveBeenCalled();
  expect(chat.phase).toBe("ready");
  expect(chat.stopNotice).toBeTruthy();
  act(() => chat.dismissStopNotice());
  expect(chat.stopNotice).toBeNull();
});

it("turn 回执尚未返回时停止，迟到的 run 被取消，不恢复气泡和批注", async () => {
  const receipt = deferred<ReturnType<typeof ok<{ runId: string; generation: number; eventCursor: number }>>>();
  api.companion.chat.sendTurn.mockReturnValueOnce(receipt.promise);
  const { sending } = await sendQuote();
  await waitFor(() => expect(api.companion.chat.sendTurn).toHaveBeenCalled());
  await act(async () => { await chat.cancel(); });
  await act(async () => { receipt.resolve(ok({ runId: id(6), generation: 1, eventCursor: 0 })); await sending; });
  expect(api.companion.chat.cancelRun).toHaveBeenCalledWith(expect.objectContaining({ request: { version: 1, runId: id(6), generation: 1 } }));
  expect(api.subscriptions.subscribe).not.toHaveBeenCalled(); expect(api.noteAnnotation.write).not.toHaveBeenCalled();
  expect(current().phase).toBe("stopped"); expect(chat.liveReply).toBeNull();
});

it.each(["stop", "failure"] as const)("生成已有半段内容后 %s，不丢内容、不保存半成品", async outcome => {
  const { sending } = await sendQuote();
  await waitFor(() => expect(streamEvent).not.toBeNull());
  emit("assistant.delta", { appendFrom: 0, textDelta: "利息加入本金，再产生新的利息。" });
  expect(current().text).toBe("利息加入本金，再产生新的利息。");
  if (outcome === "stop") await act(async () => { await chat.cancel(); });
  else emit("error", { code: "PROVIDER_FAILED", recoverable: true });
  await act(async () => { await sending; });
  expect(current()).toMatchObject({ phase: outcome === "stop" ? "stopped" : "interrupted", text: "利息加入本金，再产生新的利息。", annotation: null });
  expect(chat.draft).toBeNull(); expect(chat.interrupted?.text).toContain("利息加入本金"); expect(api.noteAnnotation.write).not.toHaveBeenCalled();
});

it("只有完整终态才自动保存一次；气泡提前收起不影响保存，迟到回执不抢新选文", async () => {
  const save = deferred<ReturnType<typeof ok<any>>>();
  api.noteAnnotation.write.mockReturnValueOnce(save.promise);
  const { sending, attempt } = await sendQuote();
  await waitFor(() => expect(streamEvent).not.toBeNull());
  emit("assistant.delta", { appendFrom: 0, textDelta: "利息加入本金" });
  messages = [{ id: id(9), role: "assistant", runId: id(6), kind: "text", blocks: [{ type: "text", text: "利息也参与下一次计算。" }] }];
  emit("assistant.final", {}); emit("character.cue", {});
  await act(async () => { await sending; });
  expect(current().phase).toBe("saving"); expect(api.noteAnnotation.write).toHaveBeenCalledTimes(1);
  act(() => chat.dismissLiveReply());
  const next = beginNoteExplanation({ ...target, anchor: { ...target.anchor, startBlockOrdinal: 1, endBlockOrdinal: 1 } });
  await act(async () => { save.resolve(ok({ annotationId: id(8), noteId: target.noteId, anchor: target.anchor, explanation: "利息也参与下一次计算。", sourceMessageId: id(9), generationJobId: null,
    revision: 1, versionState: "current", createdAt: date, updatedAt: date })); });
  expect(useNoteCompanionExplanations.getState().items.find(item => item.id === attempt.id)?.phase).toBe("saved");
  expect(useNoteCompanionExplanations.getState().activeId).toBe(next.id); expect(chat.liveReply).toBeNull();
});

it("回复结束后重试保存成功，也会解除发送框里的原句绑定", async () => {
  api.noteAnnotation.write.mockRejectedValueOnce(new Error("暂时断网"));
  const { sending, attempt } = await sendQuote();
  await waitFor(() => expect(streamEvent).not.toBeNull());
  messages = [{ id: id(9), role: "assistant", runId: id(6), kind: "text", blocks: [{ type: "text", text: "利息也参与下一次计算。" }] }];
  emit("assistant.final", {}); emit("character.cue", {});
  await act(async () => { await sending; });
  expect(current().phase).toBe("save-error");
  expect(chat.feedNoteAnchor?.explanationId).toBe(attempt.id);
  await act(async () => { await saveNoteExplanation(attempt.id); });
  expect(current().phase).toBe("saved"); expect(chat.feedNoteAnchor).toBeNull();
  expect(api.companion.chat.sendTurn).toHaveBeenCalledTimes(1);
  expect(api.noteAnnotation.write).toHaveBeenCalledTimes(2);
});

it("停止请求遇到断网仍立即停止本地接收，保留半段内容并允许重新确认停止", async () => {
  api.companion.chat.cancelRun.mockRejectedValueOnce(new Error("网络断开"));
  const { sending } = await sendQuote();
  await waitFor(() => expect(streamEvent).not.toBeNull());
  emit("assistant.delta", { appendFrom: 0, textDelta: "尚未说完的解释" });
  await act(async () => { expect(await chat.cancel()).toBe(false); await sending; });
  expect(current()).toMatchObject({ phase: "stopped", text: "尚未说完的解释", annotation: null, stopUnconfirmed: true });
  expect(current().error).toContain("停止请求暂未确认");
  expect(api.noteAnnotation.write).not.toHaveBeenCalled();
  await act(async () => { expect(await chat.cancel()).toBe(true); });
  expect(api.companion.chat.cancelRun).toHaveBeenCalledTimes(2);
  expect(current()).toMatchObject({ error: null, text: "尚未说完的解释", stopUnconfirmed: false });
});

// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import type { GatewayEventV1 } from "@astella/shared/desktop-ipc-contracts";
import { CompanionChatProvider, useCompanionChat, type CompanionChatSession } from "../companion-chat-session";
import { useRoomStore } from "../room-store";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-10-08T00:00:00.000Z";
const ok = <T,>(data: T) => ({ version: 1 as const, ok: true as const, data, requestId: "history-status-test", correlationId: "history-status-test", schemaRevision: "desktop-ipc-v1" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
let chat!: CompanionChatSession;
let streamEvent: ((event: GatewayEventV1) => void) | null;
let items: CompanionMessageV1[];
const page = () => ok({ items, total: items.length, oldestSeq: items[0]?.seq ?? null, hasMore: false });
const listMessages = vi.fn(async () => page());
function Capture() { chat = useCompanionChat(); return null; }

function emit(eventType: string, payload: Record<string, unknown> = {}) {
  act(() => streamEvent?.({
    version: 1, subscriptionId: id(7), workspaceEpoch: 1, cursor: "1", eventRevision: 1,
    kind: "companion_chat_event", schemaRevision: "desktop-ipc-v1",
    data: { kind: "companion_chat_event", conversationId: id(5), event: { runId: id(6), generation: 1, seq: 1, eventType, payload } },
  }));
}
async function openHistory() {
  const calls = listMessages.mock.calls.length;
  await act(async () => chat.setMode("history"));
  await waitFor(() => expect(listMessages.mock.calls.length).toBeGreaterThan(calls));
}
async function startSend() {
  let sending!: Promise<boolean>;
  act(() => { sending = chat.send({ text: "解释一下为什么天空是蓝色的" }); });
  await waitFor(() => expect(streamEvent).not.toBeNull());
  expect(chat.phase).toBe("sending");
  return { sending };
}
function addReply() {
  items = [...items, {
    version: 1, id: id(9), workspaceId: id(10), conversationId: id(5), seq: 2,
    role: "assistant", kind: "text", blocks: [{ type: "text", text: "蓝光更容易被空气分子散射。" }],
    runId: id(6), clientMessageId: null, contentSha256: "0".repeat(64), createdAt: date, editedAt: null,
  }];
  emit("assistant.final");
  emit("character.cue");
}

beforeEach(() => {
  streamEvent = null; items = []; listMessages.mockReset().mockImplementation(async () => page());
  useRoomStore.setState({ hudPage: "home", activeNoteRef: null, pageReadableView: null });
  Object.defineProperty(window, "astella", { configurable: true, value: {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceEpoch: 1 } })) },
    workspace: { getAiSettings: vi.fn(async () => ok({ requiresConsent: false })) },
    companion: {
      bridge: { setContext: vi.fn(async () => ok({ enabled: true, published: true, snapshot: null })), clearContext: vi.fn(async () => ok({ enabled: true, published: false, snapshot: null })) },
      chat: {
        ensureConversation: vi.fn(async () => ok({ conversation: { version: 1, id: id(5), workspaceId: id(10), userId: id(11), kind: "dialogue", title: "伴星", titleSource: "placeholder", status: "active", createdAt: date, updatedAt: date, lastMessageAt: null } })),
        listMessages,
        listAgentRoutes: vi.fn(async () => ok({ items: [], latestSeq: 0 })),
        listRunNodes: vi.fn(async () => ok({ items: [], runs: [] })),
        sendTurn: vi.fn(async () => ok({ runId: id(6), generation: 1, eventCursor: 0 })),
      },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: id(7) })), unsubscribe: vi.fn(async () => ok({})),
      onEvent: vi.fn((_id: string, listener: (event: GatewayEventV1) => void) => { streamEvent = listener; return () => { streamEvent = null; }; }),
    },
  } });
  render(<CompanionChatProvider><Capture /></CompanionChatProvider>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "astella"); });

describe("手记记录刷新与当前回复的状态归属", () => {
  it("首次打开读完记录后正常进入就绪，读取失败仍可重开恢复", async () => {
    listMessages.mockRejectedValueOnce(new Error("记录暂时无法读取"));
    await openHistory();
    expect(chat.phase).toBe("error");
    await act(async () => chat.setMode("conversation"));
    await openHistory();
    expect(chat.phase).toBe("ready");
  });

  it("回复前反复从手记切回气泡再打开，始终保持正在回复，收到正文才收起", async () => {
    await openHistory();
    const { sending } = await startSend();
    for (let visit = 0; visit < 3; visit += 1) {
      await act(async () => chat.setMode("conversation"));
      await openHistory();
      expect(chat.phase).toBe("sending");
      expect(chat.failure).toBeNull();
    }
    addReply();
    await act(async () => { expect(await sending).toBe(true); });
    expect(chat.phase).toBe("ready");
    expect(chat.liveReply?.text).toBe("蓝光更容易被空气分子散射。");
    expect(chat.messages.some(message => message.id === id(9))).toBe(true);
  });

  it("重新打开手记时记录读取失败，也不能把仍在进行的回复标成失败", async () => {
    await openHistory();
    const { sending } = await startSend();
    await act(async () => chat.setMode("conversation"));
    listMessages.mockRejectedValueOnce(new Error("记录暂时无法读取"));
    await openHistory();
    expect(chat.phase).toBe("sending");
    expect(chat.failure).toBeNull();
    addReply();
    await act(async () => { await sending; });
    expect(chat.phase).toBe("ready");
  });

  it("记录请求在发送前开始、发送后才返回，不覆盖新的回复状态", async () => {
    await openHistory();
    await act(async () => chat.setMode("conversation"));
    const history = deferred<ReturnType<typeof page>>();
    listMessages.mockReturnValueOnce(history.promise);
    await openHistory();
    const { sending } = await startSend();
    await act(async () => history.resolve(page()));
    expect(chat.phase).toBe("sending");
    addReply();
    await act(async () => { await sending; });
  });

  it.each(["发送前", "发送中"])("%s开始的记录刷新晚于真实回复失败返回，保留失败原因", async when => {
    await openHistory();
    await act(async () => chat.setMode("conversation"));
    let turn: { sending: Promise<boolean> } | undefined;
    if (when === "发送中") turn = await startSend();
    const history = deferred<ReturnType<typeof page>>();
    listMessages.mockReturnValueOnce(history.promise);
    await openHistory();
    turn ??= await startSend();
    emit("error", { code: "PROVIDER_FAILED", recoverable: true });
    await act(async () => { await turn.sending; });
    const failure = chat.failure;
    expect(chat.phase).toBe("error");
    expect(failure).toBeTruthy();
    await act(async () => history.resolve(page()));
    expect(chat.phase).toBe("error");
    expect(chat.failure).toBe(failure);
  });
});

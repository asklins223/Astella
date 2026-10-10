// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import type { GatewayEventV1 } from "@astella/shared/desktop-ipc-contracts";
import { CompanionChatProvider, useCompanionChat, type CompanionChatSession } from "../companion-chat-session";
import { publishCompanionConversationInvalidated } from "../../components/companion/companion-events";
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
const listRunNodes = vi.fn(async () => ok({ items: [] as unknown[], runs: [] as unknown[] }));
const ensureResult = (conversationId: string) => ok({
  version: 1 as const,
  created: false,
  conversation: {
    version: 1 as const, id: conversationId, workspaceId: id(10), userId: id(11), kind: "dialogue" as const,
    title: "伴星", titleSource: "placeholder" as const, status: "active" as const,
    createdAt: date, updatedAt: date, lastMessageAt: null,
  },
});
const userMessage = (conversationId: string): CompanionMessageV1 => ({
  version: 1, id: id(30), workspaceId: id(10), conversationId, seq: 1, role: "user", kind: "text",
  blocks: [{ type: "text", text: "你好呀" }], runId: null, clientMessageId: null,
  contentSha256: "0".repeat(64), createdAt: date, editedAt: null,
});
function Capture() { chat = useCompanionChat(); return null; }

function emit(eventType: string, payload: Record<string, unknown> = {}, runId = id(6), conversationId = id(5)) {
  act(() => streamEvent?.({
    version: 1, subscriptionId: id(7), workspaceEpoch: 1, cursor: "1", eventRevision: 1,
    kind: "companion_chat_event", schemaRevision: "desktop-ipc-v1",
    data: { kind: "companion_chat_event", conversationId, event: { runId, generation: 1, seq: 1, eventType, payload } },
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
  listRunNodes.mockReset().mockImplementation(async () => ok({ items: [], runs: [] }));
  useRoomStore.setState({ hudPage: "home", activeNoteRef: null, pageReadableView: null });
  Object.defineProperty(window, "astella", { configurable: true, value: {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceEpoch: 1 } })) },
    workspace: { getAiSettings: vi.fn(async () => ok({ requiresConsent: false })) },
    companion: {
      bridge: { setContext: vi.fn(async () => ok({ enabled: true, published: true, snapshot: null })), clearContext: vi.fn(async () => ok({ enabled: true, published: false, snapshot: null })) },
      chat: {
        ensureConversation: vi.fn(async () => ensureResult(id(5))),
        listMessages,
        listAgentRoutes: vi.fn(async () => ok({ items: [], latestSeq: 0 })),
        listRunNodes,
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
  it("本轮工具即刻投影，快照补回丢失回执；新轮不继承旧工具或旧统计", async () => {
    await openHistory();
    const { sending } = await startSend();
    expect(chat.processRunId).toBe(id(6));
    emit("assistant.delta", { appendFrom: 0, textDelta: "我先查一下相关笔记。" });
    const tool = { toolCallId: "read-one", name: "companion_read_note", safeLabel: "读取笔记" };
    emit("agent.tool", { tool: { ...tool, status: "requested" } });
    expect(chat.nodes.filter(node => node.kind === "tool")).toHaveLength(1);
    expect(chat.draft?.text).toBe("我先查一下相关笔记。");
    emit("agent.tool", { tool: { ...tool, status: "executing" } });
    expect(chat.nodes.filter(node => node.kind === "tool")).toHaveLength(1);
    expect(chat.nodes.find(node => node.kind === "tool")?.state).toBe("running");
    listRunNodes.mockResolvedValue(ok({
      items: [{ version: 1, seq: 2, runId: id(6), type: "agent.tool", payload: { tool: { ...tool, status: "succeeded", safeSummary: "笔记已读取" } } }],
      runs: [{ version: 1, runId: id(6), status: "running", generation: 1, stepCount: 1, toolCallCount: 1, maxSteps: 20, maxToolCalls: 40, assistantMessageId: null, nodeCount: 1 }],
    }));
    await act(async () => chat.setMode("conversation"));
    await openHistory();
    await waitFor(() => expect(chat.nodes.find(node => node.kind === "tool")?.state).toBe("succeeded"));
    emit("agent.tool", { tool: { ...tool, status: "executing" } });
    expect(chat.nodes.find(node => node.kind === "tool")?.state).toBe("succeeded");
    // 更旧或缺失的轮询结果到达时，补回的成功回执仍属于本轮。
    listRunNodes.mockResolvedValue(ok({ items: [], runs: [] }));
    await act(async () => chat.setMode("conversation"));
    await openHistory();
    await waitFor(() => expect(chat.runTraces).toHaveLength(0));
    expect(chat.nodes.find(node => node.kind === "tool")?.state).toBe("succeeded");
    addReply();
    await act(async () => { await sending; });
    expect(chat.processRunId).toBe(id(6));
    vi.mocked(window.astella.companion.chat.sendTurn).mockResolvedValueOnce(ok({ version: 1, runId: id(20), conversationId: id(5), status: "accepted", generation: 2, eventCursor: 0, clientMessageId: id(21), userMessageId: id(22) }));
    const next = await startSend();
    expect(chat.processRunId).toBe(id(20));
    expect(chat.nodes).toHaveLength(0);
    emit("error", { code: "PROVIDER_FAILED", recoverable: true }, id(20));
    await act(async () => { await next.sending; });
  });

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

describe("清空连续对话记录后，本机不再握着那条已经不存在的会话", () => {
  it("手记开着时清空：旧正文与旧会话身份一起丢弃，并重新读新建的收件箱", async () => {
    items = [userMessage(id(5))];
    await openHistory();
    expect(chat.conversationId).toBe(id(5));
    expect(chat.messages).toHaveLength(1);

    const ensure = vi.mocked(window.astella.companion.chat.ensureConversation);
    ensure.mockResolvedValue(ensureResult(id(12)));
    items = [];
    await act(async () => { publishCompanionConversationInvalidated(); });

    await waitFor(() => expect(chat.conversationId).toBe(id(12)));
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(chat.messages).toHaveLength(0);
    expect(chat.failure).toBeNull();
  });

  it("清空后发出去的那一句带的是新建的收件箱，而不是被删掉的会话", async () => {
    await openHistory();
    vi.mocked(window.astella.companion.chat.ensureConversation).mockResolvedValue(ensureResult(id(12)));
    await act(async () => { publishCompanionConversationInvalidated(); });
    await waitFor(() => expect(chat.conversationId).toBe(id(12)));

    const { sending } = await startSend();
    const turn = vi.mocked(window.astella.companion.chat.sendTurn).mock.calls.at(-1)?.[0];
    expect(turn?.request.conversationId).toBe(id(12));
    emit("error", { code: "PROVIDER_FAILED", recoverable: true }, id(6), id(12));
    await act(async () => { await sending; });
  });
});

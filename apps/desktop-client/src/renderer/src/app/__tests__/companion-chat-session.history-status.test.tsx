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
const listHistory = vi.fn(async () => ok({
  version: 1 as const,
  items: [] as Array<Record<string, unknown>>,
  nextCursor: null as string | null,
}));
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

it("stopping an accepted send is handled successfully and keeps the history view", async () => {
  await openHistory();
  const { sending } = await startSend();
  vi.mocked(window.astella.companion.chat.cancelRun).mockResolvedValueOnce(ok({ version: 1 } as never));
  await act(async () => { expect(await chat.cancel()).toBe(true); });
  await act(async () => { expect(await sending).toBe(true); });
  expect(chat.mode).toBe("history");
  expect(chat.phase).toBe("ready");
  expect(chat.failure).toBeNull();
});
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
  listHistory.mockReset().mockImplementation(async () => ok({ version: 1, items: [], nextCursor: null }));
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
        cancelRun: vi.fn(async () => ok({ version: 1 })),
      },
      history: { list: listHistory },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: id(7) })), unsubscribe: vi.fn(async () => ok({})),
      onEvent: vi.fn((_id: string, listener: (event: GatewayEventV1) => void) => { streamEvent = listener; return () => { streamEvent = null; }; }),
    },
  } });
  render(<CompanionChatProvider><Capture /></CompanionChatProvider>);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "astella"); });

describe("手记记录刷新与当前回复的状态归属", () => {
  it("同一轮可逐句发言，第一句之后仍在继续，完成时不重复追加正文", async () => {
    await openHistory(); const { sending } = await startSend();
    const first = { ...userMessage(id(5)), id: id(40), role: "assistant" as const, runId: id(6), seq: 2,
      blocks: [{ type: "text" as const, text: "第一件事，我们先确定条件。" }] };
    items = [first];
    emit("assistant.utterance", { messageId: first.id, messageSeq: 2, text: first.blocks[0]!.text, proactive: false, deviceSessionId: null });
    await waitFor(() => expect(chat.messages.some(m => m.id === first.id)).toBe(true));
    expect(chat.phase).toBe("sending");
    const second = { ...first, id: id(41), seq: 3, blocks: [{ type: "text" as const, text: "接着，再看这个条件下会发生什么。" }] };
    items = [first, second];
    emit("assistant.utterance", { messageId: second.id, messageSeq: 3, text: second.blocks[0]!.text, proactive: false, deviceSessionId: null });
    expect(chat.phase).toBe("sending");
    emit("turn.completed", { messageIds: [first.id, second.id], silent: false });
    await act(async () => { expect(await sending).toBe(true); });
    expect(chat.phase).toBe("ready"); expect(chat.messages.filter(m => m.role === "assistant")).toHaveLength(2);
    expect(chat.liveReply?.text).toBe(`${first.blocks[0]!.text}\n\n${second.blocks[0]!.text}`);
  });
  it("主动参与可以安静结束，不产生等待超时或虚构消息", async () => {
    await openHistory(); let receiving!: Promise<boolean>;
    act(() => { receiving = chat.receiveInitiative!({ conversationId: id(5), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null }); });
    await waitFor(() => expect(streamEvent).not.toBeNull());
    emit("turn.accepted", { clientMessageId: id(8), userMessageId: null, status: "accepted" });
    emit("assistant.status", { inputKind: "initiative", status: "thinking", safeLabel: "正在思考…" });
    expect(chat.phase).toBe("ready");
    expect(chat.draft).toBeNull();
    emit("turn.completed", { messageIds: [], silent: true });
    await act(async () => { await receiving; });
    expect(await receiving).toBe(false);
    expect(chat.phase).toBe("ready"); expect(chat.failure).toBeNull(); expect(chat.messages).toHaveLength(0);
  });
  /**
   * 主动开口的落点与桌面的实时会话**可以不是同一条**：worker 按观察那一刻的会话选 run
   * 的落点，而桌面永远用 `/companion/inbox/ensure` 那一条。以前这里直接放弃——气泡不出声，
   * 投递却被记成 `displayed`（投影从此不再把它交给任何设备），那一句对谁都永久消失。
   * 正文是真实存在的，所以现在从共享历史（跨 dialogue + inbox）读回来放进气泡。
   */
  it("投递落在别的对话里时，正文从共享历史读回来，而不是悄悄丢掉", async () => {
    const spoken = "来啦。晚上这会儿还开着，是想接着抠导热那块，还是随便转转？";
    listHistory.mockResolvedValue(ok({ version: 1, items: [
      { version: 1, messageId: id(40), role: "assistant", kind: "proactive", runId: id(6),
        blocks: [{ type: "text", text: spoken }], createdAt: date, editedAt: null },
      { version: 1, messageId: id(41), role: "assistant", kind: "text", runId: id(6),
        blocks: [{ type: "text", text: "导热那块我翻到一条能接上的线索。" }], createdAt: date, editedAt: null },
      { version: 1, messageId: id(42), role: "assistant", kind: "text", runId: id(60),
        blocks: [{ type: "text", text: "这是另一轮的正文，不该混进来。" }], createdAt: date, editedAt: null },
    ], nextCursor: null }));
    let shown!: Promise<boolean>;
    act(() => { shown = chat.receiveInitiative!({ conversationId: id(12), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null }); });
    await act(async () => { await shown; });
    expect(await shown).toBe(true);
    // 别人的会话没有事件流可订阅：这一次只读正文，不认领 run。
    expect(streamEvent).toBeNull();
    expect(listHistory).toHaveBeenCalledWith(expect.objectContaining({ query: { limit: 100, runId: id(6) } }));
    expect(chat.liveReply?.text).toBe(`${spoken}\n\n导热那块我翻到一条能接上的线索。`);
    // 投影刷新会让同一条投递再问一次（回执可能还没认领成功）：不重复出声，但
    // "屏幕上已经有了"这件事照旧成立——回执才敢重发。
    listHistory.mockClear();
    await act(async () => { expect(await chat.receiveInitiative!({ conversationId: id(12), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null })).toBe(true); });
    expect(listHistory).not.toHaveBeenCalled();
  });
  it("主动发言跨历史分页时按自然顺序读全，再确认展示", async () => {
    const item = (messageId: string, text: string) => ({ version: 1, messageId, role: "assistant", kind: "text", runId: id(6),
      blocks: [{ type: "text", text }], createdAt: date, editedAt: null });
    listHistory.mockResolvedValueOnce(ok({ version: 1, items: [item(id(41), "后半句。")], nextCursor: "older-page" }))
      .mockResolvedValueOnce(ok({ version: 1, items: [item(id(40), "第一句。")], nextCursor: null }));
    let shown!: Promise<boolean>;
    act(() => { shown = chat.receiveInitiative!({ conversationId: id(12), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null }); });
    await act(async () => { await shown; });
    expect(await shown).toBe(true);
    expect(chat.liveReply?.text).toBe("第一句。\n\n后半句。");
    expect(listHistory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      query: { limit: 100, runId: id(6), before: "older-page" },
    }));
  });

  it("重复历史游标不能把不完整的主动发言确认成已展示", async () => {
    listHistory.mockResolvedValue(ok({ version: 1, items: [{ version: 1, messageId: id(40), role: "assistant", kind: "proactive", runId: id(6),
      blocks: [{ type: "text", text: "只有第一句。" }], createdAt: date, editedAt: null }], nextCursor: "loop" }));
    let shown!: Promise<boolean>;
    act(() => { shown = chat.receiveInitiative!({ conversationId: id(12), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null }); });
    await act(async () => { await shown; });
    expect(await shown).toBe(false);
    expect(chat.liveReply).toBeNull();
    expect(listHistory).toHaveBeenCalledTimes(2);
  });

  it("用户正在另一轮里时不接这一句，也不假装接过", async () => {
    await openHistory();
    const { sending } = await startSend();
    await expect(chat.receiveInitiative!({ conversationId: id(5), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null })).resolves.toBe(false);
    addReply();
    await act(async () => { expect(await sending).toBe(true); });
  });
  it("历史主动消息还在读取时不提前确认展示；输入后迟到正文不再抢回气泡", async () => {
    const pending = deferred<Awaited<ReturnType<typeof listHistory>>>();
    listHistory.mockReturnValue(pending.promise);
    const delivery = { conversationId: id(12), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null };
    let receiving!: Promise<boolean>;
    act(() => { receiving = chat.receiveInitiative!(delivery); });
    await waitFor(() => expect(listHistory).toHaveBeenCalled());
    await expect(chat.receiveInitiative!(delivery)).resolves.toBe(false);
    act(() => window.dispatchEvent(new Event("astella:companion-user-input")));
    pending.resolve(ok({ version: 1, items: [{ messageId: id(40), role: "assistant", runId: id(6),
      blocks: [{ type: "text", text: "迟到的旧话" }] }], nextCursor: null }));
    await act(async () => { expect(await receiving).toBe(false); });
    expect(chat.liveReply).toBeNull();
  });
  it("历史主动消息读取失败后允许重试，不把进行中的认领记成已展示", async () => {
    const delivery = { conversationId: id(12), messageId: id(40), runId: id(6), generation: 1, deviceSessionId: null };
    listHistory.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { expect(await chat.receiveInitiative!(delivery)).toBe(false); });
    listHistory.mockResolvedValue(ok({ version: 1, items: [{ messageId: id(40), role: "assistant", runId: id(6),
      blocks: [{ type: "text", text: "已恢复的问候" }] }], nextCursor: null }));
    await act(async () => { expect(await chat.receiveInitiative!(delivery)).toBe(true); });
    expect(chat.liveReply?.text).toBe("已恢复的问候");
  });
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
    await waitFor(() => expect(chat.runTraces).toHaveLength(1));
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


it("待确认的动作卡不能提前结束回复，最终流到达时交付真正的正文", async () => {
  await openHistory();
  const { sending } = await startSend();
  items = [{ version: 1, id: id(70), workspaceId: id(10), conversationId: id(5), seq: 1,
    role: "assistant", kind: "action", blocks: [{ type: "text", text: "结果已准备好，等待确认保存" }],
    runId: id(6), clientMessageId: null, contentSha256: "0".repeat(64), createdAt: date, editedAt: null }];
  await waitFor(() => expect(chat.messages.some(message => message.id === id(70))).toBe(true));
  expect(chat.phase).toBe("sending");
  addReply();
  await act(async () => { expect(await sending).toBe(true); });
  expect(chat.liveReply?.text).toBe("蓝光更容易被空气分子散射。");
});

it("原始订阅已丢失时，持久化终答身份会自动补回确认后的回复", async () => {
  await openHistory();
  items = [{ version: 1, id: id(71), workspaceId: id(10), conversationId: id(5), seq: 2,
    role: "assistant", kind: "text", blocks: [{ type: "text", text: "改动已保存，可以接着读。" }],
    runId: id(6), clientMessageId: null, contentSha256: "0".repeat(64), createdAt: date, editedAt: null }];
  listRunNodes.mockResolvedValue(ok({ items: [], runs: [{ version: 1, runId: id(6), status: "succeeded", generation: 1,
    stepCount: 2, toolCallCount: 1, maxSteps: null, maxToolCalls: null, assistantMessageId: id(71), nodeCount: 0 }] }));
  await waitFor(() => expect(chat.messages.some(message => message.id === id(71))).toBe(true), { timeout: 6000 });
  await waitFor(() => expect(chat.phase).toBe("ready"));
  expect(chat.draft).toBeNull();
});

it("思考增量只喂给思考窗口：收是一块、露是一步一步，正文草稿不因它变化", async () => {
  const full = "先确认他问的是散射还是颜色。举个傍晚的例子就够了。";
  await openHistory();
  const { sending } = await startSend();
  expect(chat.thinking).toBe("");
  emit("assistant.thinking", { index: 0, text: "先确认他问的是散射还是颜色。" });
  emit("assistant.thinking", { index: 1, text: "举个傍晚的例子就够了。" });
  // 收到不等于立刻画完：心跳每拍只搬积压的一小步，界面才不会一跳一跳。
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
  expect(chat.thinking.length).toBeGreaterThan(0);
  expect(chat.thinking.length).toBeLessThan(full.length);
  await waitFor(() => expect(chat.thinking).toBe(full), { timeout: 6_000 });
  expect(chat.draft).toBeNull();
  // 重连接上的重放：同一块再来一次不重复贴。
  emit("assistant.thinking", { index: 1, text: "举个傍晚的例子就够了。" });
  expect(chat.thinking).toBe(full);
  // 中间缺了一块：接着拼会拼出她没想过的句子，所以整窗从这一块重新起头。
  emit("assistant.thinking", { index: 5, text: "后面这段是补回来的新起点。" });
  await waitFor(() => expect(chat.thinking).toBe("后面这段是补回来的新起点。"), { timeout: 6_000 });
  emit("assistant.delta", { appendFrom: 0, textDelta: "蓝光更容易被空气分子散射。" });
  expect(chat.draft?.text).toBe("蓝光更容易被空气分子散射。");
  addReply();
  await act(async () => { expect(await sending).toBe(true); });
});

it("接替重试又撞 409 时空手再发一次：那条 run 刚好没了不该把用户挡死", async () => {
  const conflictResult = { version: 1 as const, ok: false as const,
    error: { version: 1 as const, code: "conflict" as const, retry: "never" as const,
      safeMessageKey: "上一条还挂着", requestId: "conflict-1" },
    requestId: "conflict-1", correlationId: "conflict-1", schemaRevision: "desktop-ipc-v1" };
  const sendTurn = vi.mocked(window.astella.companion.chat.sendTurn);
  sendTurn.mockReset();
  sendTurn.mockResolvedValueOnce(conflictResult as never);
  sendTurn.mockResolvedValueOnce(conflictResult as never);
  sendTurn.mockResolvedValue(ok({ version: 1, status: "accepted", conversationId: id(5), runId: id(6),
    generation: 43, eventCursor: 0, clientMessageId: id(70), userMessageId: id(71) }));
  listRunNodes.mockResolvedValue(ok({
    items: [],
    runs: [{ version: 1, runId: id(60), status: "accepted", generation: 42, stepCount: 0, toolCallCount: 0,
      maxSteps: 20, maxToolCalls: 40, assistantMessageId: null, nodeCount: 0 }],
  }));
  await openHistory();
  const { sending } = await startSend();
  await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(3));
  // 第一次空手（本地不知道有 run）→ 读到 42 带着号接替 → 又被挡 → 第三次回到空手。
  const bodies = sendTurn.mock.calls.map(call => call[0].request.turn);
  expect(bodies[0]).not.toHaveProperty("supersedesGeneration");
  expect(bodies[1]).toMatchObject({ supersedesGeneration: 42 });
  expect(bodies[2]).not.toHaveProperty("supersedesGeneration");
  addReply();
  await act(async () => { expect(await sending).toBe(true); });
  expect(chat.blockedByRun).toBeNull();
});


it("409 只是本地接替号过期时，空手重发一次就发出去，不再挂「上一条还挂着」", async () => {
  const conflictResult = { version: 1 as const, ok: false as const,
    error: { version: 1 as const, code: "conflict" as const, retry: "never" as const,
      safeMessageKey: "上一条还挂着", requestId: "conflict-2" },
    requestId: "conflict-2", correlationId: "conflict-2", schemaRevision: "desktop-ipc-v1" };
  const sendTurn = vi.mocked(window.astella.companion.chat.sendTurn);
  sendTurn.mockReset();
  sendTurn.mockResolvedValueOnce(conflictResult as never);
  sendTurn.mockResolvedValue(ok({ version: 1, status: "accepted", conversationId: id(5), runId: id(6),
    generation: 44, eventCursor: 0, clientMessageId: id(70), userMessageId: id(71) }));
  // 409 时服务端没有任何活动 run：只是本地握着一个过期的接替号。
  listRunNodes.mockResolvedValue(ok({ items: [], runs: [] }));
  await openHistory();
  const { sending } = await startSend();
  await waitFor(() => expect(sendTurn).toHaveBeenCalledTimes(2));
  const bodies = sendTurn.mock.calls.map(call => call[0].request.turn);
  expect(bodies[0]).not.toHaveProperty("supersedesGeneration");
  expect(bodies[1]).not.toHaveProperty("supersedesGeneration");
  expect(chat.blockedByRun).toBeNull();
  addReply();
  await act(async () => { expect(await sending).toBe(true); });
});

it("two minutes of silent SSE stay below the shared read quota and still recover the final reply", async () => {
  cleanup();
  vi.useFakeTimers();
  render(<CompanionChatProvider><Capture /></CompanionChatProvider>);
  await act(async () => { chat.setMode("history"); });
  let sending!: Promise<boolean>;
  await act(async () => { sending = chat.send({ text: "请继续，等待真实完成" }); });
  expect(streamEvent).not.toBeNull();
  expect(chat.phase).toBe("sending");
  listMessages.mockClear(); listRunNodes.mockClear();
  vi.mocked(window.astella.companion.chat.listAgentRoutes).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  const reads = listMessages.mock.calls.length + listRunNodes.mock.calls.length
    + vi.mocked(window.astella.companion.chat.listAgentRoutes).mock.calls.length;
  expect(reads).toBeLessThan(120);
  expect(listMessages.mock.calls.length).toBeGreaterThan(15);
  expect(chat.phase).toBe("sending");
  items = [{ ...userMessage(id(5)), id: id(9), role: "assistant", runId: id(6), seq: 2,
    blocks: [{ type: "text", text: "流丢失后取回的真实终答。" }] }];
  listRunNodes.mockResolvedValue(ok({ items: [], runs: [{ runId: id(6), status: "succeeded" }] }));
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  await act(async () => { expect(await sending).toBe(true); });
  expect(chat.liveReply?.text).toBe("流丢失后取回的真实终答。");
});

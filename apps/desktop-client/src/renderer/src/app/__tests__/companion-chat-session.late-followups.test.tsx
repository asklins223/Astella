// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageV1 } from "@astella/shared/companion-conversation-contracts";
import type { GatewayEventV1 } from "@astella/shared/desktop-ipc-contracts";
import { CompanionChatProvider, useCompanionChat, type CompanionChatSession } from "../companion-chat-session";
import { useRoomStore } from "../room-store";

/**
 * 追问是**迟到**的：assistant.final 先落，后台任务在一到几秒后才补一条
 * assistant.followups.ready。这一段只有真挂 Provider 才钉得住——
 * 事故形状是纯文本回复根本没有附页，迟到的追问无处可挂，于是服务端给了、
 * 用户却永远看不见（2026-10-13 真窗口实测：库里三条追问，气泡上什么都没有）。
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const date = "2026-10-13T00:00:00.000Z";
const ok = <T,>(data: T) => ({ version: 1 as const, ok: true as const, data, requestId: "late-followups-test", correlationId: "late-followups-test", schemaRevision: "desktop-ipc-v1" });

let chat!: CompanionChatSession;
let streamEvent: ((event: GatewayEventV1) => void) | null = null;
let items: CompanionMessageV1[] = [];
const page = () => ok({ items, total: items.length, oldestSeq: items[0]?.seq ?? null, hasMore: false });
const listMessages = vi.fn(async () => page());

function Capture() { chat = useCompanionChat(); return null; }

function assistantMessage(blocks: CompanionMessageV1["blocks"]): CompanionMessageV1 {
  return {
    version: 1, id: id(9), workspaceId: id(10), conversationId: id(5), seq: 2,
    role: "assistant", kind: "text", blocks, runId: id(6), clientMessageId: null,
    contentSha256: "0".repeat(64), createdAt: date, editedAt: null,
  };
}

function emit(eventType: string, payload: Record<string, unknown> = {}) {
  act(() => streamEvent?.({
    version: 1, subscriptionId: id(7), workspaceEpoch: 1, cursor: "1", eventRevision: 1,
    kind: "companion_chat_event", schemaRevision: "desktop-ipc-v1",
    data: { kind: "companion_chat_event", conversationId: id(5), event: { runId: id(6), generation: 1, seq: 1, eventType, payload } },
  }));
}

async function sendAndSettle(blocks: CompanionMessageV1["blocks"]) {
  let sending!: Promise<boolean>;
  act(() => { sending = chat.send({ text: "为什么天空是蓝色的" }); });
  await waitFor(() => expect(streamEvent).not.toBeNull());
  items = [
    { ...assistantMessage([{ type: "text", text: "你好呀" }]), id: id(30), seq: 1, role: "user" },
    assistantMessage(blocks),
  ];
  emit("assistant.final", { messageId: id(9), textSha256: "0".repeat(64) });
  await act(async () => { await sending; });
  // 终态之后会话层另开一条订阅等迟到的追问；等到第二次 subscribe 才算进入这个时窗。
  await waitFor(() => expect(vi.mocked(window.astella.subscriptions.subscribe).mock.calls.length).toBeGreaterThanOrEqual(2));
}

beforeEach(() => {
  streamEvent = null; items = [];
  listMessages.mockReset().mockImplementation(async () => page());
  useRoomStore.setState({ hudPage: "home", activeNoteRef: null, pageReadableView: null });
  Object.defineProperty(window, "astella", { configurable: true, value: {
    auth: { getState: vi.fn(async () => ok({ status: "authenticated", workspace: { workspaceEpoch: 1 } })) },
    workspace: { getAiSettings: vi.fn(async () => ok({ requiresConsent: false })) },
    companion: {
      bridge: { setContext: vi.fn(async () => ok({ enabled: true, published: true, snapshot: null })), clearContext: vi.fn(async () => ok({ enabled: true, published: false, snapshot: null })) },
      chat: {
        ensureConversation: vi.fn(async () => ok({
          version: 1 as const, created: false,
          conversation: {
            version: 1 as const, id: id(5), workspaceId: id(10), userId: id(11), kind: "dialogue" as const,
            title: "伴星", titleSource: "placeholder" as const, status: "active" as const,
            createdAt: date, updatedAt: date, lastMessageAt: null,
          },
        })),
        listMessages,
        listAgentRoutes: vi.fn(async () => ok({ items: [], latestSeq: 0 })),
        listRunNodes: vi.fn(async () => ok({ items: [], runs: [] })),
        sendTurn: vi.fn(async () => ok({ runId: id(6), generation: 1, eventCursor: 0 })),
      },
    },
    subscriptions: {
      subscribe: vi.fn(async () => ok({ subscriptionId: id(7) })),
      unsubscribe: vi.fn(async () => ok({})),
      onEvent: vi.fn((_id: string, listener: (event: GatewayEventV1) => void) => { streamEvent = listener; return () => { streamEvent = null; }; }),
    },
  } });
  render(<CompanionChatProvider><Capture /></CompanionChatProvider>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "astella"); });

describe("迟到的追问要能挂到这一条回复上", () => {
  it("纯文本回复本来没有附页，追问迟到时自己把那张纸立起来", async () => {
    await sendAndSettle([{ type: "text", text: "蓝光更容易被空气分子散射。" }]);
    expect(chat.richReply).toBeNull();
    emit("assistant.followups.ready", { messageId: id(9), messageContentSha256: "0".repeat(64), followUpPrompts: ["那为什么傍晚的天是红的？"] });
    expect(chat.richReply?.messageId).toBe(id(9));
    expect(chat.richReply?.blocks).toEqual([{ type: "follow_up_suggestions", prompts: ["那为什么傍晚的天是红的？"] }]);
  });

  it("已经有查阅材料时，追问追加进去且不挤掉材料，也不重复挂两份", async () => {
    await sendAndSettle([
      { type: "text", text: "蓝光更容易被散射。" },
      { type: "quote", label: "笔记原文", text: "瑞利散射的强度与波长的四次方成反比。" },
    ]);
    expect(chat.richReply?.blocks.map(block => block.type)).toEqual(["quote"]);
    emit("assistant.followups.ready", { messageId: id(9), messageContentSha256: "0".repeat(64), followUpPrompts: ["举个生活里的例子"] });
    emit("assistant.followups.ready", { messageId: id(9), messageContentSha256: "0".repeat(64), followUpPrompts: ["举个生活里的例子"] });
    expect(chat.richReply?.blocks.map(block => block.type)).toEqual(["quote", "follow_up_suggestions"]);
  });

  it("AI 决定不给追问时什么都不出现", async () => {
    await sendAndSettle([{ type: "text", text: "蓝光更容易被空气分子散射。" }]);
    emit("assistant.followups.ready", { messageId: id(9), messageContentSha256: "0".repeat(64), followUpPrompts: [] });
    expect(chat.richReply).toBeNull();
  });

  it("回复已经翻篇时，迟到的追问不抢走现在这条气泡", async () => {
    await sendAndSettle([{ type: "text", text: "蓝光更容易被空气分子散射。" }]);
    emit("assistant.followups.ready", { messageId: id(99), messageContentSha256: "0".repeat(64), followUpPrompts: ["属于另一条回复的追问"] });
    expect(chat.richReply).toBeNull();
  });
});

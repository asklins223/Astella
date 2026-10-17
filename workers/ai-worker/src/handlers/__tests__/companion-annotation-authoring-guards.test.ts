import assert from "node:assert/strict";
import test from "node:test";
import { executeCompanionWriteAnnotation } from "../note/companion-annotation-authoring.ts";
import { CompanionToolNotExecutedError } from "../tools/companion-tool-result.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";

/**
 * 批注写入的两条前置闸：没有可写入的原句就不写，主动参与那一轮更不写。
 * 它们都发生在任何事务之前，所以这一份单测不需要库——要钉的正是「一条 SQL 都没下去」。
 */
const NOTE_VERSION = "77777777-7777-4777-8777-777777777777";
const target = { requestId: "88888888-8888-4888-8888-888888888888",
  anchor: { noteVersionId: NOTE_VERSION, startBlockOrdinal: 2, startOffset: 4, endBlockOrdinal: 2, endOffset: 16,
    excerpt: "递归的结束条件", prefix: "", suffix: "" } };

function context(readOver: Record<string, unknown> = {}): AgentEventContext {
  return {
    ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", requestedBy: "22222222-2222-4222-8222-222222222222",
      id: "33333333-3333-4333-8333-333333333333", signal: { aborted: false } },
    read: {
      userId: "22222222-2222-4222-8222-222222222222", runId: "44444444-4444-4444-8444-444444444444",
      conversationId: "55555555-5555-4555-8555-555555555555", generation: 1, accountEpoch: 1,
      userMessageId: "66666666-6666-4666-8666-666666666666", initiativeInput: null,
      pageContext: { context: { pageKind: "note", noteId: "99999999-9999-4999-8999-999999999999", noteVersionId: NOTE_VERSION },
        selection: { text: "递归的结束条件" } },
      ...readOver,
    },
    expiresAt: "2026-10-13T12:00:00.000Z",
  } as unknown as AgentEventContext;
}

const args = { markdown: "结束条件就是不用继续拆的那一步。" };

test("没有绑定原句时不写批注，也不假装交付了", async () => {
  await assert.rejects(() => executeCompanionWriteAnnotation(context({ pageContext: null }), args, undefined, "call-1"),
    (error: unknown) => error instanceof CompanionToolNotExecutedError && /没有绑定可写入的原句/.test(String((error as Error).message)));
});

test("主动参与那一轮即使带着可用的原句也不能往笔记里写", async () => {
  await assert.rejects(() => executeCompanionWriteAnnotation(
    context({ initiativeInput: { topic: "page.arrived", facts: { canSpeak: true } }, pageContext: { context: { pageKind: "note",
      noteId: "99999999-9999-4999-8999-999999999999", noteVersionId: NOTE_VERSION, annotationTarget: target }, selection: { text: "递归的结束条件" } } }),
    args, undefined, "call-2"),
    (error: unknown) => error instanceof CompanionToolNotExecutedError && /没有绑定可写入的原句/.test(String((error as Error).message)));
});

test("这一轮已经停下时，未完成的解释不落笔", async () => {
  await assert.rejects(() => executeCompanionWriteAnnotation(
    context({ pageContext: { context: { pageKind: "note", noteId: "99999999-9999-4999-8999-999999999999",
      noteVersionId: NOTE_VERSION, annotationTarget: target }, selection: { text: "递归的结束条件" } } }),
    args, { aborted: true } as AbortSignal, "call-3"),
    (error: unknown) => error instanceof CompanionToolNotExecutedError && /这一轮已停止/.test(String((error as Error).message)));
});

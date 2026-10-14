import assert from "node:assert/strict";
import test from "node:test";
import { executeCompanionParticipationTool } from "../companion-participation-tools.ts";
import { CompanionToolBlockedError, CompanionToolError, CompanionToolNotExecutedError } from "../companion-tool-result.ts";
import type { AgentEventContext } from "../companion-read-tools.ts";

/**
 * 发言发布之前的这几道闸都在任何写入之前退回，所以要钉的是「她没有把半截东西落库」。
 * 集测（companion-initiative-postgres.integration.ts）盯的是真发布出去的那一条；
 * 这一份盯没发布的那几种形状——它们出错时用户什么都不知道，最容易悄悄写歪。
 */
function context(over: Record<string, unknown> = {}, readOver: Record<string, unknown> = {}): AgentEventContext {
  return {
    ctx: { workspaceId: "11111111-1111-4111-8111-111111111111", requestedBy: "22222222-2222-4222-8222-222222222222", id: "33333333-3333-4333-8333-333333333333", signal: { aborted: false } },
    read: {
      userId: "22222222-2222-4222-8222-222222222222", runId: "44444444-4444-4444-8444-444444444444",
      conversationId: "55555555-5555-4555-8555-555555555555", generation: 1, accountEpoch: 1,
      userMessageId: "66666666-6666-4666-8666-666666666666", initiativeInput: null, pageContext: null, factSpans: null,
      ...readOver,
    },
    expiresAt: "2026-10-13T12:00:00.000Z",
    ...over,
  } as unknown as AgentEventContext;
}

test("内部考虑才有安静结束能力，用户提问那一轮不能拿它代替回答", async () => {
  await assert.rejects(() => executeCompanionParticipationTool(context(), "companion_finish_participation", { decision: "silent" }),
    (error: unknown) => error instanceof CompanionToolBlockedError && /当前用户提问仍需要完整回答/.test(String((error as Error).message)));
  assert.deepEqual(await executeCompanionParticipationTool(
    context({}, { initiativeInput: { topic: "attention.due", facts: { canSpeak: true } } }), "companion_finish_participation", { decision: "silent" }),
    { value: { decision: "silent", completed: true }, safeSummary: "本次考虑已结束。" });
});

test("发言要有真实工具调用身份，没有就不写消息", async () => {
  await assert.rejects(() => executeCompanionParticipationTool(context(), "companion_publish_utterance", { text: "你好。" }),
    (error: unknown) => error instanceof CompanionToolError && /缺少实际身份/.test(String((error as Error).message)));
});

test("人不在这台设备前面时，发言被挡在发布之前", async () => {
  await assert.rejects(() => executeCompanionParticipationTool(
    context({}, { initiativeInput: { topic: "attention.due", facts: { canSpeak: false }, deviceSessionId: "desktop:x:3" } }),
    "companion_publish_utterance", { text: "接着说一句。" }, "call-1"),
    (error: unknown) => error instanceof CompanionToolBlockedError && /不在可参与的前台/.test(String((error as Error).message)));
});

test("要写进笔记的整段内容不会被逐句发成聊天发言", async () => {
  for (const pageContext of [
    { context: { replyPurpose: "note_explanation" } },
    { context: { pageKind: "note" }, selection: { text: "递归的结束条件" } },
  ]) {
    await assert.rejects(() => executeCompanionParticipationTool(
      context({}, { initiativeInput: { topic: "reply.finished", facts: { canSpeak: true } }, pageContext }),
      "companion_publish_utterance", { text: "可以先把它想成……" }, "call-2"),
      (error: unknown) => error instanceof CompanionToolNotExecutedError && /完整解释/.test(String((error as Error).message)));
  }
});

test("执行收尾不会变成一条对白", async () => {
  await assert.rejects(() => executeCompanionParticipationTool(
    context({}, { initiativeInput: { topic: "attention.due", facts: { canSpeak: true } } }),
    "companion_publish_utterance", { text: "（安静结束，本轮不发言。）" }, "call-3"),
    (error: unknown) => error instanceof CompanionToolNotExecutedError && /执行收尾不需要发给用户/.test(String((error as Error).message)));
});

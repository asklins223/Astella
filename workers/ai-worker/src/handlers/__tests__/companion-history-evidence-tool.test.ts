import assert from "node:assert/strict";
import { test } from "node:test";
import { getCompanionAgentTool } from "@astella/shared";
import { executeReadTool } from "../companion-tool-execution.ts";
import type { AgentEventContext } from "../companion-read-tools.ts";

test("读近期历史交付完整原文、序号、来源时间；不把旧记录当成刚才", async () => {
  const text = "前文🫧\r\n".repeat(1800) + "尾部更正：咖啡是十月五号聊的。";
  // This branch must use the frozen read snapshot; the fixture has no DB or tool grants.
  const event = {read:{conversationId:"test-conversation",recentMessages:[
    {seq:"1",role:"user",text,createdAt:"2026-10-05T03:14:00Z"},
    {seq:"2",role:"assistant",text:"嗯",createdAt:null}],
    conversationClock:{observedAt:"2026-10-07T10:00:00Z",timezone:"Asia/Shanghai"}},constraints:{visionEnabled:false}} as unknown as AgentEventContext;
  const result = await executeReadTool(event, getCompanionAgentTool("companion_read_history")!, {limit:10});
  const value = result.value as {messages:Array<{seq:string;role:string;text:string;createdAt:string|null}>;
    truncated:boolean;nextFromSeq:string|null;
    source:{kind:string;observedAt:string;timestampMeaning:string}};
  assert.equal(value.messages[0]?.text,text);
  assert.equal(value.messages[0]?.seq,"1");
  assert.equal(value.messages[0]?.createdAt,"2026-10-05T03:14:00.000Z");
  assert.equal(value.source.kind,"current_conversation_tail");
  assert.equal(value.source.observedAt,"2026-10-07T10:00:00Z");
  assert.equal(value.source.timestampMeaning,"message_creation_not_narrated_event");
  // 这一条给的第一条消息正文 12,600 字，已经超开一页（`PAST_MESSAGES_PAGE_TARGET_CHARS`＝同一份
  // 声明层常量）。规则与取回原文那一支一致：**整条给，绝不切半条**，装不下的下一条
  // 不悄悄丢掉，而是如实说「还有」并把它的序号交回来续读。
  assert.equal(value.messages.length,1,"一页装不下的消息不硬塞，交给 nextFromSeq");
  assert.equal(value.messages[1],undefined,"下一条整条留给下一页，不给半条");
  assert.equal(value.truncated,true);
  assert.equal(value.nextFromSeq,"2");
});

test("一页装得下时如实说没有下一页，不多要一次续读", async () => {
  const event = {read:{conversationId:"test-conversation",recentMessages:[
    {seq:"7",role:"user",text:"这条短",createdAt:"2026-10-07T09:00:00Z"},
    {seq:"8",role:"assistant",text:"也短",createdAt:null}],
    conversationClock:{observedAt:"2026-10-07T10:00:00Z",timezone:"Asia/Shanghai"}},constraints:{visionEnabled:false}} as unknown as AgentEventContext;
  const value = (await executeReadTool(event, getCompanionAgentTool("companion_read_history")!, {limit:10}))
    .value as {messages:Array<{createdAt:string|null}>;truncated:boolean;nextFromSeq:string|null};
  assert.equal(value.messages.length,2);
  assert.equal(value.messages[1]?.createdAt,null,"没有创建时刻就如实给 null，不补成空串");
  assert.equal(value.truncated,false);
  assert.equal(value.nextFromSeq,null);
});

test("用户明确拒绝资料读取时，执行层阻止模型直接调用笔记搜索", async () => {
  const event = { read: { userId: "test-user" }, constraints: { noteLibraryReadEnabled: false } } as unknown as AgentEventContext;
  await assert.rejects(
    executeReadTool(event, getCompanionAgentTool("companion_search_notes")!, { query: "欧姆定律" }),
    /要求不读取笔记库/,
  );
});

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
    source:{kind:string;observedAt:string;timestampMeaning:string}};
  assert.equal(value.messages[0]?.text,text);
  assert.equal(value.messages[0]?.seq,"1");
  assert.equal(value.messages[0]?.createdAt,"2026-10-05T03:14:00.000Z");
  assert.equal(value.messages[1]?.createdAt,null);
  assert.equal(value.source.kind,"current_conversation_tail");
  assert.equal(value.source.observedAt,"2026-10-07T10:00:00Z");
  assert.equal(value.source.timestampMeaning,"message_creation_not_narrated_event");
});

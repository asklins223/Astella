import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompanionPersonaMessages, validateCompanionOutput } from "../companion-dialogue-content.ts";
import { conversationInstant, renderCompanionConversationEvidence } from "../companion-conversation-evidence.ts";

const clock = { observedAt: "2026-10-07T16:01:00Z", timezone: "Asia/Shanghai", currentMessageCreatedAt: "2026-10-07T16:00:59Z" };
function payload(text: string | null) {
  assert.ok(text);
  return JSON.parse(text.split("\n")[2]!) as {
    observedAt: string | null; timezone: string | null;
    history: Array<{ position: number; speaker: string; utteredAt: string | null; elapsedMs: number | null; localDateTime: string | null; replyState: string | null; gapFromPreviousMs: number | null; gapFromPrevious: string | null }>;
    current: { utteredAt: string | null; elapsedMs: number | null; gapFromPreviousMs: number | null; gapFromPrevious: string | null };
  };
}

test("跨本地午夜仍按绝对时间计算间隔，原文和角色保持完整", () => {
  const text = "刚写完，明天交。\r\n" + "🫧我没说已经交了。".repeat(1800);
  const history = [{ role: "user" as const, text, createdAt: "2026-10-07T23:59:30+08:00" },
    { role: "assistant" as const, text: "已经交了呀。", createdAt: "2026-10-07T15:59:45Z" }];
  const messages = buildCompanionPersonaMessages({ userText: "还没交呢", recentMessages: history, pageContext: null, conversationClock: clock });
  assert.equal(messages[1]?.content, text);
  assert.equal(messages[2]?.content, history[1]!.text);
  assert.equal(messages.at(-1)?.content, "还没交呢");
  const system = String(messages[0]!.content);
  const timeline = payload(system.slice(system.indexOf("<conversation_timeline>")));
  assert.equal(timeline.history[0]?.elapsedMs, 90_000);
  assert.equal(timeline.history[1]?.speaker, "assistant");
  assert.equal(timeline.current.elapsedMs, 1_000);
  assert.equal(timeline.timezone, "Asia/Shanghai");
});

test("缺时间、无时区时间、无效日期、未来消息都不能伪造已流逝时长", () => {
  for (const invalid of [null, "昨天", "2026-10-07 18:00", "2026-02-30T12:00:00Z", "2026-10-07T24:00:00Z"])
    assert.equal(conversationInstant(invalid), null);
  const data = payload(renderCompanionConversationEvidence([
    { role: "user", text: "三天前我完成的。" },
    { role: "assistant", text: "嗯", createdAt: "2026-10-07T16:02:00Z" },
  ], { ...clock, timezone: "invalid-zone" }));
  assert.equal(data.timezone, null);
  assert.equal(data.history[0]?.utteredAt, null);
  assert.equal(data.history[1]?.elapsedMs, null);
  assert.equal(data.history[1]?.utteredAt, "2026-10-07T16:02:00.000Z");
  assert.equal(renderCompanionConversationEvidence([{ role: "user", text: "昨天下午做的。" }]), null);
});

test("消息序号决定回放位置；隔几天的记录不被压成连续的一天", () => {
  const history = Array.from({ length: 22 }, (_, index) => ({
    seq: String(index + 1), role: "user" as const, text: `记录${index + 1}`,
    createdAt: index < 21 ? "2026-10-03T04:00:00Z" : "2026-10-07T16:00:00Z",
  }));
  const messages = buildCompanionPersonaMessages({ userText: "你今天有什么有意思的事？", recentMessages: history, pageContext: null, conversationClock: clock });
  const system = String(messages[0]!.content);
  const data = payload(system.slice(system.indexOf("<conversation_timeline>")));
  assert.equal(data.history.length, 20);
  assert.equal(messages[1]?.content, "记录3");
  assert.equal(data.history.at(-1)?.position, 20);
  assert.equal(data.history.at(-1)?.elapsedMs, 60_000);
  assert.ok(data.history[0]!.elapsedMs! > 3 * 86_400_000);
});

test("时间数据块不能成为可见回复；角色对时间的普通说法仍可显示", () => {
  assert.equal(validateCompanionOutput(renderCompanionConversationEvidence([], clock)!).ok, false);
  assert.equal(validateCompanionOutput("就刚才聊的那份报告，我还记得你嫌它废话多。").ok, true);
});

test("同一话题连发的补充保留原文、秒级间隔和被接替状态，规则不只回应最后一句", () => {
  const history = [
    { role: "user" as const, text: "讲讲欧姆定律", createdAt: "2026-10-07T16:00:51Z", replyStatus: "superseded" },
    { role: "user" as const, text: "举个 12 伏电源的例子", createdAt: "2026-10-07T16:00:55Z", replyStatus: "superseded" },
  ];
  const messages = buildCompanionPersonaMessages({ userText: "电阻是 4 欧姆", recentMessages: history, pageContext: null, conversationClock: clock });
  assert.equal(messages[1]?.content, "讲讲欧姆定律");
  assert.equal(messages[2]?.content, "举个 12 伏电源的例子");
  assert.equal(messages[3]?.content, "电阻是 4 欧姆");
  const system = String(messages[0]?.content);
  assert.match(system, /将几句一起理解并正常回应/);
  assert.doesNotMatch(system, /本轮只回应最后一条/);
  const data = payload(system.slice(system.indexOf("<conversation_timeline>")));
  assert.equal(data.history[1]?.gapFromPreviousMs, 4000);
  assert.equal(data.history[1]?.replyState, "回复被后续消息接替");
  assert.equal(data.current.gapFromPreviousMs, 4000);
  assert.equal(data.current.gapFromPrevious, "4 秒");
});

test("隔夜失败消息标明本地日期和真实间隔，而不是假装刚刚发来", () => {
  const data = payload(renderCompanionConversationEvidence([
    { role: "user", text: "哈哈哈", createdAt: "2026-10-08T06:07:00Z", replyStatus: "failed" },
  ], { observedAt: "2026-10-08T23:23:01Z", timezone: "Asia/Shanghai", currentMessageCreatedAt: "2026-10-08T23:23:00Z" }));
  assert.equal(data.history[0]?.localDateTime, "2026-10-08 14:07:00");
  assert.equal(data.history[0]?.replyState, "回复未完成");
  assert.equal(data.current.gapFromPrevious, "17 小时 16 分钟");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { companionVoiceSegmentsFromEventPayloads } from "../modules/companion-conversation/turn/companion-events.ts";

const payload = (over: Record<string, unknown> = {}) => ({
  version: 2, segmentId: "a".repeat(64), ordinal: 1, displayText: "刚讲完饭锅的故事",
  displayStart: 0, displayEnd: 8, cue: { emotion: "neutral" }, ...over,
});

/**
 * 2026-10-16：本机没留下录音时的补听入口要靠这一份重建合成请求。
 * 分段权威在服务端，所以这一层只做"取回 + 校正顺序 + 剔残帧"，不重新切段。
 */
test("补听清单按 ordinal 排序，不按事件到达顺序", () => {
  const items = companionVoiceSegmentsFromEventPayloads([
    payload({ ordinal: 3, segmentId: "c".repeat(64), displayStart: 18, displayEnd: 30 }),
    payload({ ordinal: 1, segmentId: "a".repeat(64) }),
    payload({ ordinal: 2, segmentId: "b".repeat(64), displayStart: 9, displayEnd: 17 }),
  ]);
  assert.deepEqual(items.map(item => item.ordinal), [1, 2, 3],
    "补听要按当时念的顺序，事件 seq 顺序在这条路上不可靠");
});

/** 残帧不入库：缺了区间，客户端就只能猜"这段对应正文的哪里"。 */
test("缺任一字段的事件直接丢掉，不产出半条", () => {
  const items = companionVoiceSegmentsFromEventPayloads([
    payload({ ordinal: 1, displayStart: undefined }),
    payload({ ordinal: 2, displayText: "" }),
    payload({ ordinal: 3, segmentId: undefined }),
    null, "not-an-object", 42,
    payload({ ordinal: 4 }),
  ]);
  assert.deepEqual(items.map(item => item.ordinal), [4], "只有完整的那一条该留下");
});

/** 补听也要认出消息边界；旧留档没有这条身份时不要凭空补一个。 */
test("messageId 随留档一起回来，旧留档没有时省略", () => {
  const messageId = "11111111-1111-4111-8111-111111111111";
  const items = companionVoiceSegmentsFromEventPayloads([
    payload({ ordinal: 1, messageId }),
    payload({ ordinal: 2, segmentId: "b".repeat(64), displayStart: 9, displayEnd: 17 }),
  ]);
  assert.equal(items[0]?.messageId, messageId);
  assert.equal("messageId" in (items[1] ?? {}), false);
});

test("整轮都没有可播段时返回空数组，由调用方如实说没有留档", () => {
  assert.deepEqual(companionVoiceSegmentsFromEventPayloads([]), []);
});

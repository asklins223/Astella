import assert from "node:assert/strict";
import { test } from "node:test";
import { createCompanionMessageDelivery, requestedIndependentMessageCount } from "../handlers/turn/companion-message-delivery.ts";

test("an explicitly stated number of messages becomes the delivery contract", () => {
  for (const [text, expected] of [
    ["分两条跟我说：第一条打个招呼，第二条问我今天先做哪件事。", 2],
    ["分 3 条消息发给我。", 3],
    ["用两条独立消息回答。", 2],
    ["拆成四则回复。", 4],
  ] as const) assert.equal(requestedIndependentMessageCount(text), expected, text);
  // No explicit count means the model decides; the host counts nothing.
  for (const text of ["你好呀。", "帮我看看这篇笔记。", "分成两部分解释一下。", "说一句话就够了。"])
    assert.equal(requestedIndependentMessageCount(text), null, text);
});

test("the delivery contract reports what is still missing until it is met", () => {
  const delivery = createCompanionMessageDelivery(requestedIndependentMessageCount("分两条跟我说。"));
  assert.equal(delivery.incomplete(), true);
  delivery.record("first");
  assert.equal(delivery.incomplete(), true);
  assert.match(delivery.guidance(), /仍须/);
  delivery.record("second");
  assert.equal(delivery.incomplete(), false);
  assert.equal(delivery.full(), true);
});

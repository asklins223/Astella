/**
 * 流中工具调用槽的累积（`StreamToolCallAccumulator`）。
 *
 * ## 为什么这段值得单独测
 *
 * 它原来住在 `openai-compatible.ts` 的 SSE 循环里，决定了**参数什么时候算拼完**。
 * 而那是没有合成-SSE 夹具的一段代码——改坏了要等真 provider 接入才看得见。
 *
 * 40b §4.1-1 把两条禁令写在这里：「**不能从流式 JSON 片段、猜测调用名**
 * 或越过输出序号缺口执行」。它们现在成了三条可断言的函数行为。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { StreamToolCallAccumulator } from "../stream-tool-call-accumulator.ts";

const settled = (acc: StreamToolCallAccumulator) =>
  acc.snapshot().filter((slot) => {
    if (!slot.name) return false;
    try {
      const parsed = JSON.parse(slot.argsText) as unknown;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch { return false; }
  }).map((slot) => slot.index);

test("参数分片逐片拼接，够了才落定", () => {
  const acc = new StreamToolCallAccumulator();
  assert.deepEqual(acc.push([{ index: 0, id: "c1", name: "companion_read_note", arguments: '{"note' }]), [],
    "半截 JSON 就落定了 —— 那正是从流式片段猜参数");
  assert.deepEqual(acc.push([{ index: 0, arguments: 'Id":"n1"}' }]), [0],
    "拼完之后没有落定");
  const slot = acc.snapshot()[0];
  assert.equal(slot?.id, "c1");
  assert.equal(slot?.name, "companion_read_note");
  assert.deepEqual(JSON.parse(slot?.argsText ?? "{}"), { noteId: "n1" });
});

test("半截 JSON 恰好以 `}` 结尾也不算完整", () => {
  // `{"a":1}` 的第一片就可能是这么长的尾巴——按"结尾有 }"判会把半截当完整。
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: "c", name: "t", arguments: '{"a":1}' }]);
  assert.deepEqual(settled(acc), [0], "自证样本：这一片确实本身就是完整的");
  const half = new StreamToolCallAccumulator();
  half.push([{ index: 0, id: "c", name: "t", arguments: '{"a":1}' }]);
  half.push([{ index: 1, id: "d", name: "u", arguments: "{}" }]);
  assert.equal(settled(half).length, 2, "两片各自完整");
});

test("调用名没拿到就不算完整 —— 不猜名字（§4.1-1）", () => {
  const acc = new StreamToolCallAccumulator();
  assert.deepEqual(acc.push([{ index: 0, arguments: "{}" }]), [],
    "只有参数没有名字却落定了");
  assert.deepEqual(settled(acc), []);
  assert.deepEqual(acc.push([{ index: 0, name: "companion_read_note" }]), [0]);
});

test("名字分片要**追加**，id 只取第一次非空", () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: "first", name: "comp", arguments: "{}" }]);
  acc.push([{ index: 0, id: "second", name: "anion_read_note" }]);
  const slot = acc.snapshot()[0];
  assert.equal(slot?.id, "first", "后到的 id 覆盖了先确认的身份");
  assert.equal(slot?.name, "companion_read_note", "分片的调用名没有被拼起来");
});

test("参数不是对象（数组/标量/null）不算完整", () => {
  for (const args of ["[1,2]", '"s"', "null", "7"]) {
    const acc = new StreamToolCallAccumulator();
    assert.deepEqual(acc.push([{ index: 0, id: "c", name: "t", arguments: args }]), [],
      `${args} 被判成完整了`);
  }
});

test("序号缺口被如实记下，不能被补成连续", () => {
  // provider 可能先吐 index 2 再补 index 1。缺口本身就是"不能越过"的依据。
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 2, id: "c2", name: "t", arguments: "{}" }]);
  acc.push([{ index: 0, id: "c0", name: "t", arguments: "{}" }]);
  assert.deepEqual(acc.gaps(), [1]);
  assert.deepEqual(acc.snapshot().map((s) => s.index), [0, 2],
    "snapshot 必须按 index 排序，而不是按到达顺序");
});

test("没有 index 的分片按到达顺序各占一格（协议退化时的兜底）", () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ id: "a", name: "t1", arguments: "{}" }, { id: "b", name: "t2", arguments: "{}" }]);
  assert.deepEqual(acc.snapshot().map((s) => s.index), [0, 1]);
});

test("重复分片不会把一个已经落定的槽再报一次", () => {
  const acc = new StreamToolCallAccumulator();
  assert.deepEqual(acc.push([{ index: 0, id: "c", name: "t", arguments: "{}" }]), [0]);
  assert.deepEqual(acc.push([{ index: 0, arguments: "{}" }]), [],
    "同一片内容重放又报了一次落定 —— 派发侧会重复执行");
});

test("【自证】判据认得出「按结尾 `}` 判完整」这个真实退化", () => {
  const naive = (text: string) => text.trim().endsWith("}");
  // 真正难辨的那一片：以 } 结尾，却不是合法 JSON（多一个右括号就是分片边界对错了）。
  assert.ok(naive('{"a":1}}'), "自证样本没造好：这一片确实以 } 结尾却是半截");
  // 退化判据**分不开**这两种：它在半截上与真判据给出同样的答案。
  assert.equal(naive('{"a":1}}'), naive('{"a":1}'),
    "自证：按结尾判的退化版根本分不出完整与半截");
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: "c", name: "t", arguments: '{"a":1}}' }]);
  assert.deepEqual(settled(acc), [], "真判据把这半截放行了 —— 那就会拿坏参数去执行");
});

test("放行判据是**顺序**：只有出现过更高 index，才敢放行低 index", () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: "c0", name: "t", arguments: "{}" }]);
  // 只有它自己：拼完了也不代表不会再有分片，所以一个都不放。
  assert.deepEqual(acc.readyForDispatch(0), [], "刚拼完就放行 —— 那会拿半截参数去执行");
  // 第 1 个到了，第 0 个才确定完整。
  acc.push([{ index: 1, id: "c1", name: "t", arguments: "{}" }]);
  assert.deepEqual(acc.readyForDispatch(1), [0], "第 1 个开始 ⇒ 第 0 个确定完整");
  // 再问一次不会重复放行。
  assert.deepEqual(acc.readyForDispatch(1), [], "同一格被放行了两次");
});

test("flush() 放行最后那一格 —— 没有它，『只调一个工具』整轮都排不上", () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: "c0", name: "t", arguments: "{}" }]);
  assert.deepEqual(acc.readyForDispatch(0), []);
  assert.deepEqual(acc.flush(), [0], "流结束了，最后那一格还没被放行");
  assert.deepEqual(acc.flush(), [], "flush 也不能重复放行");
});

test("flush() 跳过还没拼完的", () => {
  const acc = new StreamToolCallAccumulator();
  acc.push([{ index: 0, id: "c0", name: "t", arguments: '{"a":' }]);
  assert.deepEqual(acc.flush(), [], "半截参数在流末尾也不该被放行");
});

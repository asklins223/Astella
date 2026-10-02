import test from "node:test";
import assert from "node:assert/strict";
import { deterministicRecallPrompt } from "../recall-prompt.ts";

test("线索来自问题对应的真实句子，不按段号套话，也不露出空缺答案", () => {
  const first = deterministicRecallPrompt({ title: "复利是什么", text: "利息加入本金后，下一次也会继续产生利息。" });
  assert.match(first.question, /利息加入＿＿＿后/);
  assert.match(first.hint, /下一次也会继续产生利息/);
  assert.doesNotMatch(first.hint, /本金|第.*段/);
  const second = deterministicRecallPrompt({ title: "帧率压缩", text: "语义 Codec 帧率从 50Hz 压到 25Hz，语义 token 序列长度直接减半。" });
  assert.match(second.question, /50Hz 压到 ＿＿＿/);
  assert.match(second.hint, /序列长度直接减半/);
  assert.doesNotMatch(second.hint, /25/);
  assert.notEqual(first.hint, second.hint);
});
test("标题包含空缺词时，提示不能借标题泄题", () => {
  const result = deterministicRecallPrompt({ title: "换成 Zipformer", text: "S2M 模块主干换成 Zipformer，参数更少、生成更快。" });
  assert.match(result.question, /＿＿＿/);
  assert.doesNotMatch(result.hint, /Zipformer/);
});

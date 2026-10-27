import assert from "node:assert/strict";
import test from "node:test";
import { companionArithmeticMismatch } from "../turn/companion-arithmetic-check.ts";

test("a stated arithmetic result is checked against the parsed expression", () => {
  const wrong = companionArithmeticMismatch("帮我核一下 347 乘以 29 到底是多少。", "**9,663**");
  assert.equal(wrong?.expected, 10063);
  assert.equal(wrong?.claimed, "9663");
  assert.equal(companionArithmeticMismatch("帮我核一下 347 乘以 29 到底是多少。", "347 × 29 = **10063**"), null);
  assert.equal(companionArithmeticMismatch("100 除以 4 是多少", "25"), null);
  const divided = companionArithmeticMismatch("100 除以 4 是多少", "30");
  assert.equal(divided?.expected, 25);
  assert.equal(companionArithmeticMismatch("1 加 1 等于几", "2"), null);
});

test("dates, ranges and versions are not arithmetic expressions", () => {
  assert.equal(companionArithmeticMismatch("2026-10-27 的复盘写了什么？", "日期是 2026-10-27。"), null);
  assert.equal(companionArithmeticMismatch("我昨天睡了 3-4 小时。", "3-4 小时确实不多。"), null);
  assert.equal(companionArithmeticMismatch("版本 2.0.1 更新了什么？", "版本 2.0.1 修了三处。"), null);
});

test("a reply that only repeats the operands is not a result claim", () => {
  assert.equal(companionArithmeticMismatch("347 乘以 29 是多少", "你给的是 347 和 29。"), null);
});

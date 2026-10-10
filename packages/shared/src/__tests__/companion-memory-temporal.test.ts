import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCompanionMemoryTemporalMetadata } from "../companion-memory-temporal.ts";

test("memory temporal metadata keeps only values grounded in the user's source", () => {
  const sourceText = "复习数据库索引时先看例子，并在 2026-10-15T17:00:00+08:00 前完成。";
  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "goal",
    content: "复习数据库索引",
    sourceQuote: sourceText,
    appliesWhen: "复习数据库索引时",
    validUntil: "2026-10-15T17:00:00+08:00",
    sourceText,
  }), {
    ok: true,
    appliesWhen: "复习数据库索引时",
    validUntil: "2026-10-15T17:00:00+08:00",
  });

  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "goal",
    content: "复习数据库索引",
    sourceQuote: sourceText,
    validUntil: "2026-10-16T17:00:00+08:00",
    sourceText,
  }), { ok: false, reason: "unverifiable_valid_until" });
});

test("unbounded short-window goals are rejected; episodic events remain historical", () => {
  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "goal",
    content: "下周完成数据库索引复习",
    sourceText: "下周完成数据库索引复习",
  }), { ok: false, reason: "missing_finite_validity" });

  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "episodic",
    content: "今天一起复习了数据库索引",
    sourceText: "今天一起复习了数据库索引",
  }), { ok: true, appliesWhen: null, validUntil: null });
});

test("正文里顺手提到的今天/这次不算短窗口：时间说法只认用户原话", () => {
  // 真实形状（2026-10-10 dev 栈）：用户那句没有期限含义，正文里的「今天」是行为描述。
  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "preference",
    content: "打招呼时就只回应招呼：不盘点笔记、不回顾之前的对话、不追问对方今天的安排。",
    sourceQuote: "以后打招呼别盘点笔记",
    appliesWhen: "以后打招呼",
    sourceText: "以后打招呼别盘点笔记",
  }), { ok: true, appliesWhen: "以后打招呼", validUntil: null });

  // 守卫仍然在：用户原话里带了今天/这次，就得给出期限。
  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "goal",
    content: "今天先把索引复习完",
    sourceQuote: "今天先把索引复习完",
    sourceText: "今天先把索引复习完",
  }), { ok: false, reason: "missing_finite_validity" });
});

test("source quotes and applicability conditions are exact user-authored substrings", () => {
  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "preference",
    content: "解释机制时先举例",
    sourceQuote: "我喜欢解释机制时先举例",
    appliesWhen: "累的时候",
    sourceText: "我喜欢解释机制时先举例",
  }), { ok: false, reason: "unverifiable_applies_when" });

  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "goal",
    content: "下周完成复习",
    sourceQuote: "下周完成复习",
    sourceText: "我想尽快完成复习",
  }), { ok: false, reason: "unverified_source_quote" });

  assert.deepEqual(resolveCompanionMemoryTemporalMetadata({
    kind: "goal",
    content: "复习完索引",
    validUntil: "2026-10-15T17:00:00+08:00",
    sourceText: "复习完索引，并在 2026-10-15T17:00:00+08:00 前完成",
  }), { ok: false, reason: "missing_source_quote" });
});

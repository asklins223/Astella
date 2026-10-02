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

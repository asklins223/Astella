import { test } from "node:test";
import assert from "node:assert/strict";
import { accountPreferenceWriteDecision, memoryScopeForKind } from "../companion/companion-memory-scope.ts";

test("automatic scope follows explicit binding and kind, with local defaults", () => {
  assert.equal(memoryScopeForKind("preference", "workspace", "portable"), "global");
  for (const binding of [undefined, "local", "uncertain", ""]) {
    assert.equal(memoryScopeForKind("preference", "global", binding), "workspace");
  }
  for (const kind of ["goal", "learning_context", "interaction_note", "episodic"]) {
    assert.equal(memoryScopeForKind(kind, "global", "portable"), "workspace");
    assert.equal(memoryScopeForKind(kind, "task", "local"), "task");
  }
});

test("an explicitly selected account preference is not vetoed by subject or time words", () => {
  for (const content of [
    "无论在哪个书房，我都喜欢用物理类比理解抽象概念。",
    "写日记时不要盘点今天学了多少。",
    "When learning statistics, start with a counterexample.",
    "这门课、那个项目只是举例，不改变我的长期沟通偏好。",
  ]) {
    assert.deepEqual(accountPreferenceWriteDecision({ scope: "global", kind: "preference", content,
      appliesWhen: "讲这篇笔记时" }), { ok: true });
  }
});

test("scope does not turn a non-preference into an account-wide record", () => {
  for (const kind of ["goal", "learning_context", "interaction_note", "episodic", "judgment"]) {
    assert.deepEqual(accountPreferenceWriteDecision({ scope: "global", kind, content: "arbitrary text" }),
      { ok: false, reason: "kind_not_preference" });
    for (const scope of ["workspace", "task", null, undefined])
      assert.deepEqual(accountPreferenceWriteDecision({ scope, kind, content: "arbitrary text" }), { ok: true });
  }
});

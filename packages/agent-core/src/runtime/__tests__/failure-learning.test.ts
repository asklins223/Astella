import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyAgentRunFailure, planAgentMethodProposal } from "../failure-learning.ts";

/**
 * 方案 44 §6.2：失败运行也能贡献可核对经验，但**不能凭一次失败把能力永久判死**。
 *
 * 判据的核心是「这一条该不该成为规则」。混成一条规则会把一次网络抖动钉成
 * 「这招不行」，而那是错的——不是「不值得记」，是「记下来就是错的」。
 */

const op = (over: Partial<{ status: "succeeded" | "failed" | "outcome_unknown" | "cancelled"; capability: string; error: string | null }> = {}) => ({
  status: "failed" as const, capability: "note_expansion", error: null, ...over,
});

test("44 §6.2：临时供应商故障不成规则，也不判能力死刑", () => {
  for (const error of ["HTTP 503 Service Unavailable", "request timeout after 30s", "429 rate limit exceeded", "socket hang up"]) {
    const result = classifyAgentRunFailure({ runStatus: "failed", operations: [op({ error })] });
    assert.equal(result.failureClass, "transient_provider", error);
    assert.equal(result.contributesRule, false, `${error} 不该变成一条做法`);
    assert.match(result.note, /不要因此停用相关能力/);
  }
});

test("44 §6.2：outcome_unknown 既不是成功也不是失败，规则只能说「先核对」", () => {
  const result = classifyAgentRunFailure({
    runStatus: "failed",
    operations: [op({ status: "outcome_unknown", capability: "card_generation_generate" })],
  });
  assert.equal(result.failureClass, "outcome_unknown");
  assert.equal(result.contributesRule, true);
  assert.match(result.note, /结果待核对/);
  assert.match(result.note, /不要直接说成完成或没做/);
  // 待核对不足以把这条路判成「不行」。
  assert.equal(result.epistemicStatus, "tentative");
});

test("44 §6.2：确定不适用会留下带适用条件的做法，并引用那一条具体错误", () => {
  const result = classifyAgentRunFailure({
    runStatus: "failed",
    operations: [
      op({ capability: "note_read", error: "HTTP 503" }),
      op({ capability: "note_expansion", error: "材料里没有可展开的公式定义" }),
    ],
  });
  assert.equal(result.failureClass, "not_applicable");
  assert.equal(result.contributesRule, true);
  assert.equal(result.citedOperation?.capability, "note_expansion");
  assert.match(result.note, /记下适用条件/);
  // 有具体错误是可核对的事实，但仍不是「能力不行」。
  assert.match(result.note, /不是「这项能力不行」/);
  assert.equal(result.epistemicStatus, "supported");
});

test("44 §6.2：混合时以「非临时」那条为准，不因为有抖动就整条丢掉", () => {
  const result = classifyAgentRunFailure({
    runStatus: "failed",
    operations: [op({ error: "429 rate limit" }), op({ capability: "card_check", error: "题面与解析不一致" })],
  });
  assert.equal(result.failureClass, "not_applicable");
  assert.equal(result.citedOperation?.capability, "card_check");
});

test("44 §6.2：用户取消不是失败，不产生任何规则", () => {
  for (const runStatus of ["cancelled", "failed"] as const) {
    const result = classifyAgentRunFailure({
      runStatus,
      operations: [op({ status: "cancelled" })],
    });
    assert.equal(result.failureClass, "cancelled");
    assert.equal(result.contributesRule, false);
    assert.match(result.note, /不是一次失败/);
  }
});

test("44 §6.2：没有走到确定交付时不硬凑一条做法", () => {
  const result = classifyAgentRunFailure({ runStatus: "failed", operations: [] });
  assert.equal(result.failureClass, "incomplete");
  assert.equal(result.contributesRule, false);
});

test("44 §6.2：临时故障与确定不适用必须能分开表达", () => {
  const transient = classifyAgentRunFailure({ runStatus: "failed", operations: [op({ error: "timeout" })] });
  const real = classifyAgentRunFailure({ runStatus: "failed", operations: [op({ error: "definitely wrong source" })] });
  assert.notEqual(transient.failureClass, real.failureClass);
  assert.notEqual(transient.contributesRule, real.contributesRule);
});

// ─── 整理一次「从这次合作留下做法」的判定 ─────────────────────────────────

test("44 §6.2：失败运行不再被一律拒掉——但也不是照单全收", () => {
  const completed = planAgentMethodProposal({
    runStatus: "completed", operations: [op({ status: "succeeded" })], succeededCapabilities: ["card_generate"],
  });
  assert.equal(completed.allowed, true);
  assert.equal(completed.mode, "success");

  const failedHard = planAgentMethodProposal({
    runStatus: "failed",
    operations: [op({ capability: "note_expansion", error: "材料里没有可展开的公式定义" })],
    succeededCapabilities: [],
  });
  assert.equal(failedHard.allowed, true, "确定不适用恰恰是最该被记住的那部分");
  assert.equal(failedHard.mode, "failure_candidate");
  assert.equal(failedHard.epistemicStatus, "supported");
  assert.match(failedHard.failureNote ?? "", /适用条件/);

  const transient = planAgentMethodProposal({
    runStatus: "failed",
    operations: [op({ error: "HTTP 503" })],
    succeededCapabilities: [],
  });
  assert.equal(transient.allowed, false, "临时故障写下来就是错的");
  assert.match(transient.reason, /不要因此停用相关能力/);
});

test("44 §6.2：用户取消不产生任何做法", () => {
  const cancelled = planAgentMethodProposal({
    runStatus: "cancelled", operations: [op({ status: "cancelled" })], succeededCapabilities: [],
  });
  assert.equal(cancelled.allowed, false);
  assert.match(cancelled.reason, /不是一次失败/);
});

test("44 §6.2：完成但没有成功步骤时不硬凑", () => {
  const empty = planAgentMethodProposal({ runStatus: "completed", operations: [], succeededCapabilities: [] });
  assert.equal(empty.allowed, false);
  assert.match(empty.reason, /没有可核对的执行步骤/);
});

test("44 §6.2：部分失败仍走成功形态，失败只作为附加的适用条件", () => {
  const partial = planAgentMethodProposal({
    runStatus: "failed",
    operations: [op({ status: "succeeded", capability: "note_read" }), op({ capability: "card_check", error: "题面与解析不一致" })],
    succeededCapabilities: ["note_read"],
  });
  assert.equal(partial.allowed, true);
  assert.equal(partial.mode, "success");
  assert.equal(partial.epistemicStatus, "supported");
  assert.match(partial.failureNote ?? "", /card_check/);
});

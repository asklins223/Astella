import assert from "node:assert/strict";
import { test } from "node:test";
import { companionSteerCause, judgeCompanionDeliveryGate, type CompanionDeliveryGate } from "../companion-delivery-gates.ts";

const GATES: CompanionDeliveryGate[] = ["output_truncated", "unverified_quote", "action_not_executed"];

/**
 * 2026-10-16 生产两起：run `fb2da98f` 三篇笔记全部 succeeded 仍被 `ACTION_NOT_EXECUTED`
 * 判死整轮；run `df40b8a9` 只回一个 `[neutral]` 被判 `INTERNAL_ERROR`。
 * 判据两次都没算错，错的是后果。这里钉的就是后果的形状。
 */
test("本轮有已落库的写回执时，三道交付闸都不许作废整轮", () => {
  for (const gate of GATES) {
    assert.equal(judgeCompanionDeliveryGate({ gate, landedWrites: true }).destroysTurn, false,
      `${gate} 在已有成果时仍然销毁整轮：一次判错吃掉了全部已做成的事`);
  }
});

/** 反向控制：放宽的是误判的代价，不是谎报。什么都没落时判据照旧生效。 */
test("本轮一个写都没落下时，三道闸照旧作废整轮", () => {
  for (const gate of GATES) {
    assert.equal(judgeCompanionDeliveryGate({ gate, landedWrites: false }).destroysTurn, true,
      `${gate} 不再销毁了：她可以说一件根本没做过的事`);
  }
});

test("绕过销毁时错误码与留痕都按闸各自说清，不共用一个", () => {
  assert.deepEqual(GATES.map(gate => judgeCompanionDeliveryGate({ gate, landedWrites: true }).stepErrorCode),
    ["AGENT_BUDGET_EXCEEDED", "UNVERIFIED_QUOTE", "ACTION_NOT_EXECUTED"]);
  const notes = GATES.map(gate => judgeCompanionDeliveryGate({ gate, landedWrites: true }).bypassNote);
  assert.ok(notes.every(note => note.length > 0), "静默放行会让「她这次有没有被闸过」无法复盘");
  assert.equal(new Set(notes).size, GATES.length, "三道闸的起因必须分得开");
});

/**
 * `by` 是 steer 起因的唯一区分口径（39b §9.6）。正文那句曾经写死成
 * "answered an action request"，于是编数字和空承诺都被读成"动作请求"。
 */
test("companionSteerCause：五类起因分得开，不再一律读成动作请求", () => {
  const base = { unverifiedClaims: [], unverifiedQuotes: [], lookupClaim: false,
    nothingDueClaim: false, userAskedForAction: false };
  assert.equal(companionSteerCause({ ...base, correctQuote: "原文里的那一句" }), "unverified-quotes");
  assert.equal(companionSteerCause({ ...base, unverifiedClaims: ["42"] }), "unverified-numbers");
  assert.equal(companionSteerCause({ ...base, unverifiedQuotes: ["“引用”"] }), "unverified-quotes");
  assert.equal(companionSteerCause({ ...base, lookupClaim: true }), "claimed-lookup");
  assert.equal(companionSteerCause({ ...base, lookupClaim: true, nothingDueClaim: true }), "claimed-nothing-due");
  assert.equal(companionSteerCause({ ...base, userAskedForAction: true }), "action-request");
  assert.equal(companionSteerCause(base), "promise-shape");
});

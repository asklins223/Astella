import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  COMPANION_STREAM_TRANSPORT_FAILURE,
  companionSteerCause,
  companionStreamFallbackText,
  judgeCompanionDeliveryGate,
  type CompanionDeliveryGate,
} from "../companion-delivery-gates.ts";

const GATES: CompanionDeliveryGate[] = ["output_truncated", "unverified_quote", "action_not_executed",
  "stream_validation", "stream_reconcile"];

/**
 * 2026-10-16 生产两起：run `fb2da98f` 三篇笔记全部 succeeded 仍被 `ACTION_NOT_EXECUTED`
 * 判死整轮；run `df40b8a9` 只回一个 `[neutral]` 被判 `INTERNAL_ERROR`。
 * 判据两次都没算错，错的是后果。这里钉的就是后果的形状。
 */
test("本轮有已落库的写回执时，五道交付闸都不许作废整轮", () => {
  for (const gate of GATES) {
    assert.equal(judgeCompanionDeliveryGate({ gate, landedWrites: true }).destroysTurn, false,
      `${gate} 在已有成果时仍然销毁整轮：一次判错吃掉了全部已做成的事`);
  }
});

/** 反向控制：放宽的是误判的代价，不是谎报。什么都没落时判据照旧生效。 */
test("本轮一个写都没落下时，五道闸照旧作废整轮", () => {
  for (const gate of GATES) {
    assert.equal(judgeCompanionDeliveryGate({ gate, landedWrites: false }).destroysTurn, true,
      `${gate} 不再销毁了：她可以说一件根本没做过的事`);
  }
});

test("绕过销毁时错误码与留痕都按闸各自说清，不共用一个", () => {
  assert.deepEqual(GATES.map(gate => judgeCompanionDeliveryGate({ gate, landedWrites: true }).stepErrorCode),
    ["AGENT_BUDGET_EXCEEDED", "UNVERIFIED_QUOTE", "ACTION_NOT_EXECUTED", "INTERNAL_ERROR", "INTERNAL_ERROR"]);
  const notes = GATES.map(gate => judgeCompanionDeliveryGate({ gate, landedWrites: true }).bypassNote);
  assert.ok(notes.every(note => note.length > 0), "静默放行会让「她这次有没有被闸过」无法复盘");
  assert.equal(new Set(notes).size, GATES.length, "五道闸的起因必须分得开");
});

/**
 * 接线守卫（2026-10-16）：判定搬进一个模块之后，最省事的回退是"调用点又自己 throw"。
 * 那不会让上面几条红——线上表现正是"笔记全写完了还提示没成功"那一类。
 * 所以直接读那两个真正交付的文件，钉住它们各自问过这道闸。
 */
test("产出闸的降级判定真的接在交付路径上，不是只住在模块里", () => {
  const runtime = readFileSync(new URL("../companion-agent-runtime.ts", import.meta.url), "utf8");
  const dialogue = readFileSync(new URL("../companion-dialogue.ts", import.meta.url), "utf8");
  for (const gate of ["output_truncated", "unverified_quote", "action_not_executed"] as const) {
    assert.match(runtime, new RegExp(`gate: "${gate}"`), `${gate} 不再问闸了：它又会一次判错作废整轮`);
  }
  assert.match(dialogue, /gate: "stream_validation"/, "流式校验又回到自己 throw：已落库的写会再次被吃掉");
  assert.match(dialogue, /gate: "stream_reconcile"/, "全文对账又回到自己 throw：同上");
  // 降级交付之后有两处必须跟着改：尾巴补不进去（管线已判死），而语音不许念被拦下的原文。
  assert.match(dialogue, /!deliveredPrefixOnly && /, "降级后还去补尾：又会以 delta_stream_diverged 作废整轮");
  assert.match(dialogue, /deliveredPrefixOnly \? assistantText : ttsRawText/,
    "降级后仍拿模型原文念：把闸拦下来的那段送去了合成服务");
  // 交付管线真断了属于权威事实，这条不许被降级吞掉（钉的是判定住在这个模块里，
  // 值改了这里要跟着红，才挡得住"顺手把 delta_stream_lost 也降级"）。
  assert.equal(COMPANION_STREAM_TRANSPORT_FAILURE, "delta_stream_lost");
  assert.equal(companionStreamFallbackText({ gate: "stream_validation", landedWrites: true,
    reason: COMPANION_STREAM_TRANSPORT_FAILURE, deliveredPrefix: "她已经说出来的那半句" }).deliver, false);
  assert.equal(companionStreamFallbackText({ gate: "stream_reconcile", landedWrites: true,
    reason: COMPANION_STREAM_TRANSPORT_FAILURE, deliveredPrefix: "她已经说出来的那半句" }).deliver, true,
    "对账这一道与管线断裂无关，不该被同一个 reason 误伤");
  // 权威事实只有一个来源：写回执。不接受模型说法、词表、时间或条数上限。
  assert.match(runtime, /const landedWrites = companionActionResultRecorded\(/);
  assert.match(dialogue, /agentResult\.writesLanded === true/);
});

/**
 * 流式两道闸的降级对象（2026-10-16）。
 *
 * 原来这三个条件写在交付层的一个 `if` 里，两条反向对照都测不到：
 * 「本轮一个字都没落库」和「管线真断了」在源码里长得一样，改错了不会有人红。
 */
test("companionStreamFallbackText：只在三个事实同时成立时才降级交付", () => {
  const prefix = "她已经说出来的那半句";
  const base = { gate: "stream_validation" as const, landedWrites: true,
    reason: "tool_protocol_leak", deliveredPrefix: prefix };
  assert.deepEqual(companionStreamFallbackText(base), { deliver: true, text: prefix,
    note: judgeCompanionDeliveryGate({ gate: "stream_validation", landedWrites: true }).bypassNote });
  // 少一个写回执：正文还没落地，此时交付等于替她认下一件没做过的事。
  assert.equal(companionStreamFallbackText({ ...base, landedWrites: false }).deliver, false);
  // 客户端一个字都没见过：没有可交付的对象。
  assert.equal(companionStreamFallbackText({ ...base, deliveredPrefix: "" }).deliver, false);
  // 交付管线断了是权威事实，不是判错——这时候照旧作废整轮。
  assert.equal(companionStreamFallbackText({ ...base, reason: COMPANION_STREAM_TRANSPORT_FAILURE }).deliver, false);
  // 对账那道闸与"管线断裂"这个原因无关（它的 reason 来自正文比对）。
  assert.equal(companionStreamFallbackText({ ...base, gate: "stream_reconcile",
    reason: "stream_full_text_diverged" }).deliver, true);
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

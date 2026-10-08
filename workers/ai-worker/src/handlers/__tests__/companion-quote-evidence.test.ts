import assert from "node:assert/strict";
import { test } from "node:test";
import { companionQuoteSourceText } from "../companion-quote-evidence.ts";
import { unverifiedQuoteClaims } from "../companion-dialogue-content.ts";
import { shouldCorrectCompanionQuote } from "../companion-step-plan.ts";
import { unavailableCompanionToolSummary } from "../companion-tool-outcome.ts";

test("quotes match actual JSON-decoded tool text and a following citation badge", () => {
  const original = '第一行是实际返回的原文。\n第二行包含 "exact source" 的解释。';
  const sources = companionQuoteSourceText("", [{ role: "tool", toolCallId: "search-1",
    content: JSON.stringify({ sources: [{ content: original }] }) }]);
  assert.deepEqual(unverifiedQuoteClaims(`> ${original.replaceAll("\n", "\n> ")}[^web-0123456789abcdef]`, sources), []);
  assert.equal(unverifiedQuoteClaims("> 这段是模型编造的原文，实际网页没有这些文字。[^web-0123456789abcdef]", sources).length, 1);
});

test("assistant history and rejected drafts cannot establish source evidence", () => {
  const fabricated = "这段是模型编造的原文，实际网页没有这些文字。";
  const sources = companionQuoteSourceText("真实的上下文", [
    { role: "assistant", content: fabricated },
    { role: "tool", toolCallId: "plain", content: "工具实际返回的纯文本资料，不是JSON。" },
  ]);
  assert.ok(sources.includes("工具实际返回的纯文本资料，不是JSON。"));
  assert.equal(unverifiedQuoteClaims(`> ${fabricated}`, sources).length, 1);
});

test("a completed read can correct an invalid quote once, without relaxing final verification", () => {
  const plan = { stepCalls: 0, hasUnverifiedQuotes: true, correctionUsed: false, withinBudget: true };
  assert.equal(shouldCorrectCompanionQuote(plan), true, "does not depend on a zero tool-call count");
  assert.equal(shouldCorrectCompanionQuote({ ...plan, correctionUsed: true }), false);
  assert.equal(shouldCorrectCompanionQuote({ ...plan, withinBudget: false }), false);
  assert.equal(shouldCorrectCompanionQuote({ ...plan, stepCalls: 1 }), false);
  assert.equal(shouldCorrectCompanionQuote({ ...plan, hasUnverifiedQuotes: false }), false);
});

test("search round limit is distinct from an account toggle or service failure", () => {
  const exhausted = unavailableCompanionToolSummary("agent_web_search", { webSearchEnabled: true }, { searchLimitReached: true });
  assert.match(exhausted!, /本轮搜索次数已用完/);
  assert.doesNotMatch(exhausted!, /关闭|不可用|未能联网核实/);
  assert.match(unavailableCompanionToolSummary("agent_web_search", { webSearchEnabled: false }, { searchLimitReached: true })!, /关闭/);
  assert.equal(unavailableCompanionToolSummary("agent_web_search", { webSearchEnabled: true }), null);
});

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

test("格式修改说明可引用富文本可见文字，代码里的引号和大于号不冒充引文", () => {
  const original = '前半段<span style="font-size:28px">这段标题里有真实的原文内容</span>后半段';
  const sources = companionQuoteSourceText("", [{ role: "tool", toolCallId: "read", content: JSON.stringify({ body: original }) }]);
  assert.deepEqual(unverifiedQuoteClaims("原文标题是「这段标题里有真实的原文内容」。", sources), []);
  assert.equal(unverifiedQuoteClaims("原文标题是「这段标题里没有的伪造内容」。", sources).length, 1);
  assert.deepEqual(unverifiedQuoteClaims('示例代码：\n```python\n> comparator_with_long_name\nprint("“一段仅仅出现在代码字符串里的文本。”")\n```', sources), []);
  assert.equal(unverifiedQuoteClaims('```python\nprint("例子")\n```\n\n原文说：「这段标题里没有的伪造内容」。', sources).length, 1);
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

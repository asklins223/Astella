import assert from "node:assert/strict";
import { test } from "node:test";
import { companionQuoteSourceTexts } from "../companion-quote-evidence.ts";
import { unverifiedQuoteClaims } from "../companion-dialogue-content.ts";
import { shouldCorrectCompanionQuote, reviewCompanionStepCorrection } from "../companion-step-plan.ts";
import { compactionSourceMessages } from "../companion-compaction-checkpoint.ts";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { unavailableCompanionToolSummary } from "../companion-tool-outcome.ts";

test("quotes match actual JSON-decoded tool text and a following citation badge", () => {
  const original = '第一行是实际返回的原文。\n第二行包含 "exact source" 的解释。';
  const sources = companionQuoteSourceTexts("", [{ role: "tool", toolCallId: "search-1",
    content: JSON.stringify({ sources: [{ content: original }] }) }]);
  assert.deepEqual(unverifiedQuoteClaims(`> ${original.replaceAll("\n", "\n> ")}[^web-0123456789abcdef]`, sources), []);
  assert.equal(unverifiedQuoteClaims("> 这段是模型编造的原文，实际网页没有这些文字。[^web-0123456789abcdef]", sources).length, 1);
});

test("assistant history and rejected drafts cannot establish source evidence", () => {
  const fabricated = "这段是模型编造的原文，实际网页没有这些文字。";
  const sources = companionQuoteSourceTexts("真实的上下文", [
    { role: "assistant", content: fabricated },
    { role: "tool", toolCallId: "plain", content: "工具实际返回的纯文本资料，不是JSON。" },
  ]);
  assert.ok(sources.includes("工具实际返回的纯文本资料，不是JSON。"));
  assert.equal(unverifiedQuoteClaims(`> ${fabricated}`, sources).length, 1);
});

test("compaction retains exact quote evidence privately without treating summary prose as original source", () => {
  const original = "末尾最终更正：颜色仍未决定，旧方案已撤回且从未执行。";
  const invented = "生成摘要里编造出来的那段话没有原文依据，不能成为引用。";
  const json = JSON.stringify([{ role: "tool", toolCallId: "history", content: JSON.stringify({ messages: [{ text: original }] }) }]);
  const compactedEvidence = compactionSourceMessages({ json, sha256: sha256Utf8V1(json) });
  const input = { contextText: "", compactedEvidence, messages: [{ role: "assistant" as const, content: invented }],
    turnToolUse: "read", pageContext: null, groundedTutorContext: null, stepCalls: 0, toolCallCount: 1,
    finalAnswerOnly: false, stepCount: 2, stepBudget: 10, nowMs: 1, deadlineAt: 1000, userAskedForAction: false,
    requestedActionTools: [], actionSteerAttempts: 0, lookupClaimSteered: false, quoteCorrectionUsed: false };
  assert.deepEqual(reviewCompanionStepCorrection({ ...input, said: `原文：「${original}」。` }).unverifiedQuotes, []);
  assert.equal(reviewCompanionStepCorrection({ ...input, said: `原文：「${invented}」。` }).unverifiedQuotes.length, 1);
  assert.deepEqual(compactionSourceMessages({ json, sha256: "bad" }), []);
});

test("a terminal history excerpt accepts typographic quotes and explicit boundary ellipsis without requiring another read", () => {
  const question = "你前面说“P(A)=0，所以B完全落在非A里”。这句严格成立吗？请明确区分概率等式、几乎处处的关系和严格的集合包含，并举一个简单反例。";
  const sources = companionQuoteSourceTexts("", [{ role: "user", content: "请读历史，不重新解题。" },
    { role: "tool", toolCallId: "history", content: JSON.stringify({ ok: true, data: { messages: [
      { text: question, replyStatus: "failed" }, { text: "回来了？歇口气没。", kind: "proactive" }] } }) }]);
  assert.deepEqual(unverifiedQuoteClaims('质疑的创建时间：15:10:14（那条「你前面说"P(A)=0，所以B完全落在非A里"……」）。', sources), []);
  assert.deepEqual(unverifiedQuoteClaims('原文片段：「……请明确区分概率等式、几乎处处的关系和严格的集合包含...」。', sources), []);
  assert.equal(unverifiedQuoteClaims('原文：「你前面说……所以B完全落在非A里」。', sources).length, 1,
    "an internal omission cannot stitch a quotation together");
  assert.equal(unverifiedQuoteClaims('原文：「你前面说P(A)=0，所以B必然完全包含非A……」。', sources).length, 1);
});

test("separate tool records cannot be concatenated into a fabricated direct quote", () => {
  const first = "第一段只说明报告已经写完，", second = "第二段说明尚未提交审批。";
  const sources = companionQuoteSourceTexts("", [{ role: "tool", toolCallId: "history",
    content: JSON.stringify({ messages: [{ text: first }, { text: second }] }) }]);
  assert.deepEqual(unverifiedQuoteClaims(`原文：「${first}」。\n原文：「${second}」。`, sources), []);
  assert.equal(unverifiedQuoteClaims(`原文：「${first}${second}」。`, sources).length, 1);
});

test("current selected source remains available when runtime messages contain only the user and tool rounds", () => {
  const original = "这条原文出现在已经冻结的选区里，不能在工具后失去证据。";
  const context = `<selection_data>${JSON.stringify({ text: original })}</selection_data>`;
  const sources = companionQuoteSourceTexts(context, [{ role: "user", content: "解释选区的这句话" }]);
  assert.deepEqual(unverifiedQuoteClaims(`原文：「${original}」。`, sources), []);
});

test("格式修改说明可引用富文本可见文字，代码里的引号和大于号不冒充引文", () => {
  const original = '前半段<span style="font-size:28px">这段标题里有真实的原文内容</span>后半段';
  const sources = companionQuoteSourceTexts("", [{ role: "tool", toolCallId: "read", content: JSON.stringify({ body: original }) }]);
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

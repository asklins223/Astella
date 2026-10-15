import assert from "node:assert/strict";
import test from "node:test";
import { AgentRole, type AgentTurnRequest } from "@astella/shared";
import { sha256Utf8V1 } from "@astella/shared/content-hash";
import { bindHistoryForCompaction, compactUncoveredHistory } from "../companion-history-pressure-compaction.ts";
import { boundedStepSender } from "../companion-compaction.ts";
import { createCompanionContextReceipts } from "../companion-context-receipts.ts";
import { MockProvider } from "../../lib/providers/mock.ts";
import { createGovernedProvider, type AIGovernanceContext } from "../../lib/governance.ts";

const history = [
  { role: "user" as const, content: "Earlier source: ".repeat(5000) + "Keep the late restriction." },
  { role: "user" as const, content: "An addition to the same exchange." },
  { role: "assistant" as const, content: "The first completed answer." },
  { role: "assistant" as const, content: "The second answer segment. An old invitation?" },
  { role: "user" as const, content: "The latest answered question." },
  { role: "assistant" as const, content: "The latest full answer." },
];
const source = { conversationId: "conversation-a", historyTail: history.map((message, index) => ({
  seq: String(index + 1), role: message.role, text: message.content, contentSha256: sha256Utf8V1(message.content),
})) };
const request = (): AgentTurnRequest => ({ role: AgentRole.COMPANION_AGENT, systemPrompt: "Current policy.",
  messages: [...history, { role: "user", content: "The actual current request, with all restrictions." }],
  tools: [], maxTokens: 1000, temperature: 0.2 });

test("pressure compaction reads complete old exchanges without an existing summary and preserves the latest exchange/current evidence", async () => {
  const req = request();
  req.messages.push({ role: "assistant", content: "", toolCalls: [{ id: "current-read", name: "companion_read_note", arguments: { noteId: "note" } }] },
    { role: "tool", toolCallId: "current-read", content: "Latest evidence, keep exact." });
  const folded = await compactUncoveredHistory({ request: req, binding: bindHistoryForCompaction(source, req.messages, req.messages),
    targetInputTokens: 5000, maxOutputTokens: 1000, summarize: async material => {
      const read = JSON.parse(material);
      assert.deepEqual(read.messages, source.historyTail.slice(0, 4));
      assert.ok(material.includes("Keep the late restriction."));
      assert.ok(material.includes("An old invitation?"));
      return "Prior discussion with the late restriction; no new task.";
    } });
  assert.ok(folded);
  assert.equal(folded.receipt.sourceKind, "history_exchanges");
  assert.equal(folded.receipt.foldedMessageCount, 4);
  assert.deepEqual(folded.messages.slice(1), req.messages.slice(4));
  assert.equal(req.messages[0], history[0], "original input is immutable");
});

test("a stale source hash, reordered identities or a changed request prefix cannot compact another frozen replay", async () => {
  const req = request();
  const badHash = { ...source, historyTail: source.historyTail.map((entry, index) => index ? entry : { ...entry, contentSha256: "bad" }) };
  assert.equal(bindHistoryForCompaction(badHash, req.messages, req.messages), null);
  const reordered = { ...source, historyTail: source.historyTail.map((entry, index) => ({ ...entry, seq: String(10 - index) })) };
  assert.equal(bindHistoryForCompaction(reordered, req.messages, req.messages), null);
  const binding = bindHistoryForCompaction(source, req.messages, req.messages);
  const changed = { ...req, messages: [{ ...req.messages[0]!, content: "A fresh read's different first message." }, ...req.messages.slice(1)] };
  assert.equal(await compactUncoveredHistory({ request: changed, binding, targetInputTokens: 5000, maxOutputTokens: 1000,
    summarize: async () => { throw new Error("must not summarize mismatched identities"); } }), null);
});

test("a protected latest exchange that fills the window is not silently removed to make room", async () => {
  const req = request();
  assert.equal(await compactUncoveredHistory({ request: req, binding: bindHistoryForCompaction(source, req.messages, req.messages),
    targetInputTokens: 1, maxOutputTokens: 1000, summarize: async () => { throw new Error("must not run"); } }), null);
  const only = source.historyTail.slice(-2);
  assert.equal(bindHistoryForCompaction({ ...source, historyTail: only }, req.messages.slice(4), req.messages.slice(4)), null);
});

test("a failed history summary returns no replacement and leaves original source intact", async () => {
  const req = request();
  const original = structuredClone(req);
  await assert.rejects(compactUncoveredHistory({ request: req, binding: bindHistoryForCompaction(source, req.messages, req.messages),
    targetInputTokens: 5000, maxOutputTokens: 1000, summarize: async () => { throw new Error("summary failed"); } }), /summary failed/);
  assert.deepEqual(req, original);
});

test("the real full-request governor recovers an overflowing first answer request before contacting the provider", async () => {
  const governance: AIGovernanceContext = { providerName: "mock", providerConfig: {}, textProviderName: null, textProviderConfig: null,
    companionFallbackProviderName: null, companionFallbackProviderConfig: null, embeddingProviderName: null, embeddingProviderConfig: null,
    consentOk: true, policy: { sendToExternal: true, sendImageContent: true, piiDetection: false, auditLogging: false } };
  const provider = new MockProvider();
  const capability = provider.getCapabilities();
  provider.getCapabilities = () => ({ ...capability, contextWindowTokens: 60_000 });
  let actualCalls = 0;
  provider.executeAgentTurn = async sent => { actualCalls++; assert.equal(sent.messages[1]!.content, history[4]!.content);
    return { content: "A correct reply to the current request.", toolCalls: [], finishReason: "stop", usage: {}, providerRequestId: null }; };
  const receipts = createCompanionContextReceipts();
  const governed = createGovernedProvider(provider, governance, "00000000-0000-0000-0000-000000000001",
    { userId: "00000000-0000-0000-0000-000000000002", operation: "companion_agent" }, receipts.pressureGate);
  const req = request();
  const binding = bindHistoryForCompaction(source, req.messages, req.messages);
  let folds = 0;
  const send = boundedStepSender({ beginRequest: () => receipts.beginRequest("same-first-request"),
    fold: () => compactUncoveredHistory({ request: req, binding, targetInputTokens: receipts.latestPressure()!.targetTokens,
      maxOutputTokens: 1000, summarize: async material => { assert.ok(material.includes("Keep the late restriction.")); return "Complete older-exchange checkpoint."; } }),
    hasAttempt: receipts.hasCompactionAttempt, consumeAttempt: receipts.consumeCompactionAttempt,
    onCompacted: () => { folds++; } });
  await send(req, sent => governed.executeAgentTurn!(sent));
  assert.equal(actualCalls, 1, "the oversized uncompressed request never goes to the provider");
  assert.equal(folds, 1);
});

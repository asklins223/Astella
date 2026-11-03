import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWebSearchSources, readWebSearchReceipt, successfulWebSearchDocuments } from "../../agent/web-search.ts";
import { readCompanionSearchSources, compactCompanionSearchResult } from "../tools/companion-search-reads.ts";
import { companionGroundedReviewMaterial, companionCitationReadGuidance } from "../agent/companion-conversation-review.ts";
import { companionIndependentEvidenceMissing } from "../agent/companion-read-requirements.ts";
import { agentReadRequirementsV1Schema } from "@astella/shared/agent-contracts";
import type { AgentTurnRequest } from "@astella/shared";

const result = { status: "succeeded" as const, query: "original papers", searchedAt: new Date().toISOString(),
  sources: normalizeWebSearchSources(Array.from({ length: 6 }, (_, i) => ({ link: `https://example.com/paper-${i}`, title: `Paper ${i}` }))) };
const document = (url: string) => ({ status: "succeeded", url: `${url}/`, text: "Actual measured range: 10–37°C.", contentHash: "a".repeat(64) });

test("search reads overlap four pages, retain rank order and isolate one unavailable page", async () => {
  let release!: () => void;
  const gate = new Promise<void>(yes => { release = yes; });
  const started: string[] = [];
  const reads = readCompanionSearchSources({ result, count: 6, signal: new AbortController().signal,
    read: async source => { started.push(source.url); if (started.length === 4) release(); await gate;
      if (source === result.sources[1]) throw new Error("provider unavailable"); return document(source.url); } });
  const documents = await reads;
  assert.deepEqual(started, result.sources.map(source => source.url));
  assert.deepEqual(documents.map(item => item.requestedUrl), started);
  assert.equal(documents[1]!.document.status, "unavailable");
  assert.equal(successfulWebSearchDocuments({ ...result, documents }).length, 5);
});

test("cancelling a combined search drains started reads and never starts queued pages", async () => {
  const controller = new AbortController(); let starts = 0;
  const promise = readCompanionSearchSources({ result, count: 6, signal: controller.signal,
    read: async (_source, signal) => { if (++starts === 4) controller.abort(); signal.throwIfAborted();
      return new Promise<Record<string, unknown>>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } });
  await assert.rejects(promise, error => (error as Error).name === "AbortError");
  assert.equal(starts, 4);
});

test("only exact searched identities with successful real text and hash become evidence, including recovered receipts", () => {
  const source = result.sources[0]!;
  const good = { referenceId: source.referenceId, requestedUrl: source.url, document: document(source.url) };
  const receipt = { ...result, documents: [good, { ...good, requestedUrl: "https://elsewhere.test" },
    { ...good, referenceId: "web-other" }, { ...good, document: { ...good.document, contentHash: "invented" } },
    { ...good, document: { ...good.document, text: "" } }, { ...good, document: { ...good.document, status: "unavailable" } }] };
  assert.deepEqual(successfulWebSearchDocuments(receipt), [good]);
  const recovered = readWebSearchReceipt(JSON.stringify(receipt));
  assert.deepEqual(successfulWebSearchDocuments(recovered!), [good]);
  const messages: AgentTurnRequest["messages"] = [{ role: "user", content: "Check the source", requestBoundary: true },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "search", name: "companion_web", arguments: { action: "search", query: result.query, readTopResults: 1 } }] },
    { role: "tool" as const, toolCallId: "search", content: JSON.stringify({ ok: true, operation: "web.search", data: receipt }) }];
  const material = companionGroundedReviewMaterial(messages);
  assert.equal(material.documents.length, 1);
  assert.equal(material.documents[0]!.sources[0]!.referenceId, source.referenceId);
  const decision = agentReadRequirementsV1Schema.parse({ version: 1, inputHash: "a".repeat(64), policyHash: "b".repeat(64),
    status: "resolved", requirements: [], requiresIndependentEvidence: true });
  assert.equal(companionIndependentEvidenceMissing(decision, messages), false);
  assert.equal(companionCitationReadGuidance({ content: `The limited result.${source.citationMarker}`, toolCalls: [], finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1 }, providerRequestId: null }, messages), null);
  assert.equal(companionIndependentEvidenceMissing(decision, [...messages, { role: "user", content: "new", requestBoundary: true }]), true);
});

test("author context marks unread snippets as locators and avoids duplicating already read text", () => {
  const source = result.sources[0]!;
  const original = { ...result, sources: result.sources.map(item => ({ ...item, content: "long snippet ".repeat(100) })),
    documents: [{ referenceId: source.referenceId, requestedUrl: source.url, document: document(source.url) }] };
  const compact = compactCompanionSearchResult(original) as typeof original & { sources: Array<{ content: string; readStatus: string }> };
  assert.equal(compact.sources[0]!.content, ""); assert.equal(compact.sources[0]!.readStatus, "read");
  assert.equal(compact.sources[1]!.readStatus, "not_read"); assert.equal(compact.sources[1]!.content.length, 160);
  assert.equal(original.sources[0]!.content.length, 1300, "the original durable search receipt is unchanged");
  assert.deepEqual(successfulWebSearchDocuments(compact), original.documents);
});

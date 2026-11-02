import assert from "node:assert/strict";
import test from "node:test";
import { companionConversationReviewMessages, companionGroundedReviewMaterial, companionUnknownWebCitations,
  COMPANION_GROUNDED_REVIEW_POLICY, COMPANION_KNOWLEDGE_COHERENCE_REVIEW_POLICY,
  COMPANION_CONVERSATION_REVIEW_POLICY_V2 } from "../agent/companion-conversation-review.ts";

test("the settled reasoning decision selects one review responsibility without classifying reply wording", () => {
  const input = { userText: "unseen input", draft: "unseen draft", request: { role: "companion_agent" as const,
    systemPrompt: "", maxTokens: 1000, temperature: 0.4, tools: [], messages: [] } };
  assert.equal(companionConversationReviewMessages({ ...input, requiresReasoning: true })[0]!.content, COMPANION_KNOWLEDGE_COHERENCE_REVIEW_POLICY);
  assert.equal(companionConversationReviewMessages({ ...input, requiresReasoning: false })[0]!.content, COMPANION_CONVERSATION_REVIEW_POLICY_V2);
});

test("conversation correction sees the current utterance as the request and historical drafts only as context", () => {
  const messages = companionConversationReviewMessages({
    request: { role: "companion_agent", systemPrompt: "private host policy, unrelated internal protocol", tools: [], maxTokens: 1000, temperature: 0.4,
      messages: [{ role: "user", content: "刚买了一盆花" }, { role: "assistant", content: "记得浇水。" },
        { role: "user", content: "不用给建议，聊两句。", requestBoundary: true }] },
    userText: "不用给建议，聊两句。", draft: "那我不提建议了。", expressionContext: "语气随意，温和。",
  });
  const data = JSON.parse(String(messages[1]!.content));
  assert.equal(data.currentUser, "不用给建议，聊两句。");
  assert.deepEqual(data.recent, [{ role: "user", text: "刚买了一盆花" }, { role: "assistant", text: "记得浇水。" }]);
  assert.equal(data.draft, "那我不提建议了。");
  assert.equal(data.expressionContext, "语气随意，温和。");
  assert.ok(!String(messages[1]!.content).includes("private host policy"), "unrelated execution/knowledge policies do not become new review instructions");
});

test("a text-only expression review never forwards historical image bytes or asset URLs", () => {
  const messages = companionConversationReviewMessages({ userText: "换个话题", draft: "来聊点别的。",
    request: { role: "companion_agent", systemPrompt: "", maxTokens: 1000, temperature: 0.4, tools: [], messages: [
      { role: "user", content: [{ type: "text", text: "看看这张图" }, { type: "image_url", image_url: { url: "data:image/png;base64,PRIVATE_IMAGE_BYTES" } }] },
      { role: "user", content: "换个话题", requestBoundary: true },
    ] } });
  assert.ok(!JSON.stringify(messages).includes("PRIVATE_IMAGE_BYTES"));
  assert.match(String(messages[1]!.content), /看看这张图/);
});

test("source review receives only actual current reads, their requested URL and real citation identities", () => {
  const request = { role: "companion_agent" as const, systemPrompt: "", maxTokens: 1000, temperature: 0.4, tools: [], messages: [
    { role: "tool" as const, content: JSON.stringify({ ok: true, operation: "web.read_document", data: { text: "OLD SOURCE" } }) },
    { role: "user" as const, content: "核对这项研究", requestBoundary: true as const },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "read", name: "companion_web", arguments: { action: "read_document", url: "https://example.com/paper" } }] },
    { role: "tool" as const, toolCallId: "search", content: JSON.stringify({ ok: true, operation: "web.search", data: { sources: [
      { referenceId: "web-a123", citationMarker: "[^web-a123]", title: "Original research", url: "https://example.com/paper" }] } }) },
    { role: "tool" as const, toolCallId: "read", content: JSON.stringify({ ok: true, operation: "web.read_document", data: { status: "succeeded", url: "https://example.com/paper/", text: "The measured range was 10–37°C." } }) },
    { role: "tool" as const, content: JSON.stringify({ ok: false, operation: "web.read_document", data: { text: "FAILED SOURCE" } }) },
  ] };
  const messages = companionConversationReviewMessages({ request, userText: "核对这项研究", draft: "因此70°C时也成立。[^web-7]", requiresReasoning: false });
  assert.equal(messages[0]!.content, COMPANION_GROUNDED_REVIEW_POLICY);
  const data = JSON.parse(String(messages[1]!.content));
  assert.equal(data.documents.length, 1);
  assert.equal(data.documents[0].requestedUrl, "https://example.com/paper");
  assert.equal(data.sources[0].citationMarker, "[^web-a123]");
  assert.ok(!JSON.stringify(data).includes("OLD SOURCE"));
  assert.ok(!JSON.stringify(data).includes("FAILED SOURCE"));
  assert.deepEqual(companionUnknownWebCitations(data.draft, data.sources), ["web-7"]);
  assert.deepEqual(companionUnknownWebCitations("限定条件下成立。[^web-a123]", data.sources), []);
  assert.equal(companionGroundedReviewMaterial(request.messages).documents.length, 1);
});

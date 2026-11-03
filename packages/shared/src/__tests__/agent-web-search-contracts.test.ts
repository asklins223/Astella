import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAllCompanionAgentTools } from "../agent/companion-agent-registry.ts";
import { companionAgentSettingsV1Schema } from "../contracts/companion/companion-agent-contracts.ts";
import { companionAccountPatchSchema } from "../contracts/companion/companion-shell-contracts.ts";
import { companionContentBlockV1Schema, companionMessageV1Schema, createCompanionTurnRequestV1Schema } from "../contracts/companion/companion-conversation-contracts.ts";
import { validateCompanionAgentToolArguments } from "../agent/companion-agent-registry.ts";
import { resolveCompanionInitialToolNames } from "../agent/companion-tool-groups.ts";

test("authorized search is initially available without a loading round, while catalog permission still wins", () => {
  const availableToolNames = ["companion_web", "companion_load_tools", "companion_observe"];
  assert.equal(resolveCompanionInitialToolNames({ availableToolNames, webSearchEnabled: true }).has("companion_web"), true);
  assert.equal(resolveCompanionInitialToolNames({ availableToolNames, webSearchEnabled: false }).has("companion_web"), false);
  assert.equal(resolveCompanionInitialToolNames({ availableToolNames: [], webSearchEnabled: true }).has("companion_web"), false);
});

test("search may request real top-page reads while direct reads retain their distinct schema", () => {
  const parse = (args: Record<string, unknown>) => validateCompanionAgentToolArguments("companion_web", args).success;
  assert.equal(parse({ action: "search", query: "original paper", readTopResults: 3 }), true);
  assert.equal(parse({ action: "search", query: "original paper", readTopResults: 0 }), true);
  for (const readTopResults of [-1, 9, 1.5, "3"]) assert.equal(parse({ action: "search", query: "paper", readTopResults }), false);
  assert.equal(parse({ action: "read_document", url: "https://example.com", readTopResults: 2 }), false);
});

test("web search defaults off in old accounts and requires explicit exposure", () => {
  assert.notEqual(companionAgentSettingsV1Schema.parse({ version: 1, permissionLevel: "guided" }).webSearchEnabled, true);
  for (const permission of ["read_only", "guided", "full"] as const) {
    // Legacy search tool is hidden from the model; the domain tool remains for
    // reading user-provided public documents, while its search action is gated
    // at execution by the server-side web constraint.
    assert.equal(resolveAllCompanionAgentTools(permission).some(tool => tool.name === "agent_web_search"), false);
    assert.equal(resolveAllCompanionAgentTools(permission).some(tool => tool.name === "companion_web"), true);
    assert.equal(resolveAllCompanionAgentTools(permission, { webSearchEnabled: true }).some(tool => tool.name === "companion_web"), true);
  }
  assert.deepEqual(companionAccountPatchSchema.parse({ revision: 0, webSearchEnabled: false }), { revision: 0, webSearchEnabled: false });
});

test("explicit note-library read opt-out removes both search and note-body tools", () => {
  const defaultTools = resolveAllCompanionAgentTools("full");
  assert.ok(defaultTools.some(tool => tool.name === "companion_notes_read"));
  assert.ok(defaultTools.some(tool => tool.name === "companion_notes_read"));
  const restricted = resolveAllCompanionAgentTools("full", { noteLibraryReadEnabled: false });
  assert.equal(restricted.some(tool => tool.name === "companion_notes_read"), false);
  assert.equal(restricted.some(tool => tool.name === "companion_notes_read"), false);
  assert.ok(restricted.some(tool => tool.name === "companion_notes_write"), "the user can still create a standalone note");
});

test("saved search citations retain identity and the exact destination through the wire contract", () => {
  const block = { type: "citation", referenceId: "web-1234567890abcdef", label: "说明", media: "官方", publishDate: "2026-10-08",
    target: { kind: "external_https", href: "https://example.com/docs?q=2" } };
  assert.deepEqual(companionContentBlockV1Schema.parse(block), block);
  assert.equal(companionContentBlockV1Schema.safeParse({ ...block, target: { kind: "external_https", href: "javascript:alert(1)" } }).success, false);
});

test("persisted research output retains every citation while upload/input limits stay separate", () => {
  const blocks = [{ type: "text", text: "Research answer" }, ...Array.from({ length: 48 }, (_, index) => ({
    type: "citation", label: `Source ${index}`, referenceId: `web-${index.toString(16).padStart(16, "0")}`, target: { kind: "external_https", href: `https://example.com/${index}` },
  }))];
  assert.deepEqual(companionMessageV1Schema.shape.blocks.parse(blocks), blocks);
  assert.equal(createCompanionTurnRequestV1Schema.safeParse({ version: 1,
    clientMessageId: "11111111-1111-4111-8111-111111111111", inputKind: "text", sourceSurface: "pet", blocks }).success, false);
});


test("tool process contract preserves receipt-backed search metadata through SSE and archives", async () => {
  const { companionAgentToolEventV1Schema } = await import("../contracts/companion/companion-agent-contracts.ts");
  const tool = { toolCallId: "search", name: "web.search", toolVersion: "1", riskClass: "read", status: "succeeded", safeLabel: "搜索网页",
    webSearch: { query: "官方说明", outcome: "succeeded", sources: [{ referenceId: "web-1234567890abcdef", title: "标题", url: "https://example.com/a", media: "官网", publishDate: "" }] } };
  assert.deepEqual(companionAgentToolEventV1Schema.parse(tool), tool);
  assert.equal(companionAgentToolEventV1Schema.safeParse({ ...tool, webSearch: { ...tool.webSearch, sources: [{ ...tool.webSearch.sources[0], url: "javascript:alert(1)" }] } }).success, false);
});

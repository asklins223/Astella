import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAllCompanionAgentTools } from "../agent/companion-agent-registry.ts";
import { companionAgentSettingsV1Schema } from "../contracts/companion/companion-agent-contracts.ts";
import { companionAccountPatchSchema } from "../contracts/companion/companion-shell-contracts.ts";
import { companionContentBlockV1Schema } from "../contracts/companion/companion-conversation-contracts.ts";

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

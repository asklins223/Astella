import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAllCompanionAgentTools } from "../companion-agent-registry.ts";
import { companionAgentSettingsV1Schema } from "../contracts/companion-agent-contracts.ts";
import { companionAccountPatchSchema } from "../contracts/companion-shell-contracts.ts";
import { companionContentBlockV1Schema } from "../contracts/companion-conversation-contracts.ts";

test("web search defaults off in old accounts and requires explicit exposure", () => {
  assert.notEqual(companionAgentSettingsV1Schema.parse({ version: 1, permissionLevel: "guided" }).webSearchEnabled, true);
  for (const permission of ["read_only", "guided", "full"] as const) {
    assert.equal(resolveAllCompanionAgentTools(permission).some(tool => tool.name === "agent_web_search"), false);
    assert.equal(resolveAllCompanionAgentTools(permission, { webSearchEnabled: true }).some(tool => tool.name === "agent_web_search"), true);
  }
  assert.deepEqual(companionAccountPatchSchema.parse({ revision: 0, webSearchEnabled: false }), { revision: 0, webSearchEnabled: false });
});

test("saved search citations retain identity and the exact destination through the wire contract", () => {
  const block = { type: "citation", referenceId: "web-1234567890abcdef", label: "说明", media: "官方", publishDate: "2026-10-08",
    target: { kind: "external_https", href: "https://example.com/docs?q=2" } };
  assert.deepEqual(companionContentBlockV1Schema.parse(block), block);
  assert.equal(companionContentBlockV1Schema.safeParse({ ...block, target: { kind: "external_https", href: "javascript:alert(1)" } }).success, false);
});

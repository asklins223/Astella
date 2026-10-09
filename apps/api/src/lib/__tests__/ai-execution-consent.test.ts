import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setPlatformConfig } from "@astella/shared/platform-config-node";
import { requireAiExecutionConsent } from "../ai-execution-consent.ts";

before(() => setPlatformConfig({ platforms: { external: { type: "openai_compatible", apiKey: "fixture" } },
  capabilities: { agent_turn: { platform: "external", model: "fixture" } } }));
after(() => setPlatformConfig(null));
test("unsigned and external-disabled accounts are refused in the acceptance transaction", async () => {
  for (const [row, code] of [
    [null, "ai_consent_required"],
    [{ consent_at: null, consent_version: null }, "ai_consent_required"],
    [{ consent_at: new Date(), consent_version: "signed", data_policy: { sendToExternal: false } }, "ai_data_policy_denied"],
  ] as const) {
    let queries = 0;
    await assert.rejects(requireAiExecutionConsent({ execute: async () => { queries++; return row ? [row] : []; } }, { userId: "fixture" }),
      (error: unknown) => (error as { code: string; statusCode: number }).code === code && (error as { statusCode: number }).statusCode === 403);
    assert.equal(queries, 1);
  }
});
test("signed account with external permission can proceed; mock-only deployment needs no consent read", async () => {
  await requireAiExecutionConsent({ execute: async () => [{ consent_at: new Date(), consent_version: "signed", data_policy: { sendToExternal: true } }] }, { userId: "fixture" });
  setPlatformConfig({ platforms: {}, capabilities: {} });
  await requireAiExecutionConsent({ execute: async () => { throw new Error("must not read settings"); } }, { userId: "fixture" });
});

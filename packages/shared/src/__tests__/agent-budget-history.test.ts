import assert from "node:assert/strict";
import { test } from "node:test";
import { companionAgentBudgetSnapshotV1Schema, COMPANION_AGENT_DEADLINE_MS } from "../contracts/companion-agent-contracts.ts";

test("raising the current execution budget keeps historical receipts readable", () => {
  for (const deadlineMs of [120000, COMPANION_AGENT_DEADLINE_MS]) {
    const receipt = { maxSteps: 8, maxToolCallsPerStep: 4, maxToolCalls: 12, maxModelCalls: 12, deadlineMs };
    assert.equal(companionAgentBudgetSnapshotV1Schema.parse(receipt).deadlineMs, deadlineMs);
  }
});

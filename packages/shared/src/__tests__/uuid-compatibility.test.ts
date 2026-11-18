import assert from "node:assert/strict";
import { test } from "node:test";
import { z as z3 } from "zod/v3";
import { z } from "zod";
import { agentAttentionObjectV1Schema } from "../contracts/agent/agent-contracts.ts";
import { agentToolParameters } from "../agent/agent-tool-parameters.ts";

test("UUID contracts preserve the accepted Zod 3/PostgreSQL identifier format", () => {
  const original = z3.string().uuid();
  const compatible = z.string().guid();
  const values = [
    "11111111-1111-1111-1111-111111111111", // Legacy, non-RFC variant.
    "A1b2C3d4-1111-0111-0111-111111111111", // Case and version are unconstrained.
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "550e8400-e29b-41d4-a716-446655440000",
    "{11111111-1111-1111-1111-111111111111}",
    "urn:uuid:11111111-1111-1111-1111-111111111111",
    "11111111111111111111111111111111",
    "x11111111-1111-1111-1111-111111111111",
    "11111111-1111-1111-1111-11111111111g",
  ];
  for (const value of values) {
    assert.equal(compatible.safeParse(value).success, original.safeParse(value).success, value);
  }
  assert.equal(agentAttentionObjectV1Schema.safeParse({ kind: "agent_run", id: values[0] }).success, true);
  // Model-facing contracts keep their existing format despite Zod's new name.
  assert.deepEqual(agentToolParameters(compatible), { type: "string", format: "uuid" });
});

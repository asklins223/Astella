import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { agentGoalToolManifest, noteAgentCapabilityManifest } from "../agent-capabilities.ts";
import { agentToolParameters } from "../agent-tool-parameters.ts";

test("the same capability schema supplies model bounds and rejects invalid or expanded authority", () => {
  const start = agentGoalToolManifest.find(entry => entry.definition.name === "agent_start_goal")!;
  const parameters = start.definition.parameters as { properties: Record<string, { maxLength?: number; maxItems?: number }>; required: string[]; additionalProperties: boolean };
  assert.equal(parameters.properties.goal.maxLength, 8000);
  assert.equal(parameters.properties.inputs.maxItems, 20);
  assert.equal(parameters.required.includes("inputs"), false);
  assert.equal(parameters.additionalProperties, false);
  assert.equal(start.argumentSchema.safeParse({ goal: "整理", permissionLevel: "server" }).success, false);
  assert.equal(start.argumentSchema.safeParse({ goal: " ", inputs: [] }).success, false);
  const read = noteAgentCapabilityManifest.find(entry => entry.definition.name === "note_read")!;
  assert.equal(read.argumentSchema.safeParse({ noteId: "invalid", noteVersionId: "invalid", startOrdinal: 0 }).success, false);
  assert.equal((read.definition.parameters as { required: string[] }).required.includes("startOrdinal"), false);
});
test("unsupported model parameter constraints fail during registration instead of silently weakening validation", () => {
  assert.throws(() => agentToolParameters(z.object({ value: z.string().regex(/^safe$/) })), /Unsupported agent string constraint/);
  assert.throws(() => agentToolParameters(z.object({ value: z.union([z.string(),z.number()]) })), /Unsupported agent parameter contract/);
  assert.deepEqual(agentToolParameters(z.number().int().positive().max(4)), { type: "integer", exclusiveMinimum: 0, maximum: 4 });
});

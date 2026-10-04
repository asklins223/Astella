import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { agentGoalToolManifest, noteAgentCapabilityManifest } from "../agent-capabilities.ts";
import { agentToolParameters } from "../agent-tool-parameters.ts";
import { createAgentRunV1Schema } from "../contracts/agent-contracts.ts";

test("the same capability schema supplies model bounds and rejects invalid or expanded authority", () => {
  const start = agentGoalToolManifest.find(entry => entry.definition.name === "agent_start_goal")!;
  const parameters = start.definition.parameters as { properties: Record<string, { maxLength?: number; maxItems?: number }>; required: string[]; additionalProperties: boolean };
  assert.equal(parameters.properties.inputs.maxItems, 20);
  assert.equal(parameters.required.includes("inputs"), false);
  assert.equal(parameters.additionalProperties, false);
  assert.equal(start.argumentSchema.safeParse({ goal: "整理", permissionLevel: "server" }).success, false);
  assert.equal(start.argumentSchema.safeParse({ goal: " ", inputs: [] }).success, false);
  const read = noteAgentCapabilityManifest.find(entry => entry.definition.name === "note_read")!;
  assert.equal(read.argumentSchema.safeParse({ noteId: "invalid", noteVersionId: "invalid", startOrdinal: 0 }).success, false);
  assert.equal((read.definition.parameters as { required: string[] }).required.includes("startOrdinal"), false);
});

test("目标文本不在模型的参数里：要求只能由执行器取本轮原话", () => {
  const start = agentGoalToolManifest.find(entry => entry.definition.name === "agent_start_goal")!;
  const parameters = start.definition.parameters as { properties: Record<string, unknown>; additionalProperties: boolean };
  // 曾经把用户原话改写成「学习卡候选要点，只依据正文」，后台照错的 goal 只交付了文字。
  assert.equal(parameters.properties.goal, undefined, "模型看得到 goal 参数就会去改写它");
  for (const smuggled of [
    { goal: "学习卡候选要点，只依据正文，不引入新知识" },
    { inputs: [], goal: "整理" },
    { Goal: "整理" },
    { goal: "" },
  ]) assert.equal(start.argumentSchema.safeParse(smuggled).success, false, JSON.stringify(smuggled));
  // 材料引用照旧是唯一的入参，version 冻结要求不变。
  const noteId = "11111111-1111-4111-8111-111111111111", noteVersionId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(start.argumentSchema.parse({ inputs: [{ kind: "note_version", noteId, noteVersionId }] }),
    { inputs: [{ kind: "note_version", noteId, noteVersionId }] });
  assert.deepEqual(start.argumentSchema.parse({}), { inputs: [] });
  assert.equal(start.argumentSchema.safeParse({ inputs: [{ kind: "note_version", noteId, noteVersionId: "nope" }] }).success, false);
  // createAgentRunV1Schema 本身不动：直接调 API 的那条路径仍然要 goal。
  assert.equal(createAgentRunV1Schema.safeParse({ requestId: "11111111-1111-4111-8111-111111111111",
    goal: "整理", inputs: [] }).success, true);
});
test("unsupported model parameter constraints fail during registration instead of silently weakening validation", () => {
  assert.throws(() => agentToolParameters(z.object({ value: z.string().regex(/^safe$/) })), /Unsupported agent string constraint/);
  assert.throws(() => agentToolParameters(z.object({ value: z.union([z.string(),z.number()]) })), /Unsupported agent parameter contract/);
  assert.deepEqual(agentToolParameters(z.number().int().positive().max(4)), { type: "integer", exclusiveMinimum: 0, maximum: 4 });
});

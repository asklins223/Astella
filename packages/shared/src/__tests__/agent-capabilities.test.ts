import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { agentGoalToolManifest, noteAgentCapabilityManifest, agentGoalExecutionManifest, resolveAgentGoalExecutionManifest } from "../agent-capabilities.ts";
import { agentToolParameters } from "../agent-tool-parameters.ts";
import { createAgentRunV1Schema } from "../contracts/agent-contracts.ts";
import { getCompanionAgentTool, validateCompanionAgentToolArguments } from "../companion-agent-registry.ts";

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

test("目标只获得真实材料可用的能力，缺材料仍可明确交付 needs_input", () => {
  const names = (entries: ReturnType<typeof resolveAgentGoalExecutionManifest>) => entries.map(entry => entry.definition.name);
  assert.deepEqual(names(resolveAgentGoalExecutionManifest({ notes: [], methods: [] })),
    ["agent_calculate", "agent_web_search", "agent_read_public_document", "agent_deliver_goal"]);
  const notes = [{ noteId: "11111111-1111-4111-8111-111111111111", noteVersionId: "22222222-2222-4222-8222-222222222222" }];
  const methods = [{ methodId: "33333333-3333-4333-8333-333333333333", revision: 2 }];
  const full = resolveAgentGoalExecutionManifest({ notes, methods });
  assert.deepEqual(names(full), names([...agentGoalExecutionManifest]));
  const read = full.find(entry => entry.definition.name === "note_read")!;
  const properties = read.definition.parameters.properties as Record<string, { enum: string[] }>;
  assert.deepEqual(properties.noteId.enum, [notes[0]!.noteId]);
  assert.deepEqual(properties.noteVersionId.enum, [notes[0]!.noteVersionId]);
  const method = full.find(entry => entry.definition.name === "agent_read_method")!;
  const methodProperties = method.definition.parameters.properties as Record<string, { enum: (string | number)[] }>;
  assert.deepEqual(methodProperties.methodId.enum, [methods[0]!.methodId]);
  assert.deepEqual(methodProperties.expectedRevision.enum, [2]);
  const withoutMethod = names(resolveAgentGoalExecutionManifest({ notes, methods: [] }));
  assert.ok(withoutMethod.includes("note_read"));
  assert.ok(withoutMethod.includes("card_generation_generate"));
  assert.ok(!withoutMethod.includes("agent_read_method"));
  const onlyMethod = names(resolveAgentGoalExecutionManifest({ notes: [], methods }));
  assert.ok(onlyMethod.includes("agent_read_method"));
  assert.ok(!onlyMethod.includes("note_read"));
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
  assert.throws(() => agentToolParameters(z.object({ value: z.string().transform(value => value.length) })), /Unsupported agent parameter transform/);
  assert.throws(() => agentToolParameters(z.object({ value: z.string().regex(/^safe$/i) })), /Unsupported agent string regex flags/);
  assert.throws(() => agentToolParameters(z.lazy(() => z.string())), /Unsupported agent parameter contract/);
  assert.deepEqual(agentToolParameters(z.number().int().positive().max(4)), { type: "integer", exclusiveMinimum: 0, maximum: 4 });
});

test("companion capabilities derive UUID, variant bounds and refinements from the actual validator", () => {
  const card = getCompanionAgentTool("companion_open_card")!.parameters as { properties: Record<string, { format?: string }> };
  assert.equal(card.properties.cardId.format, "uuid");
  const variant = getCompanionAgentTool("companion_switch_task_variant")!.parameters as { properties: Record<string, { maxLength?: number }> };
  assert.equal(variant.properties.alternativeId.maxLength, 200);
  assert.equal(validateCompanionAgentToolArguments("companion_save_memory", { kind: "preference", content: "简短", appliesWhen: "今天" }).success, false);
  assert.deepEqual(agentToolParameters(z.union([z.literal(1), z.literal(2), z.literal(3)])), { type: "integer", enum: [1, 2, 3] });
  assert.deepEqual(agentToolParameters(z.string().max(200).nullable().optional()), { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] });
});

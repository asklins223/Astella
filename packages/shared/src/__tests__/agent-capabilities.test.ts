import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { agentGoalToolManifest, noteAgentCapabilityManifest, agentGoalExecutionManifest, resolveAgentGoalExecutionManifest } from "../agent/agent-capabilities.ts";
import { agentToolParameters } from "../agent/agent-tool-parameters.ts";
import { createAgentRunV1Schema } from "../contracts/agent/agent-contracts.ts";
import { getCompanionAgentTool, validateCompanionAgentToolArguments } from "../agent/companion-agent-registry.ts";

test("批量看图公开12图数组合同，拒绝重复、超量和含混身份，单图仍可调用", () => {
  const ids=Array.from({length:13},(_,i)=>`11111111-1111-4111-8111-${String(i).padStart(12,"0")}`);
  const validate=(args:unknown)=>validateCompanionAgentToolArguments("companion_visual",args).success;
  assert.equal(validate({action:"read_image",assetIds:ids.slice(0,12)}),true);
  assert.equal(validate({action:"read_image",assetId:ids[0]}),true);
  for(const assetIds of [[],[ids[0],ids[0]],ids,["invalid"]]) assert.equal(validate({action:"read_image",assetIds}),false);
  assert.equal(validate({action:"read_image",assetIds:[ids[0]],assetId:ids[1]}),false);
  assert.equal(validate({action:"show_image",assetIds:[ids[0]]}),false);
  const parameters=getCompanionAgentTool("companion_visual")!.parameters as {properties:{assetIds:{maxItems:number}}};
  assert.equal(parameters.properties.assetIds.maxItems,12);
});

test("invalid tool arguments expose repair fields without echoing submitted values", () => {
  const result = validateCompanionAgentToolArguments("companion_attention_write", {
    action: "arrange",
    key: "quiet", expectedRevision: "RAW_PRIVATE_VALUE", intent: "", topics: ["not-a-topic"],
    nextReviewAt: "invalid-time", expiresAt: null, preferenceRevision: 1, selfNote: null, state: "active",
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.issues.some(issue => issue.path.join(".") === "expectedRevision" && issue.expected === "number"));
  assert.ok(result.issues.some(issue => issue.path.join(".") === "intent" && issue.minimum === 1));
  assert.ok(result.issues.some(issue => issue.path.join(".") === "topics.0" && issue.allowedValues?.includes("presence.quiet")));
  assert.ok(result.issues.some(issue => issue.path.join(".") === "nextReviewAt"));
  assert.ok(!JSON.stringify(result).includes("RAW_PRIVATE_VALUE"));
});

test("custom action requirements reach the model as repair text", () => {
  const missing = validateCompanionAgentToolArguments("companion_attention_write", {
    action: "save_participation", enabled: true, sourceQuote: "晚上九点以后别打扰我",
  });
  assert.equal(missing.success, false);
  if (missing.success) return;
  const issue = missing.issues.find(item => item.path.join(".") === "markdown");
  assert.match(String(issue?.message ?? ""), /markdown/);
  assert.match(String(issue?.message ?? ""), /expectedRevision 可省略/);

  const withoutRevision = validateCompanionAgentToolArguments("companion_attention_write", {
    action: "save_participation", markdown: "晚上九点以后不打扰用户", enabled: true,
    sourceQuote: "晚上九点以后别打扰我",
  });
  assert.equal(withoutRevision.success, true, "the host reads the current revision when omitted");
});

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
  const card = getCompanionAgentTool("companion_open")!.parameters as { properties: Record<string, { format?: string }> };
  assert.equal(card.properties.cardId.format, "uuid");
  assert.equal(validateCompanionAgentToolArguments("companion_memory_write", { action: "save", kind: "preference", content: "简短", appliesWhen: "今天" }).success, false);
  assert.deepEqual(agentToolParameters(z.union([z.literal(1), z.literal(2), z.literal(3)])), { type: "integer", enum: [1, 2, 3] });
  assert.deepEqual(agentToolParameters(z.string().max(200).nullable().optional()), { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] });
});

test("note editing exposes inclusive block bounds and actionable repair fields", () => {
  const parameters = getCompanionAgentTool("companion_notes_write")!.parameters as { properties: Record<string, { description?: string }> };
  assert.match(parameters.properties.endBlock.description ?? "", /包含该块/);
  assert.match(parameters.properties.expectedBlocks.description ?? "", /endBlock-startBlock\+1/);
  const base = { action: "edit", noteId: "11111111-1111-4111-8111-111111111111",
    noteVersionId: "22222222-2222-4222-8222-222222222222", operation: "replace_blocks", markdown: "甲\n\n乙" };
  const missing = validateCompanionAgentToolArguments("companion_notes_write", base);
  assert.equal(missing.success, false);
  if (!missing.success) {
    assert.ok(missing.issues.some(issue => issue.path.join(".") === "startBlock"));
    assert.ok(missing.issues.some(issue => issue.path.join(".") === "endBlock"));
  }
  const wrong = validateCompanionAgentToolArguments("companion_notes_write", { ...base, startBlock: 1, endBlock: 2, expectedBlocks: ["原文"] });
  assert.equal(wrong.success, false);
  if (!wrong.success) assert.ok(wrong.issues.some(issue => issue.path.join(".") === "expectedBlocks" && /2 块/.test(issue.message ?? "")));
  assert.equal(validateCompanionAgentToolArguments("companion_notes_write", { ...base, startBlock: 1, endBlock: 2, expectedBlocks: ["原甲", "原乙"] }).success, true);
});

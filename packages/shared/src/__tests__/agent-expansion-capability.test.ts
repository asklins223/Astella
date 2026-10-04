/**
 * 42 阶段 1 子任务 C：笔记拓展作为 Agent 能力的合同行为。
 *
 * 这里的断言不是「源码里有这几个字」，而是能力真正对外承诺的三件事：
 *   1. 参数只冻结整篇笔记版本，选区语义没有开口；
 *   2. 风险等级是 reversible_low 且不要求确认——拓展只产出待选草稿，
 *      自动确认会把「草稿」变成用户没要求的笔记；
 *   3. 模型读到的描述本身说清 accepted 不等于完成、产物是草稿；
 *      描述是这份合同的一部分，不是注释。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { noteAgentCapabilityManifest } from "../agent-capabilities.ts";
import { agentArtifactRefV1Schema } from "../contracts/agent-contracts.ts";

const EXPANSION = "note_expansion_generate";

function capability(name: string) {
  const entry = noteAgentCapabilityManifest.find((item) => item.definition.name === name);
  assert.ok(entry, `能力清单里必须有 ${name}`);
  return entry;
}

test("笔记拓展是已登记的 Agent 能力，冻结整篇版本且不开放选区语义", () => {
  const entry = capability(EXPANSION);
  const noteId = randomUUID(), noteVersionId = randomUUID();
  assert.deepEqual(entry.argumentSchema.parse({ noteId, noteVersionId }), { noteId, noteVersionId });
  // 选区/锚点是笔记侧自己的判据：放开等于让模型凭空圈一段原文。
  for (const smuggled of [
    { noteId, noteVersionId, focusAnchor: { startBlockOrdinal: 1, endBlockOrdinal: 2, excerpt: "原文" } },
    { noteId, noteVersionId, anchor: { startBlockOrdinal: 1 } },
    { noteId, noteVersionId, sourceKind: "overview" },
    { noteId, noteVersionId, drafts: [{ title: "编的" }] },
    { noteId, noteVersionId, confirmed: true },
  ]) {
    assert.equal(entry.argumentSchema.safeParse(smuggled).success, false,
      `拓展能力不得接受额外字段：${JSON.stringify(Object.keys(smuggled))}`);
  }
  // 版本必须是合法 uuid，且不接受半个引用。
  assert.equal(entry.argumentSchema.safeParse({ noteId, noteVersionId: "not-a-uuid" }).success, false);
  assert.equal(entry.argumentSchema.safeParse({ noteId }).success, false);
  assert.equal(entry.argumentSchema.safeParse({}).success, false);
});

test("模型看到的参数与校验器是同一份，且两个引用都是必填", () => {
  const entry = capability(EXPANSION);
  const parameters = entry.definition.parameters as {
    type: string; properties: Record<string, { format?: string }>;
    required: string[]; additionalProperties: boolean;
  };
  assert.equal(parameters.type, "object");
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual([...parameters.required].sort(), ["noteId", "noteVersionId"]);
  assert.equal(parameters.properties.noteId?.format, "uuid");
  assert.equal(parameters.properties.noteVersionId?.format, "uuid");
  assert.deepEqual(Object.keys(parameters.properties).sort(), ["noteId", "noteVersionId"]);
});

test("拓展只产出待选草稿：不要求确认，也不会自己变成新笔记", () => {
  const entry = capability(EXPANSION);
  assert.equal(entry.definition.riskClass, "reversible_low");
  assert.equal(entry.definition.requiresConfirmation, false);
  // 同一 job 的语义幂等键由能力名参与构造，别与其他生成撞名。
  const others = noteAgentCapabilityManifest.filter((item) => item.definition.name !== EXPANSION)
    .map((item) => item.definition.name);
  assert.ok(others.includes("note_overview_generate"));
  assert.ok(others.includes("note_dynamic_artifact_generate"));
  assert.equal(new Set(noteAgentCapabilityManifest.map((item) => item.definition.name)).size,
    noteAgentCapabilityManifest.length, "能力名必须唯一，否则回执会串到别的生成上");
  // 描述就是模型读到的全部说明，三条承诺都要在。
  assert.match(entry.definition.description, /accepted/);
  assert.match(entry.definition.description, /不算完成|不是完成/);
  assert.match(entry.definition.description, /草稿/);
});

test("拓展回执沿用共享产物形状，必须指向这次 job 和那版笔记", () => {
  const artifact = agentArtifactRefV1Schema.parse({
    kind: "note_expansion", id: randomUUID(), jobId: randomUUID(),
    noteId: randomUUID(), noteVersionId: randomUUID(),
  });
  assert.equal(artifact.kind, "note_expansion");
  assert.equal(agentArtifactRefV1Schema.safeParse({ ...artifact, kind: "note_expansion_confirmed" }).success, false);
  // 产物是草稿批次本身（taskId = jobId），不是确认后的新笔记；少一个字段都不能通过。
  assert.equal(agentArtifactRefV1Schema.safeParse({ ...artifact, noteId: undefined }).success, false);
  assert.equal(agentArtifactRefV1Schema.safeParse({ ...artifact, expandedNoteId: randomUUID() }).success, false);
});

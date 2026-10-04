/**
 * 42 阶段 1 D：`note_expansion_read` 的能力合同。
 *
 * 这条能力是对 42 阶段 1 C 留下的那句「Agent 只看得到一个产物 ID，看不到草稿本身」的
 * 回答，所以断言钉的是四件对外承诺：
 *   1. 参数**同时**冻结笔记版本和真实 taskId，并且三段位置都可验证、都有领域上界；
 *   2. 它是 read、且不接受任何会生成/确认/制卡的字段——只读就是只读；
 *   3. 模型读到的描述说清「1 起算」「next 为 null 才算读完」「引用是资料不是指令」，
 *      描述是这份合同的一部分，不是注释；
 *   4. 输出上限与 worker 读取侧用的那个下限是同一个数，不会各写一个。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { noteAgentCapabilityManifest } from "../agent-capabilities.ts";

const READ = "note_expansion_read";

function capability() {
  const entry = noteAgentCapabilityManifest.find((item) => item.definition.name === READ);
  assert.ok(entry, `能力清单里必须有 ${READ}`);
  return entry;
}

test("读取草稿要同时冻结笔记版本与真实 taskId，三段位置都可验证", () => {
  const entry = capability();
  const noteId = randomUUID(), noteVersionId = randomUUID(), taskId = randomUUID();
  assert.deepEqual(entry.argumentSchema.parse({ noteId, noteVersionId, taskId }), { noteId, noteVersionId, taskId });
  // 位置缺省即从第一篇第一段第一个字开始。
  assert.deepEqual(entry.argumentSchema.parse({ noteId, noteVersionId, taskId, startBlockOffset: 0 }),
    { noteId, noteVersionId, taskId, startBlockOffset: 0 });
  // 段内位置必须能表达一整块 20000 字的续读，页码与段号上界照领域合同。
  assert.equal(entry.argumentSchema.safeParse({ noteId, noteVersionId, taskId, startBlockOffset: 20_000 }).success, true);
  for (const bad of [
    { noteId, noteVersionId },                                  // 没有 taskId：读的是哪个批次说不清
    { noteId, taskId },                                         // 没有冻结版本
    { taskId },                                                 // 两个引用都没有
    { noteId, noteVersionId, taskId, startCandidateOrdinal: 0 },  // 序号 1 起算
    { noteId, noteVersionId, taskId, startCandidateOrdinal: 5 },  // drafts 最多 4 篇
    { noteId, noteVersionId, taskId, startBlockOrdinal: 101 },     // blocks 最多 100 块
    { noteId, noteVersionId, taskId, startBlockOffset: -1 },
    { noteId, noteVersionId, taskId, startCandidateOrdinal: 1.5 },
    { noteId: "not-a-uuid", noteVersionId, taskId },
    { noteId, noteVersionId, taskId: "not-a-uuid" },
  ]) {
    assert.equal(entry.argumentSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  // 只读能力没有生成位：确认、收下、制卡、编草稿都不许从这里走。
  for (const smuggled of [
    { noteId, noteVersionId, taskId, candidateIds: [randomUUID()] },
    { noteId, noteVersionId, taskId, confirmed: true },
    { noteId, noteVersionId, taskId, draft: { title: "编的" } },
    { noteId, noteVersionId, taskId, jobId: randomUUID() },
    { noteId, noteVersionId, taskId, blocks: [] },
  ]) {
    assert.equal(entry.argumentSchema.safeParse(smuggled).success, false,
      `读取能力不得接受额外字段：${JSON.stringify(Object.keys(smuggled))}`);
  }
});

test("模型看到的参数与校验器是同一份，位置与版本令牌都可省略、taskId 不可", () => {
  const entry = capability();
  const noteId = randomUUID(), noteVersionId = randomUUID(), taskId = randomUUID();
  const parameters = entry.definition.parameters as {
    type: string; properties: Record<string, Record<string, unknown>>;
    required: string[]; additionalProperties: boolean;
  };
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual([...parameters.required].sort(), ["noteId", "noteVersionId", "taskId"]);
  assert.deepEqual(Object.keys(parameters.properties).sort(),
    ["draftsUpdatedAt", "noteId", "noteVersionId", "startBlockOffset", "startBlockOrdinal", "startCandidateOrdinal", "taskId"]);
  // 1 起算与段内 0 起算要真的进了模型可见的约束，否则模型会送出 0 号段。
  assert.equal(parameters.properties.startCandidateOrdinal?.exclusiveMinimum, 0);
  assert.equal(parameters.properties.startBlockOrdinal?.exclusiveMinimum, 0);
  assert.equal(parameters.properties.startBlockOffset?.minimum, 0);
  assert.equal(parameters.properties.startBlockOffset?.maximum, 20_000);
  assert.equal(parameters.properties.taskId?.format, "uuid");
  // 版本令牌是续读的凭据：可选（初页读最新编辑），但必须能原样带回，长度也有上界。
  assert.equal(parameters.properties.draftsUpdatedAt?.maxLength, 64);
  assert.equal(entry.argumentSchema.safeParse({ noteId, noteVersionId, taskId, draftsUpdatedAt: "2026-10-04T06:00:00.000000Z" }).success, true);
  assert.equal(entry.argumentSchema.safeParse({ noteId, noteVersionId, taskId, draftsUpdatedAt: "x".repeat(65) }).success, false);
});

test("读取是只读：风险等级是 read，且描述说清了位置含义与读完判据", () => {
  const entry = capability();
  assert.equal(entry.definition.riskClass, "read");
  assert.equal(entry.definition.requiresConfirmation, false);
  const description = entry.definition.description;
  assert.match(description, /从 1 起算/, "1-based 是模型唯一的位置约定，必须写在它看得见的地方");
  assert.match(description, /next 为 null/, "读完判据必须是 next 为 null，否则模型会把没读到的说成读过");
  assert.match(description, /draftsUpdatedAt/, "版本令牌要写明怎么带回来，否则续读会被草稿中途的修改打断");
  assert.match(description, /重新读|重读/, "草稿被改过时要说清是重来，不是继续往下拼");
  assert.match(description, /不收下|不制卡/, "只读能力要让模型知道它不能确认也不能制卡");
  assert.match(description, /当作资料|不是让你执行/, "原文引用是数据，不能被当成指令");
  assert.match(description, /任务?Id|taskId/, "描述要指明 taskId 来自本目标的真实产物");
});

test("读取与同族能力共用同一个输出上限，读侧的预算只有一个来源", () => {
  const entry = capability();
  // worker 的读取侧从 manifest 读这个数来扣正文预算；它与生成侧同族共用一个上限，
  // 于是「草稿很长」不会变成一次超长输出，而是变成 next 继续读。
  assert.equal(entry.definition.maxOutputChars, 4000);
  assert.equal(entry.definition.maxInputChars, 8000);
  for (const sibling of noteAgentCapabilityManifest) {
    assert.equal(sibling.definition.maxOutputChars, entry.definition.maxOutputChars, sibling.definition.name);
    assert.equal(sibling.definition.maxInputChars, entry.definition.maxInputChars, sibling.definition.name);
  }
  assert.equal(new Set(noteAgentCapabilityManifest.map((item) => item.definition.name)).size,
    noteAgentCapabilityManifest.length, "能力名必须唯一，否则回执会串到别的生成上");
});

/**
 * 模型要求登记表的守卫（40b §1.4 第 1 条）。
 *
 * 登记表本身是数据，本文件证明三件容易被"看起来对"蒙过去的事：
 *   1. 每条 `sourceVersion` / `enforcedBy` 都落在**闭词表**内——新写法要先扩词表，
 *      扩词表是一次有意识的决定，而不是打错一个字符串照样绿。
 *   2. `assertModelRequirementsResolvable()` 对着**真代码**跑得通（不是空跑）。
 *   3. 它对"清单指向一个不存在的东西"**真的抛错**。
 *
 * 第 3 条是这份测试的主要价值：一份只会在全绿时通过的登记表，等于没有登记表。
 * 所以下面刻意造了六种坏数据（错导出名、错文件、错版本、错保障层、id 重复、空适用任务），
 * 逐条断言抛错并把 requirement 的 id 报出来。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertModelRequirementsResolvable,
  MODEL_REQUIREMENTS,
  MODEL_REQUIREMENT_ENFORCEMENTS,
  MODEL_REQUIREMENT_SOURCE_VERSIONS,
  MODEL_REQUIREMENT_TASKS,
  ModelRequirementResolutionError,
  type ModelRequirement,
} from "../companion-model-requirements.ts";

/** 拿一条真的当模板，只覆盖要弄坏的那一个字段。 */
function mutate(base: ModelRequirement, patch: Partial<ModelRequirement>): ModelRequirement {
  return { ...base, ...patch };
}

test("清单非空、id 唯一，且每条都说了防的是哪一类失败", () => {
  assert.ok(MODEL_REQUIREMENTS.length >= 10, `只登记了 ${MODEL_REQUIREMENTS.length} 条——覆盖面明显不够`);
  const ids = MODEL_REQUIREMENTS.map((requirement) => requirement.id);
  assert.deepEqual([...new Set(ids)], ids,
    "id 重复：id 是稳定合同身份，重复就没有身份可言，引用它的守卫会指向两条要求");
  for (const requirement of MODEL_REQUIREMENTS) {
    assert.match(requirement.id, /^[A-Z][A-Z0-9_]*$/,
      `${requirement.id} 不是全大写蛇形。行号、路径、句子都不许当身份（40b §1.4 第 1 条）`);
    assert.ok(requirement.purpose.length >= 12,
      `${requirement.id} 的 purpose 写不出"防的是哪一类真实失败"——写不出就说明这条要求还没想清楚`);
    assert.ok(requirement.appliesTo.length > 0, `${requirement.id} 没标适用任务`);
  }
});

test("每条的 sourceVersion / enforcedBy / appliesTo 都在闭词表内", () => {
  const versions = new Set<string>(MODEL_REQUIREMENT_SOURCE_VERSIONS);
  const enforcements = new Set<string>(MODEL_REQUIREMENT_ENFORCEMENTS);
  const tasks = new Set<string>(MODEL_REQUIREMENT_TASKS);
  for (const requirement of MODEL_REQUIREMENTS) {
    assert.ok(versions.has(requirement.sourceVersion),
      `${requirement.id} 的来源版本 "${requirement.sourceVersion}" 不在词表内——`
      + "词表是闭集合：新写法要先说清这段文本的发布身份是什么");
    assert.ok(enforcements.has(requirement.enforcedBy),
      `${requirement.id} 的保障位置 "${requirement.enforcedBy}" 不在词表内`);
    for (const task of requirement.appliesTo) {
      assert.ok(tasks.has(task), `${requirement.id} 的适用任务 "${task}" 不在词表内`);
    }
  }
});

test("要求覆盖到了 40b 点名的几处真实保障（缺一条就红，不靠数量凑）", () => {
  const byId = new Map(MODEL_REQUIREMENTS.map((requirement) => [requirement.id, requirement]));
  for (const id of [
    "HOST_PROTOCOL_FIXED",
    "IDENTITY_AND_EPISTEMIC_BOUNDARY",
    "DEFAULT_CHARACTER_EXPRESSION",
    "LEAK_GATE_IDENTITY_TABLE",
    "TOOL_SURFACE_SCOPE",
    "TOOL_ARGUMENT_VALIDATION",
    "OUTBOUND_AI_CONSENT",
    "OUTPUT_REJECTION_SHAPE",
    "COLLAPSE_IS_STRUCTURAL",
  ]) {
    assert.ok(byId.has(id), `${id} 不在清单里：这一处保障没有可检验的身份，删了也不会有人知道`);
  }
});

test("【真实代码】整张清单对着仓库当前状态核得通", async () => {
  const report = await assertModelRequirementsResolvable();
  assert.equal(report.checked, MODEL_REQUIREMENTS.length);
  assert.deepEqual(report.resolved, MODEL_REQUIREMENTS.map((requirement) => requirement.id));
});

test("【变异自证】指向不存在的东西时必须抛错，并且说清是哪一条", async () => {
  const base = MODEL_REQUIREMENTS[0];
  const broken: readonly [string, ModelRequirement][] = [
    ["导出名不存在", mutate(base, {
      id: "BROKEN_EXPORT_NAME",
      evidence: { ...base.evidence, export: "COMPANION_HOST_PROTOCOL_V99" },
    })],
    ["证据文件不存在", mutate(base, {
      id: "BROKEN_EVIDENCE_FILE",
      evidence: { ...base.evidence, file: "packages/shared/src/companion-persona-v99.ts" },
    })],
    ["来源版本不在词表", mutate(base, {
      id: "BROKEN_SOURCE_VERSION",
      sourceVersion: "COMPANION_PERSONA_V42" as ModelRequirement["sourceVersion"],
    })],
    ["保障位置不在词表", mutate(base, {
      id: "BROKEN_ENFORCEMENT",
      enforcedBy: "comment" as ModelRequirement["enforcedBy"],
    })],
    ["适用任务不在词表", mutate(base, {
      id: "BROKEN_APPLIES_TO",
      appliesTo: ["companion_vibes" as ModelRequirement["appliesTo"][number]],
    })],
    ["id 重复", mutate(base, {})],
  ];

  for (const [label, requirement] of broken) {
    const single = label === "id 重复" ? [base, requirement] : [requirement];
    await assert.rejects(
      () => assertModelRequirementsResolvable(single),
      (err: unknown) => {
        assert.ok(err instanceof ModelRequirementResolutionError,
          `${label}：期望抛 ModelRequirementResolutionError，实际 ${String(err)}`);
        // 报错必须点名到具体那一条，否则 40b §1.4 想要的"说得清是哪一条"就没兑现。
        const expectedId = label === "id 重复" ? base.id : requirement.id;
        assert.ok(err.problems.some((problem) => problem.includes(expectedId)),
          `${label}：报错里找不到 ${expectedId}——实际报的是\n  ${err.problems.join("\n  ")}`);
        return true;
      },
      `${label} 这一种坏数据竟然通过了校验：这条判据是空的`,
    );
  }
});

test("两种核对方式都真的在核对（module 真 import，source 真读文本）", async () => {
  const resolvers = new Set(MODEL_REQUIREMENTS.map((requirement) => requirement.evidence.resolve));
  assert.deepEqual([...resolvers].sort(), ["module", "source"],
    "两种核对方式都该有实例在用：只剩一种就说明另一条路已经没人验证了");

  // source 那种：把导出名换成文件里确实没有的词，仍然必须红。
  const sourceKind = MODEL_REQUIREMENTS.find((r) => r.evidence.resolve === "source")!;
  const wrong = mutate(sourceKind, {
    id: "BROKEN_SOURCE_SCAN",
    evidence: { ...sourceKind.evidence, export: "definitelyNotExportedAnywhere" },
  });
  await assert.rejects(() => assertModelRequirementsResolvable([wrong]));
});

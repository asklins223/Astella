/**
 * 「本人对建议关系的表态」判据与叠加语义的单测（39d W5-6 刀七；39 §11.3）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideRelationDecisionV2,
  decideSharedRelationWriteV2,
  personalRelationDecisionV2Schema,
  personalRelationKindV2Schema,
  relationsWritesNothingSharedV2,
} from "./personal-relation-decision-rules-v2.ts";

test("两端都读得到 + 合法表态 ⇒ 成立", () => {
  assert.deepEqual(
    decideRelationDecisionV2({
      fromReadable: true,
      toReadable: true,
      sameObjective: false,
      decision: "confirmed",
    }),
    { allowed: true },
  );
});

test("任一端读不到就不成立（§11.3 首期只做单篇可核对关系）", () => {
  for (const [fromReadable, toReadable] of [[false, true], [true, false], [false, false]]) {
    assert.deepEqual(
      decideRelationDecisionV2({ fromReadable, toReadable, sameObjective: false, decision: "confirmed" }),
      { allowed: false, reasonCode: "missing_endpoints" },
    );
  }
});

test("自环不是关系", () => {
  assert.deepEqual(
    decideRelationDecisionV2({
      fromReadable: true,
      toReadable: true,
      sameObjective: true,
      decision: "confirmed",
    }),
    { allowed: false, reasonCode: "same_objective" },
  );
});

test("§11.3：只影响本人的学习视图，不改公共知识结构", () => {
  const writes = relationsWritesNothingSharedV2();
  assert.equal(writes.writesPersonalDecisionTable, true);
  // 这五条是**常量**判据，不是判断：确认一次关系只写那一张按人收的表，
  // 其余全是 false。哪天任何一条能返回 true，§11.3「不能让只读成员的确认修改公共
  // 知识结构」与「不伪造过去的学习事实」就破了——而那种破损在集成测试里很难看出来
  // （行数确实没涨，只是公共快照里多了一列被改了）。
  assert.equal(writes.writesSharedRelationsJsonb, false);
  assert.equal(writes.mutatesObjectiveLifecycle, false);
  assert.equal(writes.createsCrossMemberRows, false);
  assert.equal(writes.writesEvidenceTable, false);
  assert.equal(writes.createsReviewSchedule, false);
});

test("共享关系要材料编辑权 + 明确作用范围；个人视图不受影响（§11.3 / §4.2）", () => {
  // 只读成员：不能写公共结构，**但**个人视图照旧允许——这正是 §4.2
  // 「不能为了获得稳定 ID 要求公共编辑权」在关系这一半的形状。
  const readonly = decideSharedRelationWriteV2({
    isNoteAuthor: false,
    hasMaterialEditRight: false,
    scopeDeclared: true,
  });
  assert.equal(readonly.mayWriteShared, false);
  assert.equal(readonly.personalViewStillAllowed, true);
  assert.equal((readonly as { reasonCode?: string }).reasonCode, "no_material_edit_right");

  // 作用范围没说清 ⇒ 也不许写（§11.3「明确作用范围」）。
  const unscoped = decideSharedRelationWriteV2({
    isNoteAuthor: true,
    hasMaterialEditRight: true,
    scopeDeclared: false,
  });
  assert.equal(unscoped.mayWriteShared, false);
  assert.equal(unscoped.personalViewStillAllowed, true);
  assert.equal((unscoped as { reasonCode?: string }).reasonCode, "scope_not_declared");

  // 两者都齐才写得了。
  assert.deepEqual(
    decideSharedRelationWriteV2({ isNoteAuthor: true, hasMaterialEditRight: true, scopeDeclared: true }),
    { mayWriteShared: true, personalViewStillAllowed: true },
  );
});

test("四类关系是四个取值，不许压成一个「相关」（§11.3 明确要分开表达）", () => {
  assert.deepEqual(
    [...personalRelationKindV2Schema.options].sort(),
    ["contrasts", "explains", "prerequisite", "relates_to"],
  );
  // 压成一个的那天，这条会红。
  assert.equal(personalRelationKindV2Schema.safeParse("related").success, false);
});

test("只有 confirmed / dismissed 两种表态：没表态就是不写这一行", () => {
  assert.deepEqual([...personalRelationDecisionV2Schema.options].sort(), ["confirmed", "dismissed"]);
  // `pending` 那一档**不存在**：写成状态会让「还没看」与「看过并保留」在读侧长得一样，
  // 而 §11.3 说的正是"待确认建议"要能与"已确认"分开——"没表态"是**没有这一行**。
  for (const notAThing of ["pending", "ignored", "seen", "maybe"]) {
    assert.equal(
      personalRelationDecisionV2Schema.safeParse(notAThing).success,
      false,
      `${notAThing} 这一档不该存在：没表态就是不写，不是写一个状态`,
    );
  }
});

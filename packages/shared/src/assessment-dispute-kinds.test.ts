/**
 * 争议与更正的取值表只许有一份，且必须与 0296 的 CHECK 一字不差。
 *
 * 与 `learning-exposure-kinds.test.ts` 同一族守卫。理由一样具体：这些取值散在四处——
 * 合同的 TS union、zod enum（界面传进来的那一档）、`db-schema/assessment-disputes.ts`
 * 的 `check(...)`、以及迁移 0296 的 `CHECK (… IN (…))`。抄第二遍起它只会漂：加一档时
 * 少改一处**不会红**，只会让那一档在那个读点被静默漏掉——例如 zod 放行了、库当场拒，
 * 症状是 500 而不是"这一档没接上"。
 *
 * 刻意**不**断言"某几档现在有没有生产者"：`learning-exposure-kinds.test.ts` 的第一版
 * 写过这么一条，跑灵敏度判据时被自己抓住（那一档由分类器以变量形状落库，字面量扫不到
 * 不等于没人写）。这里同样只量**同一份取值在几处是否一致**，不量覆盖率。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assessmentCorrectionKindV2Schema,
  assessmentDisputeKindV2Schema,
  assessmentDisputeRecheckOutcomeV2Schema,
  assessmentDisputeStatusV2Schema,
  type AssessmentCorrectionKindV2,
  type AssessmentDisputeKindV2,
  type AssessmentDisputeRecheckOutcomeV2,
  type AssessmentDisputeStatusV2,
} from "./assessment-dispute-rules-v2.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const MIGRATION = "0296_assessment_disputes_v2.sql";

/** 把 CHECK 里 `IN (…)` 的取值抠出来；`kind` 写成 `${t.kind} IN (…)` 也能匹配。 */
function checkValues(sqlText: string, constraint: string): string[] {
  const constraintAt = sqlText.indexOf(constraint);
  assert.notEqual(constraintAt, -1, `${MIGRATION} 里找不到约束 ${constraint}`);
  const tail = sqlText.slice(constraintAt, constraintAt + 800);
  const inList = /\bIN\s*\(([^)]*)\)/.exec(tail);
  assert.ok(inList, `约束 ${constraint} 里解析不出 IN 列表`);
  return [...inList[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const migrationSql = readFileSync(join(REPO_ROOT, "apps/api/src/db/migrations", MIGRATION), "utf8");

/** TS union 与 zod enum 必须是同一份：`union` 少一档 = 那个读点编不过，`enum` 少一档 = 静默拒。 */
function assertSameMembers(
  label: string,
  fromSchema: readonly string[],
  fromUnion: readonly string[],
  constraint: string,
): void {
  assert.deepEqual([...fromSchema].sort(), [...fromUnion].sort(),
    `${label}：TS union 与 zod enum 不是同一份`);
  assert.deepEqual(checkValues(migrationSql, constraint), [...fromSchema],
    `${label}：${MIGRATION} 的 ${constraint} 与合同不一致（加一档要连着改迁移）`);
}

test("争议种类：union、zod 与 0296 的 CHECK 是同一份", () => {
  assertSameMembers("kind", assessmentDisputeKindV2Schema.options,
    ["explanation_faulty", "item_faulty", "misunderstood", "misjudged"] as AssessmentDisputeKindV2[],
    "adv2_kind_chk");
});

test("争议状态：zod 与 0296 的 CHECK 是同一份", () => {
  assertSameMembers("status", assessmentDisputeStatusV2Schema.options,
    ["open", "recheck_upheld", "recheck_corrected", "recheck_undetermined", "closed_held"] as AssessmentDisputeStatusV2[],
    "adv2_status_chk");
});

test("复核三态：zod 与 0296 的 CHECK 是同一份（少了 undetermined 就会逼系统二选一）", () => {
  assertSameMembers("recheckOutcome", assessmentDisputeRecheckOutcomeV2Schema.options,
    ["upheld", "corrected", "undetermined"] as AssessmentDisputeRecheckOutcomeV2[],
    "adv2_outcome_chk");
});

test("更正两档：zod 与 0296 的 CHECK 是同一份（§16.25 两者不混算）", () => {
  assertSameMembers("correctionKind", assessmentCorrectionKindV2Schema.options,
    ["system_misjudgment", "user_supplement"] as AssessmentCorrectionKindV2[],
    "acv2_kind_chk");
});

test("union 覆盖 zod 的每一档：少一档时这里是类型错，不是运行期才发现", () => {
  // 编译期那一半：`Record` 要求 union 的每一档都能当键，zod 多出来的一档立刻报错。
  const kindUnion: Record<AssessmentDisputeKindV2, true> = {
    explanation_faulty: true,
    item_faulty: true,
    misunderstood: true,
    misjudged: true,
  };
  const outcomeUnion: Record<AssessmentDisputeRecheckOutcomeV2, true> = {
    upheld: true,
    corrected: true,
    undetermined: true,
  };
  const correctionUnion: Record<AssessmentCorrectionKindV2, true> = {
    system_misjudgment: true,
    user_supplement: true,
  };
  assert.equal(Object.keys(kindUnion).length, assessmentDisputeKindV2Schema.options.length);
  assert.equal(Object.keys(outcomeUnion).length, assessmentDisputeRecheckOutcomeV2Schema.options.length);
  assert.equal(Object.keys(correctionUnion).length, assessmentCorrectionKindV2Schema.options.length);
});

test("判据自己的灵敏度：迁移解析数错取值时要红", () => {
  const synthetic = "CONSTRAINT x_chk CHECK (kind IN ('a_kind','b_kind'))";
  assert.deepEqual(checkValues(synthetic, "x_chk"), ["a_kind", "b_kind"]);
  // 换个约束名就读不到——证明上面几格不是"永远解析出同一个东西"。
  assert.throws(() => checkValues(synthetic, "not_there_chk"), /找不到约束/);
});

test("0296 仍在迁移目录里且被 journal 收着（迁移掉了这份守卫就该一起红）", () => {
  const names = readdirSync(join(REPO_ROOT, "apps/api/src/db/migrations"));
  assert.ok(names.includes(MIGRATION), `${MIGRATION} 不在迁移目录里`);
  const journal = JSON.parse(
    readFileSync(join(REPO_ROOT, "apps/api/src/db/migrations/meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  assert.ok(
    journal.entries.some((entry) => entry.tag === "0296_assessment_disputes_v2"),
    "0296 没有进 journal，跑起来不会被应用",
  );
});

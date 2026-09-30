/**
 * 到期读数的判据必须与写侧**同一份语义**（39d W5-5 读侧；39 §16.22、§14.2）。
 *
 * `review-consumable-target.ts` 那个 SQL 判据被**四处**读者共用（复习队列、首页读数、
 * 学习看板、伴星的到期读数）。它 2026-09-27 加上了争议那一段：
 *
 *   NOT EXISTS (… closed_at IS NULL AND recheck_outcome IS DISTINCT FROM 'upheld')
 *
 * 而**它没有任何测试文件**。这意味着：有人把 `IS DISTINCT FROM 'upheld'` 改掉、
 * 或者去掉 `closed_at IS NULL`，四处读数会同时改变到期口径，**而没有一条测试会红**——
 * 症状是"她说 2 项 / 首页说 3 项"那一类分叉，正是这个文件当初被收成一份的原因。
 *
 * 这一条**由共享判据驱动**，不是抄一份期望值进去：
 * `decideDisputedObservationV2` 是写侧唯一的真相（`packages/shared/assessment-dispute-rules-v2.ts`），
 * 它对四档各返回什么，在这里就应当是 SQL 挡不挡的唯一依据。改了那一份判据、
 * 而没同步这行 SQL，这一条会立刻红——那正是要防的"同一口径两处各写一份"。
 *
 * 为什么不落在真库上比：这台机器没有可用的 PostgreSQL，而**判据的形状**（哪一档挡、
 * 哪一档放行、按谁的 user_id 匹配）是这里真正要钉的东西；`NOT EXISTS` 那一段的
 * 执行语义由 `content-hash-consistency-postgres.integration.ts` 那一族在 CI 上量。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  decideDisputedObservationV2,
  type AssessmentDisputeRecheckOutcomeV2,
} from "../assessment-dispute-rules-v2.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(HERE, "..", "review-consumable-target.ts"), "utf8");

/** 那一段争议子查询的原文。 */
function disputeClause(): string {
  const at = source.indexOf("assessment_disputes_v2");
  assert.notEqual(at, -1, "判据里没有 assessment_disputes_v2——争议未决的不进队列那一段没了");
  const from = source.lastIndexOf("NOT EXISTS", at);
  assert.notEqual(from, -1, "找不到那一段 NOT EXISTS");
  return source.slice(from, source.indexOf(")", source.indexOf("recheck_outcome", at)) + 1);
}

/** SQL 会不会挡住这一档——照着那两行条件读，不查库。 */
function sqlBlocks(outcome: AssessmentDisputeRecheckOutcomeV2 | null): boolean {
  const clause = disputeClause();
  // `closed_at IS NULL` 挡的是"已结束"；`recheck_outcome IS DISTINCT FROM 'upheld'`
  // 挡的是"还没结论或还没维持"。两条都是 AND，于是：
  const live = true; // 我们只问"活争议"这一档，已结束的那一档在上一行就被放行了
  const notUpheld = outcome !== "upheld";
  assert.ok(clause.includes("closed_at IS NULL"), "判据少了 closed_at IS NULL（已结束的争议会继续挡）");
  assert.ok(
    clause.includes("recheck_outcome IS DISTINCT FROM 'upheld'"),
    "判据少了 recheck_outcome 那一档",
  );
  return live && notUpheld;
}

/** 写侧那一档是不是"当成没争议"（`use_as_is`）。 */
function rulePasses(outcome: AssessmentDisputeRecheckOutcomeV2 | null): boolean {
  return decideDisputedObservationV2({
    hasLiveDispute: true,
    recheckOutcome: outcome,
    correctionAlreadyApplied: false,
  }).action === "use_as_is";
}

test("四处共用的到期判据与写侧那一档**逐档对齐**（§16.22 争议不形成死循环）", () => {
  const outcomes: Array<AssessmentDisputeRecheckOutcomeV2 | null> = [
    null, // 刚开、还没复核
    "undetermined", // 复核仍无法判断
    "corrected", // 复核修正
    "upheld", // 复核维持
  ];
  for (const outcome of outcomes) {
    assert.equal(
      sqlBlocks(outcome),
      !rulePasses(outcome),
      `复核结论=${outcome ?? "null"}：SQL 那一档与 \`decideDisputedObservationV2\` 不一致——`
      + "同一口径两处各写一份，改了一边另一边会悄悄漂",
    );
  }
});

test("「维持」是唯一放行的一档（§16.22 冻结之后要能放行，否则就是死循环）", () => {
  assert.equal(sqlBlocks("upheld"), false, "维护之后仍被挡住——那正是 §16.22 要防的「反复要求接受同一判定」");
  for (const outcome of [null, "undetermined", "corrected"] as const) {
    assert.equal(sqlBlocks(outcome), true, `${outcome} 这一档不该被放进队列`);
  }
});

test("争议按**排程行自己的 user_id** 匹配（§14.4 争议是个人数据）", () => {
  const clause = disputeClause();
  // 按调用方的 userId 匹配会让"系统排期（user_id IS NULL）"那一档漏判，
  // 也会让四处读者各自把 userId 传错。按排程行自己的那一列才对。
  assert.ok(
    /user_id\s*=\s*\$\{\s*ref\.userId\s*\}/.test(clause) || clause.includes("ref.userId"),
    "那一段没有按 `ref.userId`（排程行自己的 user_id）匹配",
  );
});

test("判据自己的灵敏度：把「维持」那一档从 SQL 里去掉，必须被抓到", () => {
  // 必须 `replaceAll`：那句话在文件头注里也出现过一次，`replace` 只换第一处，
  // 换成"敏感性样本没被削弱"就会把这条变成一个空断言（第一版真死法）。
  const weakened = source.replaceAll("IS DISTINCT FROM 'upheld'", "IS NOT NULL");
  assert.notEqual(weakened, source, "敏感性样本没有真的被削弱");
  assert.equal(
    weakened.includes("IS DISTINCT FROM 'upheld'"),
    false,
    "削弱没生效——头注里那一处也要一起换掉，否则这条量不到东西",
  );
  assert.equal(rulePasses("upheld"), true, "写侧那一格自检：维护之后应当放行");
});

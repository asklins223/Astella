import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * P1-13：`validation_assistance_exposures` 的读必须有界。
 *
 * ## 收口前是什么
 *
 * `review/service.ts` 的结算闸先把这个用户在这个空间的**全部** exposure 行读出来
 * （没有 `limit`、没有过滤），再从里面挑出 `inputScheduleId` 去查 schedules。
 * 也就是说**复习队列每一页**都要把该用户的历史曝光全量搬一遍，
 * 而那些行数只随使用时长增长——"翻页越来越慢"，且随页码线性变差。
 *
 * ## 为什么可以安全地反序
 *
 * exposure 只有在它的 `inputScheduleId` 命中 `schedByObjective` 时才可能写进
 * `eligibleByObjective`，而那些键来自 `subjectId IN (本页 objectiveIds)`。
 * 所以先查本页的 schedule、再按这些 schedule id 读 exposure，与
 * "读全部再筛"得到的是**同一个 max**。
 *
 * 2026-09-29 在真库上验过等价（4 行 exposure，其中 1 行故意挂在**不在本页**的
 * objective 上作为干扰项）：旧实现读 4 行、新实现读 3 行，**结果逐字一致**，
 * 干扰项也都没被误算进来。
 *
 * ## 这条判据拦什么
 *
 * 只认"读 exposure 的那处 `where` 里有没有把 id 收进 `inArray(...)`"。
 * 不设一个行数上限——那会改变语义（可能漏掉 max），而真正的修复是把
 * 无界变成"跟着页大小走"，不是"砍到某个数"。
 */

const REVIEW_SERVICE = join(new URL("..", import.meta.url).pathname, "modules", "review", "service.ts");

test("结算闸读 exposures 时必须用 inArray 收窄到本页的 schedule", () => {
  const source = readFileSync(REVIEW_SERVICE, "utf8");
  const call = source.indexOf("query.validationAssistanceExposures.findMany");
  assert.ok(call >= 0, "没找到 exposures 的读点——判据可能已经和代码脱节了");

  // 取这次 findMany 的 where(...) 片段（到下一个独立的 await 为止）
  const whereBlock = source.slice(call, call + 900);
  const whereStart = whereBlock.indexOf("where: and(");
  assert.ok(whereStart >= 0, "exposures 的读没有 where 子句——那会读全表");
  const whereText = whereBlock.slice(whereStart);

  assert.match(whereText, /inArray\(\s*validationAssistanceExposures\.inputScheduleId/,
    "exposures 的读没有用 inArray 收窄到本页 objective 关联的 schedule——"
    + "那等于每次翻页都把该用户的历史曝光全量搬一遍（P1-13）");
  assert.match(whereText, /eq\(validationAssistanceExposures\.userId/,
    "userId 的范围条件不能丢（那是 RLS 之外的第二道作用域限制）");
});

test("【自证】判据能分辨「收窄了」与「没收窄」", () => {
  const narrowed = `where: and(
      eq(validationAssistanceExposures.workspaceId, workspaceId),
      eq(validationAssistanceExposures.userId, userId),
      inArray(validationAssistanceExposures.inputScheduleId, ids),
    )`;
  const unbounded = `where: and(
      eq(validationAssistanceExposures.workspaceId, workspaceId),
      eq(validationAssistanceExposures.userId, userId),
    )`;
  const re = /inArray\(\s*validationAssistanceExposures\.inputScheduleId/;
  assert.ok(re.test(narrowed), "收窄了的那份必须被认出来");
  assert.equal(re.test(unbounded), false, "没收窄的那份必须被认出来");
});

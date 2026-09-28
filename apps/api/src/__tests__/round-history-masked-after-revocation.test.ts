/**
 * 失权之后仍允许展示的那一份历史（39d W5-6；§10.3 末段、§14.4、§16.13）。
 *
 * ## 为什么要有这一格，而不是「读不到就返回空数组」
 *
 * 返回空数组在屏上与「这一篇从来没有过轮次」**完全一样**，而后者是一个关于用户
 * 自己的事实。空数组那一格自己的注释就写着「空数组是真的『这一篇还没有过轮次』，
 * 不是『读失败』」。所以失权必须是**另一种形状**，而且要说得出是哪一种。
 *
 * ## 三条产品决定
 *
 *  1. **留下不含受保护内容的元数据**：轮次 id／相位／结果／起止时刻／后续确认时刻。
 *     这些回答的是「我什么时候练过、练到哪了」——§10.3 明确说这类要保留。
 *  2. **遮蔽可能复述受保护内容的**：本轮问题（它是从笔记正文生成的摘要，
 *     §6.1 说的「半个答案」就在那里）与「实际方式」（它反映看过哪几道题）。
 *  3. **读侧先收窄，不是读出来再遮蔽**：遮蔽那一支**根本不读**那两格事实——
 *     它们要 join 教学表与判定行才能算，而那一读本身就越过权限边界。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ROUND_HISTORY_MASKED_QUESTION_V1,
  noteLearningRoundHistoryPageV1Schema,
} from "@ailearn/shared/note-learning-round-contracts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SERVICE = readFileSync(
  resolve(REPO_ROOT, "apps/api/src/modules/note-learning-rounds/round-service.ts"), "utf8",
);
const ROUTES = readFileSync(
  resolve(REPO_ROOT, "apps/api/src/modules/note-learning-rounds/routes.ts"), "utf8",
);

const NOTE_ID = "0f9a5c9c-1b3f-4c1e-9c1a-6f2b7d5e4a10";
const ROUND_ID = "1b3f4c1e-9c1a-6f2b-7d5e-4a100f9a5c9c";

const BASE_ITEM = {
  version: 1 as const,
  noteId: NOTE_ID,
  hasMore: false,
  nextCursor: null,
  shownCount: 1,
  totalCount: 1,
  contentMasked: true,
  items: [{
    roundId: ROUND_ID,
    phase: "closed" as const,
    outcome: "completed" as const,
    drivingQuestion: ROUND_HISTORY_MASKED_QUESTION_V1,
    contentMasked: true as const,
    actualModes: [] as never,
    systemUncertain: false,
    followUpSettledAt: null,
    startedAt: "2026-09-20T10:00:00.000Z",
    closedAt: "2026-09-20T10:20:00.000Z",
  }],
};

test("遮蔽那一格要能过公开合同（缺格会被读成「历史读全了」）", () => {
  const parsed = noteLearningRoundHistoryPageV1Schema.safeParse(BASE_ITEM);
  assert.equal(parsed.success, true,
    `遮蔽形状过不了合同：${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
  // 反向：内容Masked 缺了要被拒
  const { contentMasked: _dropped, ...withoutFlag } = BASE_ITEM;
  assert.equal(noteLearningRoundHistoryPageV1Schema.safeParse(withoutFlag).success, false,
    "少了 contentMasked 居然通过：屏上会把遮蔽过的内容当成读全了");
});

test("题面用**固定遮蔽句**，不是空串 —— 空串会被读成「当时没写问题」", () => {
  assert.ok(ROUND_HISTORY_MASKED_QUESTION_V1.length > 0);
  assert.ok(!/^[\s]*$/.test(ROUND_HISTORY_MASKED_QUESTION_V1));
  // 空串那一版必须被合同拒掉
  const withBlank = { ...BASE_ITEM, items: [{ ...BASE_ITEM.items[0], drivingQuestion: "" }] };
  assert.equal(noteLearningRoundHistoryPageV1Schema.safeParse(withBlank).success, false,
    "空串被接受了 —— 那一格在屏上就是「当时没写问题」，一条**假的**历史记录");
});

test("「实际方式」被遮蔽：它反映看过哪几道题，说出来等于复述结构", () => {
  assert.deepEqual(BASE_ITEM.items[0]!.actualModes, []);
  const withModes = {
    ...BASE_ITEM,
    items: [{ ...BASE_ITEM.items[0], actualModes: ["explained", "practiced"] }],
  };
  assert.equal(noteLearningRoundHistoryPageV1Schema.safeParse(withModes).success, false,
    "遮蔽状态仍然报出「实际方式」：那两格是照着教学表与判定行算的");
});

test("读侧先收窄：遮蔽那一支**不读**那两格事实", () => {
  // 判据在路由上：`contentMasked` 那一支必须**在**取事实之前就 return。
  const maskedBranch = ROUTES.indexOf("if (history.contentMasked) return");
  const fetchFacts = ROUTES.indexOf("readRoundHistoryFactsV1(");
  assert.ok(maskedBranch > 0, "路由里读不到「失权就提前返回」那一支（判据可能指错了地方）");
  assert.ok(maskedBranch < fetchFacts,
    "先取了事实再判失权：那两格要 join 教学表与判定行才算得出来，**那一读本身就越过权限边界**");
});

test("遮蔽那一支不经过那个映射：硬过一遍只会编出两格内容", () => {
  const parse = ROUTES.indexOf("items: page.contentMasked");
  assert.ok(parse > 0, "读不到分派那一行");
  const branch = ROUTES.slice(parse, parse + 400);
  assert.match(branch, /NoteLearningRoundHistoryMaskedItemV1/,
    "失权那一支没有直接交出遮蔽项");
  assert.match(branch, /roundHistoryItemV1\(row, facts!\)/,
    "完整那一支仍然走映射（这是对的——它有内容可映射）");
});

test("「本来就没有轮次」与「失权」是**两件事**，不许混", () => {
  // 判据：遮蔽分支的入口条件是**可见范围内为 0**，而它要再读一次不带可见性判据的
  // 总数；那一次为 0 ⇒ 返回 null（不是失权）。
  assert.match(SERVICE, /if \(visibleTotal === 0\)/,
    "读不到「先判权限，别拿 0 当没有轮次」那一处");
  assert.match(SERVICE, /if \(totalCount === 0\) return null;/,
    "不带可见性判据的总数为 0 时必须返回 null：说成「这些记录涉及你已无权查看的内容」"
    + "是在**凭空指控**用户发生过什么");
  // 反向自证：把那个 null 去掉，判据必须失效
  const mutated = SERVICE.replace("if (totalCount === 0) return null;", "");
  assert.ok(!/if \(totalCount === 0\) return null;/.test(mutated),
    "变异没落在正确位置：守卫读不到那一处");
});

test("页面那一格 `contentMasked` 必填且两个值都要能用", () => {
  const full = {
    ...BASE_ITEM,
    contentMasked: false,
    items: [{
      roundId: ROUND_ID,
      phase: "closed" as const,
      outcome: "completed" as const,
      drivingQuestion: "为什么有索引查询仍然可能慢",
      drivingQuestionSource: "suggested" as const,
      drivingQuestionRevision: 1,
      actualModes: ["explained", "practiced"] as never,
      systemUncertain: false,
      followUpSettledAt: null,
      startedAt: "2026-09-20T10:00:00.000Z",
      closedAt: "2026-09-20T10:20:00.000Z",
    }],
  };
  assert.equal(noteLearningRoundHistoryPageV1Schema.safeParse(full).success, true,
    "正常那一支（contentMasked: false）过不了合同");
});

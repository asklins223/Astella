import { test } from "node:test";
import assert from "node:assert/strict";
import { isRoundOpenIndexViolation } from "./round-service.ts";

/**
 * `isRoundOpenIndexViolation` 的单测——这一条判据**只能**这样钉，因为它的输入形状
 * 不是我们定的：drizzle 把驱动错误包了一层，实测（2026-09-26，一次性库上真跑一次
 * 重复 create 抓回来的）是顶层 `Error`、`code === undefined`，
 * `cause.name === "PostgresError"`、`cause.code === "23505"`，
 * 原句 `duplicate key value violates unique constraint "nlr_ws_user_note_open_unique"`。
 *
 * 顶层没有码这件事就是上一版的缺陷本身：`err.code === "23505"` 永远不成立，
 * 于是"这一篇已经有一轮没结束"这个用户看得见的出口，在实际撞索引的那一发上
 * 从来没有出现过——症状是一个没有名字的失败。
 */

const OPEN_INDEX_MESSAGE =
  'duplicate key value violates unique constraint "nlr_ws_user_note_open_unique"';

function wrappedLikeReal(): Error {
  const cause = Object.assign(new Error(OPEN_INDEX_MESSAGE), {
    name: "PostgresError",
    code: "23505",
  });
  return Object.assign(new Error('Failed query: insert into "note_learning_rounds" ...'), { cause });
}

test("真形状（drizzle 包一层、码在 cause 里）认得", () => {
  assert.equal(isRoundOpenIndexViolation(wrappedLikeReal()), true);
});

test("没包装的驱动错误也认得（裸 postgres.js 那条路）", () => {
  const raw = Object.assign(new Error(OPEN_INDEX_MESSAGE), { name: "PostgresError", code: "23505" });
  assert.equal(isRoundOpenIndexViolation(raw), true);
});

test("同为 23505 但是别的唯一索引：不算，不许把内部错误说成「已经有一轮」", () => {
  const pkey = Object.assign(
    new Error('duplicate key value violates unique constraint "note_learning_rounds_pkey"'),
    { name: "PostgresError", code: "23505" },
  );
  assert.equal(isRoundOpenIndexViolation(pkey), false);
});

test("同索引名但不是唯一冲突：不算", () => {
  const weird = Object.assign(new Error(OPEN_INDEX_MESSAGE), { name: "PostgresError", code: "23503" });
  assert.equal(isRoundOpenIndexViolation(weird), false);
});

test("无关错误与非对象输入都不炸、也不误认", () => {
  assert.equal(isRoundOpenIndexViolation(new Error("offline")), false);
  assert.equal(isRoundOpenIndexViolation(undefined), false);
  assert.equal(isRoundOpenIndexViolation("23505"), false);
  // 自引用的 cause 链不能把进程转进死循环。
  const loop: { message: string; code: string; cause?: unknown } = {
    message: "x", code: "23505",
  };
  loop.cause = loop;
  assert.equal(isRoundOpenIndexViolation(loop), false);
});

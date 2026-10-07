import assert from "node:assert/strict";
import { test } from "node:test";

import { companionTurnThinking } from "../companion-turn-thinking.ts";

/**
 * 判据来自本轮的注意力解释（`intent` + `toolUse`），2026-10-06 用户决定：
 * 闲聊要快，解释与任务要稳。
 */
test("纯闲聊轮关思考", () => {
  const decided = companionTurnThinking({ intent: "conversation", toolUse: "none" });
  assert.equal(decided.disableThinking, true);
  assert.equal(decided.basis, "casual:conversation+no-tool");
});

test("提问、任务与混合轮开思考", () => {
  for (const intent of ["question", "task", "task_control", "mixed"]) {
    assert.equal(companionTurnThinking({ intent, toolUse: "none" }).disableThinking, false, intent);
  }
});

test("闲聊话但要她看或动东西时仍开思考", () => {
  for (const toolUse of ["read", "act", "uncertain"]) {
    const decided = companionTurnThinking({ intent: "conversation", toolUse });
    assert.equal(decided.disableThinking, false, toolUse);
    assert.ok(decided.basis.includes(toolUse), decided.basis);
  }
});

test("判不出来时按开处理（分类器兜底是 question/uncertain）", () => {
  assert.equal(companionTurnThinking(null).disableThinking, false);
  assert.equal(companionTurnThinking(undefined).disableThinking, false);
  assert.equal(companionTurnThinking({}).disableThinking, false);
});

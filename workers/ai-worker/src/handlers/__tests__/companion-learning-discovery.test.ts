import assert from "node:assert/strict";
import { test } from "node:test";
import { executeCompanionLearningDiscoveryTool } from "../note/companion-learning-discovery.ts";
import type { AgentEventContext } from "../tools/companion-read-tools.ts";

test("空学习卡搜索词返回空结果，不打开数据库事务", async () => {
  const result = await executeCompanionLearningDiscoveryTool(
    {} as AgentEventContext,
    "notes.read.cards",
    { query: "   " },
  );
  assert.deepEqual(result.value, { cards: [] });
  assert.equal(result.safeSummary, "检索词是空的，我需要先知道要搜什么");
});

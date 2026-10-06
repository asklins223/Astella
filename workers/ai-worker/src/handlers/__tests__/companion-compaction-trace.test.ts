import assert from "node:assert/strict";
import { test } from "node:test";

import { recordTurnCompactionTrace } from "../companion-compaction-trace.ts";
import type { CompanionContextHandoffSnapshotV1 } from "../companion-context-handoff.ts";

/**
 * 方案 44 §5.4：折叠轨迹落不进快照时，**交付不受影响**。
 *
 * 这条单独测，是因为它有一个很容易被"顺手加个 throw"破坏的性质：轨迹只是审计材料，
 * 写不进去说明「这次折了没记上」，不是「这次回复不可信」。一旦抛出去，一句已经
 * 生成好的话会因为审计写不进去而整轮失败。
 */

const target: {
  workspaceId: string; userId: string; runId: string;
  snapshot: CompanionContextHandoffSnapshotV1; sha256: string;
} = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  runId: "00000000-0000-0000-0000-000000000003",
  snapshot: {
    version: 1, providerId: null, modelId: null,
    sources: [], budget: { maxCharacters: 0, droppedSourceIds: [] },
    modelMessages: [],
  } as unknown as CompanionContextHandoffSnapshotV1,
  sha256: "a".repeat(64),
};

test("44 §5.4：这一轮没有折叠时不写新版本，也不碰数据库", async () => {
  assert.equal(await recordTurnCompactionTrace({ ...target, traces: [] }), false);
});

test("44 §5.4：写不进去时返回 false 而不是抛出——回复照常收尾", async () => {
  // 快照来源校验会失败（这里没有任何真实来源），这正是「写不进去」的一种真实形态。
  const result = await recordTurnCompactionTrace({
    ...target,
    write: async () => { throw new Error("source verification failed"); },
    traces: [{
      foldedFromSeq: "1", foldedThroughSeq: "1", foldedMessageCount: 1,
      summarySourceSha256: "b".repeat(64), remainingFromSeq: null, uncoveredBeforeSeq: null,
      modelId: null, inputTokens: 12000, triggerTokens: 10000, hardInputTokens: 15000,
      reason: "over_trigger_line", at: "2026-10-05T00:00:00.000Z",
    }],
  });
  assert.equal(result, false);
});

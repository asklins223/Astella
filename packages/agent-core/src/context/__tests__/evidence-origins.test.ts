import assert from "node:assert/strict";
import { test } from "node:test";
import {
  groupAgentMethodEvidenceOrigins, reconcileEvidenceEpistemicStatus,
} from "../evidence-origins.ts";
import type { AgentMethodEvidenceV1 } from "@ailearn/shared/agent-growth-contracts";

/**
 * 方案 44 §6.4：同源只算一条依据。
 *
 * 要挡的那件事有具体形状：一次运行派生出记忆、摘要、日记、候选，四条一起列进
 * `evidence`，看上去就是「多方印证」——实际只有一个原始来源。
 */

const MEMORY = "11111111-1111-4111-8111-111111111111";
const OTHER_MEMORY = "11111111-1111-4111-8111-111111111112";
const RUN = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN = "22222222-2222-4222-8222-222222222223";

const memoryRef = (id: string, revision = 1): AgentMethodEvidenceV1 => ({ memoryId: id, memoryRevision: revision });
const runRef = (id: string, revision = 1): AgentMethodEvidenceV1 => ({ runId: id, runRevision: revision });

test("44 §6.4：同一次运行派生的记忆与那次运行只算一条依据", () => {
  const grouping = groupAgentMethodEvidenceOrigins([
    { ref: memoryRef(MEMORY), memoryOrigin: { originKey: `run:${RUN}` } },
    { ref: runRef(RUN, 2) },
  ]);
  assert.equal(grouping.independentCount, 1, "记忆与它的来源运行是同一个出处");
  assert.equal(grouping.mergedCount, 1);
  // 留最具体的那条：运行能被 sources_current 完整核对（含它引用的材料版本）。
  assert.deepEqual(grouping.refs, [{ runId: RUN, runRevision: 2 }]);
});

test("44 §6.4：不同来源仍然是不同依据，不误合并", () => {
  const grouping = groupAgentMethodEvidenceOrigins([
    { ref: memoryRef(MEMORY), memoryOrigin: { originKey: `run:${RUN}` } },
    { ref: memoryRef(OTHER_MEMORY), memoryOrigin: { originKey: `run:${OTHER_RUN}` } },
    { ref: { eventId: "event-1" } },
  ]);
  assert.equal(grouping.independentCount, 3);
  assert.equal(grouping.mergedCount, 0);
});

test("44 §6.4：不是从运行派生的记忆，自己就是一个独立来源", () => {
  const grouping = groupAgentMethodEvidenceOrigins([
    { ref: memoryRef(MEMORY), memoryOrigin: null },
    { ref: memoryRef(OTHER_MEMORY), memoryOrigin: null },
  ]);
  assert.equal(grouping.independentCount, 2);
  assert.deepEqual(grouping.refs.map(ref => ref.memoryId).sort(), [MEMORY, OTHER_MEMORY].sort());
});

test("44 §6.4：四条同源重述被压成一条——不得包装成多方印证", () => {
  const grouping = groupAgentMethodEvidenceOrigins([
    { ref: memoryRef(MEMORY), memoryOrigin: { originKey: `run:${RUN}` } },
    { ref: memoryRef(OTHER_MEMORY), memoryOrigin: { originKey: `run:${RUN}` } },
    { ref: runRef(RUN, 5) },
    { ref: { eventId: `memory:${MEMORY}` } },
  ]);
  assert.equal(grouping.independentCount, 2, "四条里只有运行与事件两个出处");
  assert.equal(grouping.mergedCount, 2);
});

test("44 §6.4：多条依据去重后只剩一个来源时，supported 降为 tentative", () => {
  const grouping = groupAgentMethodEvidenceOrigins([
    { ref: memoryRef(MEMORY), memoryOrigin: { originKey: `run:${RUN}` } },
    { ref: runRef(RUN, 1) },
  ]);
  assert.equal(reconcileEvidenceEpistemicStatus({ claimed: "supported", originalCount: 2, grouping }), "tentative");
});

test("44 §6.2：单条依据声称 supported 是允许的——一条可核对的具体事实就够", () => {
  const grouping = groupAgentMethodEvidenceOrigins([{ ref: runRef(RUN, 1) }]);
  assert.equal(reconcileEvidenceEpistemicStatus({ claimed: "supported", originalCount: 1, grouping }), "supported",
    "不能因为「只有一条」就把一次真实的失败条件判成没依据");
});

test("44 §6.4：disputed 与 tentative 原样保留，不被这条规则改写", () => {
  const grouping = groupAgentMethodEvidenceOrigins([{ ref: runRef(RUN, 1) }]);
  assert.equal(reconcileEvidenceEpistemicStatus({ claimed: "disputed", originalCount: 3, grouping }), "disputed");
  assert.equal(reconcileEvidenceEpistemicStatus({ claimed: "tentative", originalCount: 3, grouping }), "tentative");
});

test("44 §6.4：同源多条时保留最具体的一条，其余只在回执里留计数", () => {
  const grouping = groupAgentMethodEvidenceOrigins([
    { ref: { eventId: "event-1" } },
    { ref: memoryRef(MEMORY), memoryOrigin: { originKey: `run:${RUN}` } },
    { ref: runRef(RUN, 3) },
  ]);
  // 来源键不含 revision：同一次运行的记忆与那条运行引用落到同一个键上。
  const origin = grouping.origins.find(entry => entry.originKey === `run:${RUN}`);
  assert.equal(origin?.refCount, 2);
  assert.deepEqual(origin?.kept, { runId: RUN, runRevision: 3 });
});

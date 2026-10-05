/** 操作行 → 公共形状的投影回归（纯函数，无数据库）。 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { agentExecutionRefFromRow, agentOperationArtifacts, projectAgentOperation, type AgentOperationRow } from "../history.ts";

const SCOPE = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
};
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_JOB_ID = "6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a";
const CARD_RUN_ID = "99999999-9999-4999-8999-999999999999";
const OUTBOX_ID = "abababab-abab-4bab-8bab-abababababab";
const NOTE_ID = "77777777-7777-4777-8777-777777777777";
const NOTE_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";

const CARD_CAPABILITY = "card_generation_generate";
const NOTE_ARTIFACT = {
  kind: "note_overview", id: ARTIFACT_ID, jobId: JOB_ID, noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID,
};
const CARD_ARTIFACT = { kind: "card_candidates", id: CARD_RUN_ID, noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID };

function row(overrides: Partial<AgentOperationRow> = {}): AgentOperationRow {
  return {
    id: "44444444-4444-4444-8444-444444444444", revision: 1, capability: "note_overview_generate",
    job_id: JOB_ID, card_generation_run_id: null, card_generation_outbox_id: null,
    status: "succeeded", last_event_seq: "2", result: null, error: null, ...overrides,
  };
}

test("执行体从三列里读出来，两类互斥", () => {
  assert.deepEqual(agentExecutionRefFromRow(row()), { kind: "job", id: JOB_ID });
  assert.deepEqual(
    agentExecutionRefFromRow(row({ job_id: null, card_generation_run_id: CARD_RUN_ID, card_generation_outbox_id: OUTBOX_ID })),
    { kind: "card_generation", id: CARD_RUN_ID },
  );
  // 三列全空不是一种执行体。库里由 XOR CHECK 挡住，读侧也不该猜一个。
  assert.throws(() => agentExecutionRefFromRow(row({ job_id: null })));
});

test("结果列只有一种形状：裸产物引用读成「没有结果」，不再被兜底包一次", () => {
  // 0373 已把存量裸引用包成结果，兜底旧格式只会让「库里有值」与「值合法」变成两件事。
  const legacy = row({ result: NOTE_ARTIFACT });
  assert.equal(projectAgentOperation(SCOPE, RUN_ID, legacy).result, null);
  assert.deepEqual(agentOperationArtifacts([legacy]), []);
});

test("已经是结果形状的不再被包一次", () => {
  const wrapped = row({ result: { kind: "artifact", artifact: NOTE_ARTIFACT } });
  const operation = projectAgentOperation(SCOPE, RUN_ID, wrapped);
  assert.deepEqual(operation.result, { kind: "artifact", artifact: NOTE_ARTIFACT });
});

test("无卡推荐是结果，但不算一张产物", () => {
  const noCards = row({
    capability: CARD_CAPABILITY, job_id: null,
    card_generation_run_id: CARD_RUN_ID, card_generation_outbox_id: OUTBOX_ID,
    result: { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] },
  });
  const operation = projectAgentOperation(SCOPE, RUN_ID, noCards);
  assert.deepEqual(operation.execution, { kind: "card_generation", id: CARD_RUN_ID });
  assert.deepEqual(operation.result, { kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] });
  assert.deepEqual(agentOperationArtifacts([noCards]), [], "零推荐没有可打开的产物");
});

test("制卡候选的 id 必须等于这次 card execution 的 id，否则投影本身非法", () => {
  const cardRow = (cardId: string) => row({
    capability: CARD_CAPABILITY, job_id: null,
    card_generation_run_id: CARD_RUN_ID, card_generation_outbox_id: OUTBOX_ID,
    result: { kind: "artifact", artifact: { ...CARD_ARTIFACT, id: cardId } },
  });
  assert.doesNotThrow(() => projectAgentOperation(SCOPE, RUN_ID, cardRow(CARD_RUN_ID)));
  assert.throws(() => projectAgentOperation(SCOPE, RUN_ID, cardRow(OTHER_JOB_ID)));
});

test("card 侧结果只配 card_generation_generate；错 capability 的投影非法", () => {
  const wrongCapability = (result: unknown) => row({
    capability: "note_overview_generate", job_id: null,
    card_generation_run_id: CARD_RUN_ID, card_generation_outbox_id: OUTBOX_ID, result,
  });
  assert.throws(() => projectAgentOperation(SCOPE, RUN_ID, wrongCapability({ kind: "artifact", artifact: CARD_ARTIFACT })));
  assert.throws(() => projectAgentOperation(SCOPE, RUN_ID,
    wrongCapability({ kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"] })));
});

test("笔记产物挂在别的 job 上时投影非法——不读出一个冒名成果", () => {
  const mismatched = row({ result: { kind: "artifact", artifact: { ...NOTE_ARTIFACT, jobId: OTHER_JOB_ID } } });
  assert.throws(() => projectAgentOperation(SCOPE, RUN_ID, mismatched));
});

test("读不出结果形状的值一律当没有结果，不硬凑一个", () => {
  for (const raw of ["null", 42, [], { kind: "note_overview" }, { kind: "artifact" }, { kind: "card_candidates" }]) {
    const operation = projectAgentOperation(SCOPE, RUN_ID, row({ result: raw }));
    assert.equal(operation.result, null, JSON.stringify(raw));
  }
});

test("last_event_seq 从 bigint 字符串读成数字", () => {
  const operation = projectAgentOperation(SCOPE, RUN_ID, row({ last_event_seq: "17", result: { kind: "artifact", artifact: NOTE_ARTIFACT } }));
  assert.equal(operation.lastEventSeq, 17);
  assert.equal(typeof operation.lastEventSeq, "number");
});
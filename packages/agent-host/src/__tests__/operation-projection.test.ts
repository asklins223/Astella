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
const NOTE_ID = "77777777-7777-4777-8777-777777777777";
const NOTE_VERSION_ID = "88888888-8888-4888-8888-888888888888";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555555";
const NOTE_ARTIFACT = {
  kind: "note_overview", id: ARTIFACT_ID, jobId: JOB_ID, noteId: NOTE_ID, noteVersionId: NOTE_VERSION_ID,
};

function row(overrides: Partial<AgentOperationRow> = {}): AgentOperationRow {
  return {
    id: "44444444-4444-4444-8444-444444444444", revision: 1, capability: "note_overview_generate",
    job_id: JOB_ID,
    status: "succeeded", last_event_seq: "2", result: null, error: null, ...overrides,
  };
}

test("执行体从三列里读出来，两类互斥", () => {
  assert.deepEqual(agentExecutionRefFromRow(row()), { kind: "job", id: JOB_ID });
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

test("笔记产物挂在别的 job 上时投影非法——不读出一个冒名成果", () => {
  const mismatched = row({ result: { kind: "artifact", artifact: { ...NOTE_ARTIFACT, jobId: OTHER_JOB_ID } } });
  assert.throws(() => projectAgentOperation(SCOPE, RUN_ID, mismatched));
});

test("last_event_seq 从 bigint 字符串读成数字", () => {
  const operation = projectAgentOperation(SCOPE, RUN_ID, row({ last_event_seq: "17", result: { kind: "artifact", artifact: NOTE_ARTIFACT } }));
  assert.equal(operation.lastEventSeq, 17);
  assert.equal(typeof operation.lastEventSeq, "number");
});

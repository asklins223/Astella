/**
 * 42 阶段 0 子任务 C：纯回执状态归并的行为回归。
 *
 * 这里钉住的是同一份回执语义在多处视图里必须一致的行为：跨范围/跨身份的事件进不来，
 * 重复与乱序事件不改变状态，终态不被覆写，结果未知不盲目重做，成功必须有核对的产物。
 * 另外确认输入不可变——归并是纯函数，调用方可以放心地保留旧引用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentOperationEventV1, AgentOperationV1 } from "@ailearn/shared/agent-contracts";

import { reduceOperationReceipt } from "../run-state.ts";

const WORKSPACE_ID = "1f0a2b3c-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "1f0a2b3c-0000-4000-8000-000000000002";
const USER_ID = "1f0a2b3c-0000-4000-8000-000000000003";
const OTHER_USER_ID = "1f0a2b3c-0000-4000-8000-000000000004";
const RUN_ID = "1f0a2b3c-0000-4000-8000-000000000005";
const OTHER_RUN_ID = "1f0a2b3c-0000-4000-8000-000000000006";
const OPERATION_ID = "1f0a2b3c-0000-4000-8000-000000000007";
const OTHER_OPERATION_ID = "1f0a2b3c-0000-4000-8000-000000000008";
const JOB_ID = "1f0a2b3c-0000-4000-8000-000000000009";
const OTHER_JOB_ID = "1f0a2b3c-0000-4000-8000-00000000000a";
const NOTE_ID = "1f0a2b3c-0000-4000-8000-00000000000b";
const NOTE_VERSION_ID = "1f0a2b3c-0000-4000-8000-00000000000c";
const ARTIFACT_ID = "1f0a2b3c-0000-4000-8000-00000000000d";

const ARTIFACT: AgentOperationV1["artifact"] = {
  kind: "note_overview",
  id: ARTIFACT_ID,
  jobId: JOB_ID,
  noteId: NOTE_ID,
  noteVersionId: NOTE_VERSION_ID,
};

test("a verified artifact from another job cannot complete this operation", () => {
  const current = operation();
  const result = reduceOperationReceipt(current, event({ status: "succeeded", authoritative: true,
    artifact: { ...ARTIFACT!, jobId: OTHER_JOB_ID } }));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unverified");
  assert.equal(result.operation, current);
});

function operation(overrides: Partial<AgentOperationV1> = {}): AgentOperationV1 {
  return {
    operationId: OPERATION_ID,
    runId: RUN_ID,
    revision: 3,
    scope: { workspaceId: WORKSPACE_ID, userId: USER_ID },
    capability: "note.deepen.dynamic_artifact",
    jobId: JOB_ID,
    status: "running",
    lastEventSeq: 4,
    artifact: null,
    error: null,
    ...overrides,
  };
}

function event(overrides: Partial<AgentOperationEventV1> = {}): AgentOperationEventV1 {
  return {
    operationId: OPERATION_ID,
    runId: RUN_ID,
    revision: 3,
    scope: { workspaceId: WORKSPACE_ID, userId: USER_ID },
    jobId: JOB_ID,
    seq: 5,
    status: "running",
    artifact: null,
    error: null,
    authoritative: false,
    ...overrides,
  };
}

test("跨工作区或跨用户的回执按 scope_mismatch 拒绝", () => {
  const current = operation();

  const otherWorkspace = reduceOperationReceipt(
    current,
    event({ scope: { workspaceId: OTHER_WORKSPACE_ID, userId: USER_ID } }),
  );
  assert.equal(otherWorkspace.accepted, false);
  assert.equal(otherWorkspace.reason, "scope_mismatch");
  assert.equal(otherWorkspace.operation, current);

  const otherUser = reduceOperationReceipt(
    current,
    event({ scope: { workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID } }),
  );
  assert.equal(otherUser.accepted, false);
  assert.equal(otherUser.reason, "scope_mismatch");
  assert.equal(otherUser.operation, current);
});

test("operationId / runId / jobId 任一对不上按 identity_mismatch 拒绝", () => {
  const current = operation();

  for (const mismatched of [
    event({ operationId: OTHER_OPERATION_ID }),
    event({ runId: OTHER_RUN_ID }),
    event({ jobId: OTHER_JOB_ID }),
  ]) {
    const result = reduceOperationReceipt(current, mismatched);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(result.operation, current);
  }
});

test("旧 revision 与未来 revision 都按 revision_mismatch 拒绝", () => {
  const current = operation();

  const older = reduceOperationReceipt(current, event({ revision: 2 }));
  assert.equal(older.accepted, false);
  assert.equal(older.reason, "revision_mismatch");
  assert.equal(older.operation, current);

  const newer = reduceOperationReceipt(current, event({ revision: 4 }));
  assert.equal(newer.accepted, false);
  assert.equal(newer.reason, "revision_mismatch");
  assert.equal(newer.operation, current);
});

test("重复与乱序的事件按 stale_event 拒绝", () => {
  const current = operation({ lastEventSeq: 4 });

  const replay = reduceOperationReceipt(current, event({ seq: 4, status: "succeeded", artifact: ARTIFACT, authoritative: true }));
  assert.equal(replay.accepted, false);
  assert.equal(replay.reason, "stale_event");
  assert.equal(replay.operation, current);

  const outOfOrder = reduceOperationReceipt(current, event({ seq: 2, status: "failed", error: "boom" }));
  assert.equal(outOfOrder.accepted, false);
  assert.equal(outOfOrder.reason, "stale_event");
  assert.equal(outOfOrder.operation, current);
});

test("accepted / running 不再退回 accepted", () => {
  const running = operation({ status: "running", lastEventSeq: 4 });
  const backToAccepted = reduceOperationReceipt(running, event({ seq: 5, status: "accepted" }));
  assert.equal(backToAccepted.accepted, false);
  assert.equal(backToAccepted.reason, "stale_event");
  assert.equal(backToAccepted.operation, running);

  const accepted = operation({ status: "accepted", lastEventSeq: 4 });
  const fromAccepted = reduceOperationReceipt(accepted, event({ seq: 5, status: "accepted" }));
  assert.equal(fromAccepted.accepted, false);
  assert.equal(fromAccepted.reason, "stale_event");
  assert.equal(fromAccepted.operation, accepted);
});

test("终态之后不再被任何后来的事件覆写", () => {
  const cases: Array<[AgentOperationV1["status"], Partial<AgentOperationEventV1>]> = [
    ["succeeded", { status: "running" }],
    ["succeeded", { status: "failed", error: "too late" }],
    ["failed", { status: "running" }],
    ["failed", { status: "succeeded", artifact: ARTIFACT, authoritative: true }],
    ["cancelled", { status: "running" }],
    ["cancelled", { status: "succeeded", artifact: ARTIFACT, authoritative: true }],
  ];

  for (const [status, overrides] of cases) {
    const current = operation({ status, lastEventSeq: 4, artifact: ARTIFACT });
    const result = reduceOperationReceipt(current, event({ seq: 5, ...overrides }));
    assert.equal(result.accepted, false, `${status} 不应被 ${String(overrides.status)} 覆写`);
    assert.equal(result.reason, "terminal");
    assert.equal(result.operation, current);
  }
});

test("outcome_unknown 未核对不得重跑，也不得变成终态", () => {
  const current = operation({ status: "outcome_unknown", lastEventSeq: 4, error: "结果未知" });

  const unverified: Partial<AgentOperationEventV1>[] = [
    { status: "accepted", authoritative: true },
    { status: "running", authoritative: true },
    { status: "succeeded", artifact: ARTIFACT, authoritative: false },
    { status: "failed", error: "重试失败", authoritative: false },
    { status: "cancelled", authoritative: false },
  ];

  for (const overrides of unverified) {
    const result = reduceOperationReceipt(current, event({ seq: 5, ...overrides }));
    assert.equal(result.accepted, false, `未核对不应接受 ${String(overrides.status)}`);
    assert.equal(result.reason, "unverified");
    assert.equal(result.operation, current);
  }
});

test("outcome_unknown 经权威回执核对后可以恢复", () => {
  const current = operation({ status: "outcome_unknown", lastEventSeq: 4, error: "结果未知" });

  const recovered = reduceOperationReceipt(
    current,
    event({ seq: 6, status: "succeeded", artifact: ARTIFACT, authoritative: true, error: "迟到回执" }),
  );
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.reason, null);
  assert.equal(recovered.operation.status, "succeeded");
  assert.equal(recovered.operation.lastEventSeq, 6);
  assert.deepEqual(recovered.operation.artifact, ARTIFACT);
  // 成功不保留事件上的旧错误文案。
  assert.equal(recovered.operation.error, null);

  const recoveredFailure = reduceOperationReceipt(
    current,
    event({ seq: 6, status: "failed", error: "核对后确认失败", authoritative: true }),
  );
  assert.equal(recoveredFailure.accepted, true);
  assert.equal(recoveredFailure.operation.status, "failed");
  assert.equal(recoveredFailure.operation.error, "核对后确认失败");
});

test("进入 succeeded 必须同时有核对与真实产物", () => {
  const current = operation({ status: "running", lastEventSeq: 4 });

  const noArtifact = reduceOperationReceipt(
    current,
    event({ seq: 5, status: "succeeded", artifact: null, authoritative: true }),
  );
  assert.equal(noArtifact.accepted, false);
  assert.equal(noArtifact.reason, "unverified");
  assert.equal(noArtifact.operation, current);

  const unverified = reduceOperationReceipt(
    current,
    event({ seq: 5, status: "succeeded", artifact: ARTIFACT, authoritative: false }),
  );
  assert.equal(unverified.accepted, false);
  assert.equal(unverified.reason, "unverified");
  assert.equal(unverified.operation, current);
});

test("接受时只改 status/lastEventSeq/artifact/error，身份与能力保持不变", () => {
  const current = operation({ status: "running", lastEventSeq: 4 });

  const result = reduceOperationReceipt(
    current,
    event({ seq: 7, status: "succeeded", artifact: ARTIFACT, authoritative: true, error: "不该留下" }),
  );

  assert.equal(result.accepted, true);
  assert.equal(result.reason, null);
  assert.notEqual(result.operation, current);
  assert.deepEqual(
    {
      operationId: result.operation.operationId,
      runId: result.operation.runId,
      revision: result.operation.revision,
      scope: result.operation.scope,
      capability: result.operation.capability,
      jobId: result.operation.jobId,
      status: result.operation.status,
      lastEventSeq: result.operation.lastEventSeq,
    },
    {
      operationId: OPERATION_ID,
      runId: RUN_ID,
      revision: 3,
      scope: { workspaceId: WORKSPACE_ID, userId: USER_ID },
      capability: "note.deepen.dynamic_artifact",
      jobId: JOB_ID,
      status: "succeeded",
      lastEventSeq: 7,
    },
  );
  assert.deepEqual(result.operation.artifact, ARTIFACT);
  assert.equal(result.operation.error, null);
});

test("非成功状态沿用已有产物，失败保留事件原因", () => {
  const runningWithArtifact = operation({
    status: "running",
    lastEventSeq: 4,
    artifact: ARTIFACT,
    error: "上一次尝试留下的原因",
  });

  const failed = reduceOperationReceipt(runningWithArtifact, event({ seq: 5, status: "failed", error: "生成中断" }));
  assert.equal(failed.accepted, true);
  assert.deepEqual(failed.operation.artifact, ARTIFACT);
  assert.equal(failed.operation.error, "生成中断");

  const unknown = reduceOperationReceipt(
    runningWithArtifact,
    event({ seq: 5, status: "outcome_unknown", error: "回执中断", authoritative: false }),
  );
  assert.equal(unknown.accepted, true);
  assert.equal(unknown.operation.status, "outcome_unknown");
  assert.deepEqual(unknown.operation.artifact, ARTIFACT);
  assert.equal(unknown.operation.error, "回执中断");
});

test("归并不修改输入", () => {
  const current = operation({ status: "running", lastEventSeq: 4 });
  const acceptedEvent = event({ seq: 5, status: "succeeded", artifact: ARTIFACT, authoritative: true });
  const rejectedEvent = event({ seq: 5, status: "running", scope: { workspaceId: OTHER_WORKSPACE_ID, userId: USER_ID } });
  const currentSnapshot = structuredClone(current);
  const acceptedSnapshot = structuredClone(acceptedEvent);
  const rejectedSnapshot = structuredClone(rejectedEvent);

  const acceptedResult = reduceOperationReceipt(current, acceptedEvent);
  const rejectedResult = reduceOperationReceipt(current, rejectedEvent);

  assert.equal(acceptedResult.accepted, true);
  assert.equal(rejectedResult.accepted, false);
  assert.equal(rejectedResult.reason, "scope_mismatch");

  // 拒绝时返回原引用；接受时返回新对象，两者都不许回写输入。
  assert.equal(rejectedResult.operation, current);
  assert.notEqual(acceptedResult.operation, current);
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(acceptedEvent, acceptedSnapshot);
  assert.deepEqual(rejectedEvent, rejectedSnapshot);
});

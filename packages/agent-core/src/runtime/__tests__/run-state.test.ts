/**
 * 42 阶段 0 子任务 C：纯回执状态归并的行为回归。
 *
 * 这里钉住的是同一份回执语义在多处视图里必须一致的行为：跨范围/跨身份的事件进不来，
 * 重复与乱序事件不改变状态，终态不被覆写，结果未知不盲目重做，成功必须有核对的、
 * 且真的属于这次 execution 的结果。另外确认输入不可变——归并是纯函数，调用方可以放心
 * 地保留旧引用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentArtifactRefV1, AgentExecutionRefV1, AgentOperationEventV1,
  AgentOperationResultV1, AgentOperationV1,
} from "@astella/shared/agent-contracts";

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
const CARD_RUN_ID = "1f0a2b3c-0000-4000-8000-00000000000e";
const OTHER_CARD_RUN_ID = "1f0a2b3c-0000-4000-8000-00000000000f";

const CARD_CAPABILITY = "card_generation_generate";
const JOB_EXECUTION: AgentExecutionRefV1 = { kind: "job", id: JOB_ID };
const CARD_EXECUTION: AgentExecutionRefV1 = { kind: "card_generation", id: CARD_RUN_ID };

const ARTIFACT: AgentArtifactRefV1 = {
  kind: "note_overview",
  id: ARTIFACT_ID,
  jobId: JOB_ID,
  noteId: NOTE_ID,
  noteVersionId: NOTE_VERSION_ID,
};
const CARD_ARTIFACT: AgentArtifactRefV1 = {
  kind: "card_candidates",
  id: CARD_RUN_ID,
  noteId: NOTE_ID,
  noteVersionId: NOTE_VERSION_ID,
};
const ARTIFACT_RESULT: AgentOperationResultV1 = { kind: "artifact", artifact: ARTIFACT };
const CARD_RESULT: AgentOperationResultV1 = { kind: "artifact", artifact: CARD_ARTIFACT };
const NO_CARDS_RESULT: AgentOperationResultV1 = {
  kind: "no_cards_recommended", reasonCodes: ["no_learnable_objective"],
};

test("a verified artifact from another job cannot complete this operation", () => {
  const current = operation();
  const result = reduceOperationReceipt(current, event({ status: "succeeded", authoritative: true,
    result: { kind: "artifact", artifact: { ...ARTIFACT, jobId: OTHER_JOB_ID } } }));
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
    execution: JOB_EXECUTION,
    status: "running",
    lastEventSeq: 4,
    result: null,
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
    execution: JOB_EXECUTION,
    seq: 5,
    status: "running",
    result: null,
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

test("operationId / runId / execution 的 kind+id 任一对不上按 identity_mismatch 拒绝", () => {
  const current = operation();

  for (const mismatched of [
    event({ operationId: OTHER_OPERATION_ID }),
    event({ runId: OTHER_RUN_ID }),
    event({ execution: { kind: "job", id: OTHER_JOB_ID } }),
  ]) {
    const result = reduceOperationReceipt(current, mismatched);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "identity_mismatch");
    assert.equal(result.operation, current);
  }
});

test("执行体换成另一类，即使 id 相同也不是同一次操作", () => {
  const current = operation();
  const switched = reduceOperationReceipt(current, event({ execution: { kind: "card_generation", id: JOB_ID } }));
  assert.equal(switched.accepted, false);
  assert.equal(switched.reason, "identity_mismatch");
  assert.equal(switched.operation, current);
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

  const replay = reduceOperationReceipt(current, event({ seq: 4, status: "succeeded", result: ARTIFACT_RESULT, authoritative: true }));
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
    ["failed", { status: "succeeded", result: ARTIFACT_RESULT, authoritative: true }],
    ["cancelled", { status: "running" }],
    ["cancelled", { status: "succeeded", result: ARTIFACT_RESULT, authoritative: true }],
  ];

  for (const [status, overrides] of cases) {
    const current = operation({ status, lastEventSeq: 4, result: ARTIFACT_RESULT });
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
    { status: "succeeded", result: ARTIFACT_RESULT, authoritative: false },
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
    event({ seq: 6, status: "succeeded", result: ARTIFACT_RESULT, authoritative: true, error: "迟到回执" }),
  );
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.reason, null);
  assert.equal(recovered.operation.status, "succeeded");
  assert.equal(recovered.operation.lastEventSeq, 6);
  assert.deepEqual(recovered.operation.result, ARTIFACT_RESULT);
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

test("进入 succeeded 必须同时有核对与真实结果", () => {
  const current = operation({ status: "running", lastEventSeq: 4 });

  const noResult = reduceOperationReceipt(
    current,
    event({ seq: 5, status: "succeeded", result: null, authoritative: true }),
  );
  assert.equal(noResult.accepted, false);
  assert.equal(noResult.reason, "unverified");
  assert.equal(noResult.operation, current);

  const unverified = reduceOperationReceipt(
    current,
    event({ seq: 5, status: "succeeded", result: ARTIFACT_RESULT, authoritative: false }),
  );
  assert.equal(unverified.accepted, false);
  assert.equal(unverified.reason, "unverified");
  assert.equal(unverified.operation, current);
});

test("接受时只改 status/lastEventSeq/result/error，身份与能力保持不变", () => {
  const current = operation({ status: "running", lastEventSeq: 4 });

  const result = reduceOperationReceipt(
    current,
    event({ seq: 7, status: "succeeded", result: ARTIFACT_RESULT, authoritative: true, error: "不该留下" }),
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
      execution: result.operation.execution,
      status: result.operation.status,
      lastEventSeq: result.operation.lastEventSeq,
    },
    {
      operationId: OPERATION_ID,
      runId: RUN_ID,
      revision: 3,
      scope: { workspaceId: WORKSPACE_ID, userId: USER_ID },
      capability: "note.deepen.dynamic_artifact",
      execution: JOB_EXECUTION,
      status: "succeeded",
      lastEventSeq: 7,
    },
  );
  assert.deepEqual(result.operation.result, ARTIFACT_RESULT);
  assert.equal(result.operation.error, null);
});

test("非成功状态沿用已有结果，失败保留事件原因", () => {
  const runningWithResult = operation({
    status: "running",
    lastEventSeq: 4,
    result: ARTIFACT_RESULT,
    error: "上一次尝试留下的原因",
  });

  const failed = reduceOperationReceipt(runningWithResult, event({ seq: 5, status: "failed", error: "生成中断" }));
  assert.equal(failed.accepted, true);
  assert.deepEqual(failed.operation.result, ARTIFACT_RESULT);
  assert.equal(failed.operation.error, "生成中断");

  const unknown = reduceOperationReceipt(
    runningWithResult,
    event({ seq: 5, status: "outcome_unknown", error: "回执中断", authoritative: false }),
  );
  assert.equal(unknown.accepted, true);
  assert.equal(unknown.operation.status, "outcome_unknown");
  assert.deepEqual(unknown.operation.result, ARTIFACT_RESULT);
  assert.equal(unknown.operation.error, "回执中断");
});

test("制卡操作只能被自己的候选或无卡推荐结案", () => {
  const current = operation({ capability: "card_generation_generate", execution: CARD_EXECUTION });

  const delivered = reduceOperationReceipt(current, event({
    execution: CARD_EXECUTION, seq: 5, status: "succeeded", result: CARD_RESULT, authoritative: true,
  }));
  assert.equal(delivered.accepted, true);
  assert.equal(delivered.operation.status, "succeeded");
  assert.deepEqual(delivered.operation.result, CARD_RESULT);

  const noCards = reduceOperationReceipt(current, event({
    execution: CARD_EXECUTION, seq: 5, status: "succeeded", result: NO_CARDS_RESULT, authoritative: true,
  }));
  assert.equal(noCards.accepted, true, "无卡推荐是正常收口，不是失败");
  assert.deepEqual(noCards.operation.result, NO_CARDS_RESULT);

  // 别的制卡 run 的候选、笔记产物的 jobId，都不是这一次执行的成果。
  for (const result of [
    { kind: "artifact" as const, artifact: { ...CARD_ARTIFACT, id: OTHER_CARD_RUN_ID } },
    ARTIFACT_RESULT,
  ]) {
    const mismatched = reduceOperationReceipt(current, event({
      execution: CARD_EXECUTION, seq: 5, status: "succeeded", result, authoritative: true,
    }));
    assert.equal(mismatched.accepted, false);
    assert.equal(mismatched.reason, "unverified");
    assert.equal(mismatched.operation, current);
  }
});

test("no_cards 与制卡候选都只配 card_generation_generate 这个 capability", () => {
  // 纯 reducer 的能力约束：执行体对了但 capability 不对，同样不算这次执行的成果。
  for (const result of [CARD_RESULT, NO_CARDS_RESULT]) {
    const wrongCapability = operation({ capability: "note_overview_generate", execution: CARD_EXECUTION });
    const rejected = reduceOperationReceipt(wrongCapability, event({
      execution: CARD_EXECUTION, seq: 5, status: "succeeded", result, authoritative: true,
    }));
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, "unverified");
    assert.equal(rejected.operation, wrongCapability);

    const rightCapability = operation({ capability: CARD_CAPABILITY, execution: CARD_EXECUTION });
    const accepted = reduceOperationReceipt(rightCapability, event({
      execution: CARD_EXECUTION, seq: 5, status: "succeeded", result, authoritative: true,
    }));
    assert.equal(accepted.accepted, true, JSON.stringify(result.kind));
  }
});

test("job 执行体不能拿无卡推荐结案", () => {
  const current = operation();
  const mismatched = reduceOperationReceipt(current, event({
    seq: 5, status: "succeeded", result: NO_CARDS_RESULT, authoritative: true,
  }));
  assert.equal(mismatched.accepted, false);
  assert.equal(mismatched.reason, "unverified");
  assert.equal(mismatched.operation, current);
});

test("job 执行体不能拿制卡候选结案", () => {
  const current = operation();
  const mismatched = reduceOperationReceipt(current, event({
    seq: 5, status: "succeeded", result: CARD_RESULT, authoritative: true,
  }));
  assert.equal(mismatched.accepted, false);
  assert.equal(mismatched.reason, "unverified");
  assert.equal(mismatched.operation, current);
});

test("归并不修改输入", () => {
  const current = operation({ status: "running", lastEventSeq: 4 });
  const acceptedEvent = event({ seq: 5, status: "succeeded", result: ARTIFACT_RESULT, authoritative: true });
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
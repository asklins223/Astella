/**
 * 42 阶段 0 子任务 C：纯回执状态归并。
 *
 * 这里是唯一的「事件 → 操作状态」归并实现，纯函数、无宿主依赖（无数据库、模型、
 * 时间、网络、DOM）。这样同一份判定可以同时被 API 的读取投影、worker 的事件消费
 * 和重启恢复复用，避免各处各算一套完成状态（方案 42 §13.2）。
 *
 * 判定顺序与拒绝原因是一份对外语义，不是实现细节：
 *   1. scope_mismatch    事件不属于同一个工作区/用户，先于一切业务判断拒绝。
 *   2. identity_mismatch operationId / runId / jobId 任一对不上就不是同一次操作。
 *   3. revision_mismatch 旧版本运行的事件不能改当前状态。
 *   4. stale_event       seq 未严格递增（重复、乱序）直接丢弃。
 *   5. terminal          succeeded/failed/cancelled 是业务终态，不再被后来事件覆写。
 *   6. unverified        需要核对却没有核对的结果不许进入状态。
 *   7. stale_event       accepted/running 不再退回 accepted。
 *
 * 拒绝时原样返回 `current` 引用（不改、不复制），接受时只浅复制 status、
 * lastEventSeq、artifact、error 四个字段，身份与能力等字段不动。
 */
import type { AgentOperationEventV1, AgentOperationV1 } from "@ailearn/shared/agent-contracts";

export type OperationReceiptReduction = {
  accepted: boolean;
  operation: AgentOperationV1;
  reason:
    | "scope_mismatch"
    | "identity_mismatch"
    | "revision_mismatch"
    | "stale_event"
    | "terminal"
    | "unverified"
    | null;
};

type OperationStatusV1 = AgentOperationV1["status"];

type RejectReason = Exclude<OperationReceiptReduction["reason"], null>;

/** 业务终态：已确定发生过成功、失败或取消，之后的事件不再改写它。 */
function isTerminalStatus(status: OperationStatusV1): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function reject(current: AgentOperationV1, reason: RejectReason): OperationReceiptReduction {
  return { accepted: false, operation: current, reason };
}

function accept(
  current: AgentOperationV1,
  event: AgentOperationEventV1,
  status: OperationStatusV1,
  artifact: AgentOperationV1["artifact"],
): OperationReceiptReduction {
  return {
    accepted: true,
    reason: null,
    operation: {
      ...current,
      status,
      lastEventSeq: event.seq,
      artifact,
      // 只有失败与结果未知的回执携带原因；换成其他状态时不得留下旧错误文案。
      error: status === "failed" || status === "outcome_unknown" ? event.error : null,
    },
  };
}

export function reduceOperationReceipt(
  current: AgentOperationV1,
  event: AgentOperationEventV1,
): OperationReceiptReduction {
  // 范围先判：不属于本工作区/用户的回执连身份讨论都不必开始。
  if (
    event.scope.workspaceId !== current.scope.workspaceId ||
    event.scope.userId !== current.scope.userId
  ) {
    return reject(current, "scope_mismatch");
  }
  // 业务身份：provider 重试换 call id 也不能换掉这一次操作的稳定身份。
  if (
    event.operationId !== current.operationId ||
    event.runId !== current.runId ||
    event.jobId !== current.jobId
  ) {
    return reject(current, "identity_mismatch");
  }
  // 版本：旧 revision 的迟到事件不能覆盖当前状态。
  if (event.revision !== current.revision) {
    return reject(current, "revision_mismatch");
  }
  // 顺序：seq 必须严格递增，重复与乱序事件只丢弃不改状态。
  if (event.seq <= current.lastEventSeq) {
    return reject(current, "stale_event");
  }
  // 终态不可覆写：已发生的成功/失败/取消不能被后来的事件改回进行中。
  if (isTerminalStatus(current.status)) {
    return reject(current, "terminal");
  }

  const recovering = current.status === "outcome_unknown";
  if (recovering) {
    // 结果未知时不允许盲目重做：不能靠一个未核对的事件回到 accepted/running。
    if (event.status === "accepted" || event.status === "running") {
      return reject(current, "unverified");
    }
    // 恢复成确定终态必须经过核对（authoritative 回执），重复的 outcome_unknown 只是同向更新。
    if (event.status !== "outcome_unknown" && !event.authoritative) {
      return reject(current, "unverified");
    }
  }

  if (event.status === "succeeded") {
    // 成功必须经核对且带真实产物引用；两者缺一都当作未核对。
    const artifact = event.artifact;
    if (!event.authoritative || artifact === null || artifact.jobId !== current.jobId) {
      return reject(current, "unverified");
    }
    return accept(current, event, "succeeded", artifact);
  }

  // accepted/running 都不再退回 accepted；仍在 accepted 时收到来自 accepted 的新 seq 同样拒绝。
  if (event.status === "accepted" && (current.status === "accepted" || current.status === "running")) {
    return reject(current, "stale_event");
  }

  // 产物只从核对过的 succeeded 采用，其他状态保留已有 artifact。
  return accept(current, event, event.status, current.artifact);
}

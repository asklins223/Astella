/**
 * 纯回执状态归并：唯一的「事件 → 操作状态」实现，无数据库/模型/时间/网络依赖，
 * 于是 API 读取投影、worker 事件消费与重启恢复共用同一份判定。
 *
 * 拒绝原因是一份对外语义：scope_mismatch → identity_mismatch（operationId/runId/
 * execution 的 kind+id）→ revision_mismatch → stale_event（seq 不严格递增）→
 * terminal（终态不被覆写）→ unverified（需要核对却没有核对的结果）→ stale_event
 * （accepted/running 不退回 accepted）。
 *
 * 拒绝时原样返回 `current` 引用；接受时只浅复制 status、lastEventSeq、result、error。
 */
import {
  agentOperationResultMatchesExecutionV1,
  type AgentOperationEventV1,
  type AgentOperationResultV1,
  type AgentOperationV1,
} from "@astella/shared/agent-contracts";

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
  result: AgentOperationResultV1 | null,
): OperationReceiptReduction {
  return {
    accepted: true,
    reason: null,
    operation: {
      ...current,
      status,
      lastEventSeq: event.seq,
      result,
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
  // 业务身份：provider 重试换 call id 也不能换掉稳定身份；kind 与 id 合起来才是身份。
  if (
    event.operationId !== current.operationId ||
    event.runId !== current.runId ||
    event.execution.kind !== current.execution.kind ||
    event.execution.id !== current.execution.id
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
    // 成功必须经核对，且结果真的属于这次 execution 与 capability（共享合同唯一判定）。
    // 缺一当作未核对：宁可停在未知，也不冒充完成。
    const result = event.result;
    if (!event.authoritative || result === null
      || !agentOperationResultMatchesExecutionV1(current.execution, result, current.capability)) {
      return reject(current, "unverified");
    }
    return accept(current, event, "succeeded", result);
  }

  // accepted/running 都不再退回 accepted；仍在 accepted 时收到来自 accepted 的新 seq 同样拒绝。
  if (event.status === "accepted" && (current.status === "accepted" || current.status === "running")) {
    return reject(current, "stale_event");
  }

  // 结果只从核对过的 succeeded 采用。
  return accept(current, event, event.status, current.result);
}

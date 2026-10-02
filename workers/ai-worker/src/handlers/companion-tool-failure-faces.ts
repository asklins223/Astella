import type { CompanionAgentToolStatus } from "@ailearn/shared";
import type { CompanionToolFailureStatus } from "./companion-tool-outcome.ts";

export function companionToolFailureFaces(failure: { status: CompanionToolFailureStatus; safeSummary: string }): {
  ledgerStatus: CompanionAgentToolStatus;
  modelStatus: CompanionToolFailureStatus;
  safeSummary: string;
} {
  return {
    // 账本与 SSE 用**精确**那个词：0349 之后 CHECK 与客户端 TOOL_STATE 都认它，
    // 不再需要降级映射。折叠过的状态会让 doctor/回放查不到真实原因。
    ledgerStatus: failure.status,
    modelStatus: failure.status,
    safeSummary: failure.safeSummary,
  };
}

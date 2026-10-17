/**
 * Validation and rejection of a model tool call, as data.
 *
 * The loop used to build the rejection receipt, the audit event and the model
 * message inline in three nested branches. Keeping the shapes here makes each
 * branch testable and keeps the runtime file from growing with every new
 * rejection reason.
 */

import {
  COMPANION_AGENT_TOOL_LABELS,
  getCompanionAgentTool,
  validateCompanionAgentToolArguments,
} from "@astella/shared";
import { companionToolFailureFaces } from "./companion-tool-failure-faces.ts";

export interface CompanionToolCallIdentity {
  id: string;
  name: string;
}

export interface ValidatedCompanionToolCall {
  /** Present when the call is unusable; the loop echoes it and continues. */
  readonly rejection: { content: string; reason: string; repeatedInvalid: boolean } | null;
  /** Present when the call may run. */
  readonly accepted: { arguments: Record<string, unknown> } | null;
  readonly logFields: Record<string, unknown>;
}

/**
 * Reject a tool that this step never offered. The reduced surface is a
 * declaration, not a suggestion: without this, the model can silently use the
 * full catalog and the prompt savings are cosmetic.
 */
export function unofferedToolReceipt(name: string, offeredNames: readonly string[]): string {
  return JSON.stringify({
    ok: false,
    status: "not_executed",
    error: `工具 ${name} 不在本步已装载的工具面里。先调用 companion_load_tools 装载对应组；`
      + `当前可用：${offeredNames.slice(0, 20).join("、")}`,
  });
}

/**
 * Validate arguments against the capability's real schema. Field and range
 * limits come from that schema; a second generic JSON character cap rejects
 * valid escaped Markdown and evidence.
 */
export function validateCompanionToolCall(input: {
  name: string;
  arguments: unknown;
  alreadyRejected: ReadonlySet<string>;
  identity: string;
}): ValidatedCompanionToolCall {
  const definition = getCompanionAgentTool(input.name);
  const parsed = validateCompanionAgentToolArguments(input.name, input.arguments);
  if (parsed.success) {
    return { rejection: null, accepted: { arguments: parsed.data }, logFields: {} };
  }
  const schemaFields = new Set(Object.keys(definition?.parameters.properties ?? {}));
  const faces = companionToolFailureFaces({ status: "not_executed", safeSummary: parsed.reason });
  return {
    rejection: {
      content: JSON.stringify({
        ok: false,
        status: faces.modelStatus,
        error: parsed.reason,
        code: "invalid_arguments",
        validationIssues: parsed.issues,
        parameters: definition?.parameters,
        instruction: "按 validationIssues 修正参数，不重复提交相同无效参数；已经成功的操作不必重做。",
      }),
      reason: parsed.reason,
      // Validation is pure: identical invalid input cannot become valid by
      // waiting or spending another model call. Changed arguments remain retryable.
      repeatedInvalid: input.alreadyRejected.has(input.identity),
    },
    accepted: null,
    logFields: {
      issues: parsed.issues.map(issue => ({
        field: schemaFields.has(issue.path[0] ?? "") ? issue.path[0] : "$input",
        code: issue.code,
      })),
    },
  };
}

export function companionToolAuditLabel(name: string, description: string): string {
  return COMPANION_AGENT_TOOL_LABELS[name] ?? description.slice(0, 240);
}

/**
 * Reject a tool name that is not in the capability catalog at all.
 *
 * An unresolvable tool is treated as maximally risky in the audit trail rather
 * than understating it as a read. The receipt is still echoed with the
 * original id, or the provider rejects the next request for a missing response.
 */
export async function rejectUnknownCompanionTool(input: {
  identity: CompanionToolCallIdentity;
  recordRejected: (reason: string) => Promise<void>;
  appendEvent: (tool: { toolCallId: string; name: string; toolVersion: string;
    riskClass: "irreversible"; status: "blocked"; safeLabel: string }) => Promise<void>;
  pushReceipt: (content: string) => void;
}): Promise<void> {
  await input.recordRejected("未注册的工具，操作已阻止");
  await input.appendEvent({
    toolCallId: input.identity.id, name: input.identity.name, toolVersion: "unknown",
    riskClass: "irreversible", status: "blocked", safeLabel: "未注册工具，操作已阻止",
  });
  input.pushReceipt(JSON.stringify({ ok: false, status: "blocked", error: "unknown or disallowed tool" }));
}

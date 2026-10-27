import type { AgentTurnRequest } from "@astella/shared";
import { companionOperationDomainTool, companionOperationName, getCompanionAgentTool } from "@astella/shared";
import { claimsApplicationActionCompletion } from "../turn/companion-dialogue-content.ts";

export type CompanionFinishArguments = {
  text: string;
  actions: Array<{ receiptId: string }>;
  evidence: Array<{ receiptId: string }>;
};

export type CompanionFinishVerdict =
  | { ok: true; text: string; writesLanded: boolean }
  | { ok: false; error: string };

/**
 * Successful tool receipts owned by the current request. Host-side finalization
 * uses these when the model wrote the answer but did not call companion_finish:
 * the receipts are already real, so the host can bind them instead of spending
 * another model call (or replacing the answer with a host note).
 */
export function companionCurrentSuccessfulToolReceipts(
  messages: AgentTurnRequest["messages"],
): Array<{ id: string; name: string; riskClass: string; summary: string }> {
  // A host observation can be appended mid-turn (prefetched note, receipt
  // correction). The request boundary is still the latest user message; using
  // the last host observation would hide earlier successful receipts.
  let boundary = messages.length - 1;
  while (boundary >= 0 && messages[boundary].role !== "user") boundary -= 1;
  const current = boundary < 0 ? messages : messages.slice(boundary);
  const calls = new Map<string, { name: string }>();
  for (const message of current) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) calls.set(call.id, { name: call.name });
  }
  const receipts: Array<{ id: string; name: string; riskClass: string; summary: string }> = [];
  for (const message of current) {
    if (message.role !== "tool" || !message.toolCallId || typeof message.content !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    let receipt: { summary?: unknown };
    try {
      receipt = JSON.parse(message.content);
      if (receipt && (receipt as { ok?: unknown }).ok !== true) continue;
    } catch {
      continue;
    }
    receipts.push({ id: message.toolCallId, name: call.name,
      riskClass: getCompanionAgentTool(companionOperationDomainTool(call.name) ?? call.name)?.riskClass ?? "read",
      summary: typeof receipt.summary === "string" ? receipt.summary : "" });
  }
  return receipts;
}

/** The final-answer tool is the write boundary.
 *
 * A successful tool message is the only proof that an operation happened in the
 * current request. The model may describe whatever it wants, but actions must
 * point at real successful receipts from this request; a bare "已保存" cannot
 * pass. This replaces prose pattern matching as the primary completion check.
 */
/** Reads that produce something the user asked to have made. */
const DELIVERABLE_READ_OPERATIONS: ReadonlySet<string> = new Set(["visual.diagram"]);

export function validateCompanionFinish(
  input: CompanionFinishArguments,
  messages: AgentTurnRequest["messages"],
): CompanionFinishVerdict {
  // A host observation can be appended mid-turn (prefetched note, receipt
  // correction). The request boundary is still the latest user message; using
  // the last host observation would hide earlier successful receipts.
  let boundary = messages.length - 1;
  while (boundary >= 0 && messages[boundary].role !== "user") boundary -= 1;
  const current = boundary < 0 ? messages : messages.slice(boundary);
  const calls = new Map<string, { name: string; operation: string }>();
  for (const message of current) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? [])
      // The operation needs the arguments: `companion_visual` alone is a domain
      // tool, `{action:"diagram"}` is what makes it a deliverable.
      calls.set(call.id, { name: call.name, operation: companionOperationName({ name: call.name, arguments: call.arguments }) });
  }
  const successful = new Map<string, { name: string; operation: string; riskClass: string }>();
  for (const message of current) {
    if (message.role !== "tool" || !message.toolCallId || typeof message.content !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    try {
      if (JSON.parse(message.content).ok !== true) continue;
    } catch {
      continue;
    }
    successful.set(message.toolCallId, {
      name: call.name,
      operation: call.operation,
      riskClass: getCompanionAgentTool(companionOperationDomainTool(call.operation) ?? call.operation)?.riskClass ?? "read",
    });
  }
  const actions = input.actions ?? [];
  const evidence = input.evidence ?? [];
  const writeReceipts = [...successful].filter(([, receipt]) => receipt.riskClass !== "read");
  const writeIds = writeReceipts.map(([id]) => id);
  // Some reads produce a deliverable (a diagram is drawn for the user). Those
  // may be cited as actions; an ordinary read still may not, because citing it
  // would let "改好了" ride on a lookup.
  const isActionReceipt = (id: string) => writeReceipts.some(([writeId]) => writeId === id)
    || DELIVERABLE_READ_OPERATIONS.has(successful.get(id)!.operation);
  const invalidAction = actions.find(action => !successful.has(action.receiptId) || !isActionReceipt(action.receiptId));
  if (invalidAction) {
    return { ok: false, error: `回执 ${invalidAction.receiptId} 不是本轮真实成功、可直接交付的工具回执。`
      + `可引用的回执：${[...successful.keys()].filter(isActionReceipt).join("、") || "无"}。`
      + "不要引用历史回执，也不要用正文声称已经完成；先实际调用工具，再重新交付。" };
  }
  const invalidEvidence = evidence.find(item => !successful.has(item.receiptId));
  if (invalidEvidence) {
    return { ok: false, error: `证据回执 ${invalidEvidence.receiptId} 不是本轮真实成功的工具回执。先读取真实来源，再重新交付。` };
  }
  const claims = claimsApplicationActionCompletion(input.text);
  if (actions.length === 0 && claims.length > 0) {
    // A write claim needs a write receipt it can cite. A turn that really wrote
    // must not describe it in prose while citing nothing.
    if (writeIds.length > 0) {
      return { ok: false, error: `正文声称已经写入（${claims.join("、")}），但 actions 为空。`
        + "把本轮写操作的 receiptId 放进 actions；没有写入就把正文改成如实说明。" };
    }
    // No write happened and no tool ran at all: the claim is invented. A turn
    // that really produced something ("画好了" with a diagram receipt) is fine.
    if (successful.size === 0) {
      return { ok: false, error: `正文声称已经完成（${claims.join("、")}），但本轮没有任何工具回执。`
        + "先实际执行并把回执放进 actions；没有执行就把正文改成如实说明。" };
    }
  }
  return { ok: true, text: input.text, writesLanded: actions.length > 0 };
}

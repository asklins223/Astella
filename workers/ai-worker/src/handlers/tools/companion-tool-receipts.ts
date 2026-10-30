import { companionOperationDomainTool, companionOperationName, getCompanionAgentTool, type AgentTurnRequest } from "@astella/shared";

/** Only the actual request starts a receipt scope. Later material observations
 * and internal repairs cannot hide a successful write or revive an old one. */
export function currentCompanionRequestMessages(messages: AgentTurnRequest["messages"]): AgentTurnRequest["messages"] {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].requestBoundary !== true
    && (messages[start].role !== "user" || messages[start].hostObservation)) start--;
  return start < 0 ? messages : messages.slice(start);
}

const unsuccessful = new Set(["failed", "blocked", "not_executed", "outcome_unknown", "waiting_confirmation", "unavailable", "running", "pending"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const shortReference = (value: unknown): value is string => typeof value === "string" && /^r[1-9]\d*$/.test(value);

/** Short handles are host-owned transport references, never fuzzy ID matching.
 * They live in tool receipts/checkpoints, so folding or recovery cannot renumber
 * a reference the model already saw. Protocol toolCallId values stay untouched. */
export function withCompanionReceiptReferences(messages: AgentTurnRequest["messages"],
  currentRunEvidence: AgentTurnRequest["messages"] = []): AgentTurnRequest["messages"] {
  const current = currentCompanionRequestMessages(messages);
  const source = [...currentRunEvidence, ...current];
  const references = new Map<string, string>();
  let next = 1;
  for (const message of source) {
    if (message.role !== "tool" || !message.toolCallId || typeof message.content !== "string") continue;
    try {
      const receipt = object(JSON.parse(message.content));
      if (!shortReference(receipt.receiptId)) continue;
      references.set(message.toolCallId, receipt.receiptId);
      next = Math.max(next, Number(receipt.receiptId.slice(1)) + 1);
    } catch { /* Non-JSON tool data cannot allocate a receipt handle. */ }
  }
  const successful = new Set(currentCompanionSuccessfulReceipts(messages, currentRunEvidence).map(receipt => receipt.id));
  const scoped = new Set(current);
  return messages.map(message => {
    if (!scoped.has(message) || message.role !== "tool" || !message.toolCallId
      || !successful.has(message.toolCallId) || typeof message.content !== "string") return message;
    try {
      const receipt = object(JSON.parse(message.content));
      if (receipt.ok !== true) return message;
      const reference = references.get(message.toolCallId) ?? `r${next++}`;
      references.set(message.toolCallId, reference);
      return { ...message, content: JSON.stringify({ ...receipt, receiptId: reference }) };
    } catch { return message; }
  });
}

export function currentCompanionSuccessfulReceipts(messages: AgentTurnRequest["messages"],
  currentRunEvidence: AgentTurnRequest["messages"] = []) {
  // This optional source is private, hash-checked compaction evidence owned by
  // the same run. Never pass arbitrary conversation history here. Material
  // summaries themselves cannot create successful calls or receipts.
  const current = [...currentRunEvidence.filter(message => message.role === "assistant" || message.role === "tool"),
    ...currentCompanionRequestMessages(messages)];
  const calls = new Map(current.flatMap(message => message.role === "assistant" ? message.toolCalls ?? [] : []).map(call => [call.id, call]));
  const receipts = new Map<string, { id: string; reference?: string; name: string; operation: string; riskClass: string; summary: string;
    arguments: Record<string, unknown>; data: Record<string, unknown> }>();
  for (const message of current) {
    if (message.role !== "tool" || !message.toolCallId || typeof message.content !== "string") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    // The latest receipt for a call owns its outcome; a later unknown/failure
    // cannot leave an earlier optimistic success in the completion ledger.
    receipts.delete(call.id);
    let receipt: Record<string, unknown>;
    try { receipt = object(JSON.parse(message.content)); } catch { continue; }
    const data = object(receipt.data);
    if (receipt.ok !== true || unsuccessful.has(String(receipt.status)) || unsuccessful.has(String(data.status))) continue;
    const operation = companionOperationName(call);
    const definition = getCompanionAgentTool(call.name)
      ?? getCompanionAgentTool(companionOperationDomainTool(operation) ?? operation);
    if (!definition) continue;
    receipts.set(call.id, { id: call.id, ...(shortReference(receipt.receiptId) ? { reference: receipt.receiptId } : {}),
      name: call.name, operation, riskClass: definition.riskClass,
      summary: typeof receipt.summary === "string" ? receipt.summary : "", arguments: call.arguments, data });
  }
  return [...receipts.values()];
}

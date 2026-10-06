import { AgentStoreError, prepareGovernedAIPayload } from "@astella/agent-host";
import { externalAgentCapabilityManifest } from "@astella/shared/agent-capabilities";
import { assertOutsideRegisteredTransactions } from "@astella/shared/workspace-transaction";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { logAICall, resolveAIGovernanceContext } from "../lib/governance.ts";
import { readAgentPublicDocument } from "./public-document.ts";
import type { AgentWorkerAdvanceStore } from "./store.ts";

/** Only URLs in actual user messages grant read access; model and retrieved text do not. */
export function requireUserDocumentUrl(url: string, userTexts: readonly string[]): string {
  const requested = new URL(url);
  requested.hash = "";
  const provided = userTexts.flatMap(text => Array.from(text.matchAll(/https:\/\/[^\s<>"'）)\]】]+/giu)).flatMap(match => {
    try { const source = new URL(match[0].replace(/[.,，。；;!?！？]+$/, "")); source.hash = ""; return [source.href]; }
    catch { return []; }
  }));
  if (!provided.includes(requested.href)) throw new AgentStoreError(403, "document_url_not_authorized", "请先明确提供要读取的公开文档网址。");
  return requested.href;
}

export interface ExternalCapabilityDependencies {
  read?: typeof readAgentPublicDocument;
  governance?: (workspaceId: string, userId: string) => Promise<Pick<Awaited<ReturnType<typeof resolveAIGovernanceContext>>, "policy" | "consentOk">>;
  audit?: typeof logAICall;
}

export async function executeExternalCapability(scope: AgentScopeV1, call: { name: string; arguments: Record<string, unknown> },
  userTexts: readonly string[], signal: AbortSignal, deps: ExternalCapabilityDependencies = {}) {
  const entry = externalAgentCapabilityManifest.find(item => item.definition.name === call.name);
  if (!entry) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
  const input = entry.argumentSchema.parse(call.arguments) as { url: string };
  const url = requireUserDocumentUrl(input.url, userTexts);
  signal.throwIfAborted();
  assertOutsideRegisteredTransactions({ boundary: "Agent public document read", caller: call.name });
  const governance = await (deps.governance ?? resolveAIGovernanceContext)(scope.workspaceId, scope.userId);
  const provider = new URL(url).hostname;
  prepareGovernedAIPayload({ context: governance, workspaceId: scope.workspaceId, providerName: provider, dataCategories: ["public_document_url"], payload: {} });
  const started = performance.now();
  let status: "success" | "error" | "cancelled" = "error";
  try {
    const document = await (deps.read ?? readAgentPublicDocument)(url, signal);
    signal.throwIfAborted(); status = "success";
    return { status: "succeeded" as const, ...document };
  } catch (error) { status = signal.aborted ? "cancelled" : "error"; throw error; }
  finally {
    if (governance.policy.auditLogging) await (deps.audit ?? logAICall)({ workspaceId: scope.workspaceId, userId: scope.userId,
      provider, modelId: "none", operation: call.name, dataCategories: ["public_document_url"],
      dataSizeBytes: Buffer.byteLength(url, "utf8"), costTokens: null, durationMs: Math.round(performance.now() - started), status, errorMessage: null }, { policy: governance.policy }).catch(() => undefined);
  }
}

/** Network stays outside transactions; both acceptance and result are fenced by the current run. */
export async function invokeExternalCapability(store: AgentWorkerAdvanceStore, call: { name: string; arguments: Record<string, unknown> }, signal: AbortSignal) {
  const goal = await store.invoke(async (_tx, run) => run.goal);
  const result = await executeExternalCapability(store.scope, call, [goal], signal);
  return store.invoke(() => Promise.resolve(result));
}

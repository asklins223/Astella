import { AgentStoreError, prepareGovernedAIPayload } from "@astella/agent-host";
import { externalAgentCapabilityManifest } from "@astella/shared/agent-capabilities";
import { assertOutsideRegisteredTransactions } from "@astella/shared/workspace-transaction";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import { logAICall, resolveAIGovernanceContext } from "../lib/governance.ts";
import { readAgentPublicDocument } from "./public-document.ts";
import type { AgentWorkerAdvanceStore } from "./store.ts";
import { executeWebSearch } from "./web-search.ts";

/** Exact user links and host-verified search receipt links are readable.
 * Page text, model guesses and other URLs on the same domain grant nothing. */
export function userDocumentUrls(userTexts: readonly string[]): string[] {
  return userTexts.flatMap(text => Array.from(text.matchAll(/https:\/\/[^\s<>"'）)\]】]+/giu)).flatMap(match => {
    try { const source = new URL(match[0].replace(/[.,，。；;!?！？]+$/, "")); source.hash = ""; return [source.href]; }
    catch { return []; }
  }));
}

export type VerifiedDocumentRedirect = { requestedUrl: string; url: string };
export function requireUserDocumentUrl(url: string, userTexts: readonly string[], verifiedSearchResultUrls: readonly string[] = [],
  verifiedDocumentRedirects: readonly VerifiedDocumentRedirect[] = []): string {
  const requested = new URL(url);
  requested.hash = "";
  const provided = userDocumentUrls(userTexts);
  const searched = verifiedSearchResultUrls.flatMap(value => {
    try {
      const source = new URL(value); source.hash = "";
      return source.protocol === "https:" && !source.username && !source.password ? [source.href] : [];
    } catch { return []; }
  });
  const authorized = new Set([...provided, ...searched]);
  for (const redirect of verifiedDocumentRedirects) {
    try {
      const origin = new URL(redirect.requestedUrl); origin.hash = "";
      const target = new URL(redirect.url); target.hash = "";
      if (authorized.has(origin.href) && target.protocol === "https:" && !target.username && !target.password)
        authorized.add(target.href);
    } catch { /* Invalid provenance does not grant a URL. */ }
  }
  if (!authorized.has(requested.href))
    throw new AgentStoreError(403, "document_url_not_authorized", "这个网址不在用户提供的链接或本轮真实搜索结果中。不要猜换路径重试；请使用已取得的来源，或说明尚未取得可读取的原文。");
  return requested.href;
}

export interface ExternalCapabilityDependencies {
  /** Supplied only by the host after reading the current scoped run's durable
   * search receipts with the account web switch still enabled. Never model args. */
  verifiedSearchResultUrls?: readonly string[];
  verifiedDocumentRedirects?: readonly VerifiedDocumentRedirect[];
  read?: typeof readAgentPublicDocument;
  governance?: (workspaceId: string, userId: string) => Promise<Pick<Awaited<ReturnType<typeof resolveAIGovernanceContext>>, "policy" | "consentOk">>;
  audit?: typeof logAICall;
}

export async function executeExternalCapability(scope: AgentScopeV1, call: { name: string; arguments: Record<string, unknown> },
  userTexts: readonly string[], signal: AbortSignal, deps: ExternalCapabilityDependencies = {}) {
  const entry = externalAgentCapabilityManifest.find(item => item.definition.name === call.name);
  if (!entry) throw new AgentStoreError(400, "unknown_capability", "当前没有这项能力。");
  if (call.name === "agent_web_search") {
    const search = entry.argumentSchema.parse(call.arguments) as Parameters<typeof executeWebSearch>[1];
    return executeWebSearch(scope, search, signal);
  }
  const input = entry.argumentSchema.parse(call.arguments) as { url: string; offset?: number; findText?: string };
  const url = requireUserDocumentUrl(input.url, userTexts, deps.verifiedSearchResultUrls, deps.verifiedDocumentRedirects);
  signal.throwIfAborted();
  assertOutsideRegisteredTransactions({ boundary: "Agent public document read", caller: call.name });
  const governance = await (deps.governance ?? resolveAIGovernanceContext)(scope.workspaceId, scope.userId);
  const provider = new URL(url).hostname;
  prepareGovernedAIPayload({ context: governance, workspaceId: scope.workspaceId, providerName: provider, dataCategories: ["public_document_url"], payload: {} });
  const started = performance.now();
  let status: "success" | "error" | "cancelled" = "error";
  try {
    const document = await (deps.read ?? readAgentPublicDocument)(url, signal, {}, { offset: input.offset, findText: input.findText });
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

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { queryRows, prepareGovernedAIPayload } from "@astella/agent-host";
import { loadPlatformConfig } from "@astella/shared/platform-config-node";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { assertOutsideRegisteredTransactions } from "@astella/shared/workspace-transaction";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { resolveAIGovernanceContext, logAICall } from "../lib/governance.ts";

const SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
export const WEB_SEARCH_MAX_CALLS_PER_TURN = 3;
const QUOTA_COOLDOWN_MS = 30 * 60_000;
const QUOTA_CODES = new Set(["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"]);
const unavailableUntil = new Map<string, number>();
type SearchInput = { query: string; domain?: string; recency?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit" };
type SearchConfig = { apiKey: string };
export type WebSearchSource = {
  referenceId: string; citationMarker: string; title: string; url: string;
  content: string; media: string; publishDate: string;
};
export type WebSearchResult =
  | { status: "succeeded"; query: string; searchedAt: string; sources: WebSearchSource[] }
  | { status: "unavailable"; reason: "disabled" | "not_configured" | "quota_exhausted" | "service_unavailable"; sources: [] };

/** Reuse the existing BigModel platform credential without exposing it to clients. */
export function resolveWebSearchConfig(): SearchConfig | null {
  const platforms = loadPlatformConfig()?.platforms ?? {};
  const platform = platforms.bigmodel ?? Object.values(platforms).find(item => {
    try { return new URL(item.baseUrl ?? "").hostname === "open.bigmodel.cn"; } catch { return false; }
  });
  return platform?.apiKey && !platform.apiKey.includes("${") ? { apiKey: platform.apiKey } : null;
}
const credentialId = (config: SearchConfig) => createHash("sha256").update(config.apiKey).digest("hex");
export function webSearchServiceAvailable(config = resolveWebSearchConfig(), now = Date.now()): boolean {
  return config !== null && (unavailableUntil.get(credentialId(config)) ?? 0) <= now;
}

export async function readWebSearchEnabled(scope: AgentScopeV1): Promise<boolean> {
  const [row] = await withWorkerWorkspaceTransaction(scope, tx => queryRows<{ enabled: boolean }>(tx,
    sql`SELECT COALESCE(agent_settings->'webSearchEnabled' = 'true'::jsonb, false) AS enabled
      FROM user_companion_account_state WHERE user_id=${scope.userId}`));
  return row?.enabled === true;
}

/** Ignore upstream citation numbers: identity remains stable across queries and retries. */
export function normalizeWebSearchSources(value: unknown): WebSearchSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const sources: WebSearchSource[] = [];
  const field = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    let url: URL;
    try { url = new URL(String(row.link)); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) continue;
    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const referenceId = `web-${createHash("sha256").update(url.href).digest("hex").slice(0, 16)}`;
    sources.push({ referenceId, citationMarker: `[^${referenceId}]`, url: url.href,
      title: field(row.title, 200) || url.hostname, content: field(row.content, 1600),
      media: field(row.media, 100) || url.hostname, publishDate: field(row.publish_date, 80) });
    if (sources.length >= 8) break;
  }
  return sources;
}

export function webSearchCitationBlocks(result: WebSearchResult): CompanionContentBlockV1[] {
  return result.sources.map(source => ({ type: "citation", referenceId: source.referenceId, label: source.title,
    target: { kind: "external_https", href: source.url }, media: source.media,
    ...(source.publishDate ? { publishDate: source.publishDate } : {}) }));
}

/** Restore trusted provenance from a durable tool receipt, without searching again. */
export function readWebSearchReceipt(ref: string | null): WebSearchResult | null {
  if (!ref) return null;
  try {
    const data = JSON.parse(ref);
    if (data.status === "unavailable" && ["disabled", "not_configured", "quota_exhausted", "service_unavailable"].includes(data.reason))
      return { status: "unavailable", reason: data.reason, sources: [] };
    if (data.status !== "succeeded" || typeof data.query !== "string" || typeof data.searchedAt !== "string" || !Array.isArray(data.sources)) return null;
    const sources = normalizeWebSearchSources(data.sources.map((source: WebSearchSource) => ({
      link: source.url, title: source.title, content: source.content, media: source.media, publish_date: source.publishDate,
    })));
    return { status: "succeeded", query: data.query.slice(0, 70), searchedAt: data.searchedAt, sources };
  } catch { return null; }
}

export async function readCompanionWebSearchReceipts(scope: AgentScopeV1, runId: string): Promise<WebSearchResult[]> {
  const rows = await withWorkerWorkspaceTransaction(scope, tx => queryRows<{ result_ref: string | null }>(tx,
    sql`SELECT result_ref FROM companion_agent_tool_calls WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND run_id=${runId} AND name='agent_web_search' AND status='succeeded'
      ORDER BY created_at,id`));
  return rows.flatMap(row => { const result = readWebSearchReceipt(row.result_ref); return result ? [result] : []; });
}

export interface WebSearchDependencies {
  config?: () => SearchConfig | null;
  enabled?: typeof readWebSearchEnabled;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  governance?: (workspaceId: string, userId: string) => Promise<Pick<Awaited<ReturnType<typeof resolveAIGovernanceContext>>, "policy" | "consentOk">>;
  audit?: typeof logAICall;
}

export async function executeWebSearch(scope: AgentScopeV1, input: SearchInput, signal: AbortSignal,
  deps: WebSearchDependencies = {}): Promise<WebSearchResult> {
  signal.throwIfAborted();
  const unavailable = (reason: Extract<WebSearchResult, { status: "unavailable" }>["reason"]): WebSearchResult =>
    ({ status: "unavailable", reason, sources: [] });
  if (!await (deps.enabled ?? readWebSearchEnabled)(scope)) return unavailable("disabled");
  const config = (deps.config ?? resolveWebSearchConfig)();
  if (!config) return unavailable("not_configured");
  const now = deps.now ?? Date.now;
  if (!webSearchServiceAvailable(config, now())) return unavailable("quota_exhausted");
  assertOutsideRegisteredTransactions({ boundary: "Agent web search", caller: "agent_web_search" });
  const governance = await (deps.governance ?? resolveAIGovernanceContext)(scope.workspaceId, scope.userId);
  const body = { search_query: input.query, search_engine: "search_std", search_intent: false,
    count: 8, content_size: "medium", search_recency_filter: input.recency ?? "noLimit",
    ...(input.domain ? { search_domain_filter: input.domain } : {}) };
  const governedBody = prepareGovernedAIPayload({ context: governance, workspaceId: scope.workspaceId, providerName: "bigmodel",
    dataCategories: ["user_answer", "note_content"], payload: body });
  const started = now();
  let status: "success" | "error" | "cancelled" = "error";
  try {
    const response = await (deps.fetch ?? globalThis.fetch)(SEARCH_URL, {
      method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(governedBody), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    });
    const raw = await response.text();
    signal.throwIfAborted();
    if (raw.length > 2_000_000) return unavailable("service_unavailable");
    const data = JSON.parse(raw) as { error?: { code?: string | number }; search_result?: unknown };
    if (QUOTA_CODES.has(String(data.error?.code))) {
      unavailableUntil.set(credentialId(config), now() + QUOTA_COOLDOWN_MS);
      return unavailable("quota_exhausted");
    }
    if (!response.ok || data.error || !Array.isArray(data.search_result)) return unavailable("service_unavailable");
    status = "success";
    return { status: "succeeded", query: input.query, searchedAt: new Date(now()).toISOString(),
      sources: normalizeWebSearchSources(data.search_result) };
  } catch {
    if (signal.aborted) { status = "cancelled"; signal.throwIfAborted(); }
    return unavailable("service_unavailable");
  } finally {
    if (governance.policy.auditLogging) await (deps.audit ?? logAICall)({ workspaceId: scope.workspaceId, userId: scope.userId,
      provider: "bigmodel", modelId: "search_std", operation: "agent_web_search", dataCategories: ["user_answer", "note_content"],
      dataSizeBytes: Buffer.byteLength(JSON.stringify(body), "utf8"), costTokens: null,
      durationMs: Math.max(0, now() - started), status, errorMessage: null }, { policy: governance.policy }).catch(() => undefined);
  }
}

import { companionOperationName } from "@astella/shared";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { queryRows, prepareGovernedAIPayload } from "@astella/agent-host";
import { loadPlatformConfig } from "@astella/shared/platform-config-node";
import type { AgentScopeV1 } from "@astella/shared/agent-contracts";
import type { CompanionWebSearchProcessV1 } from "@astella/shared/companion-agent-contracts";
import type { CompanionContentBlockV1 } from "@astella/shared/companion-conversation-contracts";
import { assertOutsideRegisteredTransactions } from "@astella/shared/workspace-transaction";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { resolveAIGovernanceContext, logAICall } from "../lib/governance.ts";

const SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
const QUOTA_COOLDOWN_MS = 30 * 60_000;
const QUOTA_CODES = new Set(["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"]);
const unavailableUntil = new Map<string, number>();
type SearchInput = { query: string; domain?: string; recency?: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit" };
type SearchConfig = { apiKey: string };
type SearchEngine = "search_std" | "search_pro_sogou";
// Paired live queries found the original research immediately here while the
// basic index returned mirrors and exam pages. Same provider and credential.
const DEFAULT_SEARCH_ENGINE: SearchEngine = "search_pro_sogou";
export type WebSearchSource = {
  referenceId: string; citationMarker: string; title: string; url: string;
  content: string; media: string; publishDate: string;
};
export type WebSearchResult =
  | { status: "succeeded"; query: string; searchedAt: string; sources: WebSearchSource[]; documents?: WebSearchDocument[] }
  | { status: "unavailable"; reason: "disabled" | "not_configured" | "quota_exhausted" | "service_unavailable"; sources: [] };

export type WebSearchDocument = { referenceId: string; requestedUrl: string; citationMarker?: string; document: Record<string, unknown> };

/** A search snippet cannot stand in for a page read. Embedded document receipts
 * must match this exact search's source identity and carry a real text/hash. */
export function successfulWebSearchDocuments(data: Record<string, unknown>): WebSearchDocument[] {
  if (data.status !== "succeeded" || !Array.isArray(data.sources) || !Array.isArray(data.documents)) return [];
  return data.documents.filter((item): item is WebSearchDocument => item !== null && typeof item === "object"
    && typeof item.referenceId === "string" && typeof item.requestedUrl === "string"
    && data.sources instanceof Array && data.sources.some(source => source?.referenceId === item.referenceId && source.url === item.requestedUrl)
    && item.document?.status === "succeeded" && typeof item.document.text === "string" && item.document.text.trim().length > 0
    && typeof item.document.contentHash === "string" && /^[a-f0-9]{64}$/.test(item.document.contentHash));
}

/** Report actual new material, not whether the query string changed. This
 * leaves source selection to the Agent and never limits a research task. */
export function webSearchMaterialProgress(result: Extract<WebSearchResult, { status: "succeeded" }>, previous: readonly WebSearchResult[]) {
  const fingerprint = (source: WebSearchSource) => JSON.stringify([source.title, source.content, source.media, source.publishDate]);
  const seen = new Map<string, string>();
  for (const receipt of previous) for (const source of receipt.sources) seen.set(source.url, fingerprint(source));
  let newSourceCount = 0, changedSourceCount = 0, repeatedSourceCount = 0;
  for (const source of result.sources) {
    const earlier = seen.get(source.url);
    if (earlier === undefined) newSourceCount++;
    else if (earlier !== fingerprint(source)) changedSourceCount++;
    else repeatedSourceCount++;
  }
  return { newSourceCount, changedSourceCount, repeatedSourceCount,
    ...(previous.some(receipt => receipt.status === "succeeded") && newSourceCount + changedSourceCount === 0
      ? { note: "与本轮先前成功检索相比，本次没有取得新的网页或摘要材料。查询文字变化不等于证据增加。按尚缺的具体资料决定是否继续检索或读取已有来源；不要把反复未检出当成相关研究不存在。摘要只用于定位，原文是否支持结论仍需实际读取核对。" } : {}) };
}

/** Reuse the existing BigModel platform credential without exposing it to clients. */
export function resolveWebSearchConfig(platforms = loadPlatformConfig()?.platforms ?? {}): SearchConfig | null {
  const platform = platforms.bigmodel ?? Object.values(platforms).find(item => {
    try { return new URL(item.baseUrl ?? "").hostname === "open.bigmodel.cn"; } catch { return false; }
  });
  return platform?.apiKey && !platform.apiKey.includes("${") ? { apiKey: platform.apiKey } : null;
}
const credentialId = (config: SearchConfig, engine: SearchEngine = DEFAULT_SEARCH_ENGINE) =>
  createHash("sha256").update(config.apiKey).update(engine).digest("hex");
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
export function normalizeWebSearchSources(value: unknown, domain?: string): WebSearchSource[] {
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
    if (domain) {
      const allowed = domain.toLowerCase(), host = url.hostname.toLowerCase();
      if (host !== allowed && !host.endsWith(`.${allowed}`)) continue;
    }
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
    const documents = Array.isArray(data.documents) ? data.documents.filter((item: WebSearchDocument) =>
      item && typeof item.referenceId === "string" && typeof item.requestedUrl === "string"
      && sources.some(source => source.referenceId === item.referenceId && source.url === item.requestedUrl)
      && item.document && typeof item.document === "object") : undefined;
    return { status: "succeeded", query: data.query, searchedAt: data.searchedAt, sources, ...(documents ? { documents } : {}) };
  } catch { return null; }
}

/** Only the validated query and durable executor receipt enter the UI. */
export function webSearchProcessDetail(operation: string, args: Record<string, unknown>, resultRef: string | null = null): CompanionWebSearchProcessV1 | undefined {
  const resolved = companionOperationName({ name: operation, arguments: args });
  if (!["web.search", "agent_web_search"].includes(resolved) || typeof args.query !== "string" || !args.query.trim()) return undefined;
  const result = readWebSearchReceipt(resultRef);
  return { query: args.query.trim().slice(0, 70),
    ...(typeof args.domain === "string" ? { domain: args.domain.slice(0, 253) } : {}),
    ...(result ? { outcome: result.status } : {}),
    ...(result?.status === "succeeded" ? { searchedAt: result.searchedAt } : {}),
    sources: result?.sources.map(({ referenceId, title, url, media, publishDate }) => ({ referenceId, title, url, media, publishDate })) ?? [],
  };
}

export async function readCompanionWebSearchReceipts(scope: AgentScopeV1, runId: string): Promise<WebSearchResult[]> {
  const rows = await withWorkerWorkspaceTransaction(scope, tx => queryRows<{ result_ref: string | null }>(tx,
    sql`SELECT result_ref FROM companion_agent_tool_calls WHERE workspace_id=${scope.workspaceId}
      AND user_id=${scope.userId} AND run_id=${runId} AND name IN ('web.search','agent_web_search') AND status='succeeded'
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
  const search = async (engine: SearchEngine): Promise<WebSearchResult> => {
    signal.throwIfAborted();
    if ((unavailableUntil.get(credentialId(config, engine)) ?? 0) > now()) return unavailable("quota_exhausted");
    // A second request gets fresh consent/egress checks, too. The same service,
    // credential, query, domain and recency constraints apply to both engines.
    const governance = await (deps.governance ?? resolveAIGovernanceContext)(scope.workspaceId, scope.userId);
    const body = { search_query: input.query, search_engine: engine, search_intent: false,
      count: engine === "search_pro_sogou" ? 10 : 8, content_size: "medium", search_recency_filter: input.recency ?? "noLimit",
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
        unavailableUntil.set(credentialId(config, engine), now() + QUOTA_COOLDOWN_MS);
        return unavailable("quota_exhausted");
      }
      if (!response.ok || data.error || !Array.isArray(data.search_result)) return unavailable("service_unavailable");
      status = "success";
      return { status: "succeeded", query: input.query, searchedAt: new Date(now()).toISOString(),
        sources: normalizeWebSearchSources(data.search_result, input.domain) };
    } catch {
      if (signal.aborted) { status = "cancelled"; signal.throwIfAborted(); }
      return unavailable("service_unavailable");
    } finally {
      if (governance.policy.auditLogging) await (deps.audit ?? logAICall)({ workspaceId: scope.workspaceId, userId: scope.userId,
        provider: "bigmodel", modelId: engine, operation: "agent_web_search", dataCategories: ["user_answer", "note_content"],
        dataSizeBytes: Buffer.byteLength(JSON.stringify(governedBody), "utf8"), costTokens: null,
        durationMs: Math.max(0, now() - started), status, errorMessage: null }, { policy: governance.policy }).catch(() => undefined);
    }
  };
  const primary = await search(DEFAULT_SEARCH_ENGINE);
  if (primary.status !== "succeeded" || primary.sources.length > 0) return primary;
  // An index can miss an entire requested site. One alternate index
  // supplies actual pages without another model round. Errors, quota failures
  // and denials never enter this path; filtering and receipt provenance stay.
  signal.throwIfAborted();
  if (!await (deps.enabled ?? readWebSearchEnabled)(scope)) return unavailable("disabled");
  return search("search_std");
}

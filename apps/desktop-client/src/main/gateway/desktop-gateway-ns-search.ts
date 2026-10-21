
import { DesktopGatewayFailure } from "./desktop-gateway-failure";import { searchDriftResultV1Schema, searchReindexResultV1Schema, type SearchDriftResultV1, type SearchReindexResultV1 } from "@astella/shared/desktop-ipc-contracts";import { desktopSearchPageSchema, type DesktopSearchPage } from "@astella/shared/desktop-surface-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function getSearchDrift(t: GatewayTransport, requestId?: string): Promise<SearchDriftResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/search/drift", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const count = (value: unknown): number | undefined =>
      Array.isArray(value) ? value.length : typeof value === "number" ? value : undefined;
    // 「内容过期」= 标题过期 + 正文过期。只数标题会让"正文过期但标题没变"的漂移
    // 在界面上显示成 `发现漂移：缺失 0、幽灵 0、内容过期 0`——三个 0 配一句"发现漂移"，
    // 用户只能当它坏了（审计 F15 现场读到的就是这三个数）。两类过期都算进来，
    // hasDrift 与这几个计数才是同一件事。
    const staleTitles = count(payload.staleTitles) ?? 0;
    const staleBodies = count(payload.staleBodies) ?? 0;
    const parsed = searchDriftResultV1Schema.safeParse({
      version: 1,
      hasDrift: payload.hasDrift,
      ghosts: count(payload.ghosts),
      missing: count(payload.missing),
      stale: staleTitles + staleBodies,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function reindexSearch(t: GatewayTransport, requestId?: string): Promise<SearchReindexResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/search/reindex", { method: "POST", body: JSON.stringify({}) }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const indexed = (payload.indexed ?? {}) as Record<string, unknown>;
    const parsed = searchReindexResultV1Schema.safeParse({
      version: 1,
      deleted: payload.deleted,
      indexedNotes: indexed.note,
      indexedSources: indexed.source,
      indexedObjectives: indexed.objective,
      errors: payload.errors,
      capped: payload.capped,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function searchGlobal(t: GatewayTransport, queryValue: string, options: { type?: "note" | "source" | "objective"; limit?: number; cursor?: string } = {}, requestId?: string): Promise<DesktopSearchPage> {
    await t.ensureConnected(requestId);
    const query = new URLSearchParams({ q: queryValue });
    if (options.type) query.set("type", options.type);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    // 游标原样透传：它是服务端生成的 keyset 位置，主进程不解释也不重算。
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    const result = await t.request(`/search?${query.toString()}`, { method: "GET" }, true, true, requestId);
    const parsed = desktopSearchPageSchema.safeParse(result.body);
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

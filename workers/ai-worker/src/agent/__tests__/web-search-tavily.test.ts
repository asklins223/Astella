import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWorkspaceAIPolicy } from "@astella/agent-host";
import { executeWebSearch, normalizeWebSearchSources, resolveWebSearchConfig,
  webSearchServiceAvailable, type WebSearchDependencies } from "../web-search.ts";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222" };
const configured = { provider: "tavily" as const, apiKey: "tavily-test" };
const dependencies = (overrides: WebSearchDependencies = {}): WebSearchDependencies => ({
  config: () => configured, enabled: async () => true,
  governance: async () => ({ consentOk: true, policy: normalizeWorkspaceAIPolicy({ sendToExternal: true, auditLogging: false }) }),
  ...overrides,
});
const run = (deps: WebSearchDependencies) => executeWebSearch(scope, { query: "官方原文", domain: "example.com", recency: "oneWeek" },
  new AbortController().signal, dependencies(deps));

test("an explicitly selected Tavily service never borrows a missing key from the chat platform", () => {
  const platforms = { bigmodel: { type: "openai_compatible" as const, apiKey: "other-account", models: {} } };
  assert.deepEqual(resolveWebSearchConfig(platforms, { WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: " own-key " }),
    { provider: "tavily", apiKey: "own-key" });
  assert.equal(resolveWebSearchConfig(platforms, { WEB_SEARCH_PROVIDER: "tavily" }), null);
  assert.equal(resolveWebSearchConfig(platforms, { WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "${MISSING}" }), null);
  assert.equal(resolveWebSearchConfig(platforms, { WEB_SEARCH_PROVIDER: "unknown" }), null);
});

test("Tavily uses basic search with automatic upgrades off and preserves source identities", async () => {
  const audits: unknown[] = [];
  const result = await run({
    governance: async () => ({ consentOk: true, policy: normalizeWorkspaceAIPolicy({ sendToExternal: true, auditLogging: true }) }),
    audit: async value => { audits.push(value); return true; },
    fetch: async (url, init) => {
      assert.equal(url, "https://api.tavily.com/search");
      assert.equal(init!.redirect, "error");
      assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer tavily-test");
      assert.deepEqual(JSON.parse(String(init!.body)), { query: "官方原文", search_depth: "basic", max_results: 8,
        auto_parameters: false, include_answer: false, include_raw_content: false,
        include_domains: ["example.com"], time_range: "week" });
      return Response.json({ results: [
        { url: "https://example.com/page", title: "真实来源", content: "untrusted source text", published_date: "2026-11-04", raw_content: "Not a host read receipt" },
        { url: "https://example.com/page#duplicate" }, { url: "https://other.example/page" },
        { url: "javascript:alert(1)" }, { url: "https://user:password@example.com/" }, null,
      ] });
    },
  });
  assert.equal(result.status, "succeeded"); assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]!.referenceId, normalizeWebSearchSources([{ link: "https://example.com/page" }])[0]!.referenceId);
  assert.equal(result.sources[0]!.publishDate, "2026-11-04");
  assert.ok(!("documents" in result), "a search result is not a document read");
  assert.ok(!JSON.stringify(audits).includes("tavily-test"));
  assert.ok(!JSON.stringify(audits).includes("untrusted source text"));
  assert.match(JSON.stringify(audits), /tavily-basic/);
});

test("a Tavily quota stops further probes without switching providers; a temporary throttle does not poison availability", async () => {
  let requests = 0, now = 1000;
  const config = { provider: "tavily" as const, apiKey: "tavily-quota-test" };
  const deps = dependencies({ config: () => config, now: () => now,
    fetch: async url => { requests++; assert.equal(url, "https://api.tavily.com/search"); return Response.json({ detail: { error: "usage limit" } }, { status: 432 }); } });
  assert.deepEqual(await run(deps), { status: "unavailable", reason: "quota_exhausted", sources: [] });
  await run(deps); assert.equal(requests, 1); assert.equal(webSearchServiceAvailable(config, now), false);
  assert.equal(webSearchServiceAvailable({ apiKey: config.apiKey }, now), true, "cooldown is provider-specific");
  now += 30 * 60_000; assert.equal(webSearchServiceAvailable(config, now), true);
  const limited = { provider: "tavily" as const, apiKey: "temporary-throttle-test" };
  await run({ config: () => limited, fetch: async () => Response.json({ detail: "slow down" }, { status: 429 }) });
  assert.equal(webSearchServiceAvailable(limited), true);
});

test("empty Tavily results, denial and cancellation never invoke another account", async () => {
  let requests = 0;
  const fetch: typeof globalThis.fetch = async url => { requests++; assert.equal(url, "https://api.tavily.com/search"); return Response.json({ results: [] }); };
  const empty = await run({ fetch }); assert.equal(empty.status, "succeeded"); assert.equal(requests, 1);
  await run({ enabled: async () => false, fetch }); assert.equal(requests, 1);
  await assert.rejects(run({ fetch, governance: async () => ({ consentOk: false,
    policy: normalizeWorkspaceAIPolicy({ sendToExternal: true }) }) }));
  assert.equal(requests, 1);
  const controller = new AbortController();
  await assert.rejects(executeWebSearch(scope, { query: "公开查询" }, controller.signal, dependencies({
    fetch: async () => { controller.abort(); return Response.json({ results: [] }); },
  })), error => error instanceof Error && error.name === "AbortError");
});

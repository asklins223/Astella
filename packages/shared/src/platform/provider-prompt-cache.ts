/**
 * Provider 提示词前缀缓存（server side）。
 *
 * ## 为什么正名（P3-12，2026-09-29）
 *
 * 这个文件此前叫 `feature-flags.ts`，而它里面**只有一件事**：
 * `PROMPT_CACHE_ENABLED` / `PROMPT_CACHE_PROVIDERS` 这两个环境变量，
 * 决定要不要给 provider 的请求加缓存提示。
 *
 * 名字承诺的是"通用 feature flag 收口处"，实际是"provider 缓存开关"——
 * 于是两类错误都会发生：以为"新 flag 都该加在这里"而往里塞，
 * 以及以为"这里管所有开关"而找不到自己那个。
 *
 * 仓库里真正的 feature flag 收口处是 `apps/api/src/config/learning-companion-flags.ts`
 * （P1-8 建的那一份）。两份同名不同物，是这类误用的温床。
 *
 * ## 边界
 *
 * 只读 `process.env`（**不是** `NEXT_PUBLIC_*`），所以只在服务端可用；
 * 默认关闭。
 *
 * ⚠️ 刻意**不**从 `apps/desktop-client` 的编译图里引入：那边有
 * `objective-state-copy.ts` 的注释记着这件事。
 */
/**
 * PROMPT_CACHE_ENABLED — gates provider prompt caching (B2, 计划 §2.5).
 *
 * When false (default): no cache control markers are sent to providers,
 * and cache-related usage fields are parsed but not actively requested.
 *
 * When true: providers in the PROMPT_CACHE_PROVIDERS whitelist will have
 * cache control hints added to their requests, enabling prompt prefix
 * reuse across turns within the same run.
 *
 * Risk control: flag default off; parse failure silently degrades.
 */
function isPromptCacheEnabled(): boolean {
  return process.env.PROMPT_CACHE_ENABLED === "true";
}

// PROMPT_CACHE_PROVIDERS is effectively static in production; parse it once
// and reuse the Set to avoid per-call env split + allocation on hot LLM paths.
// Cache is keyed by the raw env value so tests that mutate env still get correct
// per-value parsing.
let promptCacheProvidersCache: { raw: string | undefined; set: Set<string> } | null = null;

/**
 * Get the set of provider IDs allowed to use prompt caching.
 *
 * Reads from PROMPT_CACHE_PROVIDERS env var (comma-separated).
 * When PROMPT_CACHE_ENABLED is true but PROMPT_CACHE_PROVIDERS is unset,
 * defaults to "dashscope" (the most commonly supported provider).
 *
 * @returns Set of lowercase provider IDs (e.g., {"dashscope", "openai_compatible"})
 */
export function getPromptCacheProviders(): Set<string> {
  const raw = process.env.PROMPT_CACHE_PROVIDERS;
  if (promptCacheProvidersCache && promptCacheProvidersCache.raw === raw) {
    return promptCacheProvidersCache.set;
  }

  let parsed: Set<string>;
  if (!raw || raw.trim() === "") {
    parsed = new Set(["dashscope"]);
  } else {
    const items = raw.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    // If all entries were empty/whitespace, fall back to default
    parsed = items.length > 0 ? new Set(items) : new Set(["dashscope"]);
  }
  promptCacheProvidersCache = { raw, set: parsed };
  return parsed;
}

/**
 * Check if a specific provider should use prompt caching.
 * Convenience wrapper: checks both the global flag and the provider whitelist.
 */
export function shouldUsePromptCache(providerId: string): boolean {
  if (!isPromptCacheEnabled()) return false;
  return getPromptCacheProviders().has(providerId.toLowerCase());
}

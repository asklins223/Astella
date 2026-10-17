/**
 * Local embedding provider for the in-compose BGE-M3 service.
 *
 * It deliberately does **not** use `postJsonToPublicEndpoint`: that guard
 * rejects private/Docker-internal addresses to prevent SSRF, while this
 * endpoint is configured by the operator and intentionally local. Input is
 * truncated exactly like the SiliconFlow provider so fallback vectors describe
 * the same text.
 */

import type { ProviderRuntimeConfig, CapabilityImpl } from "@astella/shared";
import type { EmbeddingProviderLike } from "../ai-provider.ts";
import { registerFactory } from "../provider-factory.ts";
import { logger } from "../logger.ts";

const LOCAL_EMBED_MAX_CHARS = 1_500;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function endpoints(baseUrl: string): string {
  return /\/embeddings$/i.test(baseUrl) ? baseUrl : `${normalizeBaseUrl(baseUrl)}/embeddings`;
}

export class LocalEmbeddingProvider implements EmbeddingProviderLike {
  readonly id = "local_embedding";
  readonly embeddingModelId: string;
  private readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(options: { baseUrl: string; model: string; apiKey?: string }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.endpoint = endpoints(this.baseUrl);
    this.embeddingModelId = options.model;
    this.apiKey = options.apiKey ?? "local";
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[] | null> {
    const input = text.slice(0, LOCAL_EMBED_MAX_CHARS);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.embeddingModelId,
          input: [input],
          encoding_format: "float",
        }),
        signal: signal ?? AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        logger.warn({ provider: this.id, model: this.embeddingModelId, status: response.status },
          "local embedding request failed — falling back to null (lexical search)");
        return null;
      }
      const body = await response.json() as { data?: Array<{ embedding?: unknown }> };
      const embedding = body?.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || embedding.length === 0) return null;
      return embedding.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    } catch (error) {
      logger.warn({ provider: this.id, model: this.embeddingModelId,
        error: error instanceof Error ? error.name : typeof error },
      "local embedding request threw — falling back to null (lexical search)");
      return null;
    }
  }
}

registerFactory("local_embedding", "embedding", (config: ProviderRuntimeConfig) => {
  const baseUrl = config.baseUrl;
  const model = config.model;
  if (!baseUrl || !model) return null;
  return new LocalEmbeddingProvider({
    baseUrl,
    model,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  }) as unknown as CapabilityImpl;
});

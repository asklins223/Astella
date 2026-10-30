import type {
  AgentTurnRequest,
  AgentTurnResult,
  ProviderCapability,
  ChatMessage,
  ChatOptions,
  ChatResult,
} from "@astella/shared";

// ─── v0.6: Provider Usage Tracking (计划 §6.6, §10.5) ───────────────────


/**
 * Token usage returned by an AI provider after a call.
 *
 * All fields are optional because not all providers return usage data
 * (e.g., Mock provider returns estimated values).
 *
 * This is used to populate:
 * - `ai_artifacts.cost_tokens` (§6.6)
 * - `ai_audit_log.cost_tokens` via `logAICall` (§10.5)
 */
export interface ProviderUsage {
  /** Total tokens (prompt + completion) */
  totalTokens?: number | null;
  /** Prompt/input tokens */
  promptTokens?: number | null;
  /** Completion/output tokens */
  completionTokens?: number | null;
  /** Provider request ID (for traceability, §5.2 Should) */
  requestId?: string | null;
  /**
   * B2（计划 §2.5）：prompt cache 命中的 token 数。
   * provider 返回 cache 命中时记录，用于成本观测。
   */
  cacheHitTokens?: number | null;
  /**
   * B2（计划 §2.5）：prompt cache 未命中的 token 数。
   */
  cacheMissTokens?: number | null;
}

/**
 * AIProvider interface: generic model capabilities only.
 */
export interface AIProvider {
  id: string;
  modelId: string;
  visionModelId: string;
  promptVersion: string;

  // ── Generic capability methods ──
  /** Generic chat completion; callers own prompt and output contracts. */
  chatCompletion(
    messages: ChatMessage[],
    options: ChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResult>;

  /**
   * §8.2 真实流式 chat completion：逐 token/增量调用 onDelta（不可为空串），
   * 返回累积全文与（若实现支持）本轮 native tool_calls。可选实现。
   *
   * 生产调用方：companion agent 的每一步（runStreamingAgentStep，
   * responseFormat="text"），增量经交付管线边生成边落库下发。
   *
   * `toolCalls` 为可选：SSE 里 `delta.tool_calls` 与 `delta.content` 并列，
   * 但只有声明 `chatCompletionStreamToolCalls = true` 的实现才保证把它解析出来。
   * 未声明的实现仍会返回该字段（恒为空数组），调用方据此判断"这一步真的没调工具"
   * 还是"这条流根本看不见工具调用"。
   */
  chatCompletionStream?(
    messages: ChatMessage[],
    options: ChatOptions,
    signal: AbortSignal | undefined,
    onDelta: (deltaText: string) => void,
  ): Promise<{
    content: string;
    toolCalls?: AgentTurnResult["toolCalls"];
    /** SSE 末尾的 finish_reason（缺省视作 stop；"length" 表示输出被截断）。 */
    finishReason?: string;
    phase?: "commentary" | "final_answer";
    /** Native Responses tool loops must replay opaque reasoning handles. */
    reasoning?: AgentTurnResult["reasoning"];
    usage?: AgentTurnResult["usage"];
    providerRequestId?: string | null;
  }>;

  /**
   * 流式路径是否解析 `delta.tool_calls`（2026-09-19 ④-b）。
   *
   * agent 循环用它决定**带工具的一步**能不能走流式：不能的话那一步必须留在
   * 整段取回路径上（否则模型返回的工具调用会被静默丢掉，用户看到的是一句
   * "我去看看"却什么都没发生）。
   */
  chatCompletionStreamToolCalls?: boolean;

  // ── Supervisor Agent v1（计划 §8.1） ──
  executeAgentTurn?(request: AgentTurnRequest, signal?: AbortSignal,
    observation?: { onOutputActivity?: (kind?: "text" | "reasoning" | "tool") => void }): Promise<AgentTurnResult>;
  getCapabilities?(): ProviderCapability;
  /** Effective transport output ceiling, also used by the context governor. */
  /** 这一发的输出天花板：档案声明值，拿不到声明时是这一档平台的兜底。 */
  resolveOutputTokenLimit?(): number | undefined;
  /** Local tokenizer for this model; null means no verified tokenizer exists. */
  countTextTokens?(text: string): Promise<number | null>;

  // ── Embedding (optional) ──
  embed?(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

// Import provider modules for their factory registrations.
import "./providers/mock.ts";
import "./providers/dashscope.ts";
import "./providers/openai-compatible.ts";
import "./providers/siliconflow.ts";
import "./providers/opencode-go.ts";
import "./providers/pi-agent.ts";
import "./providers/local-embedding.ts";
import { createCapabilityProvider } from "./provider-factory.ts";
import { logger } from "./logger.ts";
import type { ProviderRuntimeConfig as SharedRuntimeConfig } from "@astella/shared";
import { resolveSystemPlatform } from "@astella/shared/platform-config-node";
import type { PlatformOptions } from "@astella/shared";

export interface AIProviderRuntimeConfig {
  sessionId?: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  /** 模型能力档案（2026-10-06 配置重设计）：上下文/输出/识图/推理档位。 */
  modelProfile?: import("@astella/shared").ModelProfile;
  /** 平台级网关怪癖（disableMaxTokens / workspace / extraHeaders）。 */
  options?: PlatformOptions;
}

export interface AIProviderSelection {
  providerName: string;
  config: AIProviderRuntimeConfig;
}

/**
 * N-011: 根据 provider 名称创建 AIProvider 实例。
 *
 * R2: 只通过 provider 注册表创建实例；provider 配置由治理上下文提供。
 *
 * @param providerName provider 标识（mock | dashscope | openai_compatible | siliconflow | opencode_go）
 */
export function createProvider(
  providerName: string,
  config: AIProviderRuntimeConfig = {},
): AIProvider {
  const id = providerName.toLowerCase();

  // §2.3 缺 key 判定 fail-fast：非 mock provider 收到含 ${VAR} 字面文本的 apiKey 时，
  // 说明 config/ai-platforms.json 引用了未设置的 env var。立即报错而非等到请求期 401。
  // （resolveSystemPlatform 已将同一场景视为不可用，此处阻止未解析占位符进入 provider。）
  if (id !== "mock" && config.apiKey && config.apiKey.includes("${")) {
    // 不回显 apiKey 内容（即使其形式为未解析的 ${VAR} 占位符，也可能
    // 泄露配置细节到错误/日志）。
    throw new Error(
      `Provider "${providerName}" received an unresolved env var reference in apiKey (e.g. \${VAR}). `
      + "Set the referenced environment variable or remove the reference in config/ai-platforms.json.",
    );
  }

  const impl = createCapabilityProvider(id, "agent_turn", config as SharedRuntimeConfig);
  if (!impl) {
    throw new Error(`provider ${id} is not configured for agent_turn`);
  }
  return impl as unknown as AIProvider;
}

/**
 * Resolve the provider configuration once per job. Governance and provider
 * construction must use this same snapshot so a concurrent settings change
 * cannot make the checked provider differ from the provider being called.
 *
 * BUG-11: When callers have already resolved a governance context via
 * `resolveAIGovernanceContext`, they should pass it as `cachedContext` to
 * avoid a redundant workspace query and ensure provider selection is based
 * on the same workspace snapshot as the governance check.
 *
 * ARCH-06: This function delegates to `resolveAIGovernanceContext` when no
 * cached context is provided, keeping provider selection on one config path.
 */
export async function resolveProviderSelection(
  workspaceId?: string,
  userId?: string,
  cachedContext?: { providerName: string; providerConfig: AIProviderRuntimeConfig },
): Promise<AIProviderSelection> {
  // BUG-11: If a cached governance context is available, reuse its provider
  // resolution to avoid querying the workspaces table a second time.
  if (cachedContext) {
    return {
      providerName: cachedContext.providerName,
      config: cachedContext.providerConfig,
    };
  }

  // ARCH-06: Delegate to resolveAIGovernanceContext so there is a single
  // code path for system platform config resolution. This ensures
  // provider selection and governance checks always see the same snapshot.
  if (workspaceId) {
    const { resolveAIGovernanceContext } = await import("./governance.ts");
    const ctx = await resolveAIGovernanceContext(workspaceId, userId ?? null);
    return { providerName: ctx.providerName, config: ctx.providerConfig };
  }

  // Use platform config file to resolve system-level provider + config.
  const platform = resolveSystemPlatform("agent_turn");
  if (platform) {
    return {
      providerName: platform.type,
      config: {
        apiKey: platform.apiKey,
        baseUrl: platform.baseUrl,
        model: platform.model,
        modelProfile: platform.modelProfile,
        options: platform.options,
      },
    };
  }
  return {
    providerName: "mock",
    config: {},
  };
}

/**
 * Embedding provider interface (subset of AIProvider used for semantic search).
 * Matches EvidenceEmbeddingProvider from agent/tools/evidence.ts.
 */
export interface EmbeddingProviderLike {
  readonly id: string;
  readonly embeddingModelId: string;
  embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

function positiveEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function embedWithTimeout(
  provider: EmbeddingProviderLike,
  text: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      provider.embed(text, signal).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * SiliconFlow primary + local BGE-M3 fallback.
 *
 * The fallback is used when the primary returns null/throws, exceeds the
 * per-call timeout, is already handling `maxInflight` calls, or its circuit is
 * open. The model id must match: pgvector rows are keyed by
 * `model_revision = provider.embeddingModelId`; a different local model would
 * silently invalidate every stored vector.
 */
export class FallbackEmbeddingProvider implements EmbeddingProviderLike {
  readonly id: string;
  readonly embeddingModelId: string;
  private readonly primaryTimeoutMs: number;
  private readonly maxInflight: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private inflight = 0;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    private readonly primary: EmbeddingProviderLike,
    private readonly fallback: EmbeddingProviderLike,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.id = primary.id;
    this.embeddingModelId = primary.embeddingModelId;
    this.primaryTimeoutMs = positiveEnv(env.EMBEDDING_PRIMARY_TIMEOUT_MS, 8_000);
    this.maxInflight = positiveEnv(env.EMBEDDING_PRIMARY_MAX_INFLIGHT, 4);
    this.failureThreshold = positiveEnv(env.EMBEDDING_CIRCUIT_FAILURES, 3);
    this.cooldownMs = positiveEnv(env.EMBEDDING_CIRCUIT_COOLDOWN_MS, 60_000);
  }

  private recordFailure(reason: "timeout" | "empty" | "error" | "concurrency"): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      logger.warn({
        primary: this.primary.id,
        fallback: this.fallback.id,
        failures: this.consecutiveFailures,
        cooldownMs: this.cooldownMs,
        reason,
      }, "embedding primary circuit opened; local fallback takes over");
    }
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[] | null> {
    const now = Date.now();
    const circuitOpen = now < this.openUntil;
    const saturated = this.inflight >= this.maxInflight;
    if (!circuitOpen && !saturated) {
      this.inflight += 1;
      try {
        const vector = await embedWithTimeout(this.primary, text, signal, this.primaryTimeoutMs);
        if (vector && vector.length > 0) {
          this.consecutiveFailures = 0;
          this.openUntil = 0;
          return vector;
        }
        this.recordFailure("empty");
      } catch {
        this.recordFailure("error");
      } finally {
        this.inflight -= 1;
      }
    } else if (saturated && !circuitOpen) {
      this.recordFailure("concurrency");
    }
    return this.fallback.embed(text, signal).catch(() => null);
  }
}

function embeddingFromResolved(resolved: {
  type: string;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  modelProfile?: import("@astella/shared").ModelProfile;
  options?: import("@astella/shared").PlatformOptions;
}): EmbeddingProviderLike | null {
  const impl = createCapabilityProvider(resolved.type, "embedding", {
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    ...(resolved.modelProfile ? { modelProfile: resolved.modelProfile } : {}),
    ...(resolved.options ? { options: resolved.options } : {}),
  } as SharedRuntimeConfig);
  return impl ? impl as unknown as EmbeddingProviderLike : null;
}

/**
 * Create a standalone embedding provider.
 *
 * Resolution order (first match wins):
 *   1. Cached governance context's embedding slot + optional local fallback
 *   2. System-level embedding platform (and embedding_fallback) from config
 *   3. Returns null — callers should fall back to lexical/sequential retrieval
 */
export async function createEmbeddingProvider(
  cachedGovCtx?: {
    embeddingProviderName: string | null;
    embeddingProviderConfig: AIProviderRuntimeConfig | null;
    embeddingFallbackProviderName?: string | null;
    embeddingFallbackProviderConfig?: AIProviderRuntimeConfig | null;
  } | null,
): Promise<EmbeddingProviderLike | null> {
  const fallback = cachedGovCtx?.embeddingFallbackProviderName && cachedGovCtx.embeddingFallbackProviderConfig
    ? embeddingFromResolved({
      type: cachedGovCtx.embeddingFallbackProviderName,
      apiKey: cachedGovCtx.embeddingFallbackProviderConfig.apiKey ?? undefined,
      baseUrl: cachedGovCtx.embeddingFallbackProviderConfig.baseUrl ?? undefined,
      model: cachedGovCtx.embeddingFallbackProviderConfig.model ?? "",
      modelProfile: cachedGovCtx.embeddingFallbackProviderConfig.modelProfile,
      options: cachedGovCtx.embeddingFallbackProviderConfig.options,
    })
    : (() => {
      const platform = resolveSystemPlatform("embedding_fallback");
      return platform ? embeddingFromResolved(platform) : null;
    })();
  const primary = cachedGovCtx !== undefined
    ? (cachedGovCtx?.embeddingProviderName && cachedGovCtx.embeddingProviderConfig
      ? embeddingFromResolved({
        type: cachedGovCtx.embeddingProviderName,
        apiKey: cachedGovCtx.embeddingProviderConfig.apiKey ?? undefined,
        baseUrl: cachedGovCtx.embeddingProviderConfig.baseUrl ?? undefined,
        model: cachedGovCtx.embeddingProviderConfig.model ?? "",
        modelProfile: cachedGovCtx.embeddingProviderConfig.modelProfile,
        options: cachedGovCtx.embeddingProviderConfig.options,
      })
      : null)
    : (() => {
      const platform = resolveSystemPlatform("embedding");
      return platform ? embeddingFromResolved(platform) : null;
    })();
  // A caller may supply a governance context with no primary slot; the local
  // fallback is still a valid embedding source (e.g. during a key rotation).
  if (!primary) return fallback;
  if (!fallback) return primary;
  if (fallback.embeddingModelId !== primary.embeddingModelId) {
    logger.warn({
      primary: primary.id,
      primaryModel: primary.embeddingModelId,
      fallback: fallback.id,
      fallbackModel: fallback.embeddingModelId,
    }, "embedding fallback model id differs from primary; local fallback disabled to keep model_revision consistent");
    return primary;
  }
  return new FallbackEmbeddingProvider(primary, fallback);
}

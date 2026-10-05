import { createDefaultAIPolicy, normalizeWorkspaceAIPolicy, prepareGovernedAIPayload, AIConsentRequiredError, AIDataPolicyDeniedError, type WorkspaceAIPolicy } from "@ailearn/agent-host";
export { createDefaultAIPolicy, normalizeWorkspaceAIPolicy, enforcePrivacyGovernanceWithPolicy, detectAndSanitizePII, sanitizePIIInObject, DEFAULT_AI_DATA_POLICY, prepareGovernedAIPayload, AIConsentRequiredError, AIDataPolicyDeniedError, type WorkspaceAIPolicy } from "@ailearn/agent-host";
/**
 * N-011: Worker 端 AI 隐私治理模块。
 *
 * 从 workspace 读取 AI 治理配置，执行：
 * 1. 同意门禁 — 未签署 AI 同意的工作区不能调用外部 AI provider（mock 豁免）
 * 2. sendToExternal 门禁 — sendToExternal=false 时拒绝向外部 provider 发送数据
 * 3. PII 检测 — 发送前检测和脱敏 PII（邮箱、手机号、身份证号等）
 * 4. 审计日志 — 每次 AI 调用写入 ai_audit_log 表，支持隐私追溯
 * 5. Provider 选择 — 统一读取 config/ai-platforms.json
 */

import { eq } from "drizzle-orm";
import { safeErrorMessage, DomainError } from "@ailearn/shared";
import { resolveSystemPlatform } from "@ailearn/shared/platform-config-node";
import type { AITaskType } from "@ailearn/shared/task-router";
import { getCapabilityForTask, getTaskComplexity } from "@ailearn/shared/task-router";
import { db, withWorkerWorkspaceTransaction } from "../db.ts";
import * as schema from "@ailearn/shared/db-schema";
import { logger } from "./logger.ts";
import { recordProviderCall, type ProviderCallKind, type ProviderCallOutcome } from "./metrics.ts";

/**
 * Stable, privacy-safe governance error used by the job projection layer.
 *
 * The queue sanitiser persists `code` but deliberately removes free-form
 * messages. Keeping the consent reason as a machine-readable code lets the
 * web app offer the correct recovery action without exposing provider or
 * user content in `jobs.last_error`.
 */
/**
 * AI P0-1（2026-09-15 审计）：`AI_REQUIRE_CONFIGURED_PROVIDER=true` 时，系统级
 * provider 未配置（会回退 mock）视为**配置错误**而非可降级状态——mock 会产出固定
 * 假文本并可能作为学习记录落库。不可重试：重试不会让缺失的 key 出现。
 */
export class AIProviderNotConfiguredError extends DomainError {
  readonly code = "ai_provider_not_configured";

  constructor(capability: string) {
    super({
      name: "AIProviderNotConfiguredError",
      code: "ai_provider_not_configured",
      message: `AI provider for capability "${capability}" is not configured (mock fallback refused)`,
      statusCode: 503,
    });
  }
}

/**
 * 是否要求"必须解析到真实 provider"（拒绝 mock 回退）。
 *
 * 默认 false（保持既有行为：dev/桌面/离线可继续用 mock）；生产 compose 显式设为 true。
 */
export function isConfiguredProviderRequired(
  raw: string | undefined = process.env.AI_REQUIRE_CONFIGURED_PROVIDER,
): boolean {
  return raw === "true";
}

/**
 * N-011: 一次性解析 AI 调用所需的全部治理上下文：provider 选择 + consent + policy。
 * This eliminates the redundant workspaces table queries that the
 * previously separate consent/policy/provider resolution steps required.
 *
 * v0.6 单一配置源重构：平台解析完全收敛到 config/ai-platforms.json，
 * 不再查 personal BYOK 或 workspace.aiProvider。每个 capability 直接从
 * resolveSystemPlatform(cap) 解析。
 */
export interface AIGovernanceContext {
  providerName: string;
  providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig;
  /** 独立的文本生成（轻量任务）provider 配置。
   * 当系统配置中 text_generation 映射到不同于 agent_turn 的平台时,
   * 此字段持有该平台配置,用于低复杂度文本生成任务,以便使用更便宜的模型。
   * 当未单独配置时为 null,回退到 providerName/providerConfig。 */
  textProviderName: string | null;
  textProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  /** 独立的视觉模型配置。当系统配置了独立的 vision 平台时,
   * 此字段与 providerConfig 不同（不同平台/Key/模型）。
   * 当未配置 vision 时,回退到 providerConfig。 */
  visionProviderName: string | null;
  visionProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  /** 伴星退化兜底 provider（方案 29 §9.6 / B8）。
   * 主模型高频返回"一词 + finish=stop"的退化补全时，agent loop 会用这个**不同模型、
   * 最好不同 provider** 的槽再要一次答案。未配置时为 null，loop 跳过跨模型兜底。 */
  companionFallbackProviderName: string | null;
  companionFallbackProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  /** 独立的向量嵌入 provider 配置（plan §3.4: embedding 折进治理 map）。
   * 当系统配置了独立 embedding 平台时,
   * 此字段持有该平台配置。
   * 当未配置时为 null,调用方应回退到主 provider 的 embed() 方法。 */
  embeddingProviderName: string | null;
  embeddingProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null;
  consentOk: boolean;
  policy: WorkspaceAIPolicy;
}

/**
 * R3: Resolve which provider to use for a given AI task.
 *
 * Uses the task → capability mapping from task-router.ts to determine
 * which provider slot to read from the governance context.
 *
 * Resolution priority within the governance context:
 *   1. If the task requires "vision", use visionProviderName/visionProviderConfig
 *      (falls back to text provider if no separate vision config).
 *   2. If the task requires "text_generation", use textProviderName/
 *      textProviderConfig if set (enables cheaper models for lightweight tasks
 *      like validation/rubric/question generation). Falls back to main provider.
 *   3. If the task requires "agent_turn", use the main providerName/providerConfig.
 *   4. If the task requires "embedding", the governance context does not hold
 *      an embedding slot — callers should use createEmbeddingProvider() directly.
 *      This function returns the text provider as a fallback.
 *   5. For unknown capabilities, fall back based on task complexity:
 *      high → agent_turn provider, low → text_generation provider.
 *
 * @see 原据 provider-registry-refactor.md §3.4（2026-09-29 已归档）
 */
export function resolveProviderForTask(
  ctx: AIGovernanceContext,
  task: AITaskType,
): { providerName: string; providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig } {
  const cap = getCapabilityForTask(task);

  // Vision tasks use the vision provider slot
  if (cap === "vision") {
    if (ctx.visionProviderName && ctx.visionProviderConfig) {
      return { providerName: ctx.visionProviderName, providerConfig: ctx.visionProviderConfig };
    }
    // Fall back to text provider for vision
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Text generation: use dedicated text provider if configured (enables
  // routing lightweight tasks to a cheaper model). Falls back to main provider.
  if (cap === "text_generation") {
    if (ctx.textProviderName && ctx.textProviderConfig) {
      return { providerName: ctx.textProviderName, providerConfig: ctx.textProviderConfig };
    }
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Agent turn uses the main text provider slot
  if (cap === "agent_turn") {
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Embedding: use dedicated embedding provider if configured (plan §3.4).
  // Falls back to the text provider (whose embed() method may still work).
  if (cap === "embedding" || cap === "rerank") {
    if (ctx.embeddingProviderName && ctx.embeddingProviderConfig) {
      return { providerName: ctx.embeddingProviderName, providerConfig: ctx.embeddingProviderConfig };
    }
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }

  // Future capabilities: fall back based on task complexity
  const complexity = getTaskComplexity(task);
  if (complexity === "high") {
    return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
  }
  return { providerName: ctx.providerName, providerConfig: ctx.providerConfig };
}

/**
 * 读某个账号的 AI 设置（同意签署记录 + 数据外发政策）。0237 之后这是**唯一**
 * 的同意来源；`workspaces` 上那几列已随迁移删除。
 *
 * 必须走 `withWorkerWorkspaceTransaction`：`user_ai_settings` 启用 RLS 且按
 * `app.user_id` 隔离，裸查询会**静默返回 0 行**，表现成"这个人永远没同意"。
 */
export async function readUserAiSettings(
  workspaceId: string,
  userId: string | null,
): Promise<typeof schema.userAiSettings.$inferSelect | null> {
  if (!userId) return null;
  const row = await withWorkerWorkspaceTransaction({ workspaceId, userId }, (transaction) =>
    transaction.query.userAiSettings.findFirst({
      where: eq(schema.userAiSettings.userId, userId),
    }));
  return row ?? null;
}

/** 账号级数据外发政策；没有行时回落到拒绝默认（fail closed）。 */
export async function getAccountAIPolicy(workspaceId: string, userId: string | null): Promise<WorkspaceAIPolicy> {
  const settings = await readUserAiSettings(workspaceId, userId);
  return settings ? normalizeWorkspaceAIPolicy(settings.dataPolicy) : createDefaultAIPolicy();
}

export async function resolveAIGovernanceContext(
  workspaceId: string,
  userId: string | null,
): Promise<AIGovernanceContext> {
  // v0.6 单一配置源重构：不再查 personal BYOK，平台解析完全收敛到
  // config/ai-platforms.json。workspaces 现在只用来确认"这个工作区存在"——
  // 同意与外发政策是账号级的（0237），见下面 settings 那段。
  const ws = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, workspaceId),
  });

  // agent_turn — 主文本/agent provider
  let providerName: string;
  let providerConfig: import("./ai-provider.ts").AIProviderRuntimeConfig = {};
  const agentPlatform = resolveSystemPlatform("agent_turn");
  if (agentPlatform) {
    providerName = agentPlatform.type;
    providerConfig = {
      apiKey: agentPlatform.apiKey,
      baseUrl: agentPlatform.baseUrl,
      model: agentPlatform.model,
      visionModel: agentPlatform.visionModel,
      options: agentPlatform.options,
    };
  } else {
    providerName = "mock";
    // §2.3 mock 静默回退告警：系统平台未配置（apiKey 缺失/含未解析 ${VAR}）。
    // 若不告警，生产链路会照常运行但产出固定假文本，用户与日志无法区分。
    logger.warn(
      {
        workspaceId,
        capability: "agent_turn",
        provider: providerName,
      },
      "agent_turn 平台未配置，使用 mock provider（输出为固定假文本）",
    );
    // AI P0-1（2026-09-15 审计）：mock 产出固定假文本（"我在这里，准备好陪你学习了。"）
    // 与空工具调用，而伴星链路（dialogue/extractor/summarizer）只查 consent、不拒 mock
    // ——假文本会作为"记忆/回复"落库（V2 制卡路径是 fail-closed 的，伴星不是）。
    //
    // 这里用一个**显式**开关而不是 NODE_ENV 推断：桌面端/离线场景可能以 production
    // 模式运行且**故意**不配 AI，按 NODE_ENV 一刀切会把那些场景直接打死。生产 compose
    // 显式打开该开关 → 未配置就 fail-closed（抛不可重试错误，用户看到"AI 未配置"），
    // 而不是把编造内容写进学习记录。
    if (isConfiguredProviderRequired()) {
      logger.error(
        { workspaceId, capability: "agent_turn" },
        "AI_REQUIRE_CONFIGURED_PROVIDER=true 且 agent_turn 平台未配置：fail-closed（拒绝 mock 回退）",
      );
      throw new AIProviderNotConfiguredError("agent_turn");
    }
  }

  // vision — 独立系统级视觉平台（未配置时回退到主 provider）
  let visionProviderName: string | null = null;
  let visionProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const visionPlatform = resolveSystemPlatform("vision");
  if (visionPlatform) {
    visionProviderName = visionPlatform.type;
    visionProviderConfig = {
      apiKey: visionPlatform.apiKey,
      baseUrl: visionPlatform.baseUrl,
      model: visionPlatform.model,
      visionModel: visionPlatform.visionModel,
      options: visionPlatform.options,
    };
  }

  // text_generation — 独立系统级轻量文本平台（未配置时回退到主 provider）
  let textProviderName: string | null = null;
  let textProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const textPlatform = resolveSystemPlatform("text_generation");
  if (textPlatform) {
    textProviderName = textPlatform.type;
    textProviderConfig = {
      apiKey: textPlatform.apiKey,
      baseUrl: textPlatform.baseUrl,
      model: textPlatform.model,
      options: textPlatform.options,
    };
  }

  // companion_fallback — 伴星退化时的跨模型兜底（方案 29 §9.6）。
  // 未配置就是 null：agent loop 会跳过这一级，只保留同模型思考档重试。
  let companionFallbackProviderName: string | null = null;
  let companionFallbackProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const fallbackPlatform = resolveSystemPlatform("companion_fallback");
  if (fallbackPlatform) {
    companionFallbackProviderName = fallbackPlatform.type;
    companionFallbackProviderConfig = {
      apiKey: fallbackPlatform.apiKey,
      baseUrl: fallbackPlatform.baseUrl,
      model: fallbackPlatform.model,
      options: fallbackPlatform.options,
    };
  }

  // embedding — 独立系统级嵌入平台（未配置时回退到主 provider）
  let embeddingProviderName: string | null = null;
  let embeddingProviderConfig: import("./ai-provider.ts").AIProviderRuntimeConfig | null = null;
  const embeddingPlatform = resolveSystemPlatform("embedding");
  if (embeddingPlatform) {
    embeddingProviderName = embeddingPlatform.type;
    embeddingProviderConfig = {
      apiKey: embeddingPlatform.apiKey,
      baseUrl: embeddingPlatform.baseUrl,
      model: embeddingPlatform.model,
      options: embeddingPlatform.options,
    };
  }

  let policy: WorkspaceAIPolicy = createDefaultAIPolicy();
  let consentOk = true;

  // Check consent for any non-mock external provider (agent / vision / text_gen / embedding).
  const anyExternalNonMock =
    providerName.toLowerCase() !== "mock" ||
    (visionProviderName != null && visionProviderName.toLowerCase() !== "mock") ||
    (textProviderName != null && textProviderName.toLowerCase() !== "mock") ||
    (embeddingProviderName != null && embeddingProviderName.toLowerCase() !== "mock");

  // 0237：AI 使用同意与数据外发政策从工作区级迁到**账号级**——同意管的是
  // "我的内容能不能送出去"，授权范围只能是本人（挂在空间上等于由别人的
  // 同意决定我的数据去向）。这里以前读 `workspaces.ai_data_policy`，而该列
  // 已随迁移删除，于是每次都回落到默认 `sendToExternal=false`，
  // **所有非 mock 调用在出网前就被拒**（表现为 provider 0ms 失败）。
  //
  // 读 `user_ai_settings` 必须走 `withWorkerWorkspaceTransaction`：这张表开了
  // RLS 且按 `app.user_id` 隔离，不设会话变量的查询会**静默返回 0 行**，
  // 表现成"这个人永远没同意"而不是报错（0237 注释同样强调了这点）。
  const settings = await readUserAiSettings(workspaceId, userId);

  if (!ws) {
    // Fail-closed: workspace not found, deny non-mock providers
    if (anyExternalNonMock) consentOk = false;
  } else {
    if (settings) policy = normalizeWorkspaceAIPolicy(settings.dataPolicy);
    // consent 检查（mock 豁免）：账号级签署记录
    if (anyExternalNonMock) {
      consentOk = settings?.consentVersion != null && settings.consentAt != null;
    }
  }

  return { providerName, providerConfig, textProviderName, textProviderConfig, visionProviderName, visionProviderConfig, companionFallbackProviderName, companionFallbackProviderConfig, embeddingProviderName, embeddingProviderConfig, consentOk, policy };
}



/**
 * N-011: 写入 AI 调用审计日志。
 */
/**
 * N-011: PII 检测和脱敏。
 * 检测文本中的常见 PII 模式（邮箱、手机号、身份证号、银行卡号）并脱敏。
 */
/**
 * Luhn checksum validation for bank card numbers.
 * Returns true if the digit string passes the Luhn algorithm.
 */
function governedPayload(
  context: Pick<AIGovernanceContext, "consentOk" | "policy">,
  workspaceId: string,
  providerName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return prepareGovernedAIPayload({ context, workspaceId, providerName, payload });
}

/**
 * Enforce workspace governance at the provider boundary.  Handlers may still
 * resolve consent earlier for better UX, but every actual external call goes
 * through this wrapper so policy flags cannot become decorative metadata.
 *
 * AI P0-12（2026-09-15 审计）核对结论：审计认为"只包 chat/stream/agent/embed，
 * 漏了 rerank → 一旦接线就绕过 consent/PII 门"。实际**不可达**，原因有二：
 *   1. 各 provider 是 class，方法在**原型**上；`{ ...provider }` 只复制自有可枚举
 *      属性（如 embeddingModelId），原型方法不会被带过来——所以经治理包装后的实例
 *      上根本没有 rerank 方法，调不到（embed/chatCompletion 是显式赋值才存在的）。
 *   2. rerank 在 config/ai-platforms.json 里没有能力映射，也没有任何
 *      createCapabilityProvider(…, "rerank") 调用点。
 * 因此这里**不**为不可达路径新增包装（AGENTS.md：不为没有调用点的能力新增抽象）。
 * 若将来真的接线 rerank，必须同时：把该方法显式包装进治理 + 在 config 中登记映射。
 * 特别注意：**不要把 provider 方法改成箭头函数实例字段**，那会让 rerank 随
 * `...provider` 一起泄漏出去，从而真的绕过治理门。
 */
/**
 * 审计上下文（AI P0-8，2026-09-15 审计）。
 *
 * `logAICall` 是 `ai_audit_log` 的**唯一**写入口，而全仓零生产调用——也就是
 * 默认开启的 `policy.auditLogging`（DEFAULT_AI_DATA_POLICY.auditLogging = true）
 * 实际上从未落过一行：成本（cost_tokens）与合规审计完全空转。
 * 治理包装器是天然接线点：每次经治理边界的真实外发调用后异步写一条审计行。
 * 只记元数据（provider/model/operation/token 数/耗时/状态），**绝不记内容**——
 * 与 identity/service.ts 同名函数的隐私测试口径一致。
 */
export interface GovernedProviderAuditContext {
  userId: string;
  /** The owning turn reserves every real attempt, including fallbacks and auxiliary models. */
  reserveCall?: () => Promise<void>;
  /** 能力/操作名前缀（如 "companion_agent"），与方法名合成 operation 落库。 */
  operation: string;
  /**
   * 这一次外发带出去的是哪类内容（审计 F19）。
   *
   * 取值用 `ai_audit_log.data_categories` 声明的那套词汇（note_content / user_answer /
   * question / claim / quote）。**由调用点声明**：只有发起这次调用的人知道送出去的是
   * 用户的回答、笔记正文还是一段引用；治理层能算的只有"文本/图像"这种结构事实。
   * 不写这一格时审计行的类别就是空的——设置页那条"带出去的内容："后面什么都没有，
   * 于是"把哪类内容发给了哪家模型"这句承诺落不了地。
   */
  dataCategories?: readonly string[];
  jobId?: string | null;
  /**
   * `job_id` 之外的结构化归属。**只写进结构化日志，不进 `ai_audit_log.job_id`。**
   *
   * `job_id` 的契约是"jobs 表里的那一行"。有些调用压根没有 jobs 行
   * （制卡走 V2 outbox），把 outbox 或 generation run 的 id 填进去会让这一列
   * 在"按 job 聚合成本"时指向一个永远 join 不上的东西——比留空更坏，因为
   * 它看起来有归属。这类调用方把真实引用（runId / outbox id）放进这里，
   * 按 `operation` + 这些字段即可定位到具体那一次生成。
   */
  correlation?: Readonly<Record<string, string>>;
}

/**
 * 把一次外发里抛出来的东西归到终态上。
 *
 * 取消与超时必须分开：两者都会把 provider 的在途 HTTP 掐掉，但处置完全不同
 * ——取消是用户/任务自己按的（不可重试、不是故障），超时是上游慢
 * （要告警、要重试）。混进 `error` 之后，"模型不稳定"和"用户改了主意"
 * 在同一张图上。
 */
function classifyProviderOutcome(err: unknown, signal: AbortSignal | undefined): ProviderCallOutcome {
  if (err instanceof AIDataPolicyDeniedError || err instanceof AIConsentRequiredError) return "blocked";
  const name = (err as { name?: unknown } | null)?.name;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "AGENT_BUDGET_EXCEEDED") return "blocked";
  if (name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (name === "AbortError" || signal?.aborted) return "cancelled";
  return "error";
}

/**
 * 治理包装器登记表：包装后的对象 → 它是为哪个 workspace 建的。
 *
 * 同一份 provider 在同一个 workspace 上被包两次时，`recordCall` 会跑两遍——
 * 审计多一行、调用量与 token 各记一次。于是这里让重复包装**直接返回已有包装**：
 * 策略与工作区没变，第二次包装不会带来任何新语义，只是把同一次外发记两遍。
 * 不同 workspace 的重复包装**不**短路：那是一次真实的换上下文（政策可能不同），
 * 该发生的治理必须发生。
 */
const governedWrappers = new WeakMap<object, { raw: object; workspaceId: string; consentOk: boolean; policy: string; audit?: GovernedProviderAuditContext }>();
function equivalentGovernance(known: NonNullable<ReturnType<typeof governedWrappers.get>>, context: Pick<AIGovernanceContext, "consentOk" | "policy">, workspaceId: string, audit?: GovernedProviderAuditContext): boolean {
  return known.workspaceId===workspaceId && known.consentOk===context.consentOk
    && known.policy===JSON.stringify(context.policy) && known.audit===audit;
}

/**
 * 造出这一次 provider 的记录口。主 provider 与独立 embedding provider
 * **共用同一个工厂**——它们记的是同一件事（一次外发），分成两份就会各自漂移，
 * 而漂移的方向通常是"某条路径忘了记"而不是"多记"。
 *
 * 记两样，各有各的理由：
 *   - 指标（`recordProviderCall`）：一次外发的客观事实，**不依赖审计上下文**。
 *     审计可以被政策关掉、也可以因为没有可信 actor 而整个不传，但调用量、
 *     耗时、token 不该跟着一起消失。
 *   - 审计行（`logAICall`）：合规与成本归因，需要 userId，因此只在 `audit` 存在时写。
 *
 * 每次外发只调它一次（成功 / 抛错 / 被治理门拦下，三条路径互斥）。
 */
function createCallRecorder(input: {
  providerId: string;
  modelId: string;
  context: Pick<AIGovernanceContext, "consentOk" | "policy">;
  workspaceId: string;
  audit?: GovernedProviderAuditContext;
}): (method: string, kind: ProviderCallKind, startedAt: number, outcome?: {
  costTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  status?: string;
  errorMessage?: string | null;
  dataSizeBytes?: number | null;
  metricOutcome?: ProviderCallOutcome;
}) => void {
  const { providerId, modelId, context, workspaceId, audit } = input;
  return (method, kind, startedAt, outcome = {}) => {
    const durationMs = Math.round(performance.now() - startedAt);
    recordProviderCall({
      provider: providerId,
      kind,
      outcome: outcome.metricOutcome ?? (outcome.status === "error" ? "error" : "success"),
      durationSeconds: durationMs / 1000,
      // 没有 usage 的调用（流式接口）传 null，指标侧不递增——不用 0 冒充。
      promptTokens: outcome.promptTokens ?? null,
      completionTokens: outcome.completionTokens ?? null,
    });
    if (!audit) return;
    if (audit.correlation) {
      logger.info(
        { workspaceId, operation: `${audit.operation}:${method}`, ...audit.correlation },
        "AI call recorded without a jobs row; correlation kept in logs",
      );
    }
    void logAICall(
      {
        workspaceId,
        userId: audit.userId,
        jobId: audit.jobId ?? null,
        provider: providerId,
        modelId,
        operation: `${audit.operation}:${method}`,
        dataCategories: audit.dataCategories ? [...audit.dataCategories] : undefined,
        costTokens: outcome.costTokens ?? null,
        durationMs,
        status: outcome.status ?? "success",
        errorMessage: outcome.errorMessage ?? null,
        dataSizeBytes: outcome.dataSizeBytes ?? null,
      },
      { policy: context.policy },
    );
  };
}

export function createGovernedProvider(
  provider: import("./ai-provider.ts").AIProvider,
  context: Pick<AIGovernanceContext, "consentOk" | "policy">,
  workspaceId: string,
  audit?: GovernedProviderAuditContext,
): import("./ai-provider.ts").AIProvider {
  const known = governedWrappers.get(provider);
  if (known && equivalentGovernance(known, context, workspaceId, audit)) return provider;
  if (known) provider = known.raw as typeof provider;
  const recordCall = createCallRecorder({
    providerId: provider.id,
    modelId: provider.modelId,
    context,
    workspaceId,
    audit,
  });
  const governed: import("./ai-provider.ts").AIProvider = {
    ...provider,
    chatCompletion: async (messages, options, signal) => {
      const startedAt = performance.now();
      let data: Record<string, unknown>;
      try {
        data = governedPayload(context, workspaceId, provider.id, { messages });
        signal?.throwIfAborted();
        await audit?.reserveCall?.();
      } catch (err) {
        recordCall("chat_completion", "chat", startedAt, {
          status: "blocked",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      try {
        const result = await provider.chatCompletion(data.messages as typeof messages, options, signal);
        recordCall("chat_completion", "chat", startedAt, {
          costTokens: result.usage?.totalTokens ?? null,
          promptTokens: result.usage?.promptTokens ?? null,
          completionTokens: result.usage?.completionTokens ?? null,
        });
        return result;
      } catch (err) {
        recordCall("chat_completion", "chat", startedAt, {
          status: "error",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
  if (provider.chatCompletionStream) {
    governed.chatCompletionStream = async (messages, options, signal, onDelta) => {
      const startedAt = performance.now();
      let data: Record<string, unknown>;
      try {
        data = governedPayload(context, workspaceId, provider.id, { messages });
        signal?.throwIfAborted();
        await audit?.reserveCall?.();
      } catch (err) {
        recordCall("chat_completion_stream", "stream", startedAt, {
          status: "blocked",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      try {
        const result = await provider.chatCompletionStream!(
          data.messages as typeof messages,
          options,
          signal,
          onDelta,
        );
        // 流式接口的返回类型只有 { content }（无 usage）——AI#9 已确认这是接口缺口；
        // 这里如实记 null，不伪造 token 数（指标侧同样不递增 token）。
        recordCall("chat_completion_stream", "stream", startedAt, { costTokens: null });
        return result;
      } catch (err) {
        recordCall("chat_completion_stream", "stream", startedAt, {
          status: "error",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  }
  if (provider.executeAgentTurn) {
    governed.executeAgentTurn = async (request, signal) => {
      const startedAt = performance.now();
      let data: Record<string, unknown>;
      try {
        data = governedPayload(context, workspaceId, provider.id, { request });
        signal?.throwIfAborted();
        await audit?.reserveCall?.();
      } catch (err) {
        recordCall("execute_agent_turn", "agent_turn", startedAt, {
          status: "blocked",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      try {
        const result = await provider.executeAgentTurn!(data.request as typeof request, signal);
        recordCall("execute_agent_turn", "agent_turn", startedAt, {
          costTokens: result.usage?.totalTokens ?? null,
          promptTokens: result.usage?.promptTokens ?? null,
          completionTokens: result.usage?.completionTokens ?? null,
        });
        return result;
      } catch (err) {
        recordCall("execute_agent_turn", "agent_turn", startedAt, {
          status: "error",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  }
  if (provider.embed) {
    governed.embed = async (text, signal) => {
      const startedAt = performance.now();
      let data: Record<string, unknown>;
      try {
        data = governedPayload(context, workspaceId, provider.id, { text });
        signal?.throwIfAborted();
        await audit?.reserveCall?.();
      } catch (err) {
        recordCall("embed", "embed", startedAt, {
          status: "blocked",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      try {
        const result = await provider.embed!(String(data.text ?? ""), signal);
        recordCall("embed", "embed", startedAt, { dataSizeBytes: String(data.text ?? "").length });
        return result;
      } catch (err) {
        recordCall("embed", "embed", startedAt, {
          status: "error",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };
  }
  // Provider implementations are class methods; spreading the instance keeps
  // the function but changes its receiver to the wrapper. Preserve the
  // original receiver for capability snapshots that read private provider
  // configuration (for example contextWindowTokens).
  if (provider.getCapabilities) {
    governed.getCapabilities = provider.getCapabilities.bind(provider);
  }
  governedWrappers.set(governed, { raw: provider, workspaceId, consentOk: context.consentOk, policy: JSON.stringify(context.policy), audit });
  return governed;
}

/**
 * 独立 embedding provider 的同一条边界（记忆召回、向量重建、语义去重都走它）。
 *
 * 与 `createGovernedProvider` 共用同一份记录口径：同样的同意/政策/PII 门、
 * 同样的 `recordProviderCall`（kind 恒为 `embed`）、同样的审计行。
 * 此前这里**只有**治理门、没有记录口，于是三类向量调用既不进指标，
 * 也不写 `ai_audit_log`——"记忆相关的向量调用花了多少"没有任何数据来源。
 */
export function createGovernedEmbeddingProvider(
  provider: import("./ai-provider.ts").EmbeddingProviderLike,
  context: Pick<AIGovernanceContext, "consentOk" | "policy">,
  workspaceId: string,
  audit?: GovernedProviderAuditContext,
): import("./ai-provider.ts").EmbeddingProviderLike {
  const known = governedWrappers.get(provider);
  if (known && equivalentGovernance(known, context, workspaceId, audit)) return provider;
  if (known) provider = known.raw as typeof provider;
  const recordCall = createCallRecorder({
    providerId: provider.id,
    modelId: provider.embeddingModelId,
    context,
    workspaceId,
    audit,
  });
  const governed: import("./ai-provider.ts").EmbeddingProviderLike = {
    ...provider,
    embed: async (text, signal) => {
      const startedAt = performance.now();
      let data: Record<string, unknown>;
      try {
        data = governedPayload(context, workspaceId, provider.id, { text });
        signal?.throwIfAborted();
        await audit?.reserveCall?.();
      } catch (err) {
        recordCall("embed", "embed", startedAt, {
          status: "blocked",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      const payloadText = String(data.text ?? "");
      try {
        const result = await provider.embed(payloadText, signal);
        recordCall("embed", "embed", startedAt, { dataSizeBytes: payloadText.length });
        return result;
      } catch (err) {
        recordCall("embed", "embed", startedAt, {
          status: "error",
          metricOutcome: classifyProviderOutcome(err, signal),
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
  governedWrappers.set(governed, { raw: provider, workspaceId, consentOk: context.consentOk, policy: JSON.stringify(context.policy), audit });
  return governed;
}

export interface AICallAuditParams {
  workspaceId: string;
  userId: string;
  jobId?: string | null;
  provider: string;
  modelId: string;
  operation: string;
  dataCategories?: string[];
  dataSizeBytes?: number | null;
  costTokens?: number | null;
  durationMs?: number | null;
  status?: string;
  errorMessage?: string | null;
}

interface AuditLogDependencies {
  /** Pre-resolved workspace AI policy. When provided, avoids an extra `workspaces` SELECT.
   *  Callers that already resolved governance earlier (e.g. via resolveAIGovernanceContext)
   *  should pass their resolved policy here (PERF: no redundant DB query per audit write). */
  policy?: WorkspaceAIPolicy;
  getPolicy?: (workspaceId: string, userId: string | null) => Promise<WorkspaceAIPolicy>;
  write?: (values: typeof schema.aiAuditLog.$inferInsert) => Promise<void>;
}

export async function logAICall(
  params: AICallAuditParams,
  dependencies: AuditLogDependencies = {},
): Promise<boolean> {
  try {
    const getPolicy = dependencies.getPolicy ?? getAccountAIPolicy;
    const policy = dependencies.policy ?? await getPolicy(params.workspaceId, params.userId);
    if (!policy.auditLogging) {
      logger.debug(
        { workspaceId: params.workspaceId, operation: params.operation },
        "AI audit logging disabled by the account data policy",
      );
      return false;
    }

    const values: typeof schema.aiAuditLog.$inferInsert = {
      workspaceId: params.workspaceId,
      userId: params.userId,
      jobId: params.jobId ?? null,
      provider: params.provider,
      modelId: params.modelId,
      operation: params.operation,
      dataCategories: params.dataCategories ?? [],
      dataSizeBytes: params.dataSizeBytes ?? null,
      costTokens: params.costTokens ?? null,
      durationMs: params.durationMs ?? null,
      status: params.status ?? "success",
      errorMessage: params.errorMessage ? safeErrorMessage(params.errorMessage) : null,
    };
    const write = dependencies.write ?? (async (row) => {
      // 审计行上挂着两条 RESTRICTIVE 守卫（`sec01_v1_ai_audit_tenant_guard` 与
      // `sec01_v1_ai_audit_insert_actor_guard`）：`workspace_id` / `user_id` 必须分别等于
      // `app.workspace_id` / `app.user_id`。worker 的独立连接这两项默认都是 NULL，
      // 于是裸 `db.insert` 被守卫拒掉——审计 F07 现场：近 1 小时 35 次
      // `failed to write AI audit log`，库侧 9-23 当天 0 行，而真实模型调用确实发生了
      // （"有没有花钱"因此不能看这张表）。
      //
      // 写这类"带工作区与 actor"的行必须把同一份上下文设进事务。调用方已经在同一
      // 空间/actor 的 worker 事务里时（V2 管道、伴星 job），作用域守卫会把这次写直接
      // 并进那条事务，不额外开连接。
      //
      // actor 为 null 的调用按契约根本不写审计行（`card-generation-v2/providers.ts`
      // 在 `userId` 为空时连 audit 上下文都不传），所以这里不需要"无 actor 策略"。
      await withWorkerWorkspaceTransaction(
        { workspaceId: params.workspaceId, userId: params.userId },
        async (tx) => {
          await tx.insert(schema.aiAuditLog).values(row);
        },
      );
    });
    await write(values);
    return true;
  } catch (err) {
    // 审计日志写入失败不应阻塞主流程
    logger.error({ err, operation: params.operation }, "failed to write AI audit log");
    return false;
  }
}

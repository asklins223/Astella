/**
 * 「这一发要外发给谁、没配好时怎么拒」——制卡链共用的治理出口（39d W7-7 刀二从旧
 * `providers.ts` 里留下的一份）。
 *
 * 为什么只剩这两样：四阶段链的 planner/author/双 Critic providers、按阶段匹配的采样
 * runtime、grounding/pedagogy 报告哈希都随那条链一起删除了；简化链自己只保留"发几次、
 * 按什么合同解析"（`card-generation-v3/tasks.ts` 与 `llm-provider.ts`），而**同意检查、
 * provider 选择、mock 的 fail-fast、`ai_audit_log` 的唯一写入口**这四步两条链共用同一份
 * ——各写一遍，漂移的会是"什么算配置缺失"这件本该全仓一个答案的事。
 *
 * 事故记录跟着这个函数走（2026-09-17 实机）：这里此前抛的是裸 `Error`、只带
 * `retryable = false`，而 `isNonRetryableErrorLike` 只认类实例上的 `kind`——于是一个被
 * 显式标为"不可重试"的配置错误被判成可重试，outbox 按 15/30/60/120/240s 退避重投 6 次
 * （dev 库实测 7m45s 墙钟）、期间一次模型调用都没发生，用户只看到长时间"生成中"然后
 * needs_attention。
 */

import { createProvider, resolveProviderSelection, type AIProvider, type AIProviderRuntimeConfig } from "../lib/ai-provider.ts";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  type AIGovernanceContext,
} from "../lib/governance.ts";

/** 可分类错误：`kind` 是队列决定重不重投的唯一依据（见文件头的事故记录）。 */
export class CardGenerationProviderError extends Error {
  readonly kind: "retryable" | "non-retryable";
  constructor(kind: "retryable" | "non-retryable", message: string) {
    super(message);
    this.name = "CardGenerationProviderError";
    this.kind = kind;
  }
}

/**
 * 治理上下文 → 一份**可以外发**的 provider。四步只做一次：同意/外发政策检查、
 * provider 选择、mock 的 fail-fast、`ai_audit_log` 的唯一写入口。
 */
export async function resolveGovernedCardGenerationProvider(input: {
  workspaceId: string;
  userId: string | null;
  /** 审计行上的 operation（`ai_audit_log` 按它归类，制卡与别的 AI 用途要分得开）。 */
  operation: string;
  /** 错误消息里的链名：配置漂移那句要指得回**这一条链自己的开关**。 */
  chainLabel: "card-generation-v3";
  /** 只进错误消息：这一条链自己的环境变量名。 */
  llmModeLabel: string;
  governance?: AIGovernanceContext;
  providerName?: string;
  providerConfig?: AIProviderRuntimeConfig;
  providerInstance?: AIProvider;
}): Promise<AIProvider> {
  // 治理上下文必须在事务**外**解析好传进来（0237 之后同意是账号级的，读
  // `user_ai_settings` 要带 `app.user_id`，而管道的大事务以 `userId: null` 打开）。
  const governance = input.providerInstance
    ? null
    : input.governance ?? await resolveAIGovernanceContext(input.workspaceId, input.userId);
  if (governance && !governance.consentOk) throw new AIConsentRequiredError();

  let providerName = input.providerName;
  let providerConfig = input.providerConfig;
  if (!providerName && !input.providerInstance) {
    const selection = await resolveProviderSelection(
      input.workspaceId,
      input.userId ?? undefined,
      governance ? { providerName: governance.providerName, providerConfig: governance.providerConfig } : undefined,
    );
    providerName = selection.providerName;
    providerConfig = selection.config;
  }
  // §10.5/§29.2：LLM 模式解析到 mock = 配置缺失（apiKey 未设置/平台未配置）。
  // 禁止静默用 MockProvider 生成可发布假内容——fail fast，非重试错误，job 直接 failed。
  if (!input.providerInstance && (providerName ?? "mock").toLowerCase() === "mock") {
    throw new CardGenerationProviderError(
      "non-retryable",
      `${input.chainLabel} LLM mode resolved to mock provider: missing API key or platform not configured. `
      + `Set the provider env vars or unset ${input.llmModeLabel} (fail closed, no mock fallback)`,
    );
  }
  const rawProvider: AIProvider = input.providerInstance
    ?? createProvider(providerName ?? "mock", providerConfig ?? {});
  return governance
    ? createGovernedProvider(
        rawProvider,
        governance,
        input.workspaceId,
        // AI P0-8（2026-09-15 审计）：制卡是最重的 LLM 消费者，接上 ai_audit_log 的
        // 唯一写入口（userId 为 null 时按契约不写审计行）。
        input.userId
          ? { userId: input.userId, operation: input.operation, dataCategories: ["note_content"] }
          : undefined,
      )
    : rawProvider;
}

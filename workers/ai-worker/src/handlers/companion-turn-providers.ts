import {
  createGovernedProvider,
  resolveProviderForTask,
  type AIGovernanceContext,
  type GovernedProviderAuditContext,
} from "../lib/governance.ts";
import { createProvider, type AIProvider } from "../lib/ai-provider.ts";
import type { CompanionDialogueHandlerContext, ReadContext } from "./companion-dialogue-store.ts";
import type { ContextBudgetGateOptions } from "../lib/context-governor.ts";

/**
 * 本轮用哪几个 provider（方案 29 §9.6／B8、40b）。
 *
 * 两个槽各有各的理由，混在一个函数里才看得出它们**不是**同一个东西：
 *   - `provider`：交互主链路。闲聊/无工具请求关思考，其余请求采用模型档案默认档。
 *   - `fallbackProvider`：采用正式 companion_fallback 配置。用户已决定固定
 *     DeepSeek v4.1 Flash，备用槽也使用同一模型，不在修复回合悄悄切到 GLM。
 *     旧跨模型尝试的经验不能覆盖当前配置决定；恢复仍遵守原有调用与时限预算。
 *
 * 两个都走 `createGovernedProvider`：同意、外发政策、PII 净化、`ai_audit_log` 与
 * 方案 44 的上下文预算闸都在那一个边界上（44 §4.3）。谁绕过它，谁就同时绕过五件事。
 */
export interface CompanionTurnProviders {
  provider: AIProvider;
  fallbackProvider: AIProvider | undefined;
  /** 本轮 provider 槽解析出来的平台与配置（观测与提示词指纹要用）。 */
  textProvider: ReturnType<typeof resolveProviderForTask>;
}

export function resolveCompanionTurnProviders(input: {
  governance: AIGovernanceContext;
  ctx: CompanionDialogueHandlerContext;
  read: ReadContext;
  /** 主链与兜底共用回执/压缩端口，每次按实际目标模型重新计量。 */
  contextGate: ContextBudgetGateOptions;
  reserveCall: GovernedProviderAuditContext["reserveCall"];
}): CompanionTurnProviders {
  const { governance, ctx, read, contextGate, reserveCall } = input;
  const textProvider = resolveProviderForTask(governance, "companion_agent");
  // AI P0-8（2026-09-15 审计）：ai_audit_log 的唯一写入口 logAICall —— 此前全仓零
  // 生产调用，而 DEFAULT_AI_DATA_POLICY.auditLogging 默认为 true，等于审计/成本
  // 记录完全空转。只写元数据，不写内容。`ctx.id` 是 jobs 行，不是 run id。
  const audit = (operation: string): GovernedProviderAuditContext => ({
    userId: read.userId, operation, jobId: ctx.id, reserveCall,
    dataCategories: ["user_answer", "note_content"],
  });
  return {
    textProvider,
    provider: createGovernedProvider(
      createProvider(textProvider.providerName, { ...textProvider.providerConfig, sessionId: read.conversationId }),
      governance, ctx.workspaceId, audit("companion_agent"), contextGate,
    ),
    fallbackProvider: governance.companionFallbackProviderName && governance.companionFallbackProviderConfig
      ? createGovernedProvider(
        createProvider(
          governance.companionFallbackProviderName,
          { ...governance.companionFallbackProviderConfig, sessionId: read.conversationId },
        ),
        governance, ctx.workspaceId, audit("companion_agent_fallback"), contextGate,
      )
      : undefined,
  };
}

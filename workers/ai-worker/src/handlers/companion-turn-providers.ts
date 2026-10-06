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
 *   - `provider`：交互主链路。2026-10-06 起跟随平台配置**开启思考**（用户决定：
 *     答复质量优先于首字延迟；整段取回语义下思考 token 也计入等待与 maxTokens）。
 *   - `fallbackProvider`：跨模型兜底，必须换**模型**，最好连 provider 一起换
 *     （实测主模型 tokenrhythm/qwen3.8-flash 近 3 小时 21/32 条回复不足 6 字、
 *     finishReason=stop 且无截断日志，连着两次都退化时同模型重跑同样会退化）。
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
  /** 上下文预算闸；只有主 provider 带，兜底槽不带（它只跑退化重试）。 */
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
      createProvider(textProvider.providerName, textProvider.providerConfig),
      governance, ctx.workspaceId, audit("companion_agent"), contextGate,
    ),
    fallbackProvider: governance.companionFallbackProviderName && governance.companionFallbackProviderConfig
      ? createGovernedProvider(
        createProvider(
          governance.companionFallbackProviderName,
          governance.companionFallbackProviderConfig,
        ),
        governance, ctx.workspaceId, audit("companion_agent_fallback"),
      )
      : undefined,
  };
}

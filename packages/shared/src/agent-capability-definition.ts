import type { z } from "zod";
import { companionAgentToolDefinitionV1Schema, type CompanionAgentToolDefinitionV1 } from "./contracts/companion-agent-contracts.ts";
import { agentToolParameters } from "./agent-tool-parameters.ts";

/**
 * 只在这个工具真的出场时才需要的那段操作指引（方案 50 §7「场景指引归位」）。
 *
 * 为什么不是写在每步共用的运行时策略里：那段策略日常聊天也在读，于是「全文编辑要先读
 * 两万字、块序号减一才是 startBlock」这种只在改笔记时用得上的话，天天陪着一次招呼——
 * 她要接的那句话被埋在别人的操作规程里。归到能力声明上之后，指引跟着工具面走：
 * 面没有这个工具，这段就不进请求。判据仍然是**声明**（工具面由声明装配），
 * 不是本轮猜出来的意图。
 */
export interface AgentCapabilitySceneGuidance {
  /** 哪一档权限都说的那几句。 */
  readonly shared?: readonly string[];
  /** 只在不自动执行的那一档说（guided：跳过去要用户点「前往」）。 */
  readonly guided?: readonly string[];
  /** 只在预授权自动执行的那一档说（full：调用之后页面真的切了）。 */
  readonly full?: readonly string[];
}

export interface AgentCapabilityDeclaration {
  readonly definition: CompanionAgentToolDefinitionV1;
  readonly argumentSchema: z.ZodType<Record<string, unknown>>;
  readonly presentation: { readonly label: string; readonly methodStep?: string; readonly discovery?: string };
  readonly sceneGuidance?: AgentCapabilitySceneGuidance;
}

/** All surfaces derive model parameters, validation and presentation from this
 * declaration. The shared catalog stays browser-safe and carries no executor. */
export function defineAgentCapability(
  name: string, description: string, riskClass: CompanionAgentToolDefinitionV1["riskClass"],
  requiresConfirmation: boolean, argumentSchema: z.ZodType<Record<string, unknown>>,
  presentation: AgentCapabilityDeclaration["presentation"],
  limits: { maxInputChars?: number; maxOutputChars?: number } = {},
  sceneGuidance?: AgentCapabilitySceneGuidance,
): AgentCapabilityDeclaration {
  return { ...(sceneGuidance ? { sceneGuidance } : {}), definition: companionAgentToolDefinitionV1Schema.parse({
    version: 1, toolVersion: "1.0.0", name, description, riskClass, requiresConfirmation,
    parameters: agentToolParameters(argumentSchema), maxInputChars: limits.maxInputChars ?? 4000,
    maxOutputChars: limits.maxOutputChars ?? 4000,
  }), argumentSchema, presentation };
}

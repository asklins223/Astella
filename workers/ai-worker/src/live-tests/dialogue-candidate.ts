import type { AIPlatformConfig, ResolvedPlatform } from "@astella/shared/platform-config";
import type { AgentTurnRequest } from "@astella/shared";

/** A frozen evaluation condition, never a production automatic-mode override. */
export function dialogueCandidateThinking(route: ResolvedPlatform, request: AgentTurnRequest,
  intent: "conversation" | "question", effort?: string): { route: ResolvedPlatform; request: AgentTurnRequest } {
  const level = effort === undefined ? undefined : route.modelProfile?.reasoning?.levels.find(level => level === effort);
  if (effort !== undefined && !level) throw new Error("Candidate casual effort must be declared");
  if (intent !== "conversation" || !level) return { route, request };
  return { route: { ...route, modelProfile: { ...route.modelProfile,
    reasoning: { ...route.modelProfile!.reasoning!, default: level } } },
    request: { ...request, disableThinking: level === "none" } };
}

/** Explicit test selection only. Never mutates capability routing or config. */
export function resolveDialogueCandidate(config: AIPlatformConfig | null, platformId: string,
  model: string): ResolvedPlatform {
  const target = config?.platforms[platformId], profile = target?.models?.[model];
  if (!target || !profile) throw new Error("Candidate must already have a declared platform and model");
  if (!["openai_compatible", "opencode_go"].includes(target.type))
    throw new Error("Candidate protocol is not supported by this diagnostic driver");
  if (!target.apiKey || target.apiKey.includes("${") || !target.baseUrl || target.baseUrl.includes("${"))
    throw new Error("Candidate credentials or endpoint are unresolved");
  for (const limit of [profile.contextWindowTokens, profile.maxOutputTokens])
    if (!Number.isSafeInteger(limit) || (limit ?? 0) < 1) throw new Error("Candidate requires declared positive token limits");
  if (profile.reasoning && !profile.reasoning.levels.includes(profile.reasoning.default))
    throw new Error("Candidate reasoning default must be declared");
  return { platformId, type: target.type, apiKey: target.apiKey, baseUrl: target.baseUrl,
    model, modelProfile: structuredClone(profile), options: structuredClone(target.options) };
}

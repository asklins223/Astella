/**
 * 模型档案的稳定指纹片段（2026-10-06 配置重设计）。
 *
 * 用在 `ProviderCapability.fingerprint` 里：窗口/输出/识图/推理档位任一项变了，
 * 依赖能力快照的预算缓存与降级判定都必须失效——把档案编进指纹是最便宜的做法。
 */
import type { ModelProfile } from "@astella/shared";

export function profileFingerprint(profile: ModelProfile | undefined): string {
  return [
    profile?.contextWindowTokens ?? "d",
    profile?.maxOutputTokens ?? "d",
    profile?.vision ? "v" : "-",
    profile?.reasoning?.default ?? "d",
    profile?.reasoning?.levels ? [...profile.reasoning.levels].sort().join(",") : "d",
    profile?.temperature ?? "always",
    profile?.supportsAssistantPhase ? "phase" : "legacy",
  ].join("/");
}

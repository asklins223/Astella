import type { ModelProfile } from "@astella/shared";

/**
 * 这一发能说多少字，只有一个来源：模型档案声明的 `maxOutputTokens`。
 *
 * 拿不到声明时用调用方给的那一档平台兜底（openai_compatible 用 shared 的
 * `AI_UNDECLARED_OUTPUT_TOKENS`，opencode-go 用它自己平台声明的最大输出）。
 *
 * 曾经这里还接一个"调用方请求的 maxTokens"并在档案缺失时取小——那些数是各 handler
 * 自己抄的（3800、2600、900…），档案没声明时就直接成为天花板，把长输出砍成半截话。
 * 内容篇幅归领域合同管，线上一发给多少归档案管，两件事不再混在同一个参数里。
 */
export function modelOutputTokenLimit(
  profile: ModelProfile | undefined,
  fallbackCeiling: number,
): number | undefined {
  const ceiling = profile?.maxOutputTokens;
  if (typeof ceiling === "number" && Number.isSafeInteger(ceiling) && ceiling > 0) return ceiling;
  return fallbackCeiling;
}

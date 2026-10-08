import type { ModelProfile } from "@astella/shared";

/** Content length belongs to the output contract; the wire limit also pays for reasoning. */
export function modelOutputTokenLimit(profile: ModelProfile | undefined, requested: number | undefined,
  fallbackCeiling: number): number | undefined {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) return undefined;
  const ceiling = profile?.maxOutputTokens;
  if (typeof ceiling === "number" && Number.isSafeInteger(ceiling) && ceiling > 0) return ceiling;
  return requested === undefined ? undefined : Math.min(Math.floor(requested), fallbackCeiling);
}

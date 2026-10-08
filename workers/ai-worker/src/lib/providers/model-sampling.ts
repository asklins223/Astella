import type { ModelProfile } from "@astella/shared";

/** Decide using the effort actually sent, not merely the caller's off request. */
export function modelTemperatureFields(profile: ModelProfile | undefined, temperature: number | undefined,
  effort: unknown): { temperature?: number } {
  if (profile?.temperature === "unsupported"
    || (profile?.temperature === "reasoning_none_only" && effort !== "none")) return {};
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

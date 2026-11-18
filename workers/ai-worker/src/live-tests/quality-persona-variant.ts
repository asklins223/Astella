import {
  COMPANION_CHARACTER_BASE_V8,
  COMPANION_CHARACTER_BASE_V19,
  COMPANION_IDENTITY_BOUNDARY_V3,
  COMPANION_IDENTITY_BOUNDARY_V4,
} from "@astella/shared";

/** This is a partial historical simulation, not a reconstruction of an old runtime. */
export function qualityPersonaVariant(system: string, variant: "current" | "baseline"): string {
  if (variant === "current") return system;
  function replaceOnce(input: string, current: string, previous: string, name: string): string {
    const first = input.indexOf(current);
    if (first < 0 || input.indexOf(current, first + current.length) !== -1) {
      throw new Error(`Cannot compare persona variants: expected exactly one ${name} in the system prompt`);
    }
    return input.slice(0, first) + previous + input.slice(first + current.length);
  }
  return replaceOnce(
    replaceOnce(system, COMPANION_CHARACTER_BASE_V19, COMPANION_CHARACTER_BASE_V8, "current persona"),
    COMPANION_IDENTITY_BOUNDARY_V4, COMPANION_IDENTITY_BOUNDARY_V3, "current identity boundary",
  );
}

/** Reject typos even when another requested fixture exists, to avoid partial green runs. */
export function selectQualityCases<T extends { id: string }>(all: readonly T[], raw: string | undefined,
  variable = "LIVE_QUALITY_CASES"): T[] {
  if (raw === undefined) return [...all];
  const selected = raw.split(",").map(id => id.trim());
  const known = new Set(all.map(item => item.id));
  if (selected.length === 0 || selected.some(id => !id || !known.has(id)) || new Set(selected).size !== selected.length) {
    throw new Error(`${variable} must contain distinct known fixture IDs`);
  }
  const wanted = new Set(selected);
  return all.filter(item => wanted.has(item.id));
}

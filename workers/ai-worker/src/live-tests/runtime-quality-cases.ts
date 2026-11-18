import { qualityCases, type QualityCase } from "./quality-cases.ts";
import { selectQualityCases as selectCases } from "./quality-persona-variant.ts";

export type { QualityCase };
/** Select only prompt text for generation; evaluation references never enter the model request. */
export function selectQualityCases(raw: string): QualityCase[] {
  return selectCases(qualityCases, raw, "LIVE_RUNTIME_CASES");
}

/** Each selected case is independent: only its synthetic prompt and history
 * enter generation. Reference answers and criteria remain evaluation-only. */
export function selectedRuntimeTurns(raw: string) {
  return selectQualityCases(raw).map(({ id, prompt, history }) => ({
    caseId: id, text: prompt, history: [...history],
  }));
}

import { z } from "zod";
import { sha256Utf8V1 } from "@astella/shared/content-hash";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const companionSemanticCheckpointSchema = z.object({
  version: z.literal(1),
  sourceSha256: hash,
  contractSha256: hash,
  total: z.number().int().positive().safe(),
  end: z.number().int().positive().safe(),
  parts: z.number().int().positive().safe(),
  prefixSha256: hash,
  summaryJson: z.string().min(1),
  summarySha256: hash,
}).strict();
export type CompanionSemanticCheckpoint = z.infer<typeof companionSemanticCheckpointSchema>;

/** Private in-progress state, never a whole-source coverage receipt. Storage
 * binds it to the run/step/request; the reader also verifies source and policy. */
export interface CompanionSemanticCheckpointStore {
  contract: unknown;
  load: () => Promise<unknown>;
  save: (checkpoint: CompanionSemanticCheckpoint) => Promise<void>;
  onResume?: (progress: { end: number; total: number; parts: number; sourceSha256: string }) => void;
}

export function restoreCompanionSemanticCheckpoint<T>(input: {
  value: unknown; text: string; sourceSha256: string; contractSha256: string;
  parse: (value: unknown) => T;
}): { end: number; parts: number; summary: T } | null {
  const parsed = companionSemanticCheckpointSchema.safeParse(input.value);
  if (!parsed.success) return null;
  const state = parsed.data;
  if (state.sourceSha256 !== input.sourceSha256 || state.contractSha256 !== input.contractSha256
    || state.total !== input.text.length || state.end > state.total || state.parts > state.end
    || (state.end < state.total && /[\uD800-\uDBFF]/.test(input.text[state.end - 1]!)
      && /[\uDC00-\uDFFF]/.test(input.text[state.end]!))
    || sha256Utf8V1(input.text.slice(0, state.end)) !== state.prefixSha256
    || sha256Utf8V1(state.summaryJson) !== state.summarySha256) return null;
  try { return { end: state.end, parts: state.parts, summary: input.parse(JSON.parse(state.summaryJson)) }; }
  catch { return null; }
}

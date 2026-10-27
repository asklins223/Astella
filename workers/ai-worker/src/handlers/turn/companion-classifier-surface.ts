/**
 * What the turn interpreter is allowed to see.
 *
 * The interpreter answers two questions: does this turn need a tool, and which
 * kind of work is it. It does not choose the tool — the main model does that
 * against the surface the step actually offers.
 *
 * The semantic manifest covers authorized capabilities on every page, using
 * short names/labels rather than schemas. Execution remains a smaller core
 * plus relevant groups. A page-based vocabulary hid off-page edits and made
 * natural follow-up edits look like requests to save a memory.
 */

export function companionClassifierCapabilities(input: {
  availableToolNames: readonly string[];
  pageKind: string | null | undefined;
  userText?: string;
  hasImageAttachments?: boolean;
}): string[] {
  // Semantics must know that off-page editing and other authorized operations
  // exist. A reduced execution schema is useful; a reduced ability vocabulary
  // made natural edits look like memory requests. This manifest carries names
  // and short labels only. The runtime still offers core + selected groups.
  return [...new Set(input.availableToolNames)];
}

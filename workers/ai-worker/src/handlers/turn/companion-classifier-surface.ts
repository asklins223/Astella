/**
 * What the turn interpreter is allowed to see.
 *
 * The interpreter answers two questions: does this turn need a tool, and which
 * kind of work is it. It does not choose the tool — the main model does that
 * against the surface the step actually offers.
 *
 * Until 2026-10-17 it was handed the whole conversation catalog: 66 names,
 * 5,455 of its 7,861-character payload (69%), roughly 1.5k tokens on every
 * turn. Production data says that is mostly wasted: 63 of 95 turns answered
 * with `toolUse: "none"` and never looked at it.
 *
 * It now sees the same core + page groups the first step offers. Anything it
 * names outside that view still reaches the model, because
 * `companion_load_tools` is always on the surface and the runtime expands a
 * candidate operation's group from the full catalog.
 */

import { resolveCompanionInitialToolNames } from "@astella/shared";
import { companionTaskSurfaceCandidates } from "../tools/companion-tool-surface.ts";

export function companionClassifierCapabilities(input: {
  availableToolNames: readonly string[];
  pageKind: string | null | undefined;
  userText?: string;
  hasImageAttachments?: boolean;
}): string[] {
  const visible = resolveCompanionInitialToolNames({
    availableToolNames: input.availableToolNames,
    pageKind: input.pageKind ?? null,
    hasImageAttachments: input.hasImageAttachments,
    candidateOperations: companionTaskSurfaceCandidates(input.userText),
  });
  // Keeping core order = keeping the prompt stable between turns; a reordered
  // tool list costs a cache miss on providers that key on the prefix.
  return input.availableToolNames.filter(name => visible.has(name) || name === "companion_load_tools");
}

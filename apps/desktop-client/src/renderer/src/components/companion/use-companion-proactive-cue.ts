import { useMemo } from "react";
import type { CompanionHomeProjectionV1 } from "@astella/shared/companion-home-contracts";

/** Same-scope projection refreshes must not restart or clear a visible cue. */
export function useCompanionProactiveCue(proactive: CompanionHomeProjectionV1["proactiveCue"]) {
  const text = proactive?.text;
  const revision = proactive?.revision;
  const thoughtId = proactive?.thoughtId;
  const origin = proactive?.origin;
  return useMemo(() => text && revision && origin ? {
    priority: "ordinary" as const,
    text,
    zone: "rest" as const,
    key: `ordinary:${revision}`,
    inboxSequence: revision,
    thoughtId: thoughtId ?? null,
    origin,
  } : null, [text, revision, thoughtId, origin]);
}

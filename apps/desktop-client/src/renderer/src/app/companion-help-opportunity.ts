import { useEffect } from "react";
import type { CompanionAwarenessObservationV1 } from "@astella/shared/companion-initiative-contracts";
import { useRoomStore } from "./room-store";

const seen = new Set<string>();
/** Domains publish an actual fact and revision; there is no dwell-time or psychological inference here. */
export function useCompanionHelpOpportunity(evidence: CompanionAwarenessObservationV1["evidence"] | null,
  topic: "help.available" | "result.available" = "help.available") {
  const scope = useRoomStore(s => s.workspaceScopeRevision);
  const key = evidence ? `${scope}:${topic}:${evidence.domain}:${evidence.entityId}:${evidence.revision}:${evidence.description}` : null;
  useEffect(() => {
    if (!key || !evidence || seen.has(key)) return;
    const timer = window.setTimeout(() => {
      seen.add(key); while (seen.size > 200) seen.delete(seen.values().next().value!);
      window.dispatchEvent(new CustomEvent(topic === "result.available" ? "astella:companion-result-available" : "astella:companion-help-opportunity", { detail: evidence }));
    }, 800);
    return () => clearTimeout(timer);
  }, [key]);
}

import type { RoundNextStepV1 } from "@ailearn/shared/note-learning-round-contracts";
import type { NoteRoundPracticeObservation } from "../learning-runs/run-service.ts";

type Observation = Pick<NoteRoundPracticeObservation,
  "runId" | "phase" | "outcome" | "goal" | "gapFacets" | "gapFacetsKnown" | "updatedAt">;

/** One bounded recommendation, based only on an observable attempt in the current target. */
export function decideRoundNextStep(input: {
  roundPhase: "active" | "paused" | "closed";
  hasTeaching: boolean;
  hasTarget: boolean;
  canStartPractice: boolean;
  transferSuitable: boolean;
  gapHelpStopped: boolean;
  teachingCreatedAt: string | null;
  latestPractice: Observation | null;
}): RoundNextStepV1 {
  const step = (kind: RoundNextStepV1["kind"], practice: Observation | null,
    evidence: RoundNextStepV1["evidence"], gapFacets: Observation["gapFacets"] = []): RoundNextStepV1 => ({
    kind, basisRunId: practice?.runId ?? null, gapFacets, evidence,
  });

  const practice = input.latestPractice;
  if (input.roundPhase === "closed") {
    const evidence: RoundNextStepV1["evidence"] = practice?.outcome === "demonstrated"
      ? "independent_demonstrated"
      : practice?.outcome === "not_assessable" || (practice?.outcome === "practice_completed" && !practice.gapFacetsKnown)
        ? "unassessable"
        : practice?.outcome === "practice_completed" && practice.gapFacets.length === 0
          ? "practice_covered"
          : practice?.outcome && practice.outcome !== "skipped" ? "incomplete" : "none";
    return step("finish", practice, evidence, practice?.gapFacets ?? []);
  }
  if (input.roundPhase === "paused") return step("choose", practice, "none");
  if (!input.hasTarget) return step(input.hasTeaching ? "review_material" : "explain", null, "none");
  if (!practice) return step(input.canStartPractice ? "attempt" : "choose", null, "none");
  if (practice.outcome === null) {
    if (["skipped", "cancelled", "stale"].includes(practice.phase)) return step("choose", practice, "none");
    return step("resume", practice, "none");
  }
  if (practice.outcome === "skipped") return step("choose", practice, "none");
  if (practice.outcome === "not_assessable") return step("uncertain", practice, "unassessable");
  if (practice.outcome === "practice_completed" && !practice.gapFacetsKnown) {
    return step("uncertain", practice, "unassessable");
  }
  const hasGap = practice.gapFacets.length > 0;
  if (["partial", "needs_repair", "declared_unable"].includes(practice.outcome)
    || (practice.outcome === "practice_completed" && hasGap)) {
    if (input.gapHelpStopped) return step("choose", practice, "incomplete", practice.gapFacets);
    const taughtAfterAttempt = input.teachingCreatedAt !== null
      && Date.parse(input.teachingCreatedAt) > Date.parse(practice.updatedAt);
    return step(taughtAfterAttempt && input.canStartPractice ? "retry" : "help",
      practice, "incomplete", practice.gapFacets);
  }
  const evidence = practice.outcome === "demonstrated"
    ? "independent_demonstrated" : "practice_covered";
  if (practice.goal === "transfer" || !input.transferSuitable || !input.canStartPractice) {
    return step("finish", practice, evidence);
  }
  return step("apply", practice, evidence);
}

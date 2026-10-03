import { isCardGenerationInFlight, isCardGenerationReviewOpen } from "../review/card-generation-status";

type NoteGeneration = { readonly status: string; readonly noteVersionId: string };

/** A historical run describes its saved source, never the note currently being edited. */
export function noteCardGenerationEntry(run: NoteGeneration | null, noteVersionId: string | undefined, hasUnversionedChanges: boolean) {
  const sourceChanged = Boolean(run && (hasUnversionedChanges || run.noteVersionId !== noteVersionId));
  const working = Boolean(run && isCardGenerationInFlight(run.status));
  const stopped = Boolean(run && !working && !isCardGenerationReviewOpen(run.status) && run.status !== "activated");
  const startsNewRun = !run || sourceChanged || stopped;
  return { sourceChanged, startsNewRun, blockedByGeneration: startsNewRun && working };
}

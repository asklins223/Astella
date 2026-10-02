import { HudPage } from "./hud/HudPage";
import { useHudPage } from "./hud/use-hud-page";
import { CardGenerationProgress } from "./surfaces/review/card-generation-progress";
import { CandidateReviewDesk } from "./surfaces/review/candidate-review-desk";
import { useCardGenerationSession } from "./surfaces/review/use-card-generation-session";
import { useCardGenerationReadableView } from "./surfaces/review/use-card-generation-readable-view";

export function CardGenerationSurface() {
  const session = useCardGenerationSession();
  const page = session.page === "candidate" ? "candidate" : "generating";
  useHudPage(page);
  useCardGenerationReadableView(session);
  return <HudPage page={session.page}>
    {session.page === "generating" ? <CardGenerationProgress session={session} />
      : <CandidateReviewDesk key={session.runId} session={session} />}
  </HudPage>;
}

import { useRef } from "react";
import { useCardTactile } from "./motion/use-card-tactile";
import { useCardPaperArrival } from "./motion/card-object-spring";
import { HudPage } from "./hud/HudPage";
import { useHudPage } from "./hud/use-hud-page";
import { CardGenerationProgress } from "./surfaces/review/card-generation-progress";
import { CandidateReviewDesk } from "./surfaces/review/candidate-review-desk";
import { useCardGenerationSession } from "./surfaces/review/use-card-generation-session";
import type { CardGenerationSession } from "./surfaces/review/use-card-generation-session";
import { useCardGenerationReadableView } from "./surfaces/review/use-card-generation-readable-view";

function GeneratingCardDesk({ session }: { readonly session: CardGenerationSession }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useCardTactile(rootRef);
  useCardPaperArrival(rootRef, session.runId ?? "reading");
  return <div ref={rootRef} className="card-generating card-experience"><CardGenerationProgress session={session} /></div>;
}

export function CardGenerationSurface() {
  const session = useCardGenerationSession();
  const page = session.page === "candidate" ? "candidate" : "generating";
  useHudPage(page);
  useCardGenerationReadableView(session);
  return <HudPage page={session.page} showTitle={false}>
    {session.page === "generating" ? <GeneratingCardDesk session={session} />
      : <CandidateReviewDesk key={session.runId} session={session} />}
  </HudPage>;
}

import { useRef } from "react";
import { useCardTactile } from "./motion/use-card-tactile";
import { useCardVisibleArrival } from "./motion/card-object-spring";
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
  // 到场用「一直可见」那一档而不是 `useCardPaperArrival`：这一页是**唯一一页用户正
  // 在等它动**的地方，进去之后最想看到的是"已经开始做了"，而不是一张从透明里
  // 慢慢浮出来的纸（帧一被节流就只剩背景，2026-10-04 实机等 2–3 秒）。
  useCardVisibleArrival(rootRef, session.runId ?? "reading");
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

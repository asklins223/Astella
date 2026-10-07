import { GuideConsentEntry } from "./GuideConsentEntry";
import { GuideFilm } from "./GuideFilm";
import type { CompanionGuideController } from "./use-companion-guide";

export function CompanionGuidanceStage({ guide }: { guide: CompanionGuideController }) {
  if (!guide.session) return null;
  return guide.consent === "granted" ? <GuideFilm guide={guide} /> : <GuideConsentEntry guide={guide} />;
}

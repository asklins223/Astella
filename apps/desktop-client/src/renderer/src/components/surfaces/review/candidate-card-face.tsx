import type { ReactNode } from "react";

/** Long answers remain readable and scroll on their own paper. */
export function CandidateCardFace({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return <div className="candidate-card__body" role="region" tabIndex={0} aria-label={label}><div className="candidate-card__copy">{children}</div></div>;
}

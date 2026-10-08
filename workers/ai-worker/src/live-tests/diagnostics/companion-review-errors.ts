/** Errors of retired offline diagnostics; no production retry policy. */
/** Malformed private review output cannot be published or replayed as a draft. */
export class CompanionKnowledgeReviewError extends Error {
  readonly code = "COMPANION_KNOWLEDGE_REVIEW_INVALID" as const;
  constructor(readonly reason: "json" | "schema" | "quotation" | "completion" = "completion") {
    super("companion knowledge review returned an invalid report");
    this.name = "CompanionKnowledgeReviewError";
  }
}

export class CompanionDialogueReviewError extends Error {
  readonly code = "COMPANION_DIALOGUE_REVIEW_INVALID" as const;
  constructor() { super("companion dialogue review returned an invalid removal plan"); this.name="CompanionDialogueReviewError"; }
}

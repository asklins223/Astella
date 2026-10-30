/**
 * Deterministic grounding for short-lived memory metadata shared by extraction,
 * direct tools, and confirmed proposals. Relative dates are not converted because
 * the caller may not know the user's timezone.
 */

export type CompanionMemoryTemporalMetadataInput = {
  kind: string;
  content: string;
  appliesWhen?: string | null;
  validUntil?: string | null;
  sourceQuote?: string | null;
  sourceText: string;
};

export type CompanionMemoryTemporalMetadataResolution =
  | { ok: true; appliesWhen: string | null; validUntil: string | null }
  | {
      ok: false;
      reason: "missing_source_quote" | "unverified_source_quote" | "unverifiable_applies_when" | "unverifiable_valid_until";
    };

/**
 * Verify temporal metadata against the same user-authored source as the memory.
 * Conditions and declared deadlines are grounded in the actual source. Whether
 * a memory is temporary belongs to the model's interpretation, not a word list.
 */
export function resolveCompanionMemoryTemporalMetadata(
  input: CompanionMemoryTemporalMetadataInput,
): CompanionMemoryTemporalMetadataResolution {
  // A paraphrased applicability condition narrows or widens the stored memory.
  // When the user's own quote is verified but that paraphrase is not verbatim,
  // drop the condition and keep the explicitly requested memory. A deadline is
  // different: inventing one changes when the record expires, so it stays strict.
  const appliesWhen = input.sourceQuote != null && input.appliesWhen != null
    && !input.sourceQuote.includes(input.appliesWhen) ? null : input.appliesWhen ?? null;
  if (input.sourceQuote == null && input.validUntil != null) {
    return { ok: false, reason: "missing_source_quote" };
  }
  const sourceQuote = input.sourceQuote ?? input.content;
  if (input.sourceQuote != null && !input.sourceText.includes(sourceQuote)) {
    return { ok: false, reason: "unverified_source_quote" };
  }
  if (input.validUntil != null && !sourceQuote.includes(input.validUntil)) {
    return { ok: false, reason: "unverifiable_valid_until" };
  }
  return {
    ok: true,
    appliesWhen,
    validUntil: input.validUntil ?? null,
  };
}

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
      reason: "missing_source_quote" | "unverified_source_quote" | "unverifiable_applies_when" | "unverifiable_valid_until" | "missing_finite_validity";
    };

const FINITE_WINDOW_SIGNAL = /(今天|今日|今晚|明天|后天|本周|这周|下周|本月|这个月|下个月|本学期|这学期|本次|这次|截至)/;

/**
 * Verify temporal metadata against the same user-authored source as the memory.
 * Conditions are kept only when they appear verbatim. Unbounded short-window
 * claims are rejected so a transient goal cannot become permanent by omission.
 */
export function resolveCompanionMemoryTemporalMetadata(
  input: CompanionMemoryTemporalMetadataInput,
): CompanionMemoryTemporalMetadataResolution {
  if (input.sourceQuote == null && (input.appliesWhen != null || input.validUntil != null)) {
    return { ok: false, reason: "missing_source_quote" };
  }
  const sourceQuote = input.sourceQuote ?? input.content;
  if (input.sourceQuote != null && !input.sourceText.includes(sourceQuote)) {
    return { ok: false, reason: "unverified_source_quote" };
  }
  if (input.appliesWhen != null && !sourceQuote.includes(input.appliesWhen)) {
    return { ok: false, reason: "unverifiable_applies_when" };
  }
  if (input.validUntil != null && !sourceQuote.includes(input.validUntil)) {
    return { ok: false, reason: "unverifiable_valid_until" };
  }
  if (
    input.validUntil == null
    && input.kind !== "episodic"
    && FINITE_WINDOW_SIGNAL.test(`${sourceQuote} ${input.content}`)
  ) {
    return { ok: false, reason: "missing_finite_validity" };
  }
  return {
    ok: true,
    appliesWhen: input.appliesWhen ?? null,
    validUntil: input.validUntil ?? null,
  };
}

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
  /**
   * 有限窗口只认**用户自己那句**里的时间说法。
   *
   * 以前这里连 `content` 一起扫，于是 2026-10-10 真实栈上撞到：她要把
   * 「以后打招呼别盘点笔记」记成偏好，正文里写着「不追问对方**今天**的安排」——
   * 那个「今天」是行为描述里的一个词，不是"这条记忆只到今天"的意思，
   * 却被判成短窗口、要求补一个并不存在的期限，于是**那次写入根本没发生**
   * （`not_executed`，她重试了两次都撞同一面墙）。依据在三处都要求逐字来自
   * 用户原话；时间说法也该是同一份权威来源，而不是她自己措辞里的联想词。
   * 没有原话时 `sourceQuote` 回落到正文，守卫照旧。
   */
  if (
    input.validUntil == null
    && input.kind !== "episodic"
    && FINITE_WINDOW_SIGNAL.test(sourceQuote)
  ) {
    return { ok: false, reason: "missing_finite_validity" };
  }
  return {
    ok: true,
    appliesWhen: input.appliesWhen ?? null,
    validUntil: input.validUntil ?? null,
  };
}

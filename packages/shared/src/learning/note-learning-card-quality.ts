import {
  NOTE_LEARNING_CARD_QUESTION_TYPES,
  noteLearningCardQuestionGroundingV1Schema,
  type NoteLearningCardQuestionTypeV1,
} from "../contracts/learning/note-learning-card-contracts.ts";

export type CardQuestionCandidateV1 = {
  type: NoteLearningCardQuestionTypeV1;
  stem: string;
  grounding: unknown;
};

export type CardQuestionRejectionV1 = {
  index: number;
  reason:
    | "unsupported_type"
    | "statement_stem"
    | "missing_grounding"
    | "missing_extension_excerpt"
    | "web_extension_without_url";
};

const QUESTION_LEAD = [
  /为什么/, /为何/, /什么/, /哪/, /如何/, /怎么/, /是否/, /多少/, /几/,
  /为什么/, /凭什么/, /哪一/, /哪几/, /怎样/, /能否/, /会不会/,
  /(?:吗|么|对不对|能不能|可不可以)[？?]\s*$/,
  /^(?:what|which|why|how|when|where|who|whose|is|are|was|were|do|does|did|can|could|would|should)\b/i,
];

const OPERATION_LEAD = /^(?:请)?(?:把|将|拖|点|选|调整|连线|排序|修复|组合|移动|放置|匹配)|^(?:please\s+)?(?:adjust|select|drag|match|repair|arrange|move)\b/i;

/** A question stem must be interrogative, or an explicit operation instruction. */
export function isCardQuestionStemV1(type: NoteLearningCardQuestionTypeV1, stem: string): boolean {
  const text = stem.trim();
  if (!text) return false;
  if (type === "operation") return OPERATION_LEAD.test(text);
  if (!/[？?]\s*$/.test(text)) return false;
  return QUESTION_LEAD.some((pattern) => pattern.test(text));
}

/**
 * Validate a generated card before it can be persisted.
 *
 * Rules from Plan 57:
 * - every question carries note grounding;
 * - an extension question must carry an extension passage;
 * - a web extension must carry a URL;
 * - the card must have 4–8 questions and at least 3 types;
 * - extension questions are capped at 2;
 * - statements / vague recall are rejected.
 */
export function validateCardQuestionCandidatesV1(
  candidates: readonly CardQuestionCandidateV1[],
): { accepted: CardQuestionCandidateV1[]; rejected: CardQuestionRejectionV1[] } {
  const accepted: CardQuestionCandidateV1[] = [];
  const rejected: CardQuestionRejectionV1[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!NOTE_LEARNING_CARD_QUESTION_TYPES.includes(candidate.type)) {
      rejected.push({ index, reason: "unsupported_type" });
      continue;
    }
    if (!isCardQuestionStemV1(candidate.type, candidate.stem)) {
      rejected.push({ index, reason: "statement_stem" });
      continue;
    }
    const raw = candidate.grounding as { note?: unknown; extension?: unknown } | null;
    const noteOnly = noteLearningCardQuestionGroundingV1Schema.safeParse({ note: raw?.note });
    if (!noteOnly.success) {
      rejected.push({ index, reason: "missing_grounding" });
      continue;
    }
    const extension = raw?.extension as { kind?: unknown; quote?: unknown; url?: unknown } | null | undefined;
    if (extension && (typeof extension.quote !== "string" || !extension.quote.trim())) {
      rejected.push({ index, reason: "missing_extension_excerpt" });
      continue;
    }
    if (extension?.kind === "web" && (typeof extension.url !== "string" || !extension.url)) {
      rejected.push({ index, reason: "web_extension_without_url" });
      continue;
    }
    const grounding = noteLearningCardQuestionGroundingV1Schema.safeParse(candidate.grounding);
    if (!grounding.success) {
      rejected.push({ index, reason: "missing_grounding" });
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted: accepted.slice(0, 8), rejected };
}

export function cardQuestionMixIssuesV1(questions: readonly CardQuestionCandidateV1[]): string[] {
  const issues: string[] = [];
  if (questions.length < 4) issues.push("card needs at least 4 questions");
  if (questions.length > 8) issues.push("card exceeds 8 questions");
  if (new Set(questions.map((question) => question.type)).size < 3) issues.push("card needs at least 3 question types");
  if (questions.filter((question) => Boolean((question.grounding as { extension?: unknown }).extension)).length > 2) {
    issues.push("card has more than 2 extension questions");
  }
  const stems = questions.map((question) => question.stem.normalize("NFKC").replace(/[\s\p{P}]/gu, ""));
  if (new Set(stems).size !== stems.length) issues.push("card repeats a question");
  return issues;
}

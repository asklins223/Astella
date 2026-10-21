import { z } from "zod";
import { operationSpecV1Schema } from "@astella/shared/learning/note-learning-card-operation";
import { cardQuestionMixIssuesV1, validateCardQuestionCandidatesV1, type CardQuestionCandidateV1 } from "@astella/shared/learning/note-learning-card-quality";
import { NoteOverviewOutputError } from "../../lib/non-retryable-errors.ts";

export type GeneratedCardQuestion = CardQuestionCandidateV1 & { options?: string[]; answer?: unknown; rubric?: unknown };
export type CardSourcePassage = { title: string; text: string; url?: string };
const normalized = (text: string) => text.normalize("NFKC").replace(/[\s\p{P}]/gu, "");
const criterion = z.object({ points: z.number().positive(), keyword: z.string().trim().min(1) });
const rubricSchema = z.union([z.array(criterion).min(1), z.object({ criteria: z.array(criterion).min(1) })]);

/** A short, safe snippet of the generated content that failed a check (never the full model output). */
const excerptOf = (value: unknown, max = 40): string => {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/gu, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export type CardQuestionCheck =
  | "unsupported_type"
  | "statement_stem"
  | "missing_grounding"
  | "missing_extension_excerpt"
  | "web_extension_without_url"
  | "note_quote_mismatch"
  | "extension_source_unverified"
  | "options_missing"
  | "answer_unscorable"
  | "duplicate_stem"
  // Review-stage checks are reported through the same failure receipts.
  | "answer_mismatch"
  | "answer_unsupported"
  | "ambiguous"
  | "evidence_missing"
  | "review_duplicate"
  | "host_duplicate";

/** One rejected question: which check failed, a human-readable detail and a short offending excerpt. */
export type CardQuestionFailure = {
  /** 0-based position in the model's generated card, used to discard the question. */
  index: number;
  /** 1-based number shown to the reader (what the user sees and what the review model uses). */
  questionNumber: number;
  checks: CardQuestionCheck[];
  detail: string;
  excerpt: string;
};

export type CardGenerationValidation = {
  /** Questions that passed every per-question check, in their original order. */
  valid: GeneratedCardQuestion[];
  /** Per-question failures, attributable to one question each. */
  failures: CardQuestionFailure[];
  /** Card-level issues: requested count, type mix, extension cap. Not attributable to one question. */
  cardIssues: string[];
};

/**
 * Plan 57 §3.3 / §7.3: validate a generated card per question so the caller can
 * retry once and then discard only the failing questions instead of losing the card.
 *
 * The rules are unchanged from the original all-or-nothing gate. This function only
 * reports them per question: a card that has any failure is still not persisted as-is;
 * `validateNoteLearningCardGeneration` keeps the aggregated throwing contract for
 * callers that should reject the whole attempt.
 */
export function collectNoteLearningCardGenerationIssues(
  questions: readonly GeneratedCardQuestion[],
  lines: readonly { ordinal: number; text: string }[],
  count: number,
  sources: readonly CardSourcePassage[] = [],
): CardGenerationValidation {
  const validated = validateCardQuestionCandidatesV1(questions);
  const rejected = new Map(validated.rejected.map((item) => [item.index, item.reason]));
  const blocks = new Map(lines.map((line) => [line.ordinal, normalized(line.text)]));
  const failures = new Map<number, { checks: CardQuestionCheck[]; details: string[]; excerpt: string }>();
  const add = (index: number, check: CardQuestionCheck, detail: string, excerpt: string) => {
    const entry = failures.get(index) ?? { checks: [], details: [], excerpt };
    entry.checks.push(check);
    entry.details.push(detail);
    if (!entry.excerpt) entry.excerpt = excerpt;
    failures.set(index, entry);
  };

  for (const [index, question] of questions.entries()) {
    const number = index + 1;
    const stem = typeof question.stem === "string" ? question.stem : "";
    const rejection = rejected.get(index);
    if (rejection) {
      const detail = rejection === "statement_stem"
        ? question.type === "operation"
          ? "操作题须以调整、选择、将、排序等明确操作动词开头，不能只写泛化任务或陈述句"
          : "题干须以问号结束，并包含什么、哪些、如何、是否、多少等疑问词；填空也必须写成疑问句"
        : rejection === "unsupported_type" ? "题型不在支持范围内"
          : rejection === "missing_grounding" ? "缺少至少一条原文依据"
            : rejection === "missing_extension_excerpt" ? "拓展题缺少拓展文段"
              : "网页拓展缺少来源网址";
      const grounding = question.grounding as { note?: { quote?: unknown }[] } | null;
      const quote = Array.isArray(grounding?.note) ? excerptOf(grounding.note[0]?.quote) : "";
      add(index, rejection, `第 ${number} 题${detail}`, excerptOf(stem) || quote);
      continue;
    }
    const grounding = question.grounding as { note?: { blockOrdinal: number; quote: string }[]; extension?: CardSourcePassage & { kind: string; quote: string } };
    const badQuote = grounding.note?.find((passage) => !normalized(passage.quote) || !blocks.get(passage.blockOrdinal)?.includes(normalized(passage.quote)));
    if (badQuote || !grounding.note?.length) {
      add(index, "note_quote_mismatch", `第 ${number} 题引文与保存版本的对应段落不符`, excerptOf(badQuote?.quote));
    }
    const extension = grounding.extension;
    if (extension && extension.kind !== "ai_generated" && !sources.some((source) =>
      normalized(source.text).includes(normalized(extension.quote)) && (extension.kind !== "web" || source.url === extension.url))) {
      add(index, "extension_source_unverified", `第 ${number} 题的拓展来源未核对；自行补充的文段必须标为 AI 补充`, excerptOf(extension.quote) || excerptOf(extension.title));
    }
    const options = question.options ?? [];
    const ids = options.map((_, ordinal) => String(ordinal));
    const id = z.string().refine((value) => ids.includes(value));
    const answerSchemas = {
      single_choice: z.object({ correctOptionId: id }),
      multi_choice: z.object({ correctOptionIds: z.array(id).min(1).refine((values) => new Set(values).size === values.length) }),
      true_false: z.object({ correct: z.boolean() }),
      fill_blank: z.object({ blanks: z.array(z.array(z.string().trim().min(1)).min(1)).min(1).max(12) }),
      ordering: z.object({ order: z.array(id).refine((values) => values.length === ids.length && new Set(values).size === ids.length) }),
      matching: z.object({ pairs: z.record(z.string()), rightOptions: z.array(z.string().trim().min(1)).min(2) }).refine((value) =>
        Object.keys(value.pairs).length === ids.length && ids.every((key) => value.rightOptions.includes(value.pairs[key]!))
        && new Set(value.rightOptions).size === value.rightOptions.length && new Set(Object.values(value.pairs)).size === ids.length),
      operation: operationSpecV1Schema,
      short_answer: rubricSchema,
    };
    if (["single_choice", "multi_choice", "ordering", "matching"].includes(question.type)
      && (options.length < 2 || new Set(options.map(normalized)).size !== options.length)) {
      add(index, "options_missing", `第 ${number} 题选项缺失或重复`, excerptOf(stem));
    }
    if (!answerSchemas[question.type].safeParse(question.type === "short_answer" ? question.rubric : question.answer).success) {
      add(index, "answer_unscorable", `第 ${number} 题缺少可判分的答案或评分要点`, excerptOf(stem));
    }
  }

  // Exact duplicate stems are a dedupe failure: keep the earliest, report the later ones.
  const seenStems = new Map<string, number>();
  for (const [index, question] of questions.entries()) {
    const key = normalized(typeof question.stem === "string" ? question.stem : "");
    if (!key) continue;
    if (seenStems.has(key)) add(index, "duplicate_stem", `第 ${index + 1} 题题干与其他题重复`, excerptOf(question.stem));
    else seenStems.set(key, index);
  }

  const cardIssues = [...cardQuestionMixIssuesV1(questions)];
  if (questions.length !== count) cardIssues.push(`需要 ${count} 道题（本次生成 ${questions.length} 道）`);

  const list = [...failures.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, item]): CardQuestionFailure => ({
      index,
      questionNumber: index + 1,
      checks: [...new Set(item.checks)],
      detail: item.details.join("；"),
      excerpt: item.excerpt,
    }));
  return {
    valid: questions.filter((_, index) => !failures.has(index)),
    failures: list,
    cardIssues: [...new Set(cardIssues)],
  };
}

/** Build a short correction for the single bounded retry, naming the failed questions and checks. */
export function noteLearningCardCorrection(validation: CardGenerationValidation): string {
  const parts = [
    ...validation.failures.map((failure) => `${failure.detail}${failure.excerpt ? `（${failure.excerpt}）` : ""}`),
    ...validation.cardIssues,
  ];
  return parts.join("；");
}

/**
 * Aggregate contract kept for callers that must reject the whole attempt.
 * New callers should use {@link collectNoteLearningCardGenerationIssues}.
 */
export function validateNoteLearningCardGeneration(
  questions: readonly GeneratedCardQuestion[],
  lines: readonly { ordinal: number; text: string }[],
  count: number,
  sources: readonly CardSourcePassage[] = [],
): GeneratedCardQuestion[] {
  const validation = collectNoteLearningCardGenerationIssues(questions, lines, count, sources);
  if (validation.failures.length || validation.cardIssues.length) {
    throw new NoteOverviewOutputError(`学习卡没有通过质量闸门：${noteLearningCardCorrection(validation)}`);
  }
  return [...questions];
}

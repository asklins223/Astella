import type { NoteLearningCardAttemptV1, NoteLearningCardQuestionV1, NoteLearningCardQuestionTypeV1 } from "@astella/shared/note-learning-card-contracts";
import { isNoteLearningCardSkipV1 } from "@astella/shared/note-learning-card-contracts";

export const TYPE_LABEL: Record<NoteLearningCardQuestionTypeV1, string> = {
  single_choice: "单选", multi_choice: "多选", true_false: "判断", fill_blank: "填空",
  short_answer: "简答", ordering: "排序", matching: "配对", operation: "操作",
};
export type CardScene = "front" | "setup" | "practice" | "grading" | "celebrate" | "results";
export type Outcome = "correct" | "partial" | "wrong" | "skipped";
export const OUTCOME_LABEL: Record<Outcome, string> = { correct: "答对", partial: "部分答对", wrong: "答错", skipped: "跳过" };
export const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export const isSkipped = isNoteLearningCardSkipV1;
export const answerDraft = (value: unknown): unknown => isSkipped(value) ? record(value).draft : value;
export function skipAnswer(value: unknown): { skipped: true; draft?: unknown } {
  const draft = answerDraft(value);
  return { skipped: true, ...(draft === undefined ? {} : { draft }) };
}

export function hasAnswer(question: NoteLearningCardQuestionV1, value: unknown): boolean {
  if (isSkipped(value) || value === undefined || value === null) return false;
  const answer = record(value);
  switch (question.type) {
    case "single_choice": return typeof answer.optionId === "string";
    case "multi_choice": return strings(answer.optionIds).length > 0;
    case "true_false": return typeof value === "boolean";
    case "fill_blank": return strings(answer.values).length === (question.blankCount ?? 1) && strings(answer.values).every((text) => text.trim().length > 0);
    case "short_answer": return typeof answer.text === "string" && answer.text.trim().length > 0;
    case "ordering": return strings(answer.order).length === (question.options?.length ?? 0) && new Set(strings(answer.order)).size === question.options?.length;
    case "matching": return (question.options ?? []).every((_, index) => typeof record(answer.pairs)[String(index)] === "string" && String(record(answer.pairs)[String(index)]).trim().length > 0);
    case "operation": return answer.kind === "controls" && Object.keys(record(answer.values)).length > 0 || answer.kind === "steps" && strings(answer.steps).length > 0;
  }
}

export function outcome(attempt: NoteLearningCardAttemptV1, questionId: string): Outcome {
  const answer = attempt.answers.find((item) => item.questionId === questionId);
  return !answer || answer.skipped ? "skipped" : answer.score === 100 ? "correct" : (answer.score ?? 0) > 0 ? "partial" : "wrong";
}
export function resultCounts(attempt: NoteLearningCardAttemptV1, questions: NoteLearningCardQuestionV1[]) {
  const counts = { correct: 0, partial: 0, wrong: 0, skipped: 0 };
  questions.forEach((question) => counts[outcome(attempt, question.questionId)]++);
  return counts;
}
export function summaryText(value: unknown, questionIds: readonly string[] = []): string {
  let text = typeof value === "string" ? value : typeof record(value).text === "string" ? String(record(value).text) : "这次的总结暂时没有生成，可以先逐题回看。";
  questionIds.forEach((id, index) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) return;
    const prefix = id.slice(0, 8);
    const uniquePrefix = questionIds.filter((other) => other.slice(0, 8).toLowerCase() === prefix.toLowerCase()).length === 1;
    text = text.replace(new RegExp(`${id}${uniquePrefix ? `|\\b${prefix}\\b` : ""}`, "giu"), `第${index + 1}题`);
  });
  return text;
}
export function feedbackText(value: unknown): string {
  return typeof value === "string" ? value : typeof record(value).text === "string" ? String(record(value).text) : "";
}
export function answerText(question: NoteLearningCardQuestionV1, value: unknown): string {
  if (isSkipped(value) || value === undefined || value === null) return "本题已跳过";
  if (typeof value === "boolean") return value ? "正确" : "错误";
  const answer = record(value), option = (id: unknown) => question.options?.[Number(id)] ?? String(id);
  if (typeof answer.correct === "boolean") return answer.correct ? "正确" : "错误";
  if (typeof answer.correctOptionId === "string") return option(answer.correctOptionId);
  if (Array.isArray(answer.correctOptionIds)) return strings(answer.correctOptionIds).map(option).join("；");
  if (typeof answer.optionId === "string") return option(answer.optionId);
  if (Array.isArray(answer.optionIds)) return strings(answer.optionIds).map(option).join("；");
  if (Array.isArray(answer.values)) return strings(answer.values).join(" / ");
  if (Array.isArray(answer.blanks)) return (answer.blanks as unknown[]).map((item) => Array.isArray(item) ? item.join(" / ") : String(item)).join("；");
  if (typeof answer.text === "string") return answer.text;
  if (Array.isArray(answer.order)) return strings(answer.order).map(option).join(" → ");
  if (answer.pairs) return Object.entries(record(answer.pairs)).map(([key, right]) => `${option(key)} → ${String(right)}`).join("；");
  if (answer.kind === "controls") return Object.entries(record(answer.values)).map(([key, val]) => `${key}：${String(val)}`).join("；");
  if (Array.isArray(answer.steps)) return strings(answer.steps).join(" → ");
  if (answer.target) return Object.entries(record(answer.target)).map(([key, val]) => `${key}：${String(val)}`).join("；");
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? JSON.stringify(item) : String(item)).join("；");
  return typeof value === "string" || typeof value === "number" ? String(value) : "请结合下方原文与评分要点核对。";
}
export function rubricText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => {
    const point = record(item); return String(point.keyword ?? point.description ?? point.text ?? "");
  }).filter(Boolean).join("；");
  return typeof value === "string" ? value : "";
}
export function attemptDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

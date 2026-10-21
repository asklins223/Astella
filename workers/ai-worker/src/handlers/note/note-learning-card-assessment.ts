import { z } from "zod";
import { gradeCardQuestionV1, gradeOperationAnswerV1, operationSpecV1Schema, noteLearningCardScoreV1, type NoteLearningCardQuestionTypeV1 } from "@astella/shared";
import { isNoteLearningCardSkipV1 } from "@astella/shared/note-learning-card-contracts";
import { extractJsonFromText } from "../../lib/providers/json-response.ts";
import { NoteOverviewOutputError } from "../../lib/non-retryable-errors.ts";
import { logger } from "../../lib/logger.ts";

export type CardAssessmentQuestion = { id: string; questionType: NoteLearningCardQuestionTypeV1; stem: string; options: string[] | null; answer: unknown; rubric: unknown; grounding: unknown };
export type CardAssessmentAnswer = { questionId: string; answer: unknown; score?: number | null; feedback?: unknown };
export type CardQuestionResult = { questionId: string; score: number; feedback: { kind: string; text?: string } };
export type AskCardCompanion = (input: { instruction: string; questions: unknown[]; subjective: unknown[] }) => Promise<string>;
const resultsSchema = z.array(z.strictObject({ questionId: z.string().uuid(), score: z.number().int().min(0).max(100), feedback: z.string().trim().min(1).max(2000) }));
const summarySchema = z.strictObject({
  items: z.array(z.strictObject({ questionId: z.string().uuid(), observation: z.string().trim().min(4).max(500) })).min(1).max(8),
  nextStep: z.string().trim().min(4).max(800),
});
const instruction = '返回严格 JSON：{results:[{questionId,score,feedback}],summary:{items:[{questionId,observation}],nextStep}}。只给 subjective 中的简答题判分，questionId 必须原样返回且逐一覆盖；score 是0–100百分制。subjective为空时results必须为[]。questions 中已有分数不得重判。summary.items 必须逐一覆盖 questions 和 subjective 的所有题，questionId 原样对应，observation 写这道题的具体表现、失分或遗漏；nextStep 写一两个具体下一步，全客观题也必须总结。不写已掌握/未掌握。题号由宿主按 questionId 添加，observation、nextStep 和 feedback 只写自然内容，不要写第几题、题号、内部ID或其缩写，也不出现 subjective、questionId 等字段名。';
const internalReference = /第\s*[\d一二三四五六七八九十]+\s*题|[a-f\d]{8}-[a-f\d-]{27,}|\b(?:subjective|questionId)\b/iu;

/** The host owns question labels; generated prose cannot silently renumber a question. */
function formatCardSummary(value: unknown, questions: readonly CardAssessmentQuestion[]): string | null {
  const parsed = summarySchema.safeParse(value);
  if (!parsed.success) { logger.info({ issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })) }, "card summary rejected: response shape"); return null; }
  const { items, nextStep } = parsed.data;
  const byId = new Map(items.map(item => [item.questionId, item.observation]));
  if (items.length !== questions.length || byId.size !== questions.length || questions.some(q => !byId.has(q.id))) {
    logger.info({ expectedCount: questions.length, receivedCount: items.length, uniqueCount: byId.size }, "card summary rejected: question identity coverage"); return null;
  }
  if ([...byId.values(), nextStep].some(text => internalReference.test(text) || questions.some(q => text.includes(q.id.slice(0, 8))))) {
    logger.info("card summary rejected: generated question label or internal identity"); return null;
  }
  return [...questions.map((q, index) => `第${index + 1}题：${byId.get(q.id)}`), `下一步：${nextStep}`].join("\n\n");
}

export function parseCardCompanionAssessment(raw: string, expectedIds: readonly string[], questions: readonly CardAssessmentQuestion[]) {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["results", "summary"]); } catch { throw new NoteOverviewOutputError("批改结果不是可核对的结构化内容"); }
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const parsed = resultsSchema.safeParse(record.results);
  if (!parsed.success || parsed.data.length !== expectedIds.length || new Set(parsed.data.map((item) => item.questionId)).size !== expectedIds.length
    || parsed.data.some((item) => !expectedIds.includes(item.questionId))) throw new NoteOverviewOutputError("简答题批改结果没有逐一对应这张卷子，请重新批改；未将缺失结果记成0分。");
  return { results: parsed.data, summary: formatCardSummary(record.summary, questions) };
}

export async function summarizeGradedCard(questions: readonly CardAssessmentQuestion[], answers: readonly CardAssessmentAnswer[], ask: AskCardCompanion, maxAttempts = 2): Promise<string | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) try {
    const raw = await ask({ instruction: instruction + (attempt ? " 上一份总评没有通过身份覆盖或文字校验：逐一返回每个真实questionId，observation不要写题号。仅修正总评，results必须为空数组。" : ""), questions: questions.map((question, index) => {
      const answer = answers.find((item) => item.questionId === question.id);
      const { id: questionId, ...content } = question;
      return { ...content, questionId, questionNumber: index + 1, submitted: answer?.answer, score: answer?.score, feedback: answer?.feedback };
    }), subjective: [] });
    const value = extractJsonFromText(raw, ["summary"]) as { summary?: unknown };
    // This path has no authority to write any per-question score. Ignore model
    // grading fields entirely rather than treating them as a new assessment.
    const summary = formatCardSummary(value?.summary, questions);
    if (summary) return summary;
  } catch { return null; } // Network failures never trigger another grading or invalidate earned scores.
  return null;
}

/** Deterministic verdicts and model grading have separate ownership; every question must receive a real result. */
export async function assessNoteLearningCard(questions: readonly CardAssessmentQuestion[], answers: readonly CardAssessmentAnswer[], ask: AskCardCompanion) {
  const results: CardQuestionResult[] = [], subjective: Array<{ question: CardAssessmentQuestion; submitted: unknown }> = [];
  for (const question of questions) {
    const answer = answers.find((item) => item.questionId === question.id);
    if (!answer) throw new NoteOverviewOutputError("还有题目没有保存，不能结算");
    if (isNoteLearningCardSkipV1(answer.answer)) { results.push({ questionId: question.id, score: 0, feedback: { kind: "skipped" } }); continue; }
    if (question.questionType === "short_answer") { subjective.push({ question, submitted: answer.answer }); continue; }
    if (question.questionType === "operation") {
      const spec = operationSpecV1Schema.safeParse(question.answer);
      if (!spec.success) throw new NoteOverviewOutputError("操作题缺少可判分的目标状态");
      const result = gradeOperationAnswerV1(spec.data, answer.answer);
      results.push({ questionId: question.id, score: result.score, feedback: { kind: "operation", text: result.detail } }); continue;
    }
    const result = gradeCardQuestionV1({ type: question.questionType, answer: question.answer, options: question.options ?? [], submitted: answer.answer } as Parameters<typeof gradeCardQuestionV1>[0]);
    if (result.kind !== "graded") throw new NoteOverviewOutputError("有一道客观题的作答格式无法判分");
    results.push({ questionId: question.id, score: result.score, feedback: { kind: "objective" } });
  }
  let summary: string | null;
  if (subjective.length) {
    const raw = await ask({ instruction, questions: results.map((item) => ({ ...questions.find((question) => question.id === item.questionId), ...item, questionNumber: questions.findIndex((question) => question.id === item.questionId) + 1,
      submitted: answers.find((answer) => answer.questionId === item.questionId)?.answer })),
      subjective: subjective.map(({ question, submitted }) => ({ ...question, questionId: question.id, questionNumber: questions.findIndex((item) => item.id === question.id) + 1, submitted })) });
    const parsed = parseCardCompanionAssessment(raw, subjective.map(({ question }) => question.id), questions);
    results.push(...parsed.results.map((item) => ({ questionId: item.questionId, score: item.score, feedback: { kind: "companion", text: item.feedback } })));
    summary = parsed.summary;
    if (!summary) summary = await summarizeGradedCard(questions, answers.map(answer => ({ ...answer, ...results.find(item => item.questionId === answer.questionId) })), ask, 1);
  } else summary = await summarizeGradedCard(questions, answers.map((answer) => ({ ...answer, ...results.find((item) => item.questionId === answer.questionId) })), ask);
  return { results, summary, score: noteLearningCardScoreV1(results.map((item) => item.score)) };
}

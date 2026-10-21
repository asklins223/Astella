import { and, eq, sql } from "drizzle-orm";
import { measureChatRequest } from "@astella/agent-core";
import { AI_UNDECLARED_OUTPUT_TOKENS, noteLearningCardStarsV1, type ChatMessage } from "@astella/shared";
import { readNoteLearningCardGradeJobPayload } from "@astella/shared/job-payload-contracts";
import { noteLearningCardAnswers, noteLearningCardAttempts, noteLearningCardQuestions, noteLearningCards } from "@astella/shared/db-schema/note-learning-cards";
import { AIConsentRequiredError, createGovernedProvider, resolveAIGovernanceContext, resolveProviderForTask } from "../../lib/governance.ts";
import { createProvider } from "../../lib/ai-provider.ts";
import { governContextPressure } from "../../lib/context-governor.ts";
import { assertJobLease, withJobTransaction } from "../../lib/job-lease.ts";
import { recordJourneyMilestone } from "../../lib/journey-milestones.ts";
import { NoteOverviewOutputError } from "../../lib/non-retryable-errors.ts";
import { assessNoteLearningCard, summarizeGradedCard, type AskCardCompanion } from "./note-learning-card-assessment.ts";
import type { JobPayload } from "../index.ts";

export async function runNoteLearningCardGrade(job: JobPayload): Promise<void> {
  const input = readNoteLearningCardGradeJobPayload(job.payload);
  if (!job.requestedBy) throw new NoteOverviewOutputError("批改任务缺少发起人");
  await assertJobLease(job);
  const data = await withJobTransaction(job, async (tx) => {
    const [card] = await tx.select().from(noteLearningCards).where(eq(noteLearningCards.id, input.cardId)).limit(1);
    const [attempt] = await tx.select().from(noteLearningCardAttempts).where(and(eq(noteLearningCardAttempts.id, input.attemptId), eq(noteLearningCardAttempts.cardId, input.cardId), eq(noteLearningCardAttempts.userId, job.requestedBy!))).limit(1);
    if (!card || !attempt) throw new NoteOverviewOutputError("这张学习卡或这次作答现在读不到");
    const questions = await tx.select().from(noteLearningCardQuestions).where(eq(noteLearningCardQuestions.cardId, input.cardId)).orderBy(noteLearningCardQuestions.ordinal);
    const answers = await tx.select().from(noteLearningCardAnswers).where(eq(noteLearningCardAnswers.attemptId, input.attemptId));
    return { attempt, questions, answers };
  });
  if (data.attempt.status === "completed" && !input.summaryOnly) return;
  if (input.summaryOnly ? data.attempt.status !== "completed" : data.attempt.status !== "grading") throw new NoteOverviewOutputError("作答状态已变化，这次不再批改");
  if (!data.questions.length) throw new NoteOverviewOutputError("这张学习卡还没有题目");
  const ask: AskCardCompanion = async (input) => {
    const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy!);
    if (!governance.consentOk) throw new AIConsentRequiredError();
    const selected = resolveProviderForTask(governance, "note_learning_grading");
    const provider = createGovernedProvider(createProvider(selected.providerName, selected.providerConfig), governance, job.workspaceId,
      { userId: job.requestedBy!, operation: "note_learning_card_grade", jobId: job.id, dataCategories: ["note_content"] });
    const parameters = { temperature: 0.1, disableThinking: input.subjective.length === 0, maxTokens: provider.resolveOutputTokenLimit?.() ?? AI_UNDECLARED_OUTPUT_TOKENS, responseFormat: "json_object" as const };
    const messages: ChatMessage[] = [{ role: "system", content: "你是伴星，按原文依据和rubric批改简答题，并为整张学习卡写总评。客观题由系统评分，不重新判分。\n" + input.instruction },
      { role: "user", content: JSON.stringify({ questions: input.questions, subjective: input.subjective }) }];
    await governContextPressure({ provider, operation: "note_learning_card_grade", requestedOutputTokens: parameters.maxTokens, measure: (ports) => measureChatRequest(messages, parameters, ports) });
    return (await provider.chatCompletion(messages, parameters, job.signal)).content;
  };
  if (input.summaryOnly) {
    const summary = await summarizeGradedCard(data.questions, data.answers, ask);
    await assertJobLease(job);
    await withJobTransaction(job, async (tx) => {
      const previous = data.attempt.summary as { text?: string } | null;
      await tx.update(noteLearningCardAttempts).set({ summary: summary ? { text: summary } : { ...(previous?.text ? { text: previous.text } : {}), status: "failed" } }).where(and(eq(noteLearningCardAttempts.id, input.attemptId), eq(noteLearningCardAttempts.status, "completed")));
    });
    return;
  }
  const assessment = await assessNoteLearningCard(data.questions, data.answers, ask);
  await assertJobLease(job);
  await withJobTransaction(job, async (tx) => {
    const [attempt] = await tx.select({ status: noteLearningCardAttempts.status }).from(noteLearningCardAttempts).where(eq(noteLearningCardAttempts.id, input.attemptId)).for("update");
    if (attempt?.status !== "grading") return;
    for (const item of assessment.results) await tx.update(noteLearningCardAnswers).set({ score: item.score, feedback: item.feedback, gradedAt: new Date() })
      .where(and(eq(noteLearningCardAnswers.attemptId, input.attemptId), eq(noteLearningCardAnswers.questionId, item.questionId)));
    await tx.update(noteLearningCardAttempts).set({ status: "completed", score: assessment.score, stars: noteLearningCardStarsV1(assessment.score), summary: assessment.summary ? { text: assessment.summary } : null, completedAt: new Date() }).where(eq(noteLearningCardAttempts.id, input.attemptId));
    // Plan 57 retired learning runs, so a finished card attempt is the real
    // "first loop" for the onboarding journey.
    await recordJourneyMilestone(tx, { workspaceId: job.workspaceId, userId: job.requestedBy!, eventType: "note_learning_card.completed", entityId: input.attemptId, payload: { cardId: input.cardId } });
  });
}

/** A failed summary never changes a completed attempt into a failed grading. */
export async function markNoteLearningCardGradingFailed(job: JobPayload, _message: string): Promise<void> {
  const input = readNoteLearningCardGradeJobPayload(job.payload);
  await withJobTransaction(job, async (tx) => {
    await tx.update(noteLearningCardAttempts).set(input.summaryOnly ? { summary: sql`jsonb_strip_nulls(jsonb_build_object('text', ${noteLearningCardAttempts.summary}->>'text', 'status', 'failed'))` } : { status: "grading_failed" })
      .where(and(eq(noteLearningCardAttempts.id, input.attemptId), eq(noteLearningCardAttempts.status, input.summaryOnly ? "completed" : "grading")));
  });
}

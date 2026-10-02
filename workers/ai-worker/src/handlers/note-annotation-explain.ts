import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ChatMessage } from "@ailearn/shared";
import { readNoteAnnotationExplainJobPayload } from "@ailearn/shared/job-payload-contracts";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import { noteAnchorMatchesV1 } from "@ailearn/shared/note-annotation-contracts";
import * as schema from "@ailearn/shared/db-schema";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { NoteAnnotationOutputError } from "../lib/non-retryable-errors.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import { noteLearningSnapshotHash } from "./note-learning-snapshot.ts";
import type { JobPayload } from "./index.ts";

const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));
const explanationSchema = z.strictObject({
  explanation: z.string().trim().min(12).max(650),
  example: z.string().trim().max(350).nullable(),
});

function parseExplanation(raw: string) {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["explanation", "example"]); } catch { throw new NoteAnnotationOutputError("批注解释不是可保存的结构化内容"); }
  const result = explanationSchema.safeParse(value);
  if (!result.success) throw new NoteAnnotationOutputError("批注解释缺少清楚的白话说明");
  return result.data;
}

export async function runNoteAnnotationExplain(job: JobPayload): Promise<void> {
  const input = readNoteAnnotationExplainJobPayload(job.payload);
  if (!job.requestedBy) throw new NoteAnnotationOutputError("批注任务缺少发起人");
  await assertJobLease(job);

  const existing = await withJobTransaction(job, (tx) => tx.query.noteAnnotations.findFirst({
    where: and(eq(schema.noteAnnotations.workspaceId, job.workspaceId), eq(schema.noteAnnotations.generationJobId, job.id)),
  }));
  if (existing) return;

  const frozen = await withJobTransaction(job, async (tx) => {
    const [note] = await tx.select({ currentVersionId: schema.notes.currentVersionId }).from(schema.notes).innerJoin(schema.noteVersions, and(
      eq(schema.noteVersions.id, input.noteVersionId), eq(schema.noteVersions.noteId, schema.notes.id), eq(schema.noteVersions.workspaceId, job.workspaceId),
    )).where(and(
      eq(schema.notes.id, input.noteId), eq(schema.notes.workspaceId, job.workspaceId), isNull(schema.notes.deletedAt), visibleNoteCondition,
    )).limit(1);
    if (!note) throw new NoteAnnotationOutputError("批注对应的笔记版本已不可用");
    const blocks = await tx.select({ ordinal: schema.noteBlocks.ordinal, type: schema.noteBlocks.type, content: schema.noteBlocks.content }).from(schema.noteBlocks).where(and(
      eq(schema.noteBlocks.workspaceId, job.workspaceId), eq(schema.noteBlocks.versionId, input.noteVersionId),
      sql`${schema.noteBlocks.ordinal} BETWEEN ${input.anchor.startBlockOrdinal} AND ${input.anchor.endBlockOrdinal}`,
    ));
    const anchor = input.anchor;
    if (!noteAnchorMatchesV1(blocks, anchor)) {
      throw new NoteAnnotationOutputError("批注选区和保存的原文位置对不上");
    }
    const [previousHeading] = await tx.select({ type: schema.noteBlocks.type, content: schema.noteBlocks.content }).from(schema.noteBlocks).where(and(
      eq(schema.noteBlocks.workspaceId, job.workspaceId), eq(schema.noteBlocks.versionId, input.noteVersionId),
      eq(schema.noteBlocks.type, "heading"), sql`${schema.noteBlocks.ordinal} < ${anchor.startBlockOrdinal}`,
    )).orderBy(sql`${schema.noteBlocks.ordinal} DESC`).limit(1);
    const heading = previousHeading ? noteBlockRenderedTextV1(previousHeading.type, previousHeading.content).slice(0, 160) : "";
    return { text: anchor.excerpt, heading };
  });

  const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy);
  if (!governance.consentOk) throw new AIConsentRequiredError();
  const selected = resolveProviderForTask(governance, "note_annotation_explain");
  const provider = createGovernedProvider(
    createProvider(selected.providerName, selected.providerConfig),
    governance,
    job.workspaceId,
    { userId: job.requestedBy, operation: "note_annotation_explain", jobId: job.id, dataCategories: ["note_content"] },
  );
  const messages: ChatMessage[] = [
    { role: "system", content: "你是笔记旁边的白话解释助手。只根据给出的原句和小节标题解释，不把猜测说成事实。先用一到两句日常中文直接说清楚，尽量不超过 100 字；不要用教学术语，不要复述原句充字数。例子只有在能帮助理解时才写，尽量不超过 90 字。" },
    { role: "user", content: [
        "请把框选内容解释给第一次接触它的人。说明它具体是什么意思、在上下文里起什么作用；如果适合，用一个短例子帮助理解。",
        frozen.heading ? `小节：${frozen.heading}` : "",
        `原句：\n${frozen.text}`,
        "返回严格 JSON：{\"explanation\":\"一到两句白话解释，目标 40 到 100 字\",\"example\":\"一句短比方；不适合时填 null\"}。只解释框选内容，不把可能的神经机制写成已证实的事实。不要输出 Markdown 围栏或额外文本。",
      ].filter(Boolean).join("\n\n") },
  ];
  const generationParameters = {
    temperature: 0.25,
    maxTokens: 700,
    responseFormat: "json_object" as const,
    disableThinking: true,
  };
  const inputSnapshotHash = noteLearningSnapshotHash({
    taskVersion: 1,
    noteVersionId: input.noteVersionId,
    heading: frozen.heading,
    selectedText: frozen.text,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    generationParameters,
    messages,
  });
  const generated = await runWorkerAiTask({
    job,
    userId: job.requestedBy,
    taskId: "note_annotation_explain",
    taskVersion: 1,
    idempotencyKey: `note-annotation:${job.id}:${inputSnapshotHash}`,
    inputSnapshotRef: { kind: "note_version", id: input.noteVersionId, hash: inputSnapshotHash },
    input: messages,
    modelId: provider.modelId,
    promptVersion: `${provider.promptVersion}:note-annotation-explain-v1`,
    resourceClass: "interactive_ai",
    timeoutMs: resolveProviderCallTimeout("note_annotation_explain"),
    isOutputShapeError: (error) => error instanceof NoteAnnotationOutputError,
    execute: async (request, signal) => {
      const response = await provider.chatCompletion(request, generationParameters, signal);
      return {
        ok: true,
        output: parseExplanation(response.content),
        promptTokens: response.usage?.promptTokens ?? undefined,
        completionTokens: response.usage?.completionTokens ?? undefined,
      };
    },
  });
  const explanation = [generated.explanation, generated.example ? `举个例子：${generated.example}` : ""].filter(Boolean).join("\n\n");

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    const [visible] = await tx.select({ noteId: schema.notes.id }).from(schema.notes).innerJoin(schema.noteVersions, and(
      eq(schema.noteVersions.noteId, schema.notes.id), eq(schema.noteVersions.workspaceId, job.workspaceId),
    )).where(and(
      eq(schema.notes.id, input.noteId), eq(schema.notes.workspaceId, job.workspaceId), isNull(schema.notes.deletedAt),
      visibleNoteCondition, eq(schema.noteVersions.id, input.noteVersionId),
    )).limit(1);
    if (!visible) throw new NoteAnnotationOutputError("笔记权限或版本已变化，这条批注没有保存");
    const alreadySaved = await tx.query.noteAnnotations.findFirst({
      where: and(eq(schema.noteAnnotations.workspaceId, job.workspaceId), eq(schema.noteAnnotations.generationJobId, job.id)),
    });
    if (alreadySaved) return;
    await tx.insert(schema.noteAnnotations).values({
      workspaceId: job.workspaceId,
      userId: job.requestedBy!,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      startBlockOrdinal: input.anchor.startBlockOrdinal,
      startOffset: input.anchor.startOffset,
      endBlockOrdinal: input.anchor.endBlockOrdinal,
      endOffset: input.anchor.endOffset,
      excerpt: input.anchor.excerpt,
      prefix: input.anchor.prefix,
      suffix: input.anchor.suffix,
      explanation,
      sourceMessageId: null,
      generationJobId: job.id,
    });
  });
}

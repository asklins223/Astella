import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { ChatMessage } from "@astella/shared";
import { readNoteExpansionGenerateJobPayload } from "@astella/shared/job-payload-contracts";
import { loadAgentGenerationContext } from "../agent/generation-context.ts";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { noteAnchorMatchesV1 } from "@astella/shared/note-annotation-contracts";
import * as schema from "@astella/shared/db-schema";
import { noteExpansionDraftV1Schema, type NoteExpansionDraftV1 } from "@astella/shared/note-expansion-contracts";
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
import { NoteExpansionOutputError } from "../lib/non-retryable-errors.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import { noteLearningSnapshotHash } from "./note-learning-snapshot.ts";
import { buildNoteExpansionPrompt, type NoteExpansionSourceBlock } from "./note-expansion-prompt.ts";
import type { JobPayload } from "./index.ts";

const MAX_SOURCE_CHARS = 24_000;
const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));

const generatedDraftSchema = z.strictObject({
  title: z.string().trim().min(2).max(120),
  relationship: z.string().trim().min(12).max(500),
  sourceReferences: z.array(z.strictObject({
    blockOrdinal: z.number().int().min(0).max(100_000),
    quote: z.string().trim().min(8).max(320),
  })).min(1).max(3),
  blocks: z.array(z.strictObject({
    type: z.enum(["paragraph", "heading", "code", "list", "quote"]),
    content: z.string().trim().min(1).max(8_000),
  }).transform((block) => block.type === "list"
    ? { ...block, content: block.content.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "") }
    : block)).min(2).max(30),
}).refine((draft) => draft.blocks.reduce((total, block) => total + block.content.length, 0) <= 20_000, {
  message: "拓展草稿正文超过长度上限",
});

const generatedResponseSchema = z.strictObject({ drafts: z.array(generatedDraftSchema).min(2).max(4) });

type SourceBlock = NoteExpansionSourceBlock;

function parseResponse(raw: string) {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["drafts"]); } catch {
    throw new NoteExpansionOutputError("拓展草稿不是可审核的结构化内容");
  }
  const result = generatedResponseSchema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`).join(", ");
    throw new NoteExpansionOutputError(`拓展草稿输出不符合约定（${fields}）`);
  }
  const titles = result.data.drafts.map((draft) => draft.title.trim().toLocaleLowerCase());
  if (new Set(titles).size !== titles.length) throw new NoteExpansionOutputError("拓展草稿出现了重复标题");
  return result.data;
}

function compactEvidence(value: string) {
  const chars = Array.from(value);
  const output: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (/\s/u.test(char) || "*_~`".includes(char)) continue;
    output.push(char.toLocaleLowerCase());
    sourceOffsets.push(index);
  }
  return { text: output.join(""), sourceOffsets };
}

function findExactQuote(blockText: string, candidate: string) {
  const needle = compactEvidence(candidate).text;
  if (needle.length < 8) return null;
  const source = compactEvidence(blockText);
  const start = source.text.indexOf(needle);
  if (start < 0) return null;
  const from = source.sourceOffsets[start];
  const to = source.sourceOffsets[start + needle.length - 1];
  if (from === undefined || to === undefined) return null;
  return Array.from(blockText).slice(from, to + 1).join("").trim();
}

async function loadSource(job: JobPayload, input: ReturnType<typeof readNoteExpansionGenerateJobPayload>) {
  if (!job.requestedBy) throw new NoteExpansionOutputError("拓展任务缺少发起人");
  return withJobTransaction(job, async (tx) => {
    const [note] = await tx.select({ id: schema.notes.id, versionId: schema.noteVersions.id })
      .from(schema.notes)
      .innerJoin(schema.noteVersions, and(
        eq(schema.noteVersions.id, input.noteVersionId),
        eq(schema.noteVersions.noteId, schema.notes.id),
        eq(schema.noteVersions.workspaceId, job.workspaceId),
      ))
      .where(and(
        eq(schema.notes.id, input.noteId),
        eq(schema.notes.workspaceId, job.workspaceId),
        isNull(schema.notes.deletedAt),
        visibleNoteCondition,
      )).limit(1);
    if (!note) throw new NoteExpansionOutputError("拓展对应的笔记版本已经不可用");
    const blocks = await tx.select({
      ordinal: schema.noteBlocks.ordinal,
      type: schema.noteBlocks.type,
      content: schema.noteBlocks.content,
    }).from(schema.noteBlocks).where(and(
      eq(schema.noteBlocks.workspaceId, job.workspaceId),
      eq(schema.noteBlocks.versionId, note.versionId),
    )).orderBy(schema.noteBlocks.ordinal);
    if (blocks.length === 0) throw new NoteExpansionOutputError("这篇笔记还没有可拓展的正文");

    let sourceBlocks: SourceBlock[];
    if (input.focusAnchor) {
      const anchor = input.focusAnchor;
      const block = blocks.find((item) => item.ordinal === anchor.startBlockOrdinal);
      if (!block || !noteAnchorMatchesV1(blocks, anchor)) {
        throw new NoteExpansionOutputError("拓展选区和笔记保存的原文位置对不上");
      }
      const previousHeading = blocks.filter((item) => item.type === "heading" && item.ordinal < block.ordinal).at(-1);
      const adjacent = blocks.filter((item) => item.ordinal >= anchor.startBlockOrdinal - 1 && item.ordinal <= anchor.endBlockOrdinal + 1 && item.type !== "image");
      sourceBlocks = [
        ...(previousHeading && !adjacent.some((item) => item.ordinal === previousHeading.ordinal) ? [previousHeading] : []),
        ...adjacent,
      ];
    } else {
      sourceBlocks = blocks.filter((block) => block.type !== "image");
      const sourceSize = sourceBlocks.reduce((total, block) => total + Array.from(noteBlockRenderedTextV1(block.type, block.content)).length, 0);
      if (sourceSize > MAX_SOURCE_CHARS) {
        throw new NoteExpansionOutputError("笔记较长，请先选中最想继续了解的一段，再启动拓展");
      }
    }
    const sourceSize = sourceBlocks.reduce((total, block) => total + Array.from(noteBlockRenderedTextV1(block.type, block.content)).length, 0);
    if (sourceSize === 0) throw new NoteExpansionOutputError("当前选区没有可读文字");
    if (sourceSize > MAX_SOURCE_CHARS) throw new NoteExpansionOutputError("选中部分的上下文较长，请缩小选区后再拓展");
    return { blocks: sourceBlocks, noteVersionId: note.versionId };
  });
}

export async function runNoteExpansionGenerate(job: JobPayload): Promise<void> {
  const input = readNoteExpansionGenerateJobPayload(job.payload);
  if (!job.requestedBy) throw new NoteExpansionOutputError("拓展任务缺少发起人");
  await assertJobLease(job);

  const existing = await withJobTransaction(job, (tx) => tx.query.noteExpansionTasks.findFirst({
    where: and(eq(schema.noteExpansionTasks.workspaceId, job.workspaceId), eq(schema.noteExpansionTasks.id, job.id)),
  }));
  if (existing) return;

  // 目标被修订或停止时先停下：整篇拓展要读全部正文并做一次模型调用，
  // 放在读材料之前判断，失败得早也省掉一次白跑。UI 直接发起的拓展没有
  // agentRunId，这里只会拿到伴星风格与已确认偏好，行为与笔记旁的其他生成一致。
  const agentContext = await loadAgentGenerationContext(job);

  const source = await loadSource(job, input);
  const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy);
  if (!governance.consentOk) throw new AIConsentRequiredError();
  const selected = resolveProviderForTask(governance, "note_expansion_draft");
  const provider = createGovernedProvider(
    createProvider(selected.providerName, selected.providerConfig),
    governance,
    job.workspaceId,
    { userId: job.requestedBy, operation: "note_expansion_draft", jobId: job.id, dataCategories: ["note_content"] },
  );
  const messages: ChatMessage[] = [
    { role: "system", content: "你是笔记旁的知识拓展助手。忠实引用用户给出的笔记来解释为什么拓展方向相关；区分原文与补充理解，不伪造来源。" },
    { role: "system", content: agentContext.instructions },
    { role: "user", content: buildNoteExpansionPrompt(source.blocks, Boolean(input.focusAnchor)) },
  ];
  const generationParameters = {
    temperature: 0.35,
    // 2026-10-06 起跟随平台配置开思考；思考 token 计入 maxTokens，预算相应上调。
    maxTokens: 8_000,
    responseFormat: "json_object" as const,
  };
  const inputSnapshotHash = noteLearningSnapshotHash({
    taskVersion: 1,
    noteVersionId: source.noteVersionId,
    sourceBlocks: source.blocks,
    focusAnchor: input.focusAnchor ?? null,
    modelId: provider.modelId,
    promptVersion: provider.promptVersion,
    generationParameters,
    messages,
  });
  const generated = await runWorkerAiTask({
    job,
    userId: job.requestedBy,
    taskId: "note_expansion_draft",
    taskVersion: 1,
    idempotencyKey: `note-expansion:${job.id}:${inputSnapshotHash}`,
    inputSnapshotRef: { kind: "note_version", id: source.noteVersionId, hash: inputSnapshotHash },
    input: messages,
    modelId: provider.modelId,
    promptVersion: `${provider.promptVersion}:note-expansion-draft-v2`,
    resourceClass: "interactive_ai",
    timeoutMs: resolveProviderCallTimeout("note_expansion_generate"),
    isOutputShapeError: (error) => error instanceof NoteExpansionOutputError,
    execute: async (request, signal) => {
      // 每次真正调用模型前重新占一次目标预算：模型在事务外跑，目标可能已被
      // 修订或停止，不能靠进入时的判断。
      await agentContext.reserveModelCall();
      const response = await provider.chatCompletion(request, generationParameters, signal);
      return {
        ok: true,
        output: parseResponse(response.content),
        promptTokens: response.usage?.promptTokens ?? undefined,
        completionTokens: response.usage?.completionTokens ?? undefined,
      };
    },
  });
  const sourceByOrdinal = new Map(source.blocks.map((block) => [block.ordinal, block]));
  const drafts: NoteExpansionDraftV1[] = generated.drafts.map((draft) => {
    const references = draft.sourceReferences.map((reference) => {
      const sourceBlock = sourceByOrdinal.get(reference.blockOrdinal);
      const quote = sourceBlock ? findExactQuote(noteBlockRenderedTextV1(sourceBlock.type, sourceBlock.content), reference.quote) : null;
      if (!quote) throw new NoteExpansionOutputError("拓展关系没有可核对的原文来处");
      return { blockOrdinal: reference.blockOrdinal, quote };
    });
    return noteExpansionDraftV1Schema.parse({
      candidateId: randomUUID(),
      requestId: randomUUID(),
      title: draft.title,
      relationship: draft.relationship,
      sourceReferences: references,
      blocks: draft.blocks,
      selected: false,
    });
  });

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    const [visible] = await tx.select({ noteId: schema.notes.id }).from(schema.notes).innerJoin(schema.noteVersions, and(
      eq(schema.noteVersions.noteId, schema.notes.id), eq(schema.noteVersions.workspaceId, job.workspaceId),
    )).where(and(
      eq(schema.notes.id, input.noteId), eq(schema.notes.workspaceId, job.workspaceId),
      isNull(schema.notes.deletedAt), visibleNoteCondition, eq(schema.noteVersions.id, input.noteVersionId),
    )).limit(1);
    if (!visible) throw new NoteExpansionOutputError("笔记权限或版本已变化，这批拓展草稿没有保存");
    const alreadySaved = await tx.query.noteExpansionTasks.findFirst({
      where: and(eq(schema.noteExpansionTasks.workspaceId, job.workspaceId), eq(schema.noteExpansionTasks.id, job.id)),
    });
    if (alreadySaved) return;
    await tx.insert(schema.noteExpansionTasks).values({
      id: job.id,
      workspaceId: job.workspaceId,
      userId: job.requestedBy!,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      requestId: input.requestId,
      focusAnchor: input.focusAnchor ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      conversationId: input.conversationId ?? null,
      drafts,
    });
  });
}

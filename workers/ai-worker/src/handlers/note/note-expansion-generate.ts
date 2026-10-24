import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { measureChatRequest } from "@astella/agent-core";
import { AI_UNDECLARED_OUTPUT_TOKENS, type ChatMessage } from "@astella/shared";
import { readNoteExpansionGenerateJobPayload } from "@astella/shared/job-payload-contracts";
import { loadAgentGenerationContext } from "../../agent/generation-context.ts";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import { exactQuote as quoteFromSource } from "./note-grounding-source.ts";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { noteAnchorMatchesV1 } from "@astella/shared/note-annotation-contracts";
import * as schema from "@astella/shared/db-schema";
import { noteExpansionDraftV1Schema, type NoteExpansionDraftV1 } from "@astella/shared/note-expansion-contracts";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../../lib/governance.ts";
import { createProvider } from "../../lib/ai-provider.ts";
import { AIContextOverflowError, governContextPressure } from "../../lib/context-governor.ts";
import { extractJsonFromText } from "../../lib/providers/json-response.ts";
import { resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../../lib/job-lease.ts";
import { logger } from "../../lib/logger.ts";
import { planCoveringChunks } from "../../lib/source-coverage.ts";
import { buildRepairAttempt, repairInstruction } from "../../lib/model-repair-attempt.ts";
import { NoteExpansionOutputError } from "../../lib/non-retryable-errors.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import { noteLearningSnapshotHash } from "./note-learning-snapshot.ts";
import {
  buildNoteExpansionCandidatePrompt,
  buildNoteExpansionPrompt,
  type NoteExpansionCandidate,
  type NoteExpansionSourceBlock,
} from "./note-expansion-prompt.ts";
import type { JobPayload } from ".././index.ts";

/** 只数并发，不数覆盖：候选那一步的每一段都会跑完，批次大小编不了读多少。 */
const PROVIDER_CALL_BATCH = 4;
const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));

const generatedDraftFields = z.strictObject({
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
});

const generatedDraftSchema = generatedDraftFields.refine(
  (draft) => draft.blocks.reduce((total, block) => total + block.content.length, 0) <= 20_000,
  { message: "拓展草稿正文超过长度上限" },
);

/**
 * 分段读取那一步的合同：字段形状直接取起草合同里的那一些，条数不在这儿定上限——
 * 一段能给出几个真正不同的方向就由内容决定。
 */
const expansionCandidateResponseSchema = z.strictObject({
  candidates: z.array(z.strictObject({
    title: generatedDraftFields.shape.title,
    relationship: generatedDraftFields.shape.relationship,
    reference: generatedDraftFields.shape.sourceReferences.element,
  })).min(1),
});

const generatedResponseSchema = z.strictObject({ drafts: z.array(generatedDraftSchema).min(2).max(4) });

type SourceBlock = NoteExpansionSourceBlock;

/** 把校验问题写成"字段:类型"的小清单：重试提示要靠它指出该改哪一处。 */
function issueFields(error: { readonly issues: readonly { path: (string | number)[], code: string; message?: string }[] }): string {
  return error.issues.slice(0, 4)
    .map((issue) => `${issue.path.join(".") || "root"}:${issue.code}${issue.message ? ` (${issue.message.slice(0, 160)})` : ""}`).join(", ");
}

const EXPANSION_REPAIR_FALLBACK = "请重新检查候选结构、关系说明与逐字原文来处。";

function parseResponse(raw: string) {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["drafts"]); } catch {
    throw new NoteExpansionOutputError("拓展草稿不是可审核的结构化内容");
  }
  const result = generatedResponseSchema.safeParse(value);
  if (!result.success) {
    throw new NoteExpansionOutputError(`拓展草稿输出不符合约定（${issueFields(result.error)}）`);
  }
  const titles = result.data.drafts.map((draft) => draft.title.trim().toLocaleLowerCase());
  if (new Set(titles).size !== titles.length) throw new NoteExpansionOutputError("拓展草稿出现了重复标题");
  return result.data;
}

/**
 * 引文核对的唯一一份在 `note-grounding-source.ts`（脑图/速看/拓展共用）；
 * 拓展这一档保留自己原有的两条：至少 8 个字、按小写比对（素材里英文缩写大小写不稳定）。
 */
function findExactQuote(blockText: string, candidate: string): string | null {
  return quoteFromSource(blockText, candidate, { minNeedleChars: 8, caseInsensitive: true });
}

function splitAtCodePointLimit(value: string, limit: number): string[] {
  const chars = Array.from(value);
  const result: string[] = [];
  for (let index = 0; index < chars.length; index += limit) {
    result.push(chars.slice(index, index + limit).join(""));
  }
  return result;
}

/**
 * 按段宽切正文：段宽由这一次路由的声明预算算出来，这里不留任何默认宽度。
 * 切的是送进提示词的**渲染后文字**，同一块被切开时两段都保留，不丢内容。
 */
function buildSourceChunks(blocks: readonly SourceBlock[], pieceChars: number) {
  const chunks: { readonly lines: readonly { ordinal: number; text: string }[]; readonly ordinals: ReadonlySet<number> }[] = [];
  let lines: { ordinal: number; text: string }[] = [];
  let charCount = 0;
  const flush = () => {
    if (lines.length === 0) return;
    chunks.push({ lines, ordinals: new Set(lines.map((line) => line.ordinal)) });
    lines = [];
    charCount = 0;
  };
  for (const block of blocks) {
    const rendered = noteBlockRenderedTextV1(block.type, block.content);
    if (!rendered.trim()) continue;
    for (const piece of splitAtCodePointLimit(rendered, pieceChars)) {
      const size = Array.from(piece).length;
      if (charCount > 0 && charCount + size > pieceChars) flush();
      lines.push({ ordinal: block.ordinal, text: piece });
      charCount += size;
      if (charCount >= pieceChars) flush();
    }
  }
  flush();
  return chunks;
}

/**
 * 起草那一发看到的"原文"= 各段候选交回的那些逐字句子，按块号归并。
 *
 * 这些句子已经在各自那一段里核对过，所以引文仍是原文逐字；块号与块类型仍取真实块，
 * 落库的来处指向用户笔记里的那个位置。
 */
function draftingBlocksFromCandidates(candidates: readonly NoteExpansionCandidate[], blocks: readonly SourceBlock[]): SourceBlock[] {
  const quotesByOrdinal = new Map<number, string[]>();
  for (const candidate of candidates) {
    const ordinal = candidate.reference.blockOrdinal;
    const quotes = quotesByOrdinal.get(ordinal) ?? [];
    if (!quotes.includes(candidate.reference.quote)) quotes.push(candidate.reference.quote);
    quotesByOrdinal.set(ordinal, quotes);
  }
  return [...quotesByOrdinal.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([ordinal, quotes]) => ({
      ordinal,
      type: blocks.find((block) => block.ordinal === ordinal)?.type ?? "paragraph",
      content: quotes.join("\n"),
    }));
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
    }
    const sourceSize = sourceBlocks.reduce((total, block) => total + Array.from(noteBlockRenderedTextV1(block.type, block.content)).length, 0);
    if (sourceSize === 0) throw new NoteExpansionOutputError("当前选区没有可读文字");
    // 这里不再按字符数拒绝：读不下是这一次路由的声明预算要说话的事，见 runNoteExpansionGenerate。
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

  // 目标被修订或停止时先停下：拓展要读全部正文并花模型调用，
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
  const focused = Boolean(input.focusAnchor);
  const generationParameters = {
    temperature: 0.35,
    // 输出额度由这一次路由的模型档案声明（思考 token 也计在这里面）；调用方不再报数。
    maxTokens: provider.resolveOutputTokenLimit?.() ?? AI_UNDECLARED_OUTPUT_TOKENS,
    responseFormat: "json_object" as const,
  };
  const systemMessages: ChatMessage[] = [
    { role: "system", content: "你是笔记旁的知识拓展助手。忠实引用用户给出的笔记来解释为什么拓展方向相关；区分原文与补充理解，不伪造来源。" },
    { role: "system", content: agentContext.instructions },
  ];
  const draftingMessages = (blocks: readonly SourceBlock[], candidates?: readonly NoteExpansionCandidate[]): ChatMessage[] => [
    ...systemMessages,
    { role: "user", content: buildNoteExpansionPrompt(blocks, focused, candidates) },
  ];
  const candidateMessages = (lines: readonly { ordinal: number; text: string }[], index: number, total: number): ChatMessage[] => [
    ...systemMessages,
    { role: "user", content: buildNoteExpansionCandidatePrompt(lines, focused, { index, total }) },
  ];

  // 起点仍是整篇一段：这一档的声明预算装得下，就还是一次读完、一次起草。
  let lastOverflow: AIContextOverflowError | null = null;
  const { chunks } = await planCoveringChunks({
    build: (pieceChars) => buildSourceChunks(source.blocks, pieceChars),
    fits: async (planned) => {
      const requests = planned.length === 1
        ? [draftingMessages(source.blocks)]
        : planned.map((group, index) => candidateMessages(group.lines, index, planned.length));
      for (const request of requests) {
        try {
          await governContextPressure({
            provider,
            operation: "note_expansion_draft",
            requestedOutputTokens: generationParameters.maxTokens,
            measure: (ports) => measureChatRequest(request, generationParameters, ports),
          });
        } catch (error) {
          if (!(error instanceof AIContextOverflowError)) throw error;
          lastOverflow = error;
          return false;
        }
      }
      return true;
    },
    // 连一小段完整正文都装不下才是真失败，报的是这一档声明的输入上限（带数字的那份判定）。
    overflow: () => lastOverflow ?? new NoteExpansionOutputError("当前模型的上下文预算连一小段完整正文都装不下，这次拓展没有可读的材料"),
  });

  /**
   * 分段那一条路上，每段先交回这一段的候选方向；引文只能逐字来自**这一段**，
   * 所以核对按段做——合并时不会把别段的句子安到这一段上。
   */
  async function readCandidates(
    index: number,
    total: number,
    group: (typeof chunks)[number],
  ): Promise<NoteExpansionCandidate[]> {
    const messages = candidateMessages(group.lines, index, total);
    const textByOrdinal = new Map<number, string>();
    for (const line of group.lines) textByOrdinal.set(line.ordinal, `${textByOrdinal.get(line.ordinal) ?? ""}${line.text}`);
    const inputSnapshotHash = noteLearningSnapshotHash({
      taskVersion: 1,
      noteVersionId: source.noteVersionId,
      part: { index, total },
      sourceLines: group.lines,
      focusAnchor: input.focusAnchor ?? null,
      modelId: provider.modelId,
      promptVersion: provider.promptVersion,
      generationParameters,
      messages,
    });
    let rejected: { readonly output: string; readonly reason: string } | null = null;
    const parsed = await runWorkerAiTask({
      job,
      userId: job.requestedBy!,
      taskId: "note_expansion_candidate",
      taskVersion: 1,
      idempotencyKey: `note-expansion:${job.id}:part-${index}:${inputSnapshotHash}`,
      inputSnapshotRef: { kind: "note_version", id: source.noteVersionId, hash: inputSnapshotHash },
      input: messages,
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:note-expansion-candidate-v1`,
      resourceClass: "interactive_ai",
      timeoutMs: resolveProviderCallTimeout("note_expansion_generate"),
      isOutputShapeError: (error) => error instanceof NoteExpansionOutputError,
      execute: async (request, signal, retryIndex) => {
        await agentContext.reserveModelCall();
        // 重试带上被拒的那一版：修正指令说"其余保持不变"，可"其余"只在那份输出里。
        const response = await provider.chatCompletion(
          retryIndex > 0 && rejected
            ? buildRepairAttempt(request, rejected.output, repairInstruction(rejected.reason, EXPANSION_REPAIR_FALLBACK))
            : request,
          generationParameters, signal);
        try {
          let value: unknown;
          try { value = extractJsonFromText(response.content, ["candidates"]); } catch {
            throw new NoteExpansionOutputError("拓展候选不是可审核的结构化内容");
          }
          const result = expansionCandidateResponseSchema.safeParse(value);
          if (!result.success) {
            throw new NoteExpansionOutputError(`拓展候选缺少关系说明或原文来处（${issueFields(result.error)}）`);
          }
          return {
            ok: true,
            output: result.data,
            promptTokens: response.usage?.promptTokens ?? undefined,
            completionTokens: response.usage?.completionTokens ?? undefined,
          };
        } catch (error) {
          if (error instanceof NoteExpansionOutputError) {
            rejected = { output: response.content, reason: error.message };
          }
          throw error;
        }
      },
    });
    const kept: NoteExpansionCandidate[] = [];
    for (const candidate of parsed.candidates) {
      const text = textByOrdinal.get(candidate.reference.blockOrdinal);
      // 核不上的那条是编的依据，留它进合并等于把编的句子印成原文；丢掉，不改写。
      if (!text || !findExactQuote(text, candidate.reference.quote)) {
        logger.warn({ jobId: job.id, part: index, blockOrdinal: candidate.reference.blockOrdinal }, "expansion candidate quote is not in this part");
        continue;
      }
      kept.push(candidate);
    }
    return kept;
  }

  let candidates: NoteExpansionCandidate[] = [];
  if (chunks.length > 1) {
    // 候选那一步各段独立；批次只数同时发几段，每一段都会跑完。
    for (let start = 0; start < chunks.length; start += PROVIDER_CALL_BATCH) {
      const batch = chunks.slice(start, start + PROVIDER_CALL_BATCH);
      const settled = await Promise.all(batch.map((group, offset) => readCandidates(start + offset, chunks.length, group)));
      candidates.push(...settled.flat());
    }
    if (candidates.length === 0) throw new NoteExpansionOutputError("各段都没有给出能与原文核对得上的拓展方向");
  }
  const draftingBlocks: SourceBlock[] = candidates.length > 0
    ? draftingBlocksFromCandidates(candidates, source.blocks)
    : source.blocks;
  const messages = draftingMessages(draftingBlocks, candidates.length > 0 ? candidates : undefined);
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
  let draftRejected: { readonly output: string; readonly reason: string } | null = null;
  const generated = await runWorkerAiTask({
    job,
    userId: job.requestedBy,
    taskId: "note_expansion_draft",
    taskVersion: 1,
    idempotencyKey: `note-expansion:${job.id}:${inputSnapshotHash}`,
    inputSnapshotRef: { kind: "note_version", id: source.noteVersionId, hash: inputSnapshotHash },
    input: messages,
    modelId: provider.modelId,
    promptVersion: `${provider.promptVersion}:note-expansion-draft-v3`,
    resourceClass: "interactive_ai",
    timeoutMs: resolveProviderCallTimeout("note_expansion_generate"),
    isOutputShapeError: (error) => error instanceof NoteExpansionOutputError,
    execute: async (request, signal, retryIndex) => {
      // 每次真正调用模型前重新占一次目标预算：模型在事务外跑，目标可能已被
      // 修订或停止，不能靠进入时的判断。
      await agentContext.reserveModelCall();
      const response = await provider.chatCompletion(
        retryIndex > 0 && draftRejected
          ? buildRepairAttempt(request, draftRejected.output, repairInstruction(draftRejected.reason, EXPANSION_REPAIR_FALLBACK))
          : request,
        generationParameters, signal);
      try {
        return {
          ok: true,
          output: parseResponse(response.content),
          promptTokens: response.usage?.promptTokens ?? undefined,
          completionTokens: response.usage?.completionTokens ?? undefined,
        };
      } catch (error) {
        if (error instanceof NoteExpansionOutputError) {
          draftRejected = { output: response.content, reason: error.message };
        }
        throw error;
      }
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

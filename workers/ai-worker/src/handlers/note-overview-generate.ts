import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { measureChatRequest } from "@astella/agent-core";
import { AI_UNDECLARED_OUTPUT_TOKENS, type ChatMessage } from "@astella/shared";
import { readNoteOverviewGenerateJobPayload } from "@astella/shared/job-payload-contracts";
import { loadAgentGenerationContext } from "../agent/generation-context.ts";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import * as schema from "@astella/shared/db-schema";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { AIContextOverflowError, governContextPressure } from "../lib/context-governor.ts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { planCoveringChunks } from "../lib/source-coverage.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { NoteOverviewOutputError } from "../lib/non-retryable-errors.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import { noteLearningSnapshotHash } from "./note-learning-snapshot.ts";
import type { JobPayload } from "./index.ts";

/**
 * 一次同时发几段。这是**吞吐**护栏不是覆盖护栏：段数由正文长度与当前模型的声明预算
 * 决定，所有段都会跑完，只是不要一次把几十个请求同时压给平台。
 */
const PROVIDER_CALL_BATCH = 4;
const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));

const overviewChunkSchema = z.strictObject({
  gist: z.string().trim().min(8).max(180),
  points: z.array(z.strictObject({
    blockOrdinal: z.number().int().min(0).max(100_000),
    quote: z.string().trim().min(8).max(200),
    explanation: z.string().trim().min(8).max(200),
  })).min(1),
});

type SourceBlock = { ordinal: number; type: string; content: string };
type OverviewPoint = { blockOrdinal: number; quote: string; explanation: string };

function compactEvidence(value: string): { text: string; sourceOffsets: number[] } {
  const chars = Array.from(value);
  const text: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (/\s/u.test(char)) continue;
    // Ignore common Markdown emphasis/code markers while retaining the exact
    // original offsets for the quotation that will be shown to the reader.
    if ("*_~`".includes(char)) continue;
    text.push(char);
    sourceOffsets.push(index);
  }
  return { text: text.join(""), sourceOffsets };
}

function exactQuote(blockText: string, candidate: string): string | null {
  const needle = compactEvidence(candidate).text;
  if (needle.length < 8) return null;
  const source = compactEvidence(blockText);
  const start = source.text.indexOf(needle);
  if (start < 0) return null;
  const from = source.sourceOffsets[start];
  const to = source.sourceOffsets[start + needle.length - 1];
  if (from === undefined || to === undefined) return null;
  const quote = Array.from(blockText).slice(from, to + 1).join("").trim();
  return quote.length <= 500 ? quote : null;
}

function imageSafeText(content: string): { text: string; imageCount: number } {
  let imageCount = 0;
  const text = content.replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/gu, (_match, alt: string) => {
    imageCount += 1;
    return `[图片${alt.trim() ? `：${alt.trim()}` : ""}，画面未读取]`;
  });
  return { text, imageCount };
}

function splitAtCodePointLimit(value: string, limit: number): string[] {
  const chars = Array.from(value);
  const result: string[] = [];
  for (let index = 0; index < chars.length; index += limit) {
    result.push(chars.slice(index, index + limit).join(""));
  }
  return result;
}

/** 段宽由调用方给（那一次路由的声明预算算出来的），这里不留任何默认宽度。 */
function buildChunks(blocks: readonly SourceBlock[], pieceChars: number) {
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
    const safe = block.type === "image"
      ? { text: "", imageCount: 1 }
      : imageSafeText(block.content);
    const content = safe.text.trim();
    if (!content) continue;
    for (const piece of splitAtCodePointLimit(content, pieceChars)) {
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

function parseOverviewChunk(raw: string) {
  let parsed: unknown;
  try { parsed = extractJsonFromText(raw, ["gist", "points"]); } catch {
    throw new NoteOverviewOutputError("速看结果不是可核对的结构化内容");
  }
  const result = overviewChunkSchema.safeParse(parsed);
  if (!result.success) throw new NoteOverviewOutputError("速看结果缺少清楚的重点或原文依据");
  return result.data;
}

async function readFrozenNote(job: JobPayload, input: { noteId: string; noteVersionId: string }) {
  if (!job.requestedBy) throw new NoteOverviewOutputError("速看任务缺少发起人");
  return withJobTransaction(job, async (tx) => {
    const [frozen] = await tx.select({
      noteId: schema.notes.id,
      currentVersionId: schema.notes.currentVersionId,
      shareScope: schema.notes.shareScope,
      createdBy: schema.notes.createdBy,
      versionId: schema.noteVersions.id,
      versionNo: schema.noteVersions.versionNo,
      contentHash: schema.noteVersions.contentHash,
    }).from(schema.notes).innerJoin(schema.noteVersions, and(
      eq(schema.noteVersions.id, input.noteVersionId),
      eq(schema.noteVersions.noteId, schema.notes.id),
      eq(schema.noteVersions.workspaceId, job.workspaceId),
    )).where(and(
      eq(schema.notes.id, input.noteId),
      eq(schema.notes.workspaceId, job.workspaceId),
      isNull(schema.notes.deletedAt),
      visibleNoteCondition,
    )).limit(1);
    if (!frozen) throw new NoteOverviewOutputError("速看对应的笔记版本已不可用");
    const blocks = await tx.select({
      ordinal: schema.noteBlocks.ordinal,
      type: schema.noteBlocks.type,
      content: schema.noteBlocks.content,
    }).from(schema.noteBlocks).where(and(
      eq(schema.noteBlocks.workspaceId, job.workspaceId),
      eq(schema.noteBlocks.versionId, frozen.versionId),
    )).orderBy(schema.noteBlocks.ordinal);
    return { frozen, blocks };
  });
}

function buildPrompt(chunkIndex: number, chunkCount: number, lines: readonly { ordinal: number; text: string }[]) {
  const source = lines.map((line) => `[原文第 ${line.ordinal} 段]\n${line.text}`).join("\n\n");
  return [
    "请帮第一次接触这篇笔记的人快速听懂内容。用自然、通俗的中文解释术语，不要用空泛的评价，也不要编造材料没有说的事实。",
    `这是笔记文字的第 ${chunkIndex + 1}/${chunkCount} 部分；所有部分都会分别处理。只概括本部分，不要假装看到了其他部分。`,
    "返回严格 JSON：{\"gist\":\"一句话说清本部分，最多120字\",\"points\":[{\"blockOrdinal\":原文段落序号,\"quote\":\"从该段逐字摘录8到160字\",\"explanation\":\"一句白话重点，30到140字\"}]}。重点的条数由这一部分的内容决定，多给几条更好时就不用只给一条，尽量来自不同段落；每条先讲读者需要知道什么，再讲它有什么用，不写“这段揭示了”“体现了”之类评价。引用必须来自下方某一段原文；图片占位说明不是可引用原文。不要输出 Markdown 代码围栏或额外文本。",
    "笔记内容：",
    source,
  ].join("\n\n");
}

export async function runNoteOverviewGenerate(job: JobPayload): Promise<void> {
  const input = readNoteOverviewGenerateJobPayload(job.payload);
  if (!job.requestedBy) throw new NoteOverviewOutputError("速看任务缺少发起人");
  await assertJobLease(job);

  const existing = await withJobTransaction(job, (tx) => tx.query.noteOverviews.findFirst({
    where: and(
      eq(schema.noteOverviews.workspaceId, job.workspaceId),
      eq(schema.noteOverviews.generationJobId, job.id),
    ),
  }));
  if (existing) return;

  const { frozen, blocks } = await readFrozenNote(job, input);
  if (blocks.length === 0) throw new NoteOverviewOutputError("这篇笔记还没有可读的正文");
  const imageBlocksNotRead = blocks.reduce((count, block) => {
    const inlineImages = (block.content.match(/!\[[^\]]*\]\(/gu) ?? []).length;
    return count + (block.type === "image" ? 1 : 0) + inlineImages;
  }, 0);
  const textBlocksRead = blocks.filter((block) => block.type !== "image" && imageSafeText(block.content).text.trim().length > 0).length;
  // 只有图片时材料本身就是空的，与模型窗口无关；这一条不是长度闸门。
  if (textBlocksRead === 0) throw new NoteOverviewOutputError("这篇笔记目前只有图片，图片画面还不能用于速看");

  const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy);
  if (!governance.consentOk) throw new AIConsentRequiredError();
  const selected = resolveProviderForTask(governance, "note_learning_overview");
  const provider = createGovernedProvider(
    createProvider(selected.providerName, selected.providerConfig),
    governance,
    job.workspaceId,
    { userId: job.requestedBy, operation: "note_learning_overview", jobId: job.id, dataCategories: ["note_content"] },
  );
  const providerTimeout = resolveProviderCallTimeout("note_overview_generate");
  const agentContext = await loadAgentGenerationContext(job);
  const generationParameters = {
    temperature: 0.2,
    // 输出额度由这一次路由的模型档案声明（思考 token 也计在这里面）；写死的小数字
    // 只会把一份本来能写完的速看砍断，不会省到钱。
    maxTokens: provider.resolveOutputTokenLimit?.() ?? AI_UNDECLARED_OUTPUT_TOKENS,
    responseFormat: "json_object" as const,
  };
  const messagesFor = (
    chunkIndex: number,
    chunkCount: number,
    lines: readonly { ordinal: number; text: string }[],
  ): ChatMessage[] => [
    { role: "system", content: "你是笔记里的白话讲解助手。忠实依据用户笔记，引用必须原样来自提供的段落。" },
    { role: "system", content: agentContext.instructions },
    { role: "user", content: buildPrompt(chunkIndex, chunkCount, lines) },
  ];
  // 段宽来自这一次实际路由的声明预算：整篇装得下就一段读完，装不下才对半细分，段数不设上限。
  let lastOverflow: AIContextOverflowError | null = null;
  const { chunks } = await planCoveringChunks({
    build: (pieceChars) => buildChunks(blocks, pieceChars),
    fits: async (planned) => {
      for (let index = 0; index < planned.length; index++) {
        const chunk = planned[index]!;
        const request = messagesFor(index, planned.length, chunk.lines);
        try {
          await governContextPressure({
            provider,
            operation: "note_learning_overview",
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
    // 装不下就说这一档声明的输入上限（带数字的那份判定），不再换成「这篇笔记太长」。
    overflow: () => lastOverflow ?? new NoteOverviewOutputError("当前模型的上下文预算连一小段完整笔记正文都装不下"),
  });

  async function generateOverviewChunk(
    chunkIndex: number,
    chunk: (typeof chunks)[number],
  ): Promise<{ gist: string; points: OverviewPoint[] }> {
    const messages = messagesFor(chunkIndex, chunks.length, chunk.lines);
    const inputSnapshotHash = noteLearningSnapshotHash({
      taskVersion: 1,
      noteVersionId: frozen.versionId,
      noteContentHash: frozen.contentHash,
      chunkIndex,
      chunkCount: chunks.length,
      modelId: provider.modelId,
      promptVersion: provider.promptVersion,
      generationParameters,
      messages,
    });
    const parsed = await runWorkerAiTask({
      job,
      userId: job.requestedBy!,
      taskId: "note_overview_chunk",
      taskVersion: 1,
      idempotencyKey: `note-overview:${job.id}:${chunkIndex}:${inputSnapshotHash}`,
      inputSnapshotRef: { kind: "note_version", id: frozen.versionId, hash: inputSnapshotHash },
      input: messages,
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:note-overview-chunk-v1`,
      resourceClass: "interactive_ai",
      timeoutMs: providerTimeout,
      isOutputShapeError: (error) => error instanceof NoteOverviewOutputError,
      execute: async (request, signal) => {
        await agentContext.reserveModelCall();
        const response = await provider.chatCompletion(request, generationParameters, signal);
        return {
          ok: true,
          output: parseOverviewChunk(response.content),
          promptTokens: response.usage?.promptTokens ?? undefined,
          completionTokens: response.usage?.completionTokens ?? undefined,
        };
      },
    });
    const points = parsed.points.map((point) => {
      if (!chunk.ordinals.has(point.blockOrdinal)) throw new NoteOverviewOutputError("速看引用指向了另一段笔记");
      const source = blocks.find((block) => block.ordinal === point.blockOrdinal);
      const quote = source && source.type !== "image" ? exactQuote(source.content, point.quote) : null;
      if (!quote) throw new NoteOverviewOutputError("速看中的原文引用无法与笔记核对");
      return { blockOrdinal: point.blockOrdinal, quote, explanation: point.explanation };
    });
    return { gist: parsed.gist, points };
  }

  // 各段互相独立，一起发才让长笔记和短笔记花掉差不多的墙上时间；批次只数并发，
  // 每一段都会跑完——把它当成覆盖闸门就会重新变成「这篇太长读不完」。
  const generated: { gist: string; points: OverviewPoint[] }[] = [];
  for (let start = 0; start < chunks.length; start += PROVIDER_CALL_BATCH) {
    const batch = chunks.slice(start, start + PROVIDER_CALL_BATCH);
    generated.push(...await Promise.all(batch.map((chunk, offset) => generateOverviewChunk(start + offset, chunk))));
  }

  const references: { blockOrdinal: number; quote: string }[] = [];
  for (const section of generated) {
    for (const point of section.points) {
      if (!references.some((item) => item.blockOrdinal === point.blockOrdinal && item.quote === point.quote)) {
        references.push({ blockOrdinal: point.blockOrdinal, quote: point.quote });
      }
    }
  }
  if (references.length === 0) throw new NoteOverviewOutputError("速看没有留下可回到原文的依据");
  const gists = generated.map((section) => section.gist);
  const points = generated.flatMap((section) => section.points);
  const body = gists.length === 1 ? gists[0]! : gists.join("\n");
  // 落库那一列的 CHECK 就是这条线（note_overviews_body_length_check），按码点比。
  if (Array.from(body).length > 20_000) throw new NoteOverviewOutputError("这份速看超过可保存长度，请从笔记中选一段开始");

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    const visible = await tx.select({ id: schema.notes.id }).from(schema.notes).innerJoin(schema.noteVersions, eq(schema.noteVersions.noteId, schema.notes.id)).where(and(
      eq(schema.notes.id, input.noteId),
      eq(schema.notes.workspaceId, job.workspaceId),
      isNull(schema.notes.deletedAt),
      visibleNoteCondition,
      eq(schema.noteVersions.id, input.noteVersionId),
    )).limit(1);
    if (!visible[0]) throw new NoteOverviewOutputError("笔记权限或版本已变化，这份速看没有保存");
    const alreadySaved = await tx.query.noteOverviews.findFirst({
      where: and(
        eq(schema.noteOverviews.workspaceId, job.workspaceId),
        eq(schema.noteOverviews.generationJobId, job.id),
      ),
    });
    if (alreadySaved) return;
    await tx.insert(schema.noteOverviews).values({
      workspaceId: job.workspaceId,
      userId: job.requestedBy!,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      body,
      overviewPoints: points,
      sourceReferences: references,
      coverage: { totalBlocks: blocks.length, textBlocksRead, imageBlocksNotRead },
      generationJobId: job.id,
      sourceMessageId: null,
      conversationId: null,
    });
  });
}

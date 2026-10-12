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
  // 只卡下限：说清楚是要求，"最多多少字"不是。上限原先与提示词里那串数字互相打架
  // （提示词写 120／160／140，合同写 180／200／200），模型按提示词写、按合同被拒。
  gist: z.string().trim().min(8),
  points: z.array(z.strictObject({
    blockOrdinal: z.number().int().min(0).max(100_000),
    quote: z.string().trim().min(8),
    explanation: z.string().trim().min(8),
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

export function exactQuote(blockText: string, candidate: string): string | null {
  const needle = compactEvidence(candidate).text;
  if (needle.length < 8) return null;
  const source = compactEvidence(blockText);
  const offset = source.text.indexOf(needle);
  if (offset < 0) return null;
  // `indexOf` 给的是 UTF-16 码元下标，而 sourceOffsets 是按**码点**记的：正文里只要有
  // emoji 这类增补平面字符，两者就不再相等，直接用会把一条本来正确的引用判成"核不回
  // 原文"（脑图那边早就做了这个换算，速看这边漏了）。
  const start = Array.from(source.text.slice(0, offset)).length;
  const from = source.sourceOffsets[start];
  const to = source.sourceOffsets[start + Array.from(needle).length - 1];
  if (from === undefined || to === undefined) return null;
  const quote = Array.from(blockText).slice(from, to + 1).join("").trim();
  // 引多长由它要支撑的那个重点决定：原先超过 500 字就判"核不回原文"，
  // 于是模型引用一段长论证时，整份速看跟着失败。
  return quote.length > 0 ? quote : null;
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

export function parseOverviewChunk(raw: string) {
  let parsed: unknown;
  try { parsed = extractJsonFromText(raw, ["gist", "points"]); } catch {
    throw new NoteOverviewOutputError("速看结果不是可核对的结构化内容");
  }
  const result = overviewChunkSchema.safeParse(parsed);
  if (!result.success) throw new NoteOverviewOutputError("速看结果缺少清楚的重点或原文依据");
  return result.data;
}

/**
 * 把模型给的重点逐条核回原文。**核不上的逐条剔除并计数，而不是整份失败**——
 * 一条引用核不回原文，说明这一条不可信，但不该因此把同一段里已经核实的其他重点一起丢掉。
 * 这正是"内容合法、读数把它当故障"的老毛病；剔除条数会记进 coverage，所以少给了几条是看得见的。
 */
export function resolveOverviewPoints(
  points: readonly { blockOrdinal: number; quote: string; explanation: string }[],
  blockAt: (ordinal: number) => SourceBlock | undefined,
): { points: OverviewPoint[]; dropped: number } {
  const kept: OverviewPoint[] = [];
  let dropped = 0;
  for (const point of points) {
    const source = blockAt(point.blockOrdinal);
    const quote = source && source.type !== "image" ? exactQuote(source.content, point.quote) : null;
    if (!quote) { dropped += 1; continue; }
    kept.push({ blockOrdinal: point.blockOrdinal, quote, explanation: point.explanation });
  }
  return { points: kept, dropped };
}

/**
 * 各段要点合成一份清单：按原文顺序排，同一段同一句只留一条。
 *
 * 界面上它是一份编号清单，顺序就是读的顺序，而各段是并发生成的、返回次序不保证；
 * 长笔记分段时相邻两段常各自引用同一句，照单全收就变成重复清单。
 */
export function orderOverviewPoints(sections: readonly OverviewPoint[][]): OverviewPoint[] {
  return sections
    .flat()
    .filter((point, index, all) => all.findIndex(
      (item) => item.blockOrdinal === point.blockOrdinal && item.quote === point.quote,
    ) === index)
    .sort((left, right) => left.blockOrdinal - right.blockOrdinal);
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
    "返回严格 JSON：{\"gist\":\"...\",\"points\":[{\"blockOrdinal\":原文段落序号,\"quote\":\"...\",\"explanation\":\"...\"}]}。",
    // 长度只给形状，不给数字：写死字数会让"一句能说清的事"被撑长、把"需要两句话的事"砍断。
    "gist 是这一部分的小结：说清它整体在讲什么、几件事之间是什么关系，让没读过原文的人也能接上。写成连贯的一段话，不要写成目录或罗列。",
    // 条数由内容定：这是"重点"该有的样子，不是配额。
    "points 是读者真正该带走的重点，会按原文顺序排成一份编号清单。条数由这一部分的内容决定——有几件独立的事就写几条；不要为了凑数把一件事拆成两条，也不要把几件事压成一条。",
    "每条 explanation 先讲读者需要知道什么，再讲它有什么用；不要写“这段揭示了”“体现了”“说明了作者”这类评价句，也不要把 quote 的原话再复述一遍。",
    "quote 从该段逐字摘录，长度以“只看这一句也能认出在说哪件事”为准，通常是一句完整的话。必须来自下方某一段原文；图片占位说明不是可引用原文。",
    "尽量让不同的重点来自不同段落；同一段确实有几件独立的事时，才从同一段取多条。不要输出 Markdown 代码围栏或额外文本。",
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
  ): Promise<{ gist: string; points: OverviewPoint[]; dropped: number }> {
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
    // 逐条核回原文；核不上的只剔掉那一条，不把同一段里已经核实的其他重点一起丢掉。
    const resolved = resolveOverviewPoints(parsed.points, (ordinal) =>
      chunk.ordinals.has(ordinal) ? blocks.find((block) => block.ordinal === ordinal) : undefined);
    return { gist: parsed.gist, points: resolved.points, dropped: resolved.dropped };
  }

  // 各段互相独立，一起发才让长笔记和短笔记花掉差不多的墙上时间；批次只数并发，
  // 每一段都会跑完——把它当成覆盖闸门就会重新变成「这篇太长读不完」。
  const generated: { gist: string; points: OverviewPoint[]; dropped: number }[] = [];
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
  // 要点按原文顺序排、同一段同一句只留一条（见 orderOverviewPoints）。
  const points = orderOverviewPoints(generated.map((section) => section.points));
  const pointsDropped = generated.reduce((sum, section) => sum + section.dropped, 0);
  // 正文由各段小结组成，空行分段（界面上按 markdown 渲染）。长度不设本地上限：
  // 天花板是这一次路由的输出额度与上下文预算，存储那一层只管"有没有内容"（0412/0419）。
  const body = gists.join("\n\n");

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
      // 一条都没剩下时存 null 而不是空数组：库里那条 CHECK 管的是"要么没有、要么至少一条"。
      overviewPoints: points.length > 0 ? points : null,
      sourceReferences: references,
      coverage: { totalBlocks: blocks.length, textBlocksRead, imageBlocksNotRead, pointsDropped },
      generationJobId: job.id,
      sourceMessageId: null,
      conversationId: null,
    });
  });
}

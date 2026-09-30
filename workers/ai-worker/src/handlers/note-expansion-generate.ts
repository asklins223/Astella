import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { readNoteExpansionGenerateJobPayload } from "@ailearn/shared/job-payload-contracts";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import * as schema from "@ailearn/shared/db-schema";
import { noteExpansionDraftV1Schema, type NoteExpansionDraftV1 } from "@ailearn/shared/note-expansion-contracts";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { assertJobLease, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { NoteExpansionOutputError } from "../lib/non-retryable-errors.ts";
import type { JobPayload } from "./index.ts";

const MAX_SOURCE_CHARS = 24_000;
const MAX_PROVIDER_CALL_MS = 65_000;
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
  })).min(2).max(30),
}).refine((draft) => draft.blocks.reduce((total, block) => total + block.content.length, 0) <= 20_000, {
  message: "拓展草稿正文超过长度上限",
});

const generatedResponseSchema = z.strictObject({ drafts: z.array(generatedDraftSchema).min(2).max(4) });

type SourceBlock = { ordinal: number; type: string; content: string };

function parseResponse(raw: string) {
  let value: unknown;
  try { value = extractJsonFromText(raw, ["drafts"]); } catch {
    throw new NoteExpansionOutputError("拓展草稿不是可审核的结构化内容");
  }
  const result = generatedResponseSchema.safeParse(value);
  if (!result.success) throw new NoteExpansionOutputError("拓展草稿缺少标题、正文或原文来处");
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
      const rendered = block ? noteBlockRenderedTextV1(block.type, block.content) : "";
      if (!block || anchor.endOffset > rendered.length || rendered.slice(anchor.startOffset, anchor.endOffset) !== anchor.excerpt
        || rendered.slice(Math.max(0, anchor.startOffset - 120), anchor.startOffset) !== anchor.prefix
        || rendered.slice(anchor.endOffset, anchor.endOffset + 120) !== anchor.suffix) {
        throw new NoteExpansionOutputError("拓展选区和笔记保存的原文位置对不上");
      }
      const previousHeading = blocks.filter((item) => item.type === "heading" && item.ordinal < block.ordinal).at(-1);
      const adjacent = blocks.filter((item) => item.ordinal >= block.ordinal - 1 && item.ordinal <= block.ordinal + 1 && item.type !== "image");
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

function buildPrompt(blocks: readonly SourceBlock[], focused: boolean) {
  const source = blocks.map((block) => `[原文第 ${block.ordinal} 段]\n${noteBlockRenderedTextV1(block.type, block.content)}`).join("\n\n");
  return [
    "请从用户正在读的笔记出发，写 2 到 4 篇真正有助于继续理解的短拓展笔记。用自然、通俗的中文，不用学习理论术语。",
    focused ? "用户选中了一段，因此围绕这处概念向前置知识、相邻概念、实际用法或边界继续展开。" : "从整篇笔记中选择最值得继续了解的不同方向。",
    "每篇必须是能单独读懂的知识草稿，不要只写概念名称或学习计划。relationship 用一两句说明它和原笔记的具体关系。sourceReferences 必须引用下方原文中确实存在的句子，作为这条拓展关系的来处。拓展正文可以增加原文之外的常识，但请把不确定或超出原文的内容用‘补充理解’等自然措辞标明，不能假装它是原文事实。",
    "返回严格 JSON：{\"drafts\":[{\"title\":\"短标题\",\"relationship\":\"与原笔记的关系\",\"sourceReferences\":[{\"blockOrdinal\":原文段落序号,\"quote\":\"原文逐字摘录\"}],\"blocks\":[{\"type\":\"heading|paragraph|list|quote|code\",\"content\":\"正文\"}]}]}。每篇至少 2 个正文块，每条引用必须对应自己的方向。不要输出 Markdown 围栏或额外文本。",
    "笔记原文：",
    source,
  ].join("\n\n");
}

export async function runNoteExpansionGenerate(job: JobPayload): Promise<void> {
  const input = readNoteExpansionGenerateJobPayload(job.payload);
  if (!job.requestedBy) throw new NoteExpansionOutputError("拓展任务缺少发起人");
  await assertJobLease(job);

  const existing = await withJobTransaction(job, (tx) => tx.query.noteExpansionTasks.findFirst({
    where: and(eq(schema.noteExpansionTasks.workspaceId, job.workspaceId), eq(schema.noteExpansionTasks.id, job.id)),
  }));
  if (existing) return;

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
  const response = await runWithAbortBudget(
    (signal) => provider.chatCompletion([
      { role: "system", content: "你是笔记旁的知识拓展助手。忠实引用用户给出的笔记来解释为什么拓展方向相关；区分原文与补充理解，不伪造来源。" },
      { role: "user", content: buildPrompt(source.blocks, Boolean(input.focusAnchor)) },
    ], { temperature: 0.35, maxTokens: 6_000, responseFormat: "json_object", disableThinking: true }, signal),
    job.signal,
    Math.min(resolveProviderCallTimeout("note_expansion_generate"), MAX_PROVIDER_CALL_MS),
  );
  const generated = parseResponse(response.content);
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

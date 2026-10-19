import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { measureChatRequest } from "@astella/agent-core";
import { AI_UNDECLARED_OUTPUT_TOKENS, type ChatMessage } from "@astella/shared";
import { classifyThrownAsStepFailure, type AiAttemptToken } from "@astella/shared/ai-task-kernel";
import { readNoteDynamicArtifactGenerateJobPayload } from "@astella/shared/job-payload-contracts";
import { loadAgentGenerationContext } from "../../agent/generation-context.ts";
import { noteVisibleSqlText } from "@astella/shared/note-visibility";
import { noteBlockRenderedTextV1 } from "@astella/shared/note-doc-schema";
import { noteAnchorMatchesV1 } from "@astella/shared/note-annotation-contracts";
import * as schema from "@astella/shared/db-schema";
import {
  buildDynamicArtifactPrompt,
  createDynamicArtifactResponseSessionV1,
  dynamicArtifactDocV1Schema,
  runDynamicArtifactV1,
  type DynamicArtifactProviderV1,
} from "@astella/shared/note-dynamic-artifact/round-artifact-model";
import { checkArtifactDocumentV1 } from "@astella/shared/note-dynamic-artifact/round-artifact-doc";
import {
  evidenceQuoteMatchesBlockV1,
  groundArtifactStepsV1,
  plainTextForGroundingV1,
  type ArtifactEvidenceBlockV1,
  type ArtifactStepDraftV1,
} from "@astella/shared/note-dynamic-artifact/round-artifact-measure";
import {
  buildDynamicArtifactHtmlV1,
  DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1,
} from "@astella/shared/note-dynamic-artifact/round-artifact-render";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../../lib/governance.ts";
import { createProvider } from "../../lib/ai-provider.ts";
import { AIContextOverflowError, governContextPressure } from "../../lib/context-governor.ts";
import { extractJsonFromText } from "../../lib/providers/json-response.ts";
import { assertJobLease, isJobLeaseActive, JobLeaseLostError, lockJobLease, withJobTransaction } from "../../lib/job-lease.ts";
import { AgentOutputError, NoteDynamicArtifactOutputError, NoteDynamicArtifactAttemptExhaustedError } from "../../lib/non-retryable-errors.ts";
import { logger } from "../../lib/logger.ts";
import { currentWorkerWorkspaceTransaction } from "../../db.ts";
import { resolveNoteDynamicArtifactBudget, resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { planCoveringChunks } from "../../lib/source-coverage.ts";
import { runWorkerAiTask } from "./worker-ai-task.ts";
import { noteLearningSnapshotHash } from "./note-learning-snapshot.ts";
import type { JobPayload } from ".././index.ts";

const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));
/** 分段读要点那一步一次发几段。数的是并发，不是覆盖——每一段都会跑完。 */
const PROVIDER_CALL_BATCH = 4;
/** 分段读出来的要点：形状与回查大纲同一条合同，这里不再抄一遍字段约束。 */
const artifactCandidateSchema = z.strictObject({
  outline: z.array(dynamicArtifactDocV1Schema.shape.outline.element).min(1),
});

type FrozenArtifactInput = {
  versionNo: number;
  contentHash: string;
  blocks: ArtifactEvidenceBlockV1[];
  currentVersionId: string | null;
};

async function readFrozenInput(job: JobPayload, input: ReturnType<typeof readNoteDynamicArtifactGenerateJobPayload>): Promise<FrozenArtifactInput> {
  if (!job.requestedBy) throw new NoteDynamicArtifactOutputError("动态讲解任务缺少发起人");
  return withJobTransaction(job, async (tx) => {
    const [frozen] = await tx.select({
      currentVersionId: schema.notes.currentVersionId,
      versionNo: schema.noteVersions.versionNo,
      versionId: schema.noteVersions.id,
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
    if (!frozen) throw new NoteDynamicArtifactOutputError("动态讲解对应的笔记版本已不可用");
    const rawBlocks = await tx.select({ ordinal: schema.noteBlocks.ordinal, type: schema.noteBlocks.type, text: schema.noteBlocks.content })
      .from(schema.noteBlocks).where(and(
        eq(schema.noteBlocks.workspaceId, job.workspaceId),
        eq(schema.noteBlocks.versionId, input.noteVersionId),
      )).orderBy(schema.noteBlocks.ordinal);

    let blocks: ArtifactEvidenceBlockV1[];
    if (input.sourceKind === "annotation") {
      const anchor = input.anchor!;
      const selected = rawBlocks.find((block) => block.ordinal === anchor.startBlockOrdinal);
      if (!selected || anchor.noteVersionId !== input.noteVersionId
        || !noteAnchorMatchesV1(rawBlocks.map(block => ({ ...block, content: block.text })), anchor)) {
        throw new NoteDynamicArtifactOutputError("互动演示选区和保存的原文位置对不上");
      }
      const heading = [...rawBlocks].reverse().find((block) => block.type === "heading" && block.ordinal < selected.ordinal);
      const headingText = heading ? noteBlockRenderedTextV1(heading.type, heading.text) : "";
      blocks = [
        ...(heading && headingText.length <= 200 ? [{ ordinal: heading.ordinal, type: heading.type, text: heading.text }] : []),
        { ordinal: selected.ordinal, type: selected.type, text: anchor.excerpt },
      ];
    } else {
      blocks = rawBlocks.map((block) => ({ ordinal: block.ordinal, type: block.type, text: block.text }));
      const charCount = blocks.reduce((total, block) => total + Array.from(plainTextForGroundingV1(block.text)).length, 0);
      if (charCount === 0) throw new NoteDynamicArtifactOutputError("这版笔记没有可核对的文字内容");
      // 这里不按字符数拒绝：一次读不读得下，由这一次实际路由的模型档案声明算（见
      // runNoteDynamicArtifactGenerate 的分段读取）。
    }
    return { versionNo: frozen.versionNo, contentHash: frozen.contentHash, blocks, currentVersionId: frozen.currentVersionId };
  });
}

/**
 * 按段宽切正文，段宽由这一次路由的声明预算算出来（这里不留默认宽度）。
 * 一块太长会被按码点切开，但每一片都还带着自己的真实块号，合起来不丢内容。
 */
function buildArtifactChunks(blocks: readonly ArtifactEvidenceBlockV1[], pieceChars: number): ArtifactEvidenceBlockV1[][] {
  const groups: ArtifactEvidenceBlockV1[][] = [];
  let current: ArtifactEvidenceBlockV1[] = [];
  let size = 0;
  const flush = () => {
    if (current.length === 0) return;
    groups.push(current);
    current = [];
    size = 0;
  };
  for (const block of blocks) {
    const chars = Array.from(block.text);
    if (chars.length === 0) continue;
    for (let index = 0; index < chars.length; index += pieceChars) {
      const piece = chars.slice(index, index + pieceChars).join("");
      const pieceSize = Array.from(piece).length;
      if (size > 0 && size + pieceSize > pieceChars) flush();
      current.push({ ordinal: block.ordinal, type: block.type, text: piece });
      size += pieceSize;
      if (size >= pieceChars) flush();
    }
  }
  flush();
  return groups;
}

/**
 * 页面那一发看到的"原文"就是各段核对过的逐字引句，按真实块号归并，并带上它们各自
 * 最近的小节标题——回查节点的位置标签要从这些块里读。
 */
function artifactEvidenceBlocks(
  steps: readonly ArtifactStepDraftV1[],
  blocks: readonly ArtifactEvidenceBlockV1[],
): ArtifactEvidenceBlockV1[] {
  const collected = new Map<number, { type: string; texts: string[] }>();
  const push = (ordinal: number, type: string, text: string): void => {
    const entry = collected.get(ordinal) ?? { type, texts: [] };
    if (!entry.texts.includes(text)) entry.texts.push(text);
    collected.set(ordinal, entry);
  };
  for (const step of steps) {
    const source = blocks.find((block) => block.ordinal === step.evidenceOrdinal);
    push(step.evidenceOrdinal, source?.type ?? "paragraph", step.evidenceQuote);
    const heading = blocks.filter((block) => block.type === "heading" && block.ordinal < step.evidenceOrdinal).at(-1);
    if (heading) push(heading.ordinal, heading.type, heading.text);
  }
  return [...collected.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([ordinal, entry]) => ({ ordinal, type: entry.type, text: entry.texts.join("\n") }));
}

/**
 * 分段读的那一步的提示词：只交代这一段、只要这一段能核对上的要点。
 *
 * 条数在这里是建议，不是闸门——页面那一发按同一份合同收下或拒绝。
 */
function artifactCandidatePrompt(
  drivingQuestion: string,
  group: readonly ArtifactEvidenceBlockV1[],
  part: { index: number; total: number },
): string {
  return [
    `这篇笔记的正文超出当前模型一次能读的预算，所以按段来读。这是第 ${part.index + 1}/${part.total} 部分，只看这一部分，不要假装读过其他部分。`,
    `围绕这个问题，从这一部分里挑出值得在互动演示里讲清楚的知识过程：${drivingQuestion}`,
    "只返回 JSON，顶层只含 outline 数组；每条只含 title（24 字以内，讲一个动作而不是栏目名）、narration（200 字以内，说清这一步发生了什么）、evidenceOrdinal（逐字复制下方 blocks[].ordinal）、evidenceQuote（那一块里 160 字以内的逐字原句）。要点条数由这一部分的内容决定，能给几条真正不同的就给几条，宁少勿凑。",
    "同一块原文可以支撑多个要点。evidenceQuote 必须是这一部分里真实出现的句子，不能改写、补词或拼到别处；动画里的计算与读数是教学模拟，不要称为真实系统或阅读的实测结果。",
    JSON.stringify({ blocks: group.map((block) => ({ ordinal: block.ordinal, type: block.type, text: plainTextForGroundingV1(block.text) })) }),
  ].join("\n");
}

/**
 * 两段式：先用思考把"讲哪几步、这些步骤之间是什么关系"定下来（输出小），
 * 再用不带思考的一发把整页 HTML 写出来（输出大）。
 *
 * 为什么不是单发关思考：2026-10-19 真实模型实测单发整页在默认思考档要 668 s，
 * 有一次 900 s 直接超时；整发关思考只要 232 s，但独立评审（DeepSeek-V3）在同一篇
 * 笔记上给出 teaching 4 分，而带思考那版是 5 分——差别正好落在"把关系讲清楚"，
 * 也就是这一步真正需要推理的地方。把推理放回规划、把长文书写留给渲染，可以同时
 * 拿到"讲得对"和"等得起"：规划那一发的输出只有几百 token，整页书写仍然关思考。
 */
function artifactPlanPrompt(input: { drivingQuestion: string; blocks: readonly ArtifactEvidenceBlockV1[]; explanation: string }): string {
  return [
    `围绕这个问题，为这篇笔记策划一份互动演示：${input.drivingQuestion}`,
    "只依据下面的原文块，不要添加原文没有的事实；动画里的计算与读数只能写成教学模拟或示意值。",
    "先决定演示要讲哪几步（2-6 步，按理解顺序推进），每一步都要能指回一个原文块，并在 narration 里说清这一步和前后步骤的关系（因果、条件或对比），不要复述原句。",
    "只返回 JSON：title（1-40 字）、subject（1-60 字）、caution（1-120 字，说明哪些是示意值或边界）、outline 数组，每条只含 title（1-24 字且互不相同）、narration（1-200 字）、evidenceOrdinal（数字，逐字复制 blocks[].ordinal）、evidenceQuote（该块里 1-160 字的逐字原句）。",
    JSON.stringify({ drivingQuestion: input.drivingQuestion, explanation: input.explanation,
      blocks: input.blocks.map((block) => ({ ordinal: block.ordinal, type: block.type, text: plainTextForGroundingV1(block.text) })) }),
  ].join("\n");
}

function artifactDocumentPrompt(input: { drivingQuestion: string; blocks: readonly ArtifactEvidenceBlockV1[]; explanation: string }, planned: unknown): string {
  return [
    `按已经核定的演示大纲，为这篇笔记写一份可在笔记里直接展示的交互讲解页面：${input.drivingQuestion}`,
    "只依据下面的原文与大纲，不添加原文没有的事实，也不要改动大纲的步骤顺序与含义；读数只能写成教学模拟或示意值。",
    "document 是一段自包含的 HTML 片段（不要 <html>/<head>/<body> 外壳）：用内联 <style> 定义样式，使用 var(--lesson-*) 主题色；可含 <svg> 与内联 <script>；交互要能用鼠标/触屏点按，支持 prefers-reduced-motion；不要外部资源、不要 fetch、不要 eval。",
    "只返回 JSON：{document: string}。",
    JSON.stringify({ drivingQuestion: input.drivingQuestion, explanation: input.explanation,
      blocks: input.blocks.map((block) => ({ ordinal: block.ordinal, type: block.type, text: plainTextForGroundingV1(block.text) })),
      plannedOutline: planned }),
  ].join("\n");
}

function jsonArtifactProvider(
  provider: ReturnType<typeof createGovernedProvider>,
  job: JobPayload,
  context: Awaited<ReturnType<typeof loadAgentGenerationContext>>,
  /** 这一次能说多少：由调用方按这一档模型档案声明取好，这里不再自己数一个数。 */
  maxOutputTokens: number,
): DynamicArtifactProviderV1 {
  const session = createDynamicArtifactResponseSessionV1();
  return async (input, step) => {
    try {
      if (job.signal?.aborted) return { ok: false, class: "cancelled", message: "动态演示任务已取消" };
      if (!(await isJobLeaseActive(job))) {
        return { ok: false, class: "lease_lost", message: "动态演示 worker 已失去任务租约" };
      }
      // 第一发：规划（沿用这一档的思考设置）。输出只有大纲，思考成本小。
      await context.reserveModelCall();
      const plannedResult = await provider.chatCompletion(
        [{ role: "system", content: context.instructions }, { role: "user", content: artifactPlanPrompt(input) }],
        { temperature: 0.4, maxTokens: Math.min(maxOutputTokens, 6_000), responseFormat: "json_object" },
        step.signal,
      );
      let plannedRaw: unknown;
      try { plannedRaw = extractJsonFromText(plannedResult.content, ["title", "subject", "caution", "outline"]); } catch {
        return { ok: false, class: "output_shape", message: "动态页面大纲返回的 JSON 不完整" };
      }
      // 只取合同允许的字段：模型多写的键会让整份页面在验收时变成 unrecognized_keys，
      // 而那已经是第二发之后了——在这里就按大纲合同收口，别把多余的键带下去。
      const plannedParsed = dynamicArtifactDocV1Schema.omit({ document: true }).safeParse(plannedRaw);
      if (!plannedParsed.success) {
        return { ok: false, class: "output_shape",
          message: `动态页面大纲不符合约定（${plannedParsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "root"}:${issue.code}`).join(", ")}）` };
      }
      const planned = plannedParsed.data;
      // 第二发：整页书写（关思考）。长文输出不再等待推理。
      await context.reserveModelCall();
      const documentResult = await provider.chatCompletion(
        [{ role: "system", content: context.instructions }, { role: "user", content: artifactDocumentPrompt(input, planned) }],
        { temperature: 0.4, maxTokens: maxOutputTokens, responseFormat: "json_object", disableThinking: true },
        step.signal,
      );
      let page: unknown;
      try { page = extractJsonFromText(documentResult.content, ["document"]); } catch {
        return { ok: false, class: "output_shape", message: "动态页面正文返回的 JSON 不完整" };
      }
      const document = (page as { document?: unknown }).document;
      const merged = { ...planned, document };
      // 仍然走生产会话的验收：字段合同、原文回查、页面安全检查都在这里，不因拆成两发而放宽。
      const accepted = session.accept(merged, input);
      if (!accepted.ok) return accepted;
      const promptTokens = (plannedResult.usage?.promptTokens ?? 0) + (documentResult.usage?.promptTokens ?? 0);
      const completionTokens = (plannedResult.usage?.completionTokens ?? 0) + (documentResult.usage?.completionTokens ?? 0);
      return {
        ok: true,
        output: accepted.output,
        promptTokens: promptTokens || undefined,
        completionTokens: completionTokens || undefined,
      };
    } catch (error) {
      // 网关把"写到一半没了"作为异常抛出。按 transport 记账会让人以为是被网络打断；
      // 它是内容没写完，归到 output_shape，重跑由任务预算数着（至多三次）。
      if (error instanceof AgentOutputError && error.code === "output_truncated") {
        return { ok: false, class: "output_shape", message: "动态页面写到一半被输出上限截断" };
      }
      const failure = classifyThrownAsStepFailure(error);
      return { ok: false, class: failure.class, message: failure.message };
    }
  };
}

export async function runNoteDynamicArtifactGenerate(job: JobPayload): Promise<void> {
  const input = readNoteDynamicArtifactGenerateJobPayload(job.payload);
  if (!job.requestedBy) throw new NoteDynamicArtifactOutputError("动态讲解任务缺少发起人");
  await assertJobLease(job);

  const existing = await withJobTransaction(job, (tx) => tx.query.noteLearningArtifacts.findFirst({
    where: and(eq(schema.noteLearningArtifacts.workspaceId, job.workspaceId), eq(schema.noteLearningArtifacts.generationJobId, job.id)),
  }));
  if (existing) return;

  const frozen = await readFrozenInput(job, input);
  const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy);
  if (!governance.consentOk) throw new AIConsentRequiredError();
  const selected = resolveProviderForTask(governance, "note_dynamic_artifact");
  const provider = createGovernedProvider(
    createProvider(selected.providerName, selected.providerConfig),
    governance,
    job.workspaceId,
    { userId: job.requestedBy, operation: "note_dynamic_artifact", jobId: job.id, dataCategories: ["note_content"] },
  );
  const drivingQuestion = input.sourceKind === "annotation"
    ? `请围绕选中的原句，用更直观、有趣或容易理解的方式做一份互动演示：${input.anchor!.excerpt}`
    : "请用一份为这篇笔记专门设计的互动演示，帮助第一次接触的人快速看懂核心内容。";
  const verifyAttempt = async (attempt: AiAttemptToken) => (
    attempt.workspaceId === job.workspaceId
      && attempt.userId === job.requestedBy
      && attempt.leaseToken === job.leaseToken
      && isJobLeaseActive(job)
  );
  const agentContext = await loadAgentGenerationContext(job);
  const requestParameters = {
    temperature: 0.4,
    // 输出额度取这一档档案声明的那一个（整页 HTML 轻易上万 token，写死的小数字只会截断）。
    maxTokens: provider.resolveOutputTokenLimit?.() ?? AI_UNDECLARED_OUTPUT_TOKENS,
    responseFormat: "json_object" as const,
  };
  const pageMessages = (blocks: readonly ArtifactEvidenceBlockV1[]): ChatMessage[] => [
    { role: "system", content: agentContext.instructions },
    { role: "user", content: buildDynamicArtifactPrompt({ drivingQuestion, blocks, explanation: "" }) },
  ];
  const candidateMessages = (group: readonly ArtifactEvidenceBlockV1[], index: number, total: number): ChatMessage[] => [
    { role: "system", content: agentContext.instructions },
    { role: "user", content: artifactCandidatePrompt(drivingQuestion, group, { index, total }) },
  ];
  // 起点仍是整篇一次读完：窗口装得下的笔记还是原来那一发整页，不预先切碎材料。
  let lastOverflow: AIContextOverflowError | null = null;
  const { chunks } = await planCoveringChunks({
    build: (pieceChars) => buildArtifactChunks(frozen.blocks, pieceChars),
    fits: async (planned) => {
      const requests = planned.length === 1 ? [pageMessages(frozen.blocks)] : planned.map((group, index) => candidateMessages(group, index, planned.length));
      for (const request of requests) {
        try {
          await governContextPressure({
            provider,
            operation: "note_dynamic_artifact",
            requestedOutputTokens: requestParameters.maxTokens,
            measure: (ports) => measureChatRequest(request, requestParameters, ports),
          });
        } catch (error) {
          if (!(error instanceof AIContextOverflowError)) throw error;
          lastOverflow = error;
          return false;
        }
      }
      return true;
    },
    overflow: () => lastOverflow ?? new NoteDynamicArtifactOutputError("当前模型的上下文预算连一小段完整正文都装不下，这份演示没有可读的材料"),
  });

  /**
   * 分段读的那一步：只看这一段，交回这一段能逐字核对的知识过程要点。
   *
   * 引句只在**这一段**里核对，所以合起来不会把 A 段的句子安到 B 段上；核不上的那一条
   * 是编的依据，丢掉它，不改写也不补。
   */
  async function readArtifactCandidates(group: readonly ArtifactEvidenceBlockV1[], index: number, total: number): Promise<ArtifactStepDraftV1[]> {
    const messages = candidateMessages(group, index, total);
    const hash = noteLearningSnapshotHash({
      taskVersion: 1,
      noteVersionId: input.noteVersionId,
      sourceContentHash: frozen.contentHash,
      part: { index, total },
      blocks: group,
      modelId: provider.modelId,
      promptVersion: provider.promptVersion,
      generationParameters: requestParameters,
      messages,
    });
    const parsed = await runWorkerAiTask({
      job,
      userId: job.requestedBy!,
      taskId: "note_dynamic_artifact_candidate",
      taskVersion: 1,
      idempotencyKey: `note-dynamic-artifact:${job.id}:part-${index}:${hash}`,
      inputSnapshotRef: { kind: "note_version", id: input.noteVersionId, hash },
      input: messages,
      modelId: provider.modelId,
      promptVersion: `${provider.promptVersion}:artifact-candidate-v1`,
      resourceClass: "interactive_ai",
      timeoutMs: resolveProviderCallTimeout("note_dynamic_artifact_generate"),
      isOutputShapeError: (error) => error instanceof NoteDynamicArtifactOutputError,
      execute: async (request, signal) => {
        if (job.signal?.aborted) throw new JobLeaseLostError(job.id, "aborted");
        if (!(await isJobLeaseActive(job))) throw new JobLeaseLostError(job.id, "inactive");
        await agentContext.reserveModelCall();
        const response = await provider.chatCompletion(request, requestParameters, signal);
        let value: unknown;
        try { value = extractJsonFromText(response.content, ["outline"]); } catch {
          throw new NoteDynamicArtifactOutputError("分段读出的要点不是可核对的结构化内容");
        }
        const result = artifactCandidateSchema.safeParse(value);
        if (!result.success) throw new NoteDynamicArtifactOutputError("分段读出的要点缺少原文依据");
        return {
          ok: true,
          output: result.data,
          promptTokens: response.usage?.promptTokens ?? undefined,
          completionTokens: response.usage?.completionTokens ?? undefined,
        };
      },
    });
    const textByOrdinal = new Map<number, string>();
    for (const block of group) textByOrdinal.set(block.ordinal, `${textByOrdinal.get(block.ordinal) ?? ""}${block.text}`);
    const kept: ArtifactStepDraftV1[] = [];
    for (const step of parsed.outline) {
      const text = textByOrdinal.get(step.evidenceOrdinal);
      if (!text || !evidenceQuoteMatchesBlockV1(text, step.evidenceQuote)) {
        logger.warn({ jobId: job.id, part: index, evidenceOrdinal: step.evidenceOrdinal }, "artifact candidate quote is not in this part");
        continue;
      }
      kept.push(step);
    }
    return kept;
  }

  let materialBlocks = frozen.blocks;
  if (chunks.length > 1) {
    const steps: ArtifactStepDraftV1[] = [];
    // 批次只数同时读几段，每一段都会读完。
    for (let start = 0; start < chunks.length; start += PROVIDER_CALL_BATCH) {
      const batch = chunks.slice(start, start + PROVIDER_CALL_BATCH);
      const settled = await Promise.all(batch.map((group, offset) => readArtifactCandidates(group, start + offset, chunks.length)));
      steps.push(...settled.flat());
    }
    if (steps.length === 0) throw new NoteDynamicArtifactOutputError("这篇笔记的各段都没有给出能与原文核对得上的要点");
    materialBlocks = artifactEvidenceBlocks(steps, frozen.blocks);
  }
  const result = await runDynamicArtifactV1({
    provider: jsonArtifactProvider(provider, job, agentContext, requestParameters.maxTokens),
    modelId: provider.modelId,
    // 调用预算由共享任务定义那一份声明（一发整页 + 至多三次截断重发 + 一发字段修复）。
    // 内核先结束，再留出安全核对与落库的时间；运行中由 Worker 持续续租。
    maxDurationMs: resolveNoteDynamicArtifactBudget().loopDeadlineMs,
    input: {
      drivingQuestion,
      blocks: materialBlocks,
      explanation: "",
    },
    scope: { workspaceId: job.workspaceId, userId: job.requestedBy },
    source: {
      idempotencyKey: `note:${input.noteId}:dynamic-artifact:${input.requestId}`,
      leaseToken: job.leaseToken,
      noteVersionId: input.noteVersionId,
      sourceContentHash: frozen.contentHash,
    },
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt,
    signal: job.signal,
    attemptId: job.id,
  });
  if (!result.ok) {
    if (result.failureClass === "lease_lost") throw new JobLeaseLostError(job.id, "inactive");
    if (result.failureClass === "cancelled" || job.signal?.aborted) throw new JobLeaseLostError(job.id, "aborted");
    if (result.failure === "contract_rejected") throw new NoteDynamicArtifactOutputError(result.detail);
    throw new NoteDynamicArtifactAttemptExhaustedError(result.detail);
  }

  const grounded = groundArtifactStepsV1({ steps: result.doc.outline, blocks: frozen.blocks });
  if (!grounded.ok) {
    logger.warn({ jobId: job.id, stage: "evidence", reason: "insufficient_grounding" }, "note dynamic artifact rejected");
    throw new NoteDynamicArtifactOutputError("动态演示没有足够的笔记原文依据");
  }
  const documentCheck = checkArtifactDocumentV1({ document: result.doc.document });
  if (!documentCheck.ok) {
    // Only the bounded rule category is logged; the rejected page may contain
    // note text, URLs or script literals and must stay out of operational logs.
    const violation = documentCheck.verdict.violation;
    logger.warn({ jobId: job.id, stage: "document", reason: violation?.reason, rule: violation?.rule }, "note dynamic artifact rejected");
    throw new NoteDynamicArtifactOutputError(`动态演示页面没有通过安全检查（${violation?.rule ?? violation?.reason ?? "unknown"}）`);
  }
  const generatorRef = `${DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1} (${provider.modelId})`;
  const rendered = buildDynamicArtifactHtmlV1({
    doc: result.doc,
    nodes: grounded.nodes,
    snapshotHash: frozen.contentHash,
    generatorRef,
  });
  if (!rendered.ok) {
    logger.warn({ jobId: job.id, stage: "render", reason: rendered.reason }, "note dynamic artifact rejected");
    throw new NoteDynamicArtifactOutputError("动态演示页面整理失败");
  }

  await withJobTransaction(job, async (tx) => {
    await lockJobLease(tx, job);
    const [visible] = await tx.select({ versionNo: schema.noteVersions.versionNo, contentHash: schema.noteVersions.contentHash })
      .from(schema.notes).innerJoin(schema.noteVersions, and(
        eq(schema.noteVersions.noteId, schema.notes.id),
        eq(schema.noteVersions.workspaceId, job.workspaceId),
      )).where(and(
        eq(schema.notes.id, input.noteId),
        eq(schema.notes.workspaceId, job.workspaceId),
        isNull(schema.notes.deletedAt),
        visibleNoteCondition,
        eq(schema.noteVersions.id, input.noteVersionId),
      )).limit(1);
    if (!visible || visible.contentHash !== frozen.contentHash) {
      throw new NoteDynamicArtifactOutputError("笔记原文发生变化，互动演示没有保存");
    }
    const saved = await tx.query.noteLearningArtifacts.findFirst({
      where: and(eq(schema.noteLearningArtifacts.workspaceId, job.workspaceId), eq(schema.noteLearningArtifacts.generationJobId, job.id)),
    });
    if (saved) return;
    await tx.insert(schema.noteLearningArtifacts).values({
      workspaceId: job.workspaceId,
      userId: job.requestedBy!,
      noteId: input.noteId,
      noteVersionId: input.noteVersionId,
      requestId: input.requestId,
      generationJobId: job.id,
      sourceMessageId: null,
      conversationId: null,
      sourceKind: input.sourceKind,
      selectionText: input.anchor?.excerpt ?? null,
      selectionAnchor: input.anchor ?? null,
      sourceContentHash: frozen.contentHash,
      generatorRef,
      title: result.doc.title,
      subject: result.doc.subject,
      caution: result.doc.caution,
      outline: grounded.nodes,
      html: rendered.html,
    }).onConflictDoNothing();
  });
}

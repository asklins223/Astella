import { and, eq, isNull, sql } from "drizzle-orm";
import { classifyThrownAsStepFailure, type AiAttemptToken } from "@ailearn/shared/ai-task-kernel";
import { readNoteDynamicArtifactGenerateJobPayload } from "@ailearn/shared/job-payload-contracts";
import { loadAgentGenerationContext } from "../agent/generation-context.ts";
import { noteVisibleSqlText } from "@ailearn/shared/note-visibility";
import { noteBlockRenderedTextV1 } from "@ailearn/shared/note-doc-schema";
import { noteAnchorMatchesV1 } from "@ailearn/shared/note-annotation-contracts";
import * as schema from "@ailearn/shared/db-schema";
import {
  buildDynamicArtifactPrompt,
  dynamicArtifactDocV1Schema,
  runDynamicArtifactV1,
  ARTIFACT_COMPLETION_TOKENS_V1,
  type DynamicArtifactProviderV1,
} from "@ailearn/shared/note-dynamic-artifact/round-artifact-model";
import { checkArtifactDocumentV1 } from "@ailearn/shared/note-dynamic-artifact/round-artifact-doc";
import {
  groundArtifactStepsV1,
  plainTextForGroundingV1,
  type ArtifactEvidenceBlockV1,
} from "@ailearn/shared/note-dynamic-artifact/round-artifact-measure";
import {
  buildDynamicArtifactHtmlV1,
  DYNAMIC_ARTIFACT_GENERATOR_VERSION_V1,
} from "@ailearn/shared/note-dynamic-artifact/round-artifact-render";
import {
  AIConsentRequiredError,
  createGovernedProvider,
  resolveAIGovernanceContext,
  resolveProviderForTask,
} from "../lib/governance.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import { assertJobLease, isJobLeaseActive, JobLeaseLostError, lockJobLease, withJobTransaction } from "../lib/job-lease.ts";
import { NoteDynamicArtifactOutputError, NoteDynamicArtifactAttemptExhaustedError } from "../lib/non-retryable-errors.ts";
import { logger } from "../lib/logger.ts";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { resolveNoteDynamicArtifactBudget } from "../lib/handler-timeout-config.ts";
import type { JobPayload } from "./index.ts";

const visibleNoteCondition = sql.raw(noteVisibleSqlText(
  "notes",
  "NULLIF(current_setting('app.user_id', true), '')::uuid",
));
const MAX_ARTIFACT_SOURCE_CHARS = 24_000;

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
      if (charCount > MAX_ARTIFACT_SOURCE_CHARS) throw new NoteDynamicArtifactOutputError("笔记较长，请先选中一小段再做互动演示");
    }
    return { versionNo: frozen.versionNo, contentHash: frozen.contentHash, blocks, currentVersionId: frozen.currentVersionId };
  });
}

function jsonArtifactProvider(provider: ReturnType<typeof createGovernedProvider>, job: JobPayload, context: Awaited<ReturnType<typeof loadAgentGenerationContext>>): DynamicArtifactProviderV1 {
  return async (input, step) => {
    try {
      if (job.signal?.aborted) return { ok: false, class: "cancelled", message: "动态演示任务已取消" };
      if (!(await isJobLeaseActive(job))) {
        return { ok: false, class: "lease_lost", message: "动态演示 worker 已失去任务租约" };
      }
      await context.reserveModelCall();
      const result = await provider.chatCompletion(
        [{ role: "system", content: context.instructions }, { role: "user", content: buildDynamicArtifactPrompt(input) }],
        { temperature: 0.4, maxTokens: ARTIFACT_COMPLETION_TOKENS_V1, responseFormat: "json_object", disableThinking: true },
        step.signal,
      );
      let parsed: unknown;
      try { parsed = extractJsonFromText(result.content, ["title", "subject", "caution", "document", "outline"]); } catch {
        return { ok: false, class: "output_shape", message: "动态页面返回的 JSON 不完整" };
      }
      const document = dynamicArtifactDocV1Schema.safeParse(parsed);
      if (!document.success) {
        const fields = document.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "root"}:${issue.code}`).join(", ");
        const rawOutline = parsed && typeof parsed === "object" && "outline" in parsed ? parsed.outline : null;
        const firstOutline = Array.isArray(rawOutline) ? rawOutline[0] : null;
        const outlineKeys = firstOutline && typeof firstOutline === "object" ? Object.keys(firstOutline).join("|") : "none";
        return { ok: false, class: "output_shape", message: `动态页面不符合输出约定（${fields}; outlineKeys=${outlineKeys}）` };
      }
      return {
        ok: true,
        output: document.data,
        promptTokens: result.usage?.promptTokens ?? undefined,
        completionTokens: result.usage?.completionTokens ?? undefined,
      };
    } catch (error) {
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
  const result = await runDynamicArtifactV1({
    provider: jsonArtifactProvider(provider, job, await loadAgentGenerationContext(job)),
    modelId: provider.modelId,
    maxModelCalls: 2,
    // 内核先结束，再留出安全核对与落库的时间；不要让共享内核的 210s
    // 默认值越过 Worker 的 120s 租约，被外层杀掉后重新计费整轮。
    maxDurationMs: resolveNoteDynamicArtifactBudget().loopDeadlineMs,
    input: {
      drivingQuestion,
      blocks: frozen.blocks,
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
    logger.warn({ jobId: job.id, stage: "document", reason: documentCheck.verdict.violation?.reason }, "note dynamic artifact rejected");
    throw new NoteDynamicArtifactOutputError("动态演示页面没有通过安全检查");
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

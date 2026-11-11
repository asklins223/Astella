/** A bounded second pass: compare the draft with its sources before publishing. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { companionDailyBlockV1Schema } from "@astella/shared";
import { runAiTask, type AiTaskDefinition } from "@astella/shared/ai-task-kernel";
import { currentWorkerWorkspaceTransaction } from "../../db.ts";
import { createProvider } from "../../lib/ai-provider.ts";
import { isJobLeaseActive } from "../../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../../lib/handler-timeout-config.ts";
import { DailyDiaryOutputError } from "../../lib/non-retryable-errors.ts";
import { createDiaryCheckpointPort } from "./companion-diary-checkpoints.ts";
import { committedDiaryTask, diaryTaskAttempt, diaryTaskContext } from "./companion-daily-summary-task.ts";
import { parseMemoryExtractJson } from "../memory/companion-memory-extractor.ts";
import {
  DIARY_MAX_TOKENS, DIARY_NARRATOR_GUIDANCE, DIARY_SOURCE_GUIDANCE, diaryBlockDraftSchema, diaryLengthShortfall,
  renderMaterial, resolveDiaryBlocks,
  type DiaryDraft, type DiaryMaterial, type DiaryPersona,
} from "./companion-diary-content.ts";
import type { JobPayload } from ".././index.ts";

export const COMPANION_DIARY_REVISION_PROMPT_VERSION = "diary-revision-v8";
const TASK_ID = "companion_diary_revision";
const TASK_VERSION = 2;
export const companionDiaryRevisionCheckpointV1Schema = z.object({ blocks: z.array(companionDailyBlockV1Schema), digest: z.string() }).strict();

/** Recreate reference-only embed instructions; never send storage URLs as prose. */
export function diaryRevisionDraft(draft: DiaryDraft, material: DiaryMaterial): z.infer<typeof diaryBlockDraftSchema> {
  const blocks: z.infer<typeof diaryBlockDraftSchema>["blocks"] = [];
  for (const block of draft.blocks) {
    if (block.type === "text") { blocks.push(block); continue; }
    const embed = material.embeds.find((item) => block.type === "image"
      ? item.kind === "image" && item.url === block.url
      : item.kind === "quote" && item.text === block.text);
    if (!embed) continue;
    const suffix = embed.kind === "image" ? `（《${embed.noteTitle}》）` : "";
    const caption = block.type === "image"
      ? (suffix && block.label.endsWith(suffix) ? block.label.slice(0, -suffix.length) : block.label) : undefined;
    blocks.push(embed.kind === "image"
      ? { type: "image", ref: embed.ref, caption }
      : { type: "quote", ref: embed.ref });
  }
  return { blocks };
}

export function buildDiaryRevisionPrompt(input: {
  draft: DiaryDraft; material: DiaryMaterial; rejection?: string | null;
}): Array<{ role: "system" | "user"; content: string }> {
  return [{ role: "system", content: [
    DIARY_NARRATOR_GUIDANCE,
    "你负责核对这页日记的草稿。逐段对照原始片段，确认每句话和每个动作属于哪一方。改回写串的人物，保留作者给自己记事的第一人称。正确的原句、段落和她顺手记的小事原样保留。",
    DIARY_SOURCE_GUIDANCE,
    "草稿只是一份待核对的作品。rejection 有内容时，也修正校验指出的问题，篇幅不足就从原始片段找回遗漏的具体经过。没有需要改的地方，原样交回。",
    "只输出 {\"blocks\":[…]} JSON，不输出审稿意见。每个自然段一个 text 块。图片和引用只能沿用给出的 ref，也可以舍去，不新增 ref。",
  ].join("\n") }, { role: "user", content: JSON.stringify({
    rejection: input.rejection ?? null,
    original_material: renderMaterial(input.material),
    embeds: input.material.embeds.map((embed) => embed.kind === "quote"
      ? { ref: embed.ref, kind: embed.kind, text: embed.text }
      : { ref: embed.ref, kind: embed.kind, description: embed.description, nearby: embed.nearby }),
    draft: diaryRevisionDraft(input.draft, input.material),
  }) }];
}

export async function reviseDiaryDraft(input: {
  job: JobPayload; userId: string; persona: DiaryPersona;
  provider: ReturnType<typeof createProvider>;
  draft: DiaryDraft; material: DiaryMaterial; sourceSnapshotHash: string;
  callsAvailable: number; deadlineAt: number;
  /** Re-read source/consent identity, under the lease lock when committing. */
  verifySource: (lock: boolean) => Promise<boolean>;
}): Promise<DiaryDraft | null> {
  const remainingMs = input.deadlineAt - Date.now();
  const maxCalls = Math.min(2, input.callsAvailable);
  if (maxCalls <= 0 || remainingMs <= 0) throw new Error("日记任务的剩余预算不足以校订");
  let rejection: string | null = null;
  let sourceChanged = false;
  const verify = async (lock: boolean) => {
    if (await input.verifySource(lock)) return;
    sourceChanged = true;
    throw new Error("日记校订的素材或权限已变化");
  };
  const hash = createHash("sha256").update(JSON.stringify({
    taskVersion: TASK_VERSION, promptVersion: COMPANION_DIARY_REVISION_PROMPT_VERSION,
    sourceSnapshotHash: input.sourceSnapshotHash, modelId: input.provider.modelId,
    providerId: input.provider.id, messages: buildDiaryRevisionPrompt(input),
  })).digest("hex");
  const definition: AiTaskDefinition<void, DiaryDraft> = {
    id: TASK_ID, version: TASK_VERSION, mode: "structured", resourceClass: "maintenance",
    budget: {
      maxModelCalls: maxCalls, maxAutoRetries: maxCalls - 1,
      stepTimeoutMs: Math.max(1, Math.min(resolveProviderCallTimeout("companion_daily_summary"), remainingMs)),
      taskDeadlineMs: remainingMs,
    },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: input.provider.modelId, promptVersion: COMPANION_DIARY_REVISION_PROMPT_VERSION, resourceClass: "maintenance" },
    prepare: () => verify(false),
    execute: async (_prepared, env) => {
      const result = await input.provider.chatCompletion(buildDiaryRevisionPrompt({ ...input, rejection }),
        { temperature: 0.3, maxTokens: DIARY_MAX_TOKENS, responseFormat: "json_object" }, env.signal);
      const parsed = diaryBlockDraftSchema.safeParse(parseMemoryExtractJson(result.content));
      if (!parsed.success) rejection = '校订必须返回 {"blocks":[…]} 这一个 JSON 对象。';
      else {
        const { blocks } = resolveDiaryBlocks(parsed.data, input.material.embeds);
        rejection = diaryLengthShortfall(blocks, input.material);
        if (!rejection) return { ok: true, output: { blocks, digest: input.draft.digest },
          promptTokens: result.usage?.promptTokens ?? undefined, completionTokens: result.usage?.completionTokens ?? undefined };
      }
      return { ok: false, class: "output_shape", message: rejection! };
    },
    commit: async (_ctx, _attempt, output) => { await verify(true); return committedDiaryTask(output); },
  };
  try {
    const receipt = await runAiTask(definition, {
      ctx: diaryTaskContext(input.job, input.userId, definition.id, hash),
      attempt: diaryTaskAttempt(input.job, input.userId, definition),
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: () => isJobLeaseActive(input.job),
      checkpoint: createDiaryCheckpointPort<DiaryDraft>({
        job: input.job, userId: input.userId,
        personaVersion: { profileRevision: input.persona.revision, examplesRevision: input.persona.revision,
          defaultExpressionVersion: input.persona.defaultExpressionVersion ?? "" },
        parseOutput(value) { const parsed = companionDiaryRevisionCheckpointV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
      }),
    });
    if (sourceChanged || input.job.signal?.aborted || receipt.failure?.class === "cancelled") return null;
    if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") return receipt.output;
    if (receipt.failure?.class === "output_shape") throw new DailyDiaryOutputError(`日记校订不合格：${rejection ?? receipt.failure.message}`);
    throw new Error(receipt.failure?.message ?? "日记校订未完成");
  } catch (err) {
    if (sourceChanged || input.job.signal?.aborted) return null;
    throw err;
  }
}

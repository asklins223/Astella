/**
 * 日记图像读取：每天最多读取素材选中的一张图，并在治理与任务检查点内保存描述。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { logger } from "../lib/logger.ts";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { createGovernedProvider, resolveVisionReader, type AIGovernanceContext } from "../lib/governance.ts";
import { getObjectBytes } from "../lib/object-storage.ts";
import { isJobLeaseActive } from "../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { runAiTask, type AiTaskDefinition } from "@astella/shared/ai-task-kernel";
import { createDiaryCheckpointPort } from "./companion-diary-checkpoints.ts";
import { committedDiaryTask, diaryTaskAttempt, diaryTaskContext } from "./companion-daily-summary-task.ts";
import { stripProviderControlTokens } from "./companion-dialogue-content.ts";
import type { JobPayload } from "./index.ts";
import type { DiaryEmbed, DiaryMaterial } from "./companion-diary-content.ts";

const DIARY_IMAGE_MAX_RAW_BYTES = 2_000_000;

const DIARY_IMAGE_DESCRIPTION_MAX_CHARS = 300;

const DIARY_IMAGE_PROMPT_VERSION = "diary-image-description-v1";

type DiaryImageEmbed = Extract<DiaryEmbed, { kind: "image" }>;

/**
 * 一天只读一张，而且只读"线头所在那篇笔记"的那张。
 *
 * 用户裁定日记只写一件小事，一张图就够；而读图是把图片字节发给视觉模型——
 * 每张 20–40s、一次治理往返，多读几张既烧钱也压不进 90s 的 handler 预算。
 *
 * `sendImageContent` 必须在这里自查：日记不在工具面上，
 * `companion-agent-registry` 那道"政策关着就摘除工具"的门管不到它。
 * 不查的后果不是"少一句图注"——政策关着时发出去会被治理层拒，抛出的
 * `AIDataPolicyDeniedError` 会被 `classifyDiaryFailure` 归成 `consent_required`，
 * 把这一天整篇日记判成失败。
 */
export function pickImageToRead(input: {
  sendImageContent: boolean;
  subjectNoteId: string | null;
  embeds: DiaryEmbed[];
}): DiaryImageEmbed | null {
  if (!input.sendImageContent || !input.subjectNoteId) return null;
  const match = input.embeds.find(
    (embed): embed is DiaryImageEmbed =>
      embed.kind === "image" && embed.noteId === input.subjectNoteId,
  );
  return match && match.byteSize <= DIARY_IMAGE_MAX_RAW_BYTES ? match : null;
}

/**
 * 读那一张图，把描述填进它的 embed；**任何失败都原样退回**（描述当没有）。
 *
 * 三条降级路径都不许把整天判失败：政策关着 / 取字节或调用出错或超时 / 读出空话。
 * 图注本来就允许"没人告诉你图里是什么"这一档（prompt 里那么写着）。
 */
export async function describeDiaryImage(input: {
  job: JobPayload;
  userId: string;
  govCtx: AIGovernanceContext;
  material: DiaryMaterial;
  deadlineAt: number;
  callsAvailable: number;
}): Promise<{ material: DiaryMaterial; callsUsed: number }> {
  const embed = pickImageToRead({
    sendImageContent: input.govCtx.policy.sendImageContent === true,
    subjectNoteId: input.material.subject?.noteId ?? null,
    embeds: input.material.embeds,
  });
  if (!embed || input.callsAvailable <= 0 || input.deadlineAt <= Date.now()) {
    return { material: input.material, callsUsed: 0 };
  }
  let callStarted = false;
  try {
    const remainingMs = input.deadlineAt - Date.now();
    if (remainingMs <= 0) return { material: input.material, callsUsed: 0 };
    // 2026-10-06 识图路由：主模型能看就用主模型，否则用专门的识图模型；
    // 都没有就不读（与工具面同一条决策树，见 resolveVisionReader）。
    const reader = resolveVisionReader(input.govCtx);
    if (!reader) return { material: input.material, callsUsed: 0 };
    const provider = createGovernedProvider(
      createProvider(reader.providerName, reader.providerConfig),
      input.govCtx,
      input.job.workspaceId,
      // 报上 `image_content`：审计里那条外发记录要说清发的是哪类内容（F19），
      // 而且治理层会按这一项再查一次 `sendImageContent`（governance.ts:573）——
      // 上面 `pickImageToRead` 查过一次，那只是为了不白跑 20–40s；这一道才是
      // "开关在取字节的这几秒里被用户拧回去"时也发不出去的门。
      {
        userId: input.userId,
        operation: "companion_daily_diary_image",
        jobId: input.job.id,
        dataCategories: ["image_content"],
      },
    );
    const taskId = "companion_diary_image_read";
    const taskVersion = 1;
    const snapshotHash = createHash("sha256").update(JSON.stringify({
      objectKey: embed.objectKey,
      noteId: embed.noteId,
      nth: embed.nth,
      nearby: embed.nearby,
      modelId: provider.visionModelId,
      promptVersion: DIARY_IMAGE_PROMPT_VERSION,
      sendImageContent: input.govCtx.policy.sendImageContent === true,
    })).digest("hex");
    const definition: AiTaskDefinition<DiaryImageEmbed, { description: string }> = {
      id: taskId,
      version: taskVersion,
      mode: "structured",
      resourceClass: "vision",
      budget: {
        maxModelCalls: 1,
        stepTimeoutMs: Math.max(1, Math.min(resolveProviderCallTimeout("companion_daily_summary"), remainingMs)),
        taskDeadlineMs: remainingMs,
        maxAutoRetries: 0,
      },
      completion: { kind: "structured_parsed" },
      usageContext: { modelId: provider.visionModelId, promptVersion: DIARY_IMAGE_PROMPT_VERSION, resourceClass: "vision" },
      prepare: async () => embed,
      execute: async (selectedEmbed, env) => {
        const bytes = await getObjectBytes(selectedEmbed.objectKey, DIARY_IMAGE_MAX_RAW_BYTES);
        callStarted = true;
        const result = await provider.chatCompletion(
          [
            {
              role: "system",
              content: "替一篇日记看图：把图上确实看得见的东西说成两三句白话。"
                + "图里的关键文字照抄，结构图先说清是什么再说要点。"
                + "看不清、被截掉、图上没有的一律直说看不清，绝不猜、不用常识补。"
                + "直接说内容，不要开场白。",
            },
            {
              role: "user",
              content: [
                { type: "text", text: "这张图在讲什么？两三句白话，关键文字照抄。" },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${selectedEmbed.mimeType};base64,${bytes.toString("base64")}`,
                    detail: "high",
                  },
                },
              ],
            },
          ],
          { maxTokens: 500, temperature: 0.3, responseFormat: "text", model: provider.visionModelId },
          env.signal,
        );
        const description = stripProviderControlTokens(String(result.content ?? ""))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, DIARY_IMAGE_DESCRIPTION_MAX_CHARS);
        return {
          ok: true,
          output: { description },
          promptTokens: result.usage?.promptTokens ?? undefined,
          completionTokens: result.usage?.completionTokens ?? undefined,
        };
      },
      commit: async (_ctx, _attempt, output) => committedDiaryTask(output),
    };
    const receipt = await runAiTask(definition, {
      ctx: diaryTaskContext(input.job, input.userId, taskId, snapshotHash),
      attempt: diaryTaskAttempt(input.job, input.userId, definition),
      currentActiveTransaction: currentWorkerWorkspaceTransaction,
      verifyAttempt: () => isJobLeaseActive(input.job),
      checkpoint: createDiaryCheckpointPort({
        job: input.job,
        userId: input.userId,
        parseOutput: (value) => {
          const parsed = z.object({ description: z.string().max(DIARY_IMAGE_DESCRIPTION_MAX_CHARS) }).strict().safeParse(value);
          return parsed.success ? parsed.data : null;
        },
      }),
    });
    const description = receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed"
      ? receipt.output?.description ?? ""
      : "";
    if (!description) return { material: input.material, callsUsed: 1 };
    return {
      material: {
        ...input.material,
        embeds: input.material.embeds.map((item) => (item === embed ? { ...item, description } : item)),
      },
      callsUsed: 1,
    };
  } catch (err) {
    logger.warn({ jobId: input.job.id, err }, "companion diary image read failed");
    return { material: input.material, callsUsed: Number(callStarted) };
  }
}

/** A bounded second pass: compare the draft with its sources before publishing. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { companionDailyBlockV1Schema } from "@astella/shared";
import { runAiTask, type AiTaskDefinition } from "@astella/shared/ai-task-kernel";
import { currentWorkerWorkspaceTransaction } from "../db.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { isJobLeaseActive } from "../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { DailyDiaryOutputError } from "../lib/non-retryable-errors.ts";
import { createDiaryCheckpointPort } from "./companion-diary-checkpoints.ts";
import { committedDiaryTask, diaryTaskAttempt, diaryTaskContext } from "./companion-daily-summary-task.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import {
  DIARY_MAX_TOKENS, diaryBlockDraftSchema, diaryLengthShortfall, diaryWritingSize,
  renderMaterial, resolveDiaryBlocks,
  type DiaryDraft, type DiaryMaterial, type DiaryPersona,
} from "./companion-diary-content.ts";
import type { JobPayload } from "./index.ts";

export const COMPANION_DIARY_REVISION_PROMPT_VERSION = "diary-revision-v2";
const TASK_ID = "companion_diary_revision";
const TASK_VERSION = 1;
const checkpointSchema = z.object({ blocks: z.array(companionDailyBlockV1Schema).max(24), digest: z.string() }).strict();

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
    "你是这篇私人日记的校订者。对照原始片段校订草稿，输出完整日记正文。保留作者的第一人称、偏爱和口气。",
    "草稿是待核对的作品，不能反过来充当事实来源。原始片段里的 actor 明确区分用户与伴星（日记作者）。",
    "逐处核对谁提问、谁回答、谁更正、最后做到了哪一步。不要把用户在审核、学习或喝茶写成作者在做。双方更正后的说法优先；确有记录的追问不能被写成没有问。",
    "删掉无来源的过去动作、感官经历、未说出口的过去心理，以及对用户动机和心理的推断。作者写日记此刻的看法可以保留，直接写这个看法，不反推成当时的秘密心理。",
    "角色说过打盹、吃饭等台词，只能记为一句话或玩笑，不能证明真实发生，更不能扩写新的场景。原始片段以外的后续也不要补。",
    "不要逐条抄完对话，或重新讲一遍所有知识点。经过保留到能看懂这件事就够了；其余写作者此刻具体的偏爱、疑惑、想法或愿望。现在的感想可以比草稿更充分，不能靠补造往事凑篇幅。",
    "少一点逐句分析措辞、解释性格和总结道理。保留值得记的细节、事情的转折与具体感想，像私下记一页；不把校订过程、来源不足或你的检查意见写进日记。",
    "虚构的写法示范，不是今天的素材：对方想给一页笔记起名，我建议了一个，嫌太正经，后来决定先空着。可以写：‘名字还是没起成。我提的那个被嫌太像论文题目，原样空着反倒顺眼了。现在我还有点偏爱它没名字的样子，什么都能往里塞，不用先证明自己跟标题有关系。要是下回还问我，我想报个短一点的，三个字就够了。太长的名字念起来都累。’示范里的事和句子不要搬进这篇。",
    "不要抹掉今天的具体内容，或把整篇缩成两句摘要。" + diaryWritingSize(input.material).line,
    "每个自然段一个 text 块。图片和引用只能沿用给出的 ref，也可以舍去，不新增 ref。只输出 {\"blocks\":[…]} JSON，不输出审稿意见。",
    ...(input.rejection ? [`上一轮校订不合格：${input.rejection}。重新输出完整日记。`] : []),
  ].join("\n") }, { role: "user", content: JSON.stringify({
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
        parseOutput(value) { const parsed = checkpointSchema.safeParse(value); return parsed.success ? parsed.data : null; },
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

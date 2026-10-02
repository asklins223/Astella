/**
 * Orchestrator 模型生成接线（文档 16 §14.3 P8：记忆候选生成）。
 *
 * Run 结算后（Policy 允许）用真实 LLM（DashScope OpenAI-compatible，复用
 * ASSESSMENT_CRITIC_* 配置，key 同源 DASHSCOPE_API_KEY）生成分层记忆候选：
 * - learning_context：本 Run 的学习洞察（用户掌握/缺口，含来源引用）
 * - interaction_note：值得后续提醒的交互备注（可选，模型判定无需则缺省）
 *
 * 任何失败（无配置/网络/输出非法）静默降级返回空（确定性最小闭环照常），
 * 不阻塞 Run 结算事务；输出经 strict schema 校验，失败即弃。
 */

import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { postJsonToPublicEndpoint } from "@ailearn/shared/public-json-http";
import { runAiTask, type AiTaskDefinition } from "@ailearn/shared/ai-task-kernel";
import { resolveAssessmentCriticConfig } from "../../../lib/assessment-critic-config.ts";

/**
 * 记忆候选生成的单次调用预算（设计 P1-11，2026-09-15 审计）。
 *
 * 这是一次短 JSON 生成（输入是枚举 + 短文本，输出 ≤200 字），不是长文生成：
 * 8s 已远高于正常耗时。超时按既有 fail-open 语义返回 null，调用方走确定性模板。
 * 重点是把上界从"共享的 300s"压到与业务重要性相称的量级——该调用此前会最坏
 * 阻塞 run-processing tick 的串行链 5 分钟/条。
 */
const MEMORY_CANDIDATE_TIMEOUT_MS = 8_000;

/** 提示版本进 `usageContext` 与检查点键：换提示词必须让旧产物回放不了。 */
const MEMORY_CANDIDATE_PROMPT_VERSION = "memory-candidate-v1";
/** 输入快照的领域身份：一次 run 的结算摘要。跨 run 不复用。 */
const MEMORY_CANDIDATE_TASK_ID = "companion_memory_candidate";

/** 这一次生成归属谁，以及「当前作用域有没有活动事务」那一个读数。 */
export interface ProactiveGenerationScope {
  readonly workspaceId: string;
  readonly userId: string;
  /**
   * 必填（同 `siliconflow-asr` 的同名端口）。做成可选就等于让「忘记核对」成为
   * 一种能通过编译的形状——而这正是 41a 要挡的那件事。
   */
  readonly currentActiveTransaction: () => unknown;
}

export const memoryCandidateOutputSchema = z
  .object({
    learningContext: z
      .object({
        // §9.4/§25：写入端统一限制 ≤200 字。
        content: z.string().min(2).max(200),
        needsFollowup: z.boolean(),
      })
      .strict(),
    interactionNote: z
      .object({
        // §9.4/§25：写入端统一限制 ≤200 字。
        content: z.string().min(2).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface GeneratedMemoryCandidates {
  learningContext: string;
  interactionNote: string | null;
}

/**
 * 生成记忆候选（不抛错；失败返回 null 由调用方降级）。
 *
 * 2026-10-02：整条生成**接到 41a 的统一内核**上。此前它是一次裸
 * `postJsonToPublicEndpoint`：没有任务身份、没有预算、没有检查点、没有统一失败
 * 分类，也没有任何一次模型调用的用量读数——W3-2 那个出口闸只挡"在事务里发外部
 * 请求"，挡不住这些。
 *
 * **行为刻意不变**：仍然 fail-open 返回 null、仍然不自动重试
 * （`maxAutoRetries: 0`）。内核换进来的是边界与分类，不是"顺手多试一次"——
 * 这一发的下游是确定性模板，多花一次钱换来的只是同一句模板晚 8 秒。
 */
export async function generateMemoryCandidates(
  input: {
    outcome: string;
    trustOutcome: string;
    /** Plan 23 CS-05：从 Objective revision conceptLabel 取，不再用 legacy claim。 */
    keyPointClaim: string;
    scheduleImpact: string;
    /** 产生这份摘要的那一次 run（进输入快照身份与幂等键）。 */
    runId: string;
  },
  scope: ProactiveGenerationScope,
): Promise<GeneratedMemoryCandidates | null> {
  // 设计 P0-2（2026-09-15 审计）：收敛到单一解析点。此前用
  // `?? DASHSCOPE_API_KEY`，而 compose 注入的是空串（`${VAR:-}`）——空串不回退，
  // 于是未显式配置 key 时这里会静默 return null，个性化被无声关闭。
  const config = resolveAssessmentCriticConfig();
  if (!config) return null;
  const { url, key, model } = config;

  const prompt = [
    "你是学习伴星的记忆整理器。根据一次三分钟巩固的结果，输出 JSON：",
    `{"learningContext":{"content":"一句话学习洞察（用户掌握或缺口，中文，不含答案正文，不超过 200 字）","needsFollowup":true},"interactionNote":{"content":"值得后续提醒的交互备注（无则省略整个字段，不超过 200 字）"}}`,
    "输入：",
    `outcome=${input.outcome}`,
    `trustOutcome=${input.trustOutcome}`,
    `objectiveLabel=${input.keyPointClaim.slice(0, 200)}`,
    `scheduleImpact=${input.scheduleImpact}`,
    "只输出 JSON。",
  ].join("\n");

  const task: AiTaskDefinition<
    { url: string; key: string; model: string; prompt: string },
    GeneratedMemoryCandidates
  > = {
    id: MEMORY_CANDIDATE_TASK_ID,
    version: 1,
    mode: "structured",
    // 锦上添花的观察性生成，确定性最小闭环不依赖它 ⇒ 维护档，不占用户等待的名额
    // （D5 §3：交互反馈与后台批量分名额，靠的就是这一档）。
    resourceClass: "maintenance",
    budget: {
      maxModelCalls: 1,
      stepTimeoutMs: MEMORY_CANDIDATE_TIMEOUT_MS,
      taskDeadlineMs: MEMORY_CANDIDATE_TIMEOUT_MS,
      maxAutoRetries: 0,
    },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: model, promptVersion: MEMORY_CANDIDATE_PROMPT_VERSION, resourceClass: "maintenance" },
    prepare: async () => ({ url, key, model, prompt }),
    execute: async (prepared, step) => {
      let response: Awaited<ReturnType<typeof postJsonToPublicEndpoint>>;
      try {
        // 预算由内核的 `step.signal` 统一给（它已经是 min(stepTimeoutMs, 剩余预算)），
        // 这里不再自己 AbortSignal.timeout 一个数字——同一个预算只准有一个来源。
        response = await postJsonToPublicEndpoint(
          prepared.url,
          { Authorization: `Bearer ${prepared.key}`, "Content-Type": "application/json" },
          {
            model: prepared.model,
            messages: [
              { role: "system", content: "你是学习伴星的记忆整理器，输出严格 JSON。" },
              { role: "user", content: prepared.prompt },
            ],
            response_format: { type: "json_object" },
            stream: false,
          },
          step.signal,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return step.signal.aborted
          ? { ok: false as const, class: "timeout" as const, message: `记忆候选生成超时：${message}` }
          : { ok: false as const, class: "transport" as const, message: `记忆候选生成网络错误：${message}` };
      }
      const raw = extractJson(
        (response.body as { choices?: Array<{ message?: { content?: string } }> })
          ?.choices?.[0]?.message?.content ?? "",
      );
      if (!raw) return { ok: false as const, class: "output_shape" as const, message: "响应里没有可解析的 JSON" };
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (err) {
        return { ok: false as const, class: "output_shape" as const, message: `响应不是合法 JSON：${String(err)}` };
      }
      const parsed = memoryCandidateOutputSchema.safeParse(parsedJson);
      if (!parsed.success) {
        return { ok: false as const, class: "output_shape" as const, message: "记忆候选形状不合合同" };
      }
      return {
        ok: true as const,
        output: {
          learningContext: parsed.data.learningContext.content,
          interactionNote: parsed.data.interactionNote?.content ?? null,
        },
      };
    },
    // 恒等提交：记忆的 upsert 留在调用方那段独立短事务里（它要拿 scope 与 now）。
    // 搬进 `commit` 等于让公共层替业务写库——41a §3 明令禁止的那件事。
    commit: async (_ctx, _attempt, output) => ({
      outcome: "committed" as const,
      output,
      usage: { modelCalls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
      failure: null,
      preservedValidResult: false,
      resumedFromCheckpoint: false,
      modelCalls: 0,
    }),
  };

  try {
    const receipt = await runAiTask(task, {
      ctx: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        // 输入快照的身份就是这一份结算摘要：同一 run 的同一份摘要才允许命中检查点。
        inputSnapshotRef: { kind: "task", id: input.runId, hash: memoryCandidateInputHash(input) },
        permissionLevel: "server",
      },
      attempt: {
        taskId: task.id,
        taskVersion: task.version,
        attemptId: randomUUID(),
        leaseToken: `memory-candidate:${input.runId}`,
        idempotencyKey: `memory-candidate:${input.runId}`,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      },
      currentActiveTransaction: scope.currentActiveTransaction,
      reportDevelopmentError: (message) => process.stderr.write(`[dev-error] ${message}\n`),
    });
    return receipt.outcome === "committed" ? receipt.output : null;
  } catch {
    return null; // 任何失败静默降级（确定性最小闭环照常）。
  }
}

/**
 * 输入快照哈希：**哈希实际送进模型的那四段文本**，不是 runId。
 *
 * 判据是「同一份输入才允许复用旧结果」——同一个 runId 两次调用带着不同的
 * `outcome` / `objectiveLabel`，那是两次不同的输入，让它们共用一个检查点
 * 就是把上一次的话当成这一次的。
 */
function memoryCandidateInputHash(input: {
  outcome: string;
  trustOutcome: string;
  keyPointClaim: string;
  scheduleImpact: string;
}): string {
  return createHash("sha256")
    .update([input.outcome, input.trustOutcome, input.keyPointClaim.slice(0, 200), input.scheduleImpact].join(" "))
    .digest("hex");
}

function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

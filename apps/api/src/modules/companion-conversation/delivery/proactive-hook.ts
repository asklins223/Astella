/**
 * Orchestrator 最小接线（文档 16 §10.2/§14.3 P8 版）。
 *
 * Run 完成事件 → 确定性 Policy Engine 判定 → 通过后 durable deliver 入队
 * （kind=system_event、dedupeKey=run.completed:runId、TTL 有界）。同一事务
 * 内执行（与 Journey 推进一致：失败整体回滚由 outbox 命令重试）。
 */

import type { ApiTransaction } from "../../../db/client.ts";
import { createHash, randomUUID } from "node:crypto";
import { runAiTask, type AiTaskDefinition } from "@ailearn/shared/ai-task-kernel";
import type { postJsonToPublicEndpoint } from "@ailearn/shared/public-json-http";
import { resolveAssessmentCriticConfig } from "../../../lib/assessment-critic-config.ts";
import { sql } from "drizzle-orm";
import {
  evaluateTriggeredPush,
} from "@ailearn/shared/companion-proactive-policy";
import { deliver } from "./delivery-service.ts";

/** §11.5：个性化文案 2s 上界。它同时是内核的 stepTimeout 与 taskDeadline。 */
const PERSONALIZED_PROACTIVE_TIMEOUT_MS = 2_000;
const PERSONALIZED_PROACTIVE_TASK_ID = "companion_personalized_proactive_text";
const PERSONALIZED_PROACTIVE_PROMPT_VERSION = "personalized-proactive-v1";

// PERF-WN: Intl.DateTimeFormat 构造带时区数据，开销可观且每次调用都重建。
// 按 timezone 记忆化复用；时区来自账号设置（有限 IANA 集合），加容量上限
// 防不可信输入导致 Map 无界增长。
export interface ProactiveMemoryDeferInput {
  scope: { workspaceId: string; userId: string };
  runId: string;
  outcome: string;
  trustOutcome: string;
  keyPointClaim: string;
  scheduleImpact: string;
  now: Date;
  /** 22 方案 §9.7/§11.5：个性化文案延迟生成所需的记忆快照。 */
  topMemories?: string[];
}

/**
 * 事务提交后刷新延迟的 LLM 记忆候选（P8）。LLM 网络调用不持有任何 DB 连接：
 * 先生成候选，成功后在新事务里 upsert 记忆（失败静默降级，不影响确定性闭环）。
 */
export async function flushDeferredProactiveMemoryCandidates(
  defer: ProactiveMemoryDeferInput,
): Promise<void> {
  try {
    const { generateMemoryCandidates } = await import("./proactive-generator.ts");
    const { upsertMemory } = await import("../memory/memory-service.ts");
    const { withWorkspaceTransaction, currentApiWorkspaceTransaction } = await import("../../../db/client.ts");
    const generated = await generateMemoryCandidates(
      {
        outcome: defer.outcome,
        trustOutcome: defer.trustOutcome,
        keyPointClaim: defer.keyPointClaim,
        scheduleImpact: defer.scheduleImpact,
        runId: defer.runId,
      },
      // 边界读数用 API 那一份作用域读者：内核会在**发外部请求之前**核一次
      // 「当前作用域有没有活动事务」，把这发生成钉死在事务外
      // （本函数整段都在结算事务提交之后跑，正常情况下这道核是恒真的——
      // 恒真正是它该有的样子：它防的是将来有人把这段搬回事务里）。
      { ...defer.scope, currentActiveTransaction: currentApiWorkspaceTransaction },
    );
    if (!generated) return;
    const { scope } = defer;
    // upsert 在独立事务内执行（不再持有结算事务的连接）。
    await withWorkspaceTransaction(scope, async (tx) => {
      await upsertMemory(tx, scope, {
        kind: "learning_context",
        content: generated.learningContext,
        sourceEventId: `run.completed:${defer.runId}`,
        candidate: true,
      }, defer.now);
      if (generated.interactionNote) {
        await upsertMemory(tx, scope, {
          kind: "interaction_note",
          content: generated.interactionNote,
          sourceEventId: `run.completed:${defer.runId}:note`,
          candidate: true,
        }, defer.now);
      }
    });
  } catch (err) {
    // 生成/写入失败不阻塞确定性交付（fail-open 观察性降级）。
    const { logger } = await import("../../../lib/logger.ts");
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), runId: defer.runId },
      "memory candidate generation skipped",
    );
  }

  // 22 方案 §9.7/§11.5：个性化主动文案异步生成 + 2s 超时 + 回退模板。
  // delivery 已在事务内以模板文案入队；此处异步生成成功后更新 text 字段。
  // §11.5：同一提醒类型 24h 内最多个性化 1 次——通过检查最近 24h 是否已有
  // 个性化文案覆盖（payload_ref->>'text' 不等于模板文案）来控制频率。
  if (defer.topMemories && defer.topMemories.length > 0) {
    try {
      const { withWorkspaceTransaction, currentApiWorkspaceTransaction } = await import("../../../db/client.ts");
      const { sql } = await import("drizzle-orm");
      // §11.5 频率限制：检查最近 24h 是否已有个性化文案（text 被覆盖过）。
      let alreadyPersonalized = false;
      try {
        const personalizedCheck = await withWorkspaceTransaction(defer.scope, async (tx) => {
          const rows = await tx.execute<{ n: string }>(sql`
            SELECT count(*)::int AS n FROM assistant_deliveries
            WHERE workspace_id = ${defer.scope.workspaceId}
              AND user_id = ${defer.scope.userId}
              AND kind = 'system_event'
              AND created_at > now() - interval '24 hours'
              AND payload_ref->>'text' IS NOT NULL
              AND payload_ref->>'text' <> '刚才的学习已完成，要继续吗？'
          `);
          return Number((Array.isArray(rows) ? rows : [])[0]?.n ?? 0);
        });
        alreadyPersonalized = personalizedCheck > 0;
      } catch {
        // 频率检查失败不阻塞个性化生成（fail-open，最多多一次个性化文案）。
      }
      if (alreadyPersonalized) {
        // 24h 内已个性化过，跳过本次个性化，保留模板文案。
        const { logger } = await import("../../../lib/logger.ts");
        logger.info(
          { runId: defer.runId },
          "personalized proactive text skipped: 24h limit reached",
        );
      } else {
        const personalizedText = await generatePersonalizedProactiveText(
          {
            runId: defer.runId,
            topMemories: defer.topMemories,
            outcome: defer.outcome,
            keyPointClaim: defer.keyPointClaim,
          },
          { ...defer.scope, currentActiveTransaction: currentApiWorkspaceTransaction },
        );
        if (personalizedText) {
          // 在独立事务中更新已入队 delivery 的 text 字段。
          await withWorkspaceTransaction(defer.scope, async (tx) => {
            await tx.execute(sql`
              UPDATE assistant_deliveries
              SET payload_ref = jsonb_set(
                payload_ref,
                '{text}',
                ${JSON.stringify(personalizedText)}::jsonb
              )
              WHERE workspace_id = ${defer.scope.workspaceId}
                AND user_id = ${defer.scope.userId}
                AND dedupe_key = ${`run.completed:${defer.runId}`}
            `);
          });
        }
      }
    } catch (err) {
      // 个性化文案生成失败不阻塞已入队的模板文案。
      const { logger } = await import("../../../lib/logger.ts");
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId: defer.runId },
        "personalized proactive text generation skipped",
      );
    }
  }
}

/**
 * 22 方案 §10.3.4/§11.5：个性化主动提醒文案生成。
 *
 * 调用 LLM 生成简短、自然、不打扰的提醒文案；输入为用户记忆 + 学习上下文。
 * - 2s 超时（§11.5）；
 * - 不编造记忆中没有的事实（§10.3.4）；
 * - 生成的文案必须通过安全校验（不泄露内部 ID）；
 * - 失败/超时返回 null，由调用方回退模板文案。
 *
 * 2026-10-02：接到 41a 统一内核上（此前是一次自带 2s AbortController 的裸 HTTP）。
 * 换进来的是任务身份、预算口径与统一失败分类；**2s 这个上界没有变**，
 * 也不自动重试——文案晚到 4 秒比拿不到更糟，模板文案此刻已经在队列里了。
 */
async function generatePersonalizedProactiveText(
  input: { runId: string; topMemories: string[]; outcome: string; keyPointClaim: string },
  scope: { workspaceId: string; userId: string; currentActiveTransaction: () => unknown },
): Promise<string | null> {
  // 设计 P0-2（2026-09-15 审计）：收敛到单一解析点（见 lib/assessment-critic-config.ts）。
  // 此前 `?? DASHSCOPE_API_KEY` 在 compose 注入空串时不回退，导致个性化被静默关闭。
  const config = resolveAssessmentCriticConfig();
  if (!config) return null;
  const { url, key, model } = config;

  const memoryBlock = input.topMemories
    .slice(0, 3)
    .map((m, i) => `[记忆${i + 1}] ${m.slice(0, 200)}`)
    .join("\n");

  const prompt = [
    "根据用户记忆和当前学习上下文，生成一条简短、自然、不打扰的提醒。",
    "不要编造记忆中没有的事实。",
    "受提醒类型模板约束：学习完成的提醒。",
    "只输出提醒文案本身，不要输出其他内容。",
    "文案不超过 80 字。",
    "",
    `学习结果：${input.outcome}`,
    // Plan 23 CS-05：keyPointClaim 实际传入的是 Objective conceptLabel（不再用 legacy claim）。
    `学习目标：${input.keyPointClaim.slice(0, 200)}`,
    "",
    "用户记忆：",
    memoryBlock,
  ].join("\n");

  const task: AiTaskDefinition<{ url: string; key: string; model: string; prompt: string }, string> = {
    id: PERSONALIZED_PROACTIVE_TASK_ID,
    version: 1,
    mode: "structured",
    // 模板文案已经入队，这一发只是把更好的那句换上去 ⇒ 维护档，不占交互名额。
    resourceClass: "maintenance",
    budget: {
      maxModelCalls: 1,
      stepTimeoutMs: PERSONALIZED_PROACTIVE_TIMEOUT_MS,
      taskDeadlineMs: PERSONALIZED_PROACTIVE_TIMEOUT_MS,
      maxAutoRetries: 0,
    },
    completion: { kind: "structured_parsed" },
    usageContext: { modelId: model, promptVersion: PERSONALIZED_PROACTIVE_PROMPT_VERSION, resourceClass: "maintenance" },
    prepare: async () => ({ url, key, model, prompt }),
    execute: async (prepared, step) => {
      let response: Awaited<ReturnType<typeof postJsonToPublicEndpoint>>;
      try {
        const { postJsonToPublicEndpoint: post } = await import("@ailearn/shared/public-json-http");
        response = await post(
          prepared.url,
          { Authorization: `Bearer ${prepared.key}`, "Content-Type": "application/json" },
          {
            model: prepared.model,
            messages: [
              { role: "system", content: "你是学习伴星的提醒文案生成器，输出简短自然的中文提醒。" },
              { role: "user", content: prepared.prompt },
            ],
            stream: false,
          },
          // 超时由内核的 step.signal 给；这里不再自己挂一个 setTimeout。
          step.signal,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return step.signal.aborted
          ? { ok: false as const, class: "timeout" as const, message: `提醒文案生成超时：${message}` }
          : { ok: false as const, class: "transport" as const, message: `提醒文案生成网络错误：${message}` };
      }
      const content = (response.body as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content?.trim();
      if (!content) return { ok: false as const, class: "output_shape" as const, message: "提醒文案为空" };
      // 长度与内部 ID 两道校验留在 execute 里：它们是**这一步的完成判据**，
      // 不是提交后的业务规则。过了这一关的内容才算「模型任务成功」。
      if (content.length > 200) return { ok: false as const, class: "quality" as const, message: "提醒文案超过长度上限" };
      if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(content)) {
        return { ok: false as const, class: "quality" as const, message: "提醒文案疑似泄露内部 ID" };
      }
      return { ok: true as const, output: content };
    },
    // 恒等提交：那一列 text 的 UPDATE 留在调用方的独立短事务里（它要 dedupe_key）。
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
        inputSnapshotRef: {
          kind: "task",
          id: input.runId,
          hash: createHash("sha256")
            .update([input.outcome, input.keyPointClaim.slice(0, 200), ...input.topMemories.slice(0, 3)].join(" "))
            .digest("hex"),
        },
        permissionLevel: "server",
      },
      attempt: {
        taskId: task.id,
        taskVersion: task.version,
        attemptId: randomUUID(),
        leaseToken: `personalized-proactive:${input.runId}`,
        idempotencyKey: `personalized-proactive:${input.runId}`,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      },
      currentActiveTransaction: scope.currentActiveTransaction,
      reportDevelopmentError: (message) => process.stderr.write(`[dev-error] ${message}\n`),
    });
    return receipt.outcome === "committed" ? receipt.output : null;
  } catch {
    return null; // 超时/网络失败回退模板文案
  }
}

export async function hookProactiveOnRunCompleted(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  input: {
    runId: string;
    /** 模型生成记忆候选所需的结算摘要（缺省时跳过生成，确定性交付照常）。 */
    outcome?: string;
    trustOutcome?: string;
    keyPointClaim?: string;
    scheduleImpact?: string;
  },
  now: Date = new Date(),
): Promise<ProactiveMemoryDeferInput | null> {
  // 这是**触发式**主动输出：用户刚跑完一个学习运行，"要继续吗"正是他在等的东西。
  // 所以这里不读静默时段、作答状态、24h 计数、最近展示时间、反馈窗口——那五道闸管的
  // 是"她自己想开口"的节奏（用户 2026-09-21 的口径：触发式不进频率限制）。
  // 只剩两条：账号级总开关，和设备明确不在（气泡进收件箱，人回来照样看得见）。
  const { userCompanionAccountState } = await import("@ailearn/shared/db-schema/companion");
  const { eq } = await import("drizzle-orm");
  const accountRows = await tx
    .select({
      presence: userCompanionAccountState.presence,
      globalEnabled: userCompanionAccountState.globalEnabled,
      suggestionPause: userCompanionAccountState.suggestionPause,
    })
    .from(userCompanionAccountState)
    .where(eq(userCompanionAccountState.userId, scope.userId))
    .limit(1);
  const presence = accountRows[0]?.presence as { presence?: "online" | "dnd" | "offline" } | null;
  const availability = presence?.presence ?? "online";
  if (accountRows[0] && accountRows[0].globalEnabled === false) {
    return null; // 全局关闭：不打扰。
  }
  if (!evaluateTriggeredPush({ availability, expired: false }).allow) return null;

  /**
   * 40 §8.2：「用户说『今天别催学习』，该本地日不再主动推荐学习；**不会取消
   * 已授权安排**。」
   *
   * 这一条管的是**这里**——「刚跑完，要不要继续」就是主动推荐学习。
   * 而到点提醒走它自己那条路（`arranged_reminder`），**不受这一条影响**：
   * 用户约好的事不能被一句「别催」顺手撤掉。
   *
   * 放在这里而不是执行器里：这一条是**账号级**的当天决定，与这一轮的内容无关；
   * 而执行器看不到账号状态，也分不清"她在推学习"与"她在履约"。
   */
  const { evaluateLearningNudgePause } = await import("@ailearn/shared/companion-proactive-quota");
  const pauseVerdict = evaluateLearningNudgePause({
    pause: accountRows[0]?.suggestionPause as { paused?: boolean; localDate?: string; timezone?: string } | null,
    now,
  });
  if (pauseVerdict.suppressed) {
    // 记一笔：用户说"别催"之后仍然收到了催学，这就是那条证据。
    const { logger } = await import("../../../lib/logger.ts");
    logger.info(
      { runId: input.runId, suppressedLocalDate: pauseVerdict.suppressedLocalDate, todayLocalDate: pauseVerdict.todayLocalDate },
      "proactive learning nudge suppressed by local-day pause",
    );
    return null;
  }

  // 22 方案 §9.7/§11.5：个性化主动文案。
  // 在事务内只读取记忆快照（不调 LLM，避免钉住连接）；
  // 事务提交后由 flushDeferredProactiveMemoryCandidates 异步生成文案并更新 delivery。
  let topMemories: string[] | undefined;
  if (process.env.COMPANION_PROACTIVE_PERSONALIZED_V1 === "true") {
    try {
      const memoryRows = await tx.execute<{ content: string }>(sql`
        SELECT content FROM assistant_memory_items
        WHERE workspace_id = ${scope.workspaceId}
          AND user_id = ${scope.userId}
          AND deleted_at IS NULL
          AND candidate = false
          AND archived_at IS NULL
          AND (valid_from IS NULL OR valid_from <= now())
          AND (valid_until IS NULL OR valid_until > now())
        ORDER BY pinned DESC, importance DESC, updated_at DESC
        LIMIT 3
      `);
      topMemories = (Array.isArray(memoryRows) ? memoryRows : [])
        .map((row) => row.content)
        .filter((content) => content.length > 0);
      if (topMemories.length === 0) topMemories = undefined;
    } catch {
      topMemories = undefined; // 读取失败不阻塞，后续走模板文案。
    }
  }

  // 模板文案：作为 fallback 先入队，异步生成成功后覆盖。
  const templateText = "刚才的学习已完成，要继续吗？";
  await deliver(tx, scope, {
    assistantSessionId: null,
    kind: "system_event",
    payloadRef: {
      kind: "system_event",
      systemEventId: `run.completed:${input.runId}`,
      text: templateText,
    },
    dedupeKey: `run.completed:${input.runId}`,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  }, now);

  // P8 模型生成接线：LLM 网络调用不能在结算事务内执行（会钉住连接）。这里
  // 只返回延后所需的输入，由调用方在事务提交后调 flushDeferredProactiveMemoryCandidates。
  if (!input.keyPointClaim && !topMemories) return null;
  return {
    scope,
    runId: input.runId,
    outcome: input.outcome ?? "unknown",
    trustOutcome: input.trustOutcome ?? "unknown",
    keyPointClaim: input.keyPointClaim ?? "",
    scheduleImpact: input.scheduleImpact ?? "none",
    now,
    topMemories,
  };
}

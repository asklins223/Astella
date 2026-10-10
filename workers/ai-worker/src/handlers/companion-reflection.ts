/**
 * 她自己回顾一段相处的那次后台任务（方案 50 §9，首批闭环的"成长"那一环）。
 *
 * ## 它不是什么
 *
 * 不是"另一位伴星"：这一次回顾**沿用同一个人格版本**（进 prompt 的就是那段相处
 * 结束时生效的那一版），也不新建任何 Provider、重试循环或常驻心跳。
 * 也不是现役的记忆整理：整理做的是判重、过期、容量这些**规则维护**（它明确不管
 * `judgment`）；这里做的是语义比较——那一句真的说过之后，下次的说法该不该变。
 *
 * ## 形状
 *
 * 1. 短事务读：把 `(fromSeq, toSeq]` 这段真实交流、当时的真实回执、她已经记下的条目
 *    拼成**不可变输入快照**；门不过就安静留下一个结果码，不花一次模型调用。
 * 2. 事务外一次有界模型调用：走现役 `runAiTask` 内核（响应先落检查点、租约核对、
 *    预算与失败分类都在），一次结构化输出 + 至多一次协议修复。
 * 3. 短事务写：重新核对同意、来源版本、人格基线 revision、pending 引用与字段保护，
 *    然后经 `agent-host` 的共享端口落 —— 判断走记忆域、方法走方法域、自我修订走身份域。
 *    模型答得漂亮**不等于**它拿到了提交权。
 *
 * ## 关于"同一账号串行"这一条
 *
 * 队列领取保证同账号最多一个 running 反思，其他空间的回顾按水位等候。
 * 模型等待发生在事务外；提交时才短暂取得账号写锁，并核对基线与 pending 提案。
 * 用户编辑、删除与前台聊天不等待反思模型。
 */

import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  runAiTask, type AiAttemptToken, type AiCheckpointEntry, type AiCheckpointKey,
  type AiTaskCheckpointPort, type AiTaskContext, type AiTaskDefinition, type AiTaskReceipt,
} from "@astella/shared/ai-task-kernel";
import { toTextArrayLiteral } from "@astella/shared/pg-text-array";
import { resolveSystemProviderForCapability } from "@astella/shared/task-router";
import { agentMethodEvidenceV1Schema } from "@astella/shared/agent-growth-contracts";
import { companionMemoryMutationLockKey } from "@astella/shared/db-schema/assistant-memory";
import { getDefaultPersonaPreset } from "@astella/shared/pet-persona-presets";
import { personaFromDefaultPreset } from "@astella/shared/pet-persona-merge";
import type {
  CompanionPersonaProfileContent,
  CompanionReflectionDecision,
} from "@astella/shared/db-schema/companion-memory";
import {
  COMPANION_REFLECTION_INPUT_BUDGET,
  COMPANION_REFLECTION_STRATEGY_VERSION,
  claimReflectionRun,
  commitPersonaProposalV1,
  createOrLoadReflection,
  finalizeReflection,
  personaSourcesCurrent,
  recordReflectionEdge,
  upsertAgentMethodCandidate,
  type CompanionPersonaSourceRefV1,
  type CompanionReflectionRowV1,
} from "@astella/agent-host";
import { currentWorkerWorkspaceTransaction, withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import { createProvider } from "../lib/ai-provider.ts";
import { isJobLeaseActive, lockJobLease, throwIfJobAborted, withJobTransaction } from "../lib/job-lease.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import {
  createGovernedProvider, resolveAIGovernanceContext, resolveProviderForTask,
} from "../lib/governance.ts";
import { logger } from "../lib/logger.ts";
import { parseMemoryExtractJson } from "./companion-memory-extractor.ts";
import {
  COMPANION_REFLECTION_PROMPT_VERSION, COMPANION_REFLECTION_TASK_ID, COMPANION_REFLECTION_TASK_VERSION,
  buildReflectionMessages, clipReflectionOverflow, companionReflectionOutputV1Schema,
  boundReflectionSnapshot, normalizeReflectionPayload, reflectionInputFingerprint, verifyReflectionOutput,
  reflectionInputSnapshotV1Schema,
  type ReflectionInputSnapshotV1, type ReflectionVerifiedV1,
} from "./companion-reflection-content.ts";
import { companionReflectionGate, reflectionSnapshotSufficient, reflectionTailWindow } from "./companion-reflection-gate.ts";
import type { JobPayload } from "./index.ts";

/** 一次回顾的输出上限：它是结构化结论，不是文章。 */
const REFLECTION_MAX_OUTPUT_TOKENS = 1_200;

const jobPayloadSchema = z.strictObject({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().positive(),
});

/** 同一段相处只有一个幂等键：worker 重启、outbox 重投都落回同一行反思记录。 */
export function companionReflectionDedupeKey(conversationId: string, toSeq: number): string {
  return `companion-reflection:${conversationId}:${toSeq}`;
}

export async function runCompanionReflectionJob(job: JobPayload): Promise<void> {
  const parsed = jobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error("companion_reflection payload 不合合同");
  const input = parsed.data;
  if (input.userId !== job.requestedBy) {
    throw new Error("companion_reflection payload 的 userId 与认领到的请求人不一致");
  }
  if (input.workspaceId !== job.workspaceId) throw new Error("companion_reflection workspace 与 job 不一致");
  throwIfJobAborted(job);

  const prepared = await prepareReflection(job, input);
  if (!prepared) return;
  if (prepared.reflection.decision !== "running") {
    // 门没过、或这一段已经被别人跑完：结论码已经在那一行上，没有该花的模型调用。
    logger.info({
      jobId: job.id, decision: prepared.reflection.decision,
      conversationId: input.conversationId,
    }, "companion reflection skipped its model call");
    return;
  }

  const verified = await runReflectionModelCall(job, input.userId, prepared);
  if (!verified) return;
  await commitReflection(job, input, prepared, verified);
}

// ─── 1. 输入快照、门与认领 ───────────────────────────────────────────────

interface PreparedReflection {
  readonly reflection: CompanionReflectionRowV1;
  readonly snapshot: ReflectionInputSnapshotV1;
  readonly fingerprint: string;
}

/**
 * 短事务：幂等地拿到这一次的行，读输入快照，判门，并认领执行。
 *
 * 认领（`queued → running`）与"门没过就落一个结论码"都在这一个事务里，
 * 于是重复投递的第二条 job 读到的已经是终态行——它不会再跑一次模型，
 * 也不会把上一轮的 `no_change` 覆盖成新结论（§15.1「结果和版本不重复」）。
 */
async function prepareReflection(
  job: JobPayload,
  input: z.infer<typeof jobPayloadSchema>,
): Promise<PreparedReflection | null> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      await lockJobLease(tx, job);
      const persona = await readPersona(tx, input.userId);
      const messages = await readSegmentMessages(tx, input);
      const receipts = await readSegmentToolReceipts(tx, input);
      const related = await readRelatedMemories(tx, input);
      const context = await readReflectionContext(tx, input.conversationId, input.userId);

      const authority = await readReflectionAuthority(tx, input);
      const snapshot = boundReflectionSnapshot({
        accountEpoch: authority.epoch,
        pendingPersonaRevision: persona.pendingRevision,
        conversationId: input.conversationId,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
        persona, messages,
        toolReceipts: receipts,
        relatedMemories: related,
      });
      const fingerprint = reflectionInputFingerprint(snapshot, COMPANION_REFLECTION_STRATEGY_VERSION);
      const created = await createOrLoadReflection(tx, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        jobId: job.id,
        dedupeKey: companionReflectionDedupeKey(input.conversationId, input.toSeq),
        inputFingerprint: fingerprint,
        inputSnapshot: snapshot,
        baselinePersonaRevision: persona.revision,
        fromSeq: input.fromSeq,
        toSeq: input.toSeq,
      });
      if (!created) return null;

      // A second job cannot take over a running reflection. A queue retry uses
      // the same job and frozen input, so its response checkpoint still matches.
      if (created.decision === "running") {
        if (created.jobId !== job.id) return null;
        const frozen = reflectionInputSnapshotV1Schema.safeParse(created.inputSnapshot);
        if (!frozen.success) {
          await finalizeReflection(tx, input.userId, created.id, {
            decision: "source_invalid", summary: "原输入快照已清除或不可读，没有重新取材提交旧结论",
          });
          return null;
        }
        return { reflection: created, snapshot: frozen.data, fingerprint: created.inputFingerprint };
      }
      if (created.decision !== "queued") return { reflection: created, snapshot, fingerprint };
      if (!authority.allowed) {
        await finalizeReflection(tx, input.userId, created.id, {
          decision: "governance_denied", summary: "伴星已关闭、账号未授权或已离开来源空间，没有外发或提交",
        });
        return null;
      }

      const settled = await settleReflectionGate(tx, job, input, created, snapshot, context, fingerprint);
      if (!settled) return null;
      if (settled.reflection.decision !== "running") return settled;

      // read 边在**这次读的这一刻**就落下来：模型还没答，依据先固定。
      // 于是"依据后来被删了"复查得到，而不是等提交时才发现少了一份快照。
      for (const message of snapshot.messages) {
        await recordReflectionEdge(tx, input.userId, settled.reflection.id, {
          relation: "read", workspaceId: input.workspaceId,
          source: {
            kind: message.role === "user" ? "user_message" : "assistant_message",
            id: message.id, revision: message.contentHash ?? null,
          },
        });
      }
      for (const memory of snapshot.relatedMemories) {
        await recordReflectionEdge(tx, input.userId, settled.reflection.id, {
          relation: "read", workspaceId: input.workspaceId,
          source: { kind: "memory", id: memory.id, revision: String(memory.revision) },
        });
      }
      return settled;
    },
  );
}

/** 门（含快照够不够）与认领：不过门的那几条把原因写在行上就结束。 */
async function settleReflectionGate(
  tx: WorkerTransaction,
  job: JobPayload,
  input: z.infer<typeof jobPayloadSchema>,
  reflection: CompanionReflectionRowV1,
  snapshot: ReflectionInputSnapshotV1,
  context: { lastReflectionAt: Date | null; openReflections: number },
  fingerprint: string,
): Promise<PreparedReflection | null> {
  const base = { reflection, snapshot, fingerprint };
  if (reflection.decision !== "queued") return base;

  const gate = companionReflectionGate({
    userMessageCount: snapshot.messages.filter((message) => message.role === "user").length,
    assistantDeliveredCount: snapshot.messages.filter((message) => message.role === "assistant").length,
    lastReflectionAt: context.lastReflectionAt,
    openReflectionsForAccount: context.openReflections,
    now: new Date(),
  });
  if (!gate.run) {
    await finalizeReflection(tx, input.userId, reflection.id, {
      decision: "trigger_none", summary: `门未过：${gate.reason}`,
    });
    return { ...base, reflection: { ...reflection, decision: "trigger_none" } };
  }
  const sufficient = reflectionSnapshotSufficient(snapshot);
  if (!sufficient.ok) {
    await finalizeReflection(tx, input.userId, reflection.id, {
      decision: "insufficient_input", summary: `读不出可用依据：${sufficient.reason}`,
    });
    return { ...base, reflection: { ...reflection, decision: "insufficient_input" } };
  }
  const claimed = await claimReflectionRun(tx, input.userId, reflection.id, job.id);
  if (!claimed) {
    const current = await loadReflectionRow(tx, input.userId, reflection.id);
    return current ? { ...base, reflection: current } : null;
  }
  return { ...base, reflection: { ...reflection, decision: "running" } };
}

/** 快照里的消息带上内容哈希：它是"还是不是当初那一条"的身份证据。 */
async function readSegmentMessages(tx: WorkerTransaction, input: {
  conversationId: string; fromSeq: number; toSeq: number;
}) {
  const rows = await tx.execute<{
    id: string; seq: number; role: string; kind: string; blocks: unknown; content_sha256: string;
  }>(sql`
    SELECT id::text AS id, seq, role, kind, blocks, content_sha256
      FROM companion_messages
     WHERE conversation_id = ${input.conversationId}::uuid
       AND seq > ${input.fromSeq} AND seq <= ${input.toSeq}
       AND role IN ('user', 'assistant')
     ORDER BY seq DESC
     LIMIT ${COMPANION_REFLECTION_INPUT_BUDGET.maxMessages}
  `);
  // 库里按 seq 倒序取**尾窗**，交给模型前排回正序（见 reflectionTailWindow 的注释：
  // 取前 N 条会把刚说完的那句截掉，段落还会被误判成"没落定"）。
  const window = reflectionTailWindow((Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.id),
    seq: Number(row.seq),
    role: row.role as "user" | "assistant",
    kind: String(row.kind),
    text: textFromBlocks(row.blocks),
    contentHash: String(row.content_sha256 ?? ""),
  })), COMPANION_REFLECTION_INPUT_BUDGET.maxMessages);
  return window.sort((left, right) => left.seq - right.seq);
}

function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => (typeof block === "object" && block !== null
      && typeof (block as { text?: unknown }).text === "string"
      ? (block as { text: string }).text : ""))
    .filter((text) => text.length > 0)
    .join(" ");
}

/**
 * 这一段里真实执行过的动作与回执。
 *
 * 按**回合**取（run 属于这一段里的哪条用户消息），不是按时间窗：时间窗会把上一段
 * 尾巴上的动作算进这一段，于是她把一次没在自己看到的执行当成依据。
 */
async function readSegmentToolReceipts(tx: WorkerTransaction, input: {
  conversationId: string; fromSeq: number; toSeq: number;
}) {
  const rows = await tx.execute<{
    id: string; name: string; status: string; result_safe_summary: string | null;
  }>(sql`
    SELECT c.id::text AS id, c.name, c.status, c.result_safe_summary
      FROM companion_agent_tool_calls c
      JOIN companion_messages m
        ON m.run_id = c.run_id AND m.conversation_id = c.conversation_id
     WHERE c.conversation_id = ${input.conversationId}::uuid
       AND m.role = 'user' AND m.seq > ${input.fromSeq} AND m.seq <= ${input.toSeq}
     ORDER BY c.created_at
     LIMIT ${COMPANION_REFLECTION_INPUT_BUDGET.maxToolReceipts}
  `);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.id), name: String(row.name), status: String(row.status),
    safeSummary: String(row.result_safe_summary ?? ""),
  }));
}

/**
 * 她已经记下的相关条目（避免把同一件事再说成新发现）。
 *
 * 只取判断、偏好与相处笔记三类、按更新时间有界读取：这不是"把全空间历史塞进去"，
 * 而是让她看得见自己已经说过什么（§7 收紧不相关供给，同时不省掉必要来源）。
 */
async function readRelatedMemories(tx: WorkerTransaction, input: { workspaceId: string; userId: string }) {
  const rows = await tx.execute<{
    id: string; kind: string; content: string; epistemic_status: string | null; revision: number;
  }>(sql`
    SELECT a.id::text AS id, a.kind, a.content, a.epistemic_status, a.revision
      FROM assistant_memory_items a
     WHERE a.workspace_id = ${input.workspaceId} AND a.user_id = ${input.userId}
       AND a.deleted_at IS NULL AND a.candidate = false
       AND a.dismissed_at IS NULL AND a.archived_at IS NULL
       AND a.epistemic_status NOT IN ('disputed','superseded')
       AND (a.valid_from IS NULL OR a.valid_from <= now())
       AND (a.valid_until IS NULL OR a.valid_until > now())
       AND a.kind IN ('judgment', 'preference', 'interaction_note')
     ORDER BY a.updated_at DESC
     LIMIT ${COMPANION_REFLECTION_INPUT_BUDGET.maxRelatedMemories}
  `);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.id), kind: String(row.kind), content: String(row.content),
    epistemicStatus: String(row.epistemic_status ?? "tentative"), revision: Number(row.revision),
  }));
}

async function readReflectionContext(tx: WorkerTransaction, conversationId: string, userId: string) {
  const rows = await tx.execute<{ last_at: Date | string | null; open: number }>(sql`
    SELECT (SELECT max(created_at) FROM companion_reflections
             WHERE conversation_id = ${conversationId}::uuid
               AND user_id = ${userId}
               AND decision NOT IN ('queued')) AS last_at,
           (SELECT count(*)::int FROM companion_reflections
             WHERE user_id = ${userId} AND decision IN ('queued', 'running')) AS open
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  const lastAt = row?.last_at ?? null;
  return {
    lastReflectionAt: lastAt ? new Date(lastAt) : null,
    openReflections: Number(row?.open ?? 0),
  };
}

async function loadReflectionRow(tx: WorkerTransaction, userId: string, id: string) {
  const rows = await tx.execute<{
    id: string; user_id: string; workspace_id: string; conversation_id: string;
    trigger_kind: string; input_from_seq: string; input_to_seq: string;
    strategy_version: string; baseline_persona_revision: number; decision: string;
    job_id: string | null; input_snapshot: unknown; input_fingerprint: string;
  }>(sql`
    SELECT id, user_id, workspace_id, conversation_id, trigger_kind,
           input_from_seq, input_to_seq, strategy_version, baseline_persona_revision, decision,
           job_id, input_snapshot, input_fingerprint
    FROM companion_reflections WHERE id = ${id}::uuid AND user_id = ${userId} LIMIT 1
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  if (!row) return null;
  return {
    id: String(row.id), userId: String(row.user_id), workspaceId: String(row.workspace_id),
    conversationId: String(row.conversation_id),
    triggerKind: row.trigger_kind as CompanionReflectionRowV1["triggerKind"],
    inputFromSeq: Number(row.input_from_seq), inputToSeq: Number(row.input_to_seq),
    strategyVersion: row.strategy_version,
    baselinePersonaRevision: Number(row.baseline_persona_revision),
    decision: row.decision as CompanionReflectionDecision,
    jobId: row.job_id, inputSnapshot: row.input_snapshot, inputFingerprint: row.input_fingerprint,
  } satisfies CompanionReflectionRowV1;
}

/** 她当时是谁：账号档案，没有就用系统默认人格（与前台装配同一条读取规则）。 */
async function readPersona(tx: WorkerTransaction, userId: string) {
  const rows = await tx.execute<{ revision: number; profile: unknown; pending_revision: number | null }>(sql`
    SELECT revision, profile, pending_revision FROM companion_persona_profiles WHERE user_id = ${userId} LIMIT 1
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  const content = (typeof row?.profile === "object" && row.profile !== null && !Array.isArray(row.profile)
    ? row.profile : null) as CompanionPersonaProfileContent | null;
  const base = content ?? personaFromDefaultPreset(getDefaultPersonaPreset());
  return {
    revision: Number(row?.revision ?? 0),
    pendingRevision: row?.pending_revision ?? null,
    name: base.name,
    speakingStyle: base.speakingStyle,
    selfDescription: base.selfDescription ?? null,
    personalityTags: base.personalityTags,
  };
}

/** Recheck actual access and consent inside each short execution boundary. */
async function readReflectionAuthority(tx: WorkerTransaction, input: {
  workspaceId: string; userId: string; conversationId: string;
}) {
  const [authority] = await tx.execute<{ epoch: number; allowed: boolean; external_allowed: boolean }>(sql`
    SELECT * FROM astella_companion_reflection_authority(
      ${input.userId}::uuid,${input.workspaceId}::uuid,${input.conversationId}::uuid)
  `);
  const usesExternal = resolveSystemProviderForCapability("agent_turn") !== "mock";
  return { epoch: Number(authority?.epoch ?? 0),
    allowed: authority?.allowed === true && (!usesExternal || authority.external_allowed === true) };
}

// ─── 2. 那一次模型调用（事务外） ─────────────────────────────────────────

/**
 * 走现役内核的有界回顾：一次结构化调用 + 至多一次协议修复。
 *
 * 返回 null 表示"什么也没得到"：被取消、租约没了、或协议两次都不合。
 * 那三种都会先把结论码落库——§12.2 要能分辨协议失败与"看了但没什么可改"。
 */
async function runReflectionModelCall(
  job: JobPayload,
  userId: string,
  prepared: PreparedReflection,
): Promise<ReflectionVerifiedV1 | null> {
  const govCtx = await resolveAIGovernanceContext(job.workspaceId, userId);
  if (!govCtx.consentOk) {
    // 没有授权外发：这一次回顾**根本没有向模型发过任何东西**，
    // 记成"素材不足"会让排查的人找错方向，所以它有自己的结论码。
    await finalizeOutcome(job, userId, prepared.reflection.id, "governance_denied",
      "这个账号没有授权外发，这次回顾没有向模型发任何东西");
    return null;
  }
  const textRes = resolveProviderForTask(govCtx, "companion_agent");
  const provider = createGovernedProvider(
    createProvider(textRes.providerName, textRes.providerConfig),
    govCtx, job.workspaceId,
    { userId, operation: "companion_reflection", jobId: job.id, dataCategories: ["conversation_content"] },
  );
  const messages = buildReflectionMessages(prepared.snapshot);
  let rejection: string | null = null;

  const definition: AiTaskDefinition<void, ReflectionVerifiedV1> = {
    id: COMPANION_REFLECTION_TASK_ID, version: COMPANION_REFLECTION_TASK_VERSION,
    mode: "structured", resourceClass: "maintenance",
    budget: {
      maxModelCalls: 2, maxAutoRetries: 1,
      stepTimeoutMs: resolveProviderCallTimeout("companion_reflection"),
      taskDeadlineMs: resolveProviderCallTimeout("companion_reflection") * 2,
    },
    completion: { kind: "structured_parsed" },
    usageContext: {
      modelId: provider.modelId, promptVersion: COMPANION_REFLECTION_PROMPT_VERSION,
      resourceClass: "maintenance",
    },
    prepare: async () => {
      if (!await isJobLeaseActive(job)) throw new Error("反思的执行租约已经不在这一次手里");
      const authority = await withJobTransaction(job, tx => readReflectionAuthority(tx, {
        workspaceId: job.workspaceId, userId, conversationId: prepared.snapshot.conversationId,
      }));
      if (!authority.allowed || authority.epoch !== prepared.snapshot.accountEpoch) {
        throw new Error("回顾的账号授权或来源空间已失效");
      }
    },
    execute: async (_prepared, env) => {
      const result = await provider.chatCompletion(
        rejection ? [...messages, { role: "user", content: `上一版协议没有通过，请修正：${rejection}` }] : messages,
        { temperature: 0.2, maxTokens: REFLECTION_MAX_OUTPUT_TOKENS, responseFormat: "json_object" },
        env.signal);
      const normalized = normalizeReflectionPayload(parseMemoryExtractJson(result.content));
      const clipped = clipReflectionOverflow(normalized.payload);
      if (clipped.clipped.length > 0) {
        // 超出容量的条目被剪掉，剩下的照收：这不是失败，但要看得见剪了几条。
        logger.warn({ jobId: job.id, clipped: clipped.clipped }, "companion reflection trimmed over-capacity items");
      }
      const parsed = companionReflectionOutputV1Schema.safeParse(clipped.payload);
      if (!parsed.success) {
        // 记下**哪一个字段不合**：只说"格式不对"，第二次跑还是同样失败，
        // 而线上排查的人什么也看不见（§12.2 要能分辨协议失败）。
        // 不落原始正文：那里面有用户的原话。
        const issues = parsed.error.issues
          .slice(0, 6)
          .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
          .join(",");
        rejection = `字段不合 [${issues}]。键名必须照这个写：decision("no_change" 或 "proposals")、summary、`
          + `judgments[{text,appliesWhen,epistemicStatus,sourceMessageIds}]、`
          + `experiences[{title,triggerCondition,steps,exceptions,sourceMessageIds}]、`
          + `persona({selfDescription,speakingStyle,reason,sourceMessageIds} 或 null)。${
            normalized.droppedKeys.length > 0 ? `多出来的键没有采用：${normalized.droppedKeys.slice(0, 5).join(",")}。` : ""}`;
        logger.warn({ jobId: job.id, issues }, "companion reflection output rejected by schema");
        return { ok: false, class: "output_shape", message: rejection };
      }
      return {
        ok: true,
        output: verifyReflectionOutput(parsed.data, prepared.snapshot),
        promptTokens: result.usage?.promptTokens ?? undefined,
        completionTokens: result.usage?.completionTokens ?? undefined,
      };
    },
    // 业务写不在这里：内核只管"这一次的产物留住了"，
    // 人格与经验的提交在 `commitReflection` 里按现役围栏重新核对后走。
    commit: async (_ctx, _attempt, output) => settledReceipt(output),
  };

  const receipt = await runAiTask(definition, {
    ctx: reflectionTaskContext(job, userId, prepared.fingerprint),
    attempt: reflectionTaskAttempt(job, userId, definition),
    currentActiveTransaction: currentWorkerWorkspaceTransaction,
    verifyAttempt: () => isJobLeaseActive(job),
    checkpoint: createReflectionCheckpointPort<ReflectionVerifiedV1>({
      job, userId, personaRevision: prepared.reflection.baselinePersonaRevision,
      parseOutput: parseReflectionCheckpointOutput,
    }),
  });

  if (job.signal?.aborted || receipt.failure?.class === "cancelled") {
    await finalizeOutcome(job, userId, prepared.reflection.id, "lease_lost", "任务被取消或租约到期，没有提交");
    return null;
  }
  if (receipt.outcome === "committed" || receipt.outcome === "resumed_and_committed") return receipt.output;
  if (receipt.failure?.class === "output_shape") {
    await finalizeOutcome(job, userId, prepared.reflection.id, "protocol_failed",
      `协议不合：${rejection ?? receipt.failure.message ?? ""}`);
    return null;
  }
  await finalizeOutcome(job, userId, prepared.reflection.id, "protocol_failed",
    receipt.failure?.message ?? "回顾没有完成");
  return null;
}

/**
 * 检查点里存的是**验收后**的结果。
 *
 * 重放时不必再走一遍模型，也不必再判一次依据在不在段内——那两个判断的输入
 * （快照与 schema）都已经定型，重算只会带来新的不一致。
 */
function parseReflectionCheckpointOutput(value: unknown): ReflectionVerifiedV1 | null {
  const parsed = z.strictObject({
    output: companionReflectionOutputV1Schema,
    rejected: z.array(z.strictObject({
      slot: z.enum(["judgments", "experiences", "persona"]),
      index: z.number().int().nonnegative(),
      reason: z.enum(["no_cited_source", "cited_source_not_in_snapshot",
        "missing_user_utterance", "unchanged_from_current"]),
    })).max(8),
    citedSources: z.array(z.strictObject({
      kind: z.enum(["user_message", "assistant_message"]), id: z.string().uuid(),
      revision: z.string().nullable().optional(),
    })).max(24),
  }).safeParse(value);
  return parsed.success ? (parsed.data as ReflectionVerifiedV1) : null;
}

function reflectionTaskContext(job: JobPayload, userId: string, hash: string): AiTaskContext {
  return {
    workspaceId: job.workspaceId, userId,
    inputSnapshotRef: { kind: "task", id: `${job.id}:${COMPANION_REFLECTION_TASK_ID}`, hash },
    permissionLevel: "ai_consent_with_workspace_access",
    signal: job.signal,
  };
}

function reflectionTaskAttempt(job: JobPayload, userId: string,
  definition: Pick<AiTaskDefinition<unknown, unknown>, "id" | "version">): AiAttemptToken {
  return {
    taskId: definition.id, taskVersion: definition.version, attemptId: randomUUID(),
    leaseToken: job.leaseToken,
    idempotencyKey: `companion-reflection:${job.id}:${definition.id}`,
    workspaceId: job.workspaceId, userId,
  };
}

function settledReceipt<T>(output: T): AiTaskReceipt<T> {
  return {
    outcome: "committed", output,
    usage: { modelCalls: 1, promptTokens: 0, completionTokens: 0, elapsedMs: 0, autoRetriesUsed: 0 },
    failure: null, preservedValidResult: false, resumedFromCheckpoint: false, modelCalls: 1,
  };
}

function createReflectionCheckpointPort<TOutput>(input: {
  job: JobPayload; userId: string; personaRevision: number;
  parseOutput(value: unknown): TOutput | null;
}): AiTaskCheckpointPort<TOutput> {
  return {
    load: async (key: AiCheckpointKey) => {
      if (key.workspaceId !== input.job.workspaceId || key.userId !== input.userId) return null;
      const rows = await withJobTransaction(input.job, (tx) => tx.execute<{
        output: unknown; prompt_tokens: number; completion_tokens: number;
        persona_profile_revision: number | null;
      }>(sql`
        SELECT output, prompt_tokens, completion_tokens, persona_profile_revision
        FROM companion_reflection_checkpoints
        WHERE job_id = ${input.job.id} AND workspace_id = ${key.workspaceId} AND user_id = ${input.userId}
          AND task_id = ${key.taskId} AND task_version = ${key.taskVersion}
          AND input_snapshot_hash = ${key.inputSnapshotHash}
        LIMIT 1
      `));
      const row = (Array.isArray(rows) ? rows : [])[0];
      if (!row) return null;
      // 人格版本变了：那次回顾看到的"她是谁"已经不是现在这一版，旧产物不能拿来提交。
      if (Number(row.persona_profile_revision) !== input.personaRevision) return null;
      const output = input.parseOutput(row.output);
      if (output === null) return null;
      return {
        output,
        promptTokens: Number(row.prompt_tokens) || 0,
        completionTokens: Number(row.completion_tokens) || 0,
      } satisfies AiCheckpointEntry<TOutput>;
    },
    save: async (key: AiCheckpointKey, entry: AiCheckpointEntry<TOutput>) => {
      if (key.workspaceId !== input.job.workspaceId || key.userId !== input.userId) {
        throw new Error("reflection checkpoint scope does not match its job");
      }
      await withJobTransaction(input.job, async (tx) => {
        await lockJobLease(tx, input.job);
        const [reflection] = await tx.execute<{ input_snapshot: unknown }>(sql`
          SELECT input_snapshot FROM companion_reflections
          WHERE job_id=${input.job.id} AND user_id=${input.userId} AND decision='running'
          FOR UPDATE
        `);
        // Deletion clears input before a late model response arrives. Do not
        // recreate its checkpoint; commit will record source_invalid instead.
        if (!reflection?.input_snapshot) return;
        await tx.execute(sql`
          INSERT INTO companion_reflection_checkpoints
            (job_id, workspace_id, user_id, task_id, task_version, input_snapshot_hash,
             output, prompt_tokens, completion_tokens, persona_profile_revision, created_at)
          VALUES (${input.job.id}, ${key.workspaceId}, ${input.userId}, ${key.taskId}, ${key.taskVersion},
                  ${key.inputSnapshotHash}, ${JSON.stringify(entry.output)}::jsonb,
                  ${entry.promptTokens}, ${entry.completionTokens}, ${input.personaRevision}, now())
          ON CONFLICT (job_id, task_id, task_version, input_snapshot_hash)
          DO UPDATE SET output = EXCLUDED.output, prompt_tokens = EXCLUDED.prompt_tokens,
                        completion_tokens = EXCLUDED.completion_tokens,
                        persona_profile_revision = EXCLUDED.persona_profile_revision,
                        created_at = now()
        `);
      });
    },
  };
}

// ─── 3. 提交：核对之后才落 ───────────────────────────────────────────────

/**
 * 一次短事务里的重新核对与落库。
 *
 * 核对的每一条都可能让这次结论作废：基线版本被推走（用户改过人）、依据被删、
 * 排队里是用户自己的草稿、租约已经不是这一次的。作废就写下**为什么**作废，
 * 不悄悄成功。
 */
async function commitReflection(
  job: JobPayload,
  input: z.infer<typeof jobPayloadSchema>,
  prepared: PreparedReflection,
  verified: ReflectionVerifiedV1,
): Promise<void> {
  const reflection = prepared.reflection;
  const outcome = await withWorkerWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.userId },
    async (tx) => {
      // 同一账号的写入串行：两个空间的回顾不能同时改一份人格（§9.2）。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${companionMemoryMutationLockKey(input.userId)},0))`);
      await lockJobLease(tx, job);
      const [active] = await tx.execute<{ decision: string; job_id: string; input_snapshot: unknown }>(sql`
        SELECT decision, job_id, input_snapshot FROM companion_reflections WHERE id=${reflection.id}::uuid
          AND user_id=${input.userId} FOR UPDATE
      `);
      if (active?.decision !== "running" || active.job_id !== job.id) return null;
      const write = async () => {
        if (!active.input_snapshot) {
          return { decision: "source_invalid" as const, summary: "原始输入已改写或清除，没有提交旧快照结论" };
        }
        const authority = await readReflectionAuthority(tx, input);
        if (!authority.allowed || authority.epoch !== prepared.snapshot.accountEpoch) {
          return { decision: "governance_denied" as const, summary: "账号授权、世代或来源空间已失效，没有提交" };
        }
        const current = await readPersona(tx, input.userId);
        if (current.revision !== reflection.baselinePersonaRevision) {
          return {
            decision: "commit_conflict" as const,
            summary: `基线已变：回顾时第 ${reflection.baselinePersonaRevision} 版，现在第 ${current.revision} 版`,
          };
        }
        const sources: readonly CompanionPersonaSourceRefV1[] = verified.citedSources;
        if (sources.length > 0) {
          const validity = await personaSourcesCurrent(tx, input.userId, sources);
          if (!validity.current) {
            return {
              decision: "source_invalid" as const,
              summary: `依据已不可读：${validity.dead.map((dead) => `${dead.kind}:${dead.id}`).join(",")}`,
            };
          }
        }

        // 依据落到"这一批结论点名引用了哪几句"：撤回按这一组判，不按"当时读过的一切"。
        for (const cited of verified.citedSources) {
          await recordReflectionEdge(tx, input.userId, reflection.id, {
            relation: "cited", workspaceId: input.workspaceId, source: cited,
          });
        }

        const produced: CompanionPersonaSourceRefV1[] = [];
        let pendingPersonaRevision: number | null = null;
        const persona = verified.output.persona;
        if (persona) {
          const edits: { field: "selfDescription" | "speakingStyle"; value: unknown }[] = [];
          if (persona.selfDescription !== undefined) {
            edits.push({ field: "selfDescription", value: persona.selfDescription });
          }
          if (persona.speakingStyle !== undefined) edits.push({ field: "speakingStyle", value: persona.speakingStyle });
          const result = await commitPersonaProposalV1(tx, input.userId, {
            edits, reason: persona.reason, stage: true,
            protectUserFields: true,
            expectedRevision: reflection.baselinePersonaRevision,
            expectedPendingRevision: prepared.snapshot.pendingPersonaRevision ?? null,
            proposal: { kind: "assistant_reflection", proposalId: reflection.id },
          }, { sourceWorkspaceId: input.workspaceId });
          if (result.kind === "conflict") {
            return { decision: "commit_conflict" as const, summary: `人格排队不让写：${result.reason}` };
          }
          if (result.kind === "changed") {
            pendingPersonaRevision = result.revision;
            produced.push({ kind: "persona_revision", id: String(result.revision), revision: null });
          }
        }

        // All conflicts have been checked before experience writes. The persona,
        // experiences, derivation edges and conclusion share this transaction.
        for (const judgment of verified.output.judgments) {
          const memoryId = await insertReflectionJudgment(tx, input, judgment);
          if (memoryId) produced.push({ kind: "memory", id: memoryId, revision: "1" });
        }
        for (const experience of verified.output.experiences) {
          const method = await upsertReflectionMethod(tx, input, experience);
          if (method) produced.push({ kind: "method", id: method.playbookId, revision: String(method.version) });
        }

        for (const edge of produced) {
          await recordReflectionEdge(tx, input.userId, reflection.id, {
            relation: "produced", workspaceId: input.workspaceId, source: edge,
          });
        }
        const wroteAnything = produced.length > 0;
        return {
          decision: wroteAnything ? ("committed" as const) : ("no_change" as const),
          summary: wroteAnything ? verified.output.summary : `没有值得留下的：${verified.output.summary}`,
          pendingPersonaRevision,
          resultRef: {
            judgments: verified.output.judgments.length,
            experiences: verified.output.experiences.length,
            dropped: verified.rejected.map((drop) => `${drop.slot}#${drop.index}:${drop.reason}`),
            personaSources: persona ? sources.filter(source => persona.sourceMessageIds.includes(source.id)) : [],
            personaFields: persona ? [
              ...(persona.selfDescription !== undefined ? ["selfDescription"] : []),
              ...(persona.speakingStyle !== undefined ? ["speakingStyle"] : []),
            ] : [],
          },
        };
      };
      const outcome = await write();
      const finalized = await finalizeReflection(tx, input.userId, reflection.id, {
        decision: outcome.decision, summary: outcome.summary.slice(0, 300),
        pendingPersonaRevision: "pendingPersonaRevision" in outcome ? outcome.pendingPersonaRevision : null,
        resultRef: "resultRef" in outcome ? outcome.resultRef : null,
      });
      if (!finalized) throw new Error("反思终态未保存，撤销本次领域写入");
      return outcome;
    },
  );
  if (!outcome) return;
  logger.info({
    jobId: job.id, conversationId: input.conversationId, decision: outcome.decision,
  }, "companion reflection settled");
}

/**
 * 判断条目走的是与前台 `companion_remember_judgment` 同一套形状：
 * `user_stated=false`、`scope='workspace'`、来源说话者标 `companion`、
 * 认识状态按她如实给的（不为填满 schema 就乐观成 `supported`）。
 *
 * 这里**不**写关于用户的事实（preference / goal 那几类）：那是现役用户记忆准入的领地，
 * 要求用户自己的原话支撑，反思没有资格替他说（§8.2）。
 */
async function insertReflectionJudgment(tx: WorkerTransaction, input: {
  workspaceId: string; userId: string;
}, judgment: { text: string; epistemicStatus: string; appliesWhen?: string; sourceMessageIds: string[] }) {
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO assistant_memory_items
      (workspace_id, user_id, kind, content, source_event_ids,
       source_speaker, source_basis, applies_when,
       user_stated, user_confirmed, candidate, importance, confidence, scope, source_type,
       epistemic_status, author_type, embedding_status, created_at, updated_at)
    VALUES (${input.workspaceId}, ${input.userId}, 'judgment', ${judgment.text},
            ${toTextArrayLiteral(judgment.sourceMessageIds)}::text[], 'companion',
            'companion_interpretation', ${judgment.appliesWhen ?? null},
            false, false, false, 0.3, 0.6, 'workspace', 'model_inferred',
            ${judgment.epistemicStatus}, 'companion', 'none', now(), now())
    RETURNING id
  `);
  const row = (Array.isArray(rows) ? rows : [])[0];
  return row ? String(row.id) : null;
}

/** 合作方法走现役方法域的来源与采用规则（`author='maintenance'`，仍从 `tentative` 起）。 */
async function upsertReflectionMethod(tx: WorkerTransaction, input: {
  workspaceId: string; userId: string;
}, experience: {
  title: string; triggerCondition: string; steps: string[]; exceptions: string[]; sourceMessageIds: string[];
}) {
  const evidence = agentMethodEvidenceV1Schema.array().parse(
    experience.sourceMessageIds.map((id) => ({ eventId: `message:${id}` })));
  // playbookKey 由触发条件定型：同一条件再回顾时命中同一行、只升版本，
  // 不会长出五条措辞不同的"讲机制要举例"。
  const playbookKey = `reflection:${createHash("sha256").update(experience.triggerCondition).digest("hex").slice(0, 24)}`;
  return upsertAgentMethodCandidate(tx,
    { workspaceId: input.workspaceId, userId: input.userId },
    {
      playbookKey, title: experience.title, triggerCondition: experience.triggerCondition,
      steps: experience.steps, exceptions: experience.exceptions,
      evidence, epistemicStatus: "tentative", author: "maintenance",
    });
}

async function finalizeOutcome(
  job: JobPayload,
  userId: string,
  reflectionId: string,
  decision: Exclude<CompanionReflectionDecision, "queued" | "running">,
  summary: string,
  extra: { pendingPersonaRevision?: number | null; resultRef?: Record<string, unknown> | null } = {},
): Promise<void> {
  // A cancelled or reaped attempt cannot settle the reflection owned by a retry.
  if (!await isJobLeaseActive(job)) return;
  await withWorkerWorkspaceTransaction({ workspaceId: job.workspaceId, userId }, async (tx) => {
    await lockJobLease(tx, job);
    const [active] = await tx.execute<{ decision: string; job_id: string }>(sql`
      SELECT decision, job_id FROM companion_reflections WHERE id=${reflectionId}::uuid
        AND user_id=${userId} FOR UPDATE
    `);
    if (active?.decision !== "running" || active.job_id !== job.id) return;
    await finalizeReflection(tx, userId, reflectionId,
      { decision, summary: summary.slice(0, 300), ...extra });
  });
}

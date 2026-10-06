import {
  decideStoredCompactionAttempt, recordCompactionAttemptState,
  type CompactionStateKey,
} from "@ailearn/agent-host";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";
import type { CompactionCooldownPorts } from "./companion-compaction.ts";
import type { ContextPressureReceiptV1 } from "@ailearn/shared/context-budget-contracts";

/**
 * 方案 44 §5.4 后半：把压缩的失败冷却接到真实链路上。
 *
 * 冷却是**跨轮次**的记忆，所以它必须活在数据库里——只存在内存的话，下一轮又是
 * 「第一次尝试」，于是每轮都重折一次。
 *
 * 键的构成理由见 `packages/agent-core/src/context/compaction-cooldown.ts`：
 * （会话, 来源哈希, 模型路由）。换会话、来源重算或换模型都让上一次失败不再适用。
 */
export interface CompactionCooldownContext {
  workspaceId: string;
  userId: string;
  conversationId: string;
  /**
   * 本次压缩针对的**来源版本**：当前摘要的 coverage_source_hash。
   *
   * 由组装回放的那一层给（只有它知道）。没有摘要时返回 null——此时键退化成
   * 「会话 + 模型路由 + 触发线」，仍然能区分「换了什么」与「上一次」，
   * 只是粒度粗一档：同一会话在摘要重算前会共享同一份冷却。
   */
  sourceHash: () => string | null;
  /** 最近一次压力判定；它给出模型路由。 */
  latestPressure: () => ContextPressureReceiptV1 | null;
}

/**
 * 造一份冷却端口。
 *
 * 「折完记一笔」用的是**重发之后**的读数：真正决定有没有进展的是折完还剩多少，
 * 而不是折之前有多少。用折前的数字记，等于每次都记「没变小」。
 */
export function createCompactionCooldownPorts(context: CompactionCooldownContext): CompactionCooldownPorts {
  const keyFor = (): CompactionStateKey | null => {
    const pressure = context.latestPressure();
    if (!pressure) return null;
    return {
      conversationId: context.conversationId,
      sourceHash: context.sourceHash() ?? `pressure:${pressure.triggerTokens}`,
      providerId: pressure.providerId,
      modelId: pressure.modelId,
    };
  };
  return {
    async decide() {
      const key = keyFor();
      if (!key) return { allowed: true, reason: "not_recorded", retryAfterMs: null };
      const decision = await withWorkerWorkspaceTransaction(
        { workspaceId: context.workspaceId, userId: context.userId },
        (tx) => decideStoredCompactionAttempt(tx as WorkerTransaction, { workspaceId: context.workspaceId, userId: context.userId }, key, new Date()),
      );
      return {
        allowed: decision.outcome === "attempt",
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
      };
    },
    async record({ inputTokens, at }) {
      const key = keyFor();
      if (!key) return;
      await withWorkerWorkspaceTransaction(
        { workspaceId: context.workspaceId, userId: context.userId },
        async (tx) => {
          await recordCompactionAttemptState(
            tx as WorkerTransaction,
            { workspaceId: context.workspaceId, userId: context.userId },
            key,
            { inputTokens, reason: "over_trigger_line", at },
          );
        },
      );
    },
  };
}

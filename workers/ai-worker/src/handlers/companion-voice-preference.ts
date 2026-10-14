import { and, eq, sql } from "drizzle-orm";
import { QWEN_TTS_DIALECT_PREFERENCE_KEY, QWEN_TTS_SUPPORTED_DIALECTS } from "@astella/shared/tts-voice-catalog";
import type { AgentPersistentVoicePreferenceV1, AgentVoicePreferenceWriteStatusV1 } from "@astella/shared/agent-contracts";
import { userLearningPreferences } from "@astella/shared/db-schema/companion";
import { withWorkerWorkspaceTransaction, type WorkerTransaction } from "../db.ts";

export function mergePersistentDialectPreference(
  explicitPreferences: Record<string, unknown>,
  change: AgentPersistentVoicePreferenceV1,
): { explicitPreferences: Record<string, unknown>; changed: boolean } {
  if (change.action === "keep") return { explicitPreferences, changed: false };
  if (change.action === "set" && (!change.dialect || !(QWEN_TTS_SUPPORTED_DIALECTS as readonly string[]).includes(change.dialect))) {
    throw new Error("Unsupported persistent Qwen dialect preference");
  }
  const next = { ...explicitPreferences };
  if (change.action === "clear") {
    if (!(QWEN_TTS_DIALECT_PREFERENCE_KEY in next)) return { explicitPreferences, changed: false };
    delete next[QWEN_TTS_DIALECT_PREFERENCE_KEY];
    return { explicitPreferences: next, changed: true };
  }
  if (next[QWEN_TTS_DIALECT_PREFERENCE_KEY] === change.dialect) return { explicitPreferences, changed: false };
  next[QWEN_TTS_DIALECT_PREFERENCE_KEY] = change.dialect;
  return { explicitPreferences: next, changed: true };
}

/** Account-level write; the ordinary TTS preference reader sees it on the next segment/turn. */
export async function persistCompanionDialectPreference(input: {
  workspaceId: string;
  userId: string;
  change: AgentPersistentVoicePreferenceV1;
}): Promise<AgentVoicePreferenceWriteStatusV1> {
  if (input.change.action === "keep") return "not_requested";
  return withWorkerWorkspaceTransaction({ workspaceId: input.workspaceId, userId: input.userId }, async (tx) => {
    const rows = await tx
      .select()
      .from(userLearningPreferences)
      .where(and(
        eq(userLearningPreferences.userId, input.userId),
        sql`${userLearningPreferences.workspaceId} IS NULL`,
      ))
      .for("update");
    const row = rows[0];
    const current = row?.explicitPreferences ?? {};
    const merged = mergePersistentDialectPreference(current, input.change);
    if (!merged.changed) return "unchanged";
    const now = new Date();
    if (!row) {
      await tx.insert(userLearningPreferences).values({
        userId: input.userId,
        explicitPreferences: merged.explicitPreferences,
        suggestedPreferences: {},
        updatedAt: now,
      });
    } else {
      await tx.update(userLearningPreferences)
        .set({ explicitPreferences: merged.explicitPreferences, updatedAt: now })
        .where(eq(userLearningPreferences.id, row.id));
    }
    return "saved";
  });
}

/**
 * 账号里已保存的长期默认方言。合成侧自己会读这一行做口音，正文生成也要读它——
 * 否则用户说「以后都用河南话」之后，她的声音变了、写出来的字还是普通话。
 *
 * 一份判据两个入口：对话链自己开事务走 `readCompanionDialectPreference`，
 * 已经在 worker 事务里的调用方复用当前事务读取。
 */
export async function readStoredDialectPreference(
  tx: WorkerTransaction,
  userId: string,
): Promise<AgentPersistentVoicePreferenceV1["dialect"]> {
  const rows = await tx
    .select({ explicitPreferences: userLearningPreferences.explicitPreferences })
    .from(userLearningPreferences)
    .where(and(
      eq(userLearningPreferences.userId, userId),
      sql`${userLearningPreferences.workspaceId} IS NULL`,
    ))
    .limit(1);
  const stored = rows[0]?.explicitPreferences?.[QWEN_TTS_DIALECT_PREFERENCE_KEY];
  return typeof stored === "string"
    && (QWEN_TTS_SUPPORTED_DIALECTS as readonly string[]).includes(stored)
    ? stored as (typeof QWEN_TTS_SUPPORTED_DIALECTS)[number]
    : null;
}

export async function readCompanionDialectPreference(input: {
  workspaceId: string;
  userId: string;
}): Promise<AgentPersistentVoicePreferenceV1["dialect"]> {
  return withWorkerWorkspaceTransaction(input, tx => readStoredDialectPreference(tx, input.userId));
}

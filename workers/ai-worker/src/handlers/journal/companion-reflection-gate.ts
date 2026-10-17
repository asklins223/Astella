/**
 * 反思的**触发门**（方案 50 §9.1）：这一次到底值不值得花一次模型调用。
 *
 * ## 为什么它是纯函数、而且是结构性的
 *
 * 「用户这次是不是在纠正她」这句话是语义判断，交给回顾那一次的模型去答；
 * 门只回答能从**已记录的事实**算出来的部分：这一段真的来回过吗、上一段是不是已经
 * 回顾过了、这个账号排队的反思是否已经够多。
 *
 * 用关键词去猜"这是不是一次反馈"是这个项目明确不收的那类启发式：猜错一次的代价是
 * 她记住一条用户根本没说过的偏好，而且再也查不出来是从哪一次猜错的。
 *
 * ## 为什么门在两处都判
 *
 * 库里那一版（0400 的 `astella_enqueue_companion_reflection`）负责**少投**，
 * 这里负责**不白花**：从入队到真正执行之间，用户可能又说了话、又删了消息、
 * 或者另一个空间的反思已经把这段之后的内容看过了。
 */

import { COMPANION_REFLECTION_THRESHOLDS } from "@astella/agent-host";
import type { ReflectionInputSnapshotV1 } from "./companion-reflection-content.ts";

export interface ReflectionGateInputV1 {
  readonly userMessageCount: number;
  readonly assistantDeliveredCount: number;
  readonly lastReflectionAt: Date | null;
  readonly openReflectionsForAccount: number;
  readonly now: Date;
}

export type ReflectionGateDecisionV1 =
  | { readonly run: true }
  | { readonly run: false; readonly reason: "too_few_user_turns" | "no_delivered_reply"
      | "interval_not_reached" | "account_backlog_full" };

export function companionReflectionGate(
  input: ReflectionGateInputV1,
  thresholds = COMPANION_REFLECTION_THRESHOLDS,
): ReflectionGateDecisionV1 {
  if (input.userMessageCount < thresholds.minUserMessages) {
    return { run: false, reason: "too_few_user_turns" };
  }
  if (input.assistantDeliveredCount < thresholds.minAssistantMessages) {
    return { run: false, reason: "no_delivered_reply" };
  }
  if (input.lastReflectionAt !== null) {
    const elapsedMs = input.now.getTime() - input.lastReflectionAt.getTime();
    if (elapsedMs < thresholds.minIntervalHours * 60 * 60 * 1000) {
      return { run: false, reason: "interval_not_reached" };
    }
  }
  if (input.openReflectionsForAccount >= thresholds.maxOpenPerAccount) {
    return { run: false, reason: "account_backlog_full" };
  }
  return { run: true };
}

/**
 * 快照够不够格送进模型（§9.1「新内容不足或来源无法读取时安静结束」）。
 *
 * 三条都是**读得出来的事实**，不是判断：
 *  1. 一条消息都没有（会话被删了、权限变了）；
 *  2. 只剩她自己的话，没有用户的原话可以核对；
 *  3. 段落还没落定——末尾是用户正在说话的那一句。她不能在被说到一半的时候
 *     给自己下结论；库里那道入队门也要求同一件事（0400），两边都判是因为
 *     手动投的 job 与重启后补投的 job 不走库那道门。
 */
export function reflectionSnapshotSufficient(
  snapshot: ReflectionInputSnapshotV1,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (snapshot.messages.length === 0) return { ok: false, reason: "no_readable_messages" };
  if (!snapshot.messages.some((message) => message.role === "user")) {
    return { ok: false, reason: "no_user_utterance" };
  }
  if (snapshot.messages[snapshot.messages.length - 1].role !== "assistant") {
    return { ok: false, reason: "segment_not_settled" };
  }
  if (snapshot.persona.revision < 0) return { ok: false, reason: "persona_version_unreadable" };
  return { ok: true };
}

/**
 * 段落窗口只留**最近**那些消息（活口在末尾，不在开头）。
 *
 * 为什么单独抽出来：快照有容量上限，而 SQL 里写 `ORDER BY seq LIMIT n` 会取到**段首**
 * 那几条——一段聊长了，末尾那句刚刚说过的话反而不在她读到的材料里，
 * 「段落是否已经落定」也就会被误判成"还停在用户说话"（2026-10-10 真实栈上就是这么撞上的）。
 * 所以取尾、再按时间正序交给模型。
 */
export function reflectionTailWindow<T extends { seq: number }>(
  rows: readonly T[], max: number,
): T[] {
  return rows.length <= max ? [...rows] : rows.slice(rows.length - max);
}

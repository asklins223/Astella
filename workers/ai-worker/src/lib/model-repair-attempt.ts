import type { ChatMessage } from "@astella/shared";

/** 修正指令的开头：只有这一处这么说，两条链的措辞不会各自漂移。 */
export const REPAIR_HEAD_V1 = "上一次的返回没有通过校验。请只修正下面这一处，其余部分保持不变，然后完整返回严格 JSON。";

/**
 * 修正指令。`detail` 是服务端算出来的**具体**失败原因（哪个节点、哪条引用）；
 * 拿不到具体原因时由调用方给出自己领域的兜底检查项——"哪里没过"泛泛一句，
 * 模型只能把同一份输出再交一遍。
 */
export function repairInstruction(detail: string | null, fallback: string): string {
  return detail ? `${REPAIR_HEAD_V1}\n\n具体原因：${detail}` : `${REPAIR_HEAD_V1}\n\n${fallback}`;
}

/**
 * 校验失败后重试那一发的对话组装：带上模型**上一次真正交回来的那一版**，再接修正指令。
 *
 * 修正指令写的是"只改这一处、其余保持不变"——可"其余"只存在于它刚交出去的那份输出里。
 * 只追加一句批评的话，模型看不到自己被拒的是哪一版，只能整份重画：实测
 * （2026-10-14 脑图，同一篇《瑞利散射》）连烧两发都在同一类块号上翻车，
 * 一发的重试预算就这么白烧完，用户看到的是"这次生成没有完成"。
 *
 * 谁在用：脑图的每一段、拓展的候选与草稿两步。指令文本由调用方决定（它才知道
 * 各自的结构判据叫什么），这里只管形状。
 */
export function buildRepairAttempt(
  request: readonly ChatMessage[],
  rejectedOutput: string | null,
  instruction: string,
): ChatMessage[] {
  const next: ChatMessage = { role: "user", content: instruction };
  // 没有上一版可带（第一次就被别的错误打断）时不编造 assistant 轮。
  if (rejectedOutput === null) return [...request, next];
  return [...request, { role: "assistant", content: rejectedOutput }, next];
}

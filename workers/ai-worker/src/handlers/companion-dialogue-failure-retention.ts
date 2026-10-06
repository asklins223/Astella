/**
 * 一轮**失败**之后把她已经下发的部分留档，以及这件事的两条配套口径。
 *
 * 自 companion-dialogue.ts 拆出（2026-10-06，输入框传图把编排文件推过 1500 行棘轮）。
 * 判据是**域**：这里回答「这一轮没成，用户看过的字怎么留住、没字可留时说哪句」，
 * 编排文件回答「这一轮怎么读进来、这些步怎么走」——留档只在失败收尾时被调用，
 * 不读上下文、不碰 provider，留在编排文件里只会让它多背一份职责。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJsonV1, sha256Utf8V1 } from "@ailearn/shared/content-hash";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { resolveReplyToneEmotion } from "../lib/companion-tone.ts";

/**
 * 用户"停止"后至少留下多少字才算值得留档（2026-09-19）。
 *
 * 与"太短不念"同一口径：一两句寒暄都没说完就停下（如"好"、"嗯我"），
 * 留在历史里是噪音而不是记录。可调，集中在这里改。
 */
export const COMPANION_CANCELLED_MIN_CHARS = 12;

/**
 * 失败兜底话术（方案 29 §4.9：fail-open，绝不空白）。
 *
 * 抱怨 #4「经常性的出现输出不了东西了」的直接来源：任何一道校验判失败时，
 * 旧实现只写一条 `error` 事件就 throw，而 `persistFailedPartial` 在"一个字都没
 * 下发"时**直接放弃落消息**——于是界面上什么都没有，像她突然不理人。
 *
 * 三条轮换（按 runId 确定性取，同一轮重投不会换话，也不会连着两轮一模一样）。
 * 口径：只承认"这句没成"并邀请重试，**不编造任何内容、不虚构已完成的事**，
 * 也不暴露 provider / prompt / 错误码。
 */
const COMPANION_FAILURE_FALLBACK_LINES = [
  "诶，这句我没组织好，你再跟我说一次？",
  "刚刚那句话卡住了，我没听清，你再说一遍嘛。",
  "我走神了一下下，这条没答上来，你重新问我一次？",
] as const;

/** 按 runId 确定性挑一句（同一 run 重投得到同一句，避免话术来回跳）。 */
export function pickCompanionFailureFallbackLine(runId: string): string {
  let hash = 0;
  for (const ch of runId) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  return COMPANION_FAILURE_FALLBACK_LINES[hash % COMPANION_FAILURE_FALLBACK_LINES.length];
}

/**
 * 一轮**失败**之后，把她已经下发给客户端的部分留档（2026-09-19）。
 *
 * 与"用户按停止"那条留档对称：取消路径早就留了 `kind='cancelled'` 的部分记录，
 * 而失败路径此前只写 `error` 事件、**不写消息**——于是气泡里她已经说过的那半句，
 * 在收尾的一瞬间从对话历史里彻底消失（用户看到的是"内容没了"，历史里连这条都查不到）。
 *
 * 三条护栏：
 * - 只在 run 的真实终态是 `failed` 时落（`assistant_message_id IS NULL` 同时保证幂等：
 *   同一个 run 的重试/多次失败收尾不会插出第二条）；用户取消走 `cancelled` 路径，
 *   supersede 走新回合，都不在这里落。
 * - 太短不落（与取消同一个阈值）——碎片是噪音，不是记录。
 * - 不写 `assistant.final` / `character.cue`:事件侧由 `error` 收尾，一个回合出现两个
 *   "结束"会让客户端状态机打架。
 *
 * 落的是**已下发的可见前缀**（`deliveredText`），也就是用户真的看到过的那段字。
 */
export async function persistFailedPartial(args: {
  workspaceId: string;
  userId: string;
  conversationId: string;
  runId: string;
  deliveredText: string;
}): Promise<boolean> {
  // fail-open：已经说出来的半句优先保留；连半句都没有时，落一句诚实的兜底话，
  // 而不是让用户面对空白（旧实现在这里 `return false`，界面什么都不显示）。
  const delivered = args.deliveredText.trim();
  const text = delivered.length >= COMPANION_CANCELLED_MIN_CHARS
    ? delivered
    : pickCompanionFailureFallbackLine(args.runId);
  const blocks = [{ type: "text" as const, text, emotion: resolveReplyToneEmotion(text) }];
  const contentSha256 = sha256Utf8V1(canonicalJsonV1(blocks));
  const messageId = randomUUID();
  try {
    return await withWorkerWorkspaceTransaction(
      { workspaceId: args.workspaceId, userId: args.userId },
      async (tx) => {
        // 先锁住"这一轮确实失败了、且还没留过档"。用 SELECT ... FOR UPDATE 而不是
        // 先写 assistant_message_id：那是指向 companion_messages 的**立即**外键，
        // 消息行还没插进去就回填，整笔事务会被 FK 打回（取消路径踩过这个坑）。
        const claimed = await tx.execute<{ id: string }>(sql`
          SELECT id FROM companion_turn_runs
          WHERE id = ${args.runId} AND status = 'failed' AND assistant_message_id IS NULL
          FOR UPDATE
        `);
        if (!claimed[0]) return false;
        const counters = await tx.execute<{ next_message_seq: string }>(sql`
          UPDATE companion_conversations
          SET next_message_seq = next_message_seq + 1, last_message_at = now()
          WHERE id = ${args.conversationId}
          RETURNING next_message_seq
        `);
        const seqRow = counters[0];
        if (!seqRow) return false;
        await tx.execute(sql`
          INSERT INTO companion_messages
            (id, workspace_id, user_id, conversation_id, seq, role, kind, blocks, run_id, content_sha256)
          VALUES (${messageId}, ${args.workspaceId}, ${args.userId},
                  ${args.conversationId}, ${Number(seqRow.next_message_seq) - 1},
                  'assistant', 'error',
                  ${JSON.stringify(blocks)}, ${args.runId}, ${contentSha256})
        `);
        await tx.execute(sql`
          UPDATE companion_turn_runs
          SET assistant_message_id = ${messageId}, updated_at = now()
          WHERE id = ${args.runId}
        `);
        return true;
      },
    );
  } catch (err) {
    // 留档是"别把用户看过的字弄丢"的补救，不是主链路：它失败不该盖掉真正的失败原因。
    logger.warn({ runId: args.runId, err }, "companion failed-partial retention skipped");
    return false;
  }
}

/**
 * 伴星思考的下发通道（2026-10-13）。
 *
 * 提问轮的实测形状：首个可见正文字之前有 17–26 秒只有内部思考在动
 * （`response.reasoning_text.delta`），这段空白以前一个字都不下发，用户对着的是
 * 一句固定文案。这里把它变成独立的 `assistant.thinking` 事件流。
 *
 * 三条边界，都是这条通道存在的理由：
 * 1. **只看不读**：绝不进入 `companion_stream_delivery` 的可见正文管线，
 *    朗读分段由已提交的可见正文驱动，因此拿不到这里的一个字；
 * 2. **与正文分开留档**：不写 `companion_messages`，避免思考混入答案、复制和语音；
 *    思考文本单独保存在 `companion_turn_runs.thinking_text`，供手记历史读取；流事件仍按
 *    `companion_stream_events` 的既有 TTL 清理；
 * 3. **不带崩正文**：这条通道是辅助。写库失败、run 已失效都只让它自己
 *    停下（`closed`），绝不把错误抛回 provider 的 SSE 读取循环，也不叫停交付。
 *
 * 节流阈值与正文 delta 不同口径：思考的到达速率实测约 5,000 字/秒（正文 40 字
 * 就一轮说完了），所以按「攒够一块 + 最短间隔」写。手记完整留档；气泡只显示尾部。
 */

import { sql } from "drizzle-orm";
import { withWorkerWorkspaceTransaction } from "../db.ts";
import { logger } from "../lib/logger.ts";
import { chunkTextIntoDeltas } from "./companion-dialogue-content.ts";
import type { ReadContext } from "./companion-dialogue-store.ts";

/** 单块上限：与事件合同 `text.max=4000` 同一口径，留出 JSON 开销后仍远小于桌面的 16KB 过桥线。 */
const THINKING_CHUNK_CHARS = 2_000;
/**
 * 攒够这么多字才写一次（思考速率高，块太小只会把连接池打满）。
 *
 * 2026-10-13 用户实测"一卡一卡的"之后收紧一半（800→400）：客户端已经改成每拍
 * 露一小步，但一次到 800 字仍会看出一顿；块切小之后到达更密，代价是一轮落库
 * 从 ~43 次涨到 ~80 次（正文一轮才 3–4 块，这个量级还在同一条管线的预算里）。
 */
const DEFAULT_FLUSH_CHARS = 400;
/** 低频思考也要尽快露面：距上次落库超过这个时间就刷。 */
const DEFAULT_FLUSH_INTERVAL_MS = 180;
/** 每事务最多写几块（与正文 delta 同一形状）。 */
const CHUNKS_PER_TX = 4;

export interface CompanionThinkingDelivery {
  /** provider 的思考增量。同步、绝不抛出——它在 SSE 读取循环里。 */
  onReasoningDelta(text: string): void;
  /** 本轮收尾：把最后一块刷出去（失败也已自行 closed，调用方无需处理返回值）。 */
  finish(): Promise<void>;
  /** 已经交出去多少字（测试/诊断）。 */
  emittedChars(): number;
}

interface ThinkingDeliveryArgs {
  ctx: { workspaceId: string };
  read: Pick<ReadContext, "userId" | "runId" | "conversationId" | "generation" | "accountEpoch">;
  expiresAt: string;
  notifyCompanionEvent: (tx: { execute(q: unknown): Promise<unknown> }, seq: number) => Promise<void>;
  flushChars?: number;
  flushIntervalMs?: number;
  turnBudgetChars?: number;
  /** 落库实现（测试注入用）：不碰数据库即可验证节流、分块与预算语义。 */
  write?: (chunks: readonly { index: number; text: string }[]) => Promise<boolean>;
}

export function createCompanionThinkingDelivery(args: ThinkingDeliveryArgs): CompanionThinkingDelivery {
  const flushChars = args.flushChars ?? DEFAULT_FLUSH_CHARS;
  const flushIntervalMs = args.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const turnBudget = args.turnBudgetChars ?? Number.POSITIVE_INFINITY;
  const notifyCompanionEvent = args.notifyCompanionEvent;

  let pending = "";
  let index = 0;
  let emitted = 0;
  let lastFlushAt = 0;
  /** 关掉后这条通道不再写任何东西：失败/超预算/run 已终态都走这里。 */
  let closed = false;
  /** 串行落库链：同一时刻只有一个思考事务在跑，序号因此单调。 */
  let chain: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | null = null;

  interface ThinkingChunk {
    index: number;
    text: string;
  }

  const writeChunks = async (chunks: readonly ThinkingChunk[]): Promise<boolean> => {
    if (args.write) return chunks.length === 0 || await args.write(chunks);
    for (let i = 0; i < chunks.length; i += CHUNKS_PER_TX) {
      const batch = chunks.slice(i, i + CHUNKS_PER_TX);
      const written = await withWorkerWorkspaceTransaction(
        { workspaceId: args.ctx.workspaceId, userId: args.read.userId },
        async (tx) => {
          const alive = await tx.execute<{ id: string }>(sql`
            UPDATE companion_turn_runs
            SET thinking_text = coalesce(thinking_text, '') || ${batch.map((chunk) => chunk.text).join("")},
                updated_at = now()
            WHERE id = ${args.read.runId} AND status IN ('accepted', 'running')
              AND generation = ${args.read.generation}
            RETURNING id
          `);
          if (!alive[0]) return false;
          const counters = await tx.execute<{ next_event_seq: string }>(sql`
            UPDATE companion_conversations
            SET next_event_seq = next_event_seq + ${batch.length}
            WHERE id = ${args.read.conversationId}
            RETURNING next_event_seq
          `);
          const endSeq = Number(counters[0].next_event_seq) - 1;
          const startSeq = endSeq - batch.length + 1;
          await tx.execute(sql`
            INSERT INTO companion_stream_events
              (conversation_id, seq, workspace_id, user_id, run_id, generation, account_epoch, type, payload, expires_at)
            VALUES ${sql.join(batch.map((chunk, j) => sql`(
              ${args.read.conversationId}, ${startSeq + j}, ${args.ctx.workspaceId}, ${args.read.userId},
              ${args.read.runId}, ${args.read.generation}, ${args.read.accountEpoch}, 'assistant.thinking',
              ${JSON.stringify({ index: chunk.index, text: chunk.text })},
              ${args.expiresAt}
            )`), sql`, `)}
          `);
          await notifyCompanionEvent(tx, endSeq);
          return true;
        },
      );
      if (!written) return false;
    }
    return true;
  };

  const flush = (force: boolean): void => {
    if (closed || pending.length === 0) return;
    if (!force && pending.length < flushChars) return;
    const texts = chunkTextIntoDeltas(pending, THINKING_CHUNK_CHARS).map((chunk) => chunk.textDelta);
    pending = "";
    lastFlushAt = Date.now();
    const chunks = texts.map((text) => ({ index: index++, text }));
    emitted += texts.join("").length;
    if (emitted >= turnBudget) closed = true;
    chain = chain.then(() => writeChunks(chunks)).then((ok) => {
      if (!ok) closed = true;
    }).catch((err) => {
      // 与正文交付相反：这里叫停没有任何收益，思考少一段不影响她回答。
      closed = true;
      logger.warn({ err, runId: args.read.runId }, "companion thinking stream emit skipped");
    });
  };

  return {
    onReasoningDelta(text: string): void {
      if (closed || text.length === 0) return;
      const room = turnBudget - emitted - pending.length;
      if (room <= 0) {
        closed = true;
        return;
      }
      pending += text.length > room ? text.slice(0, room) : text;
      flush(false);
      if (!closed && pending.length > 0 && timer === null) {
        const wait = Math.max(0, flushIntervalMs - (Date.now() - lastFlushAt));
        timer = setTimeout(() => { timer = null; flush(true); }, wait);
      }
    },

    async finish(): Promise<void> {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      flush(true);
      await chain.catch(() => undefined);
    },

    emittedChars(): number {
      return emitted;
    },
  };
}

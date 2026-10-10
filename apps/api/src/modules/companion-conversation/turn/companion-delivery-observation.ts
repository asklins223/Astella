/**
 * 上一句朗读的实际交付背景（方案 50 §10.2）。
 *
 * ## 为什么在 API 侧、在接受回合的那一刻算
 *
 * 权威行是 `companion_tts_outcomes`（0246/0247）。worker 对那张表**刻意没有读边**，
 * 而"她这一轮看到了什么"必须是可回放的事实——所以由持有那侧读边的 API 在写 run 行时
 * 算一份有界投影存下去，而不是让 worker 现场去查一次运气。
 *
 * ## 三条口径
 *
 * - **只在真有必要时说**。全部段落都播成了、也没有失败段，就是 null：她不必每轮
 *   复述一遍"我上次播完了"。
 * - **不猜没播到的位置**。合同里没有"播到第几个字"这一格，因为权威行只有段粒度；
 *   段内位置只能标成"未播完"，谁填了具体位置就是在编。
 * - `rejected` 与 `failed` 分开看：前者是"没尝试"（静音、窗口不可见），
 *   那不该被说成"播失败了"。
 */
import { sql } from "drizzle-orm";
import { companionObservationSetV1Schema } from "@astella/shared";
import type { ApiTransaction } from "../../../db/client.ts";

/** 一条回行的形状（只取算投影要用的那三列）。 */
type OutcomeRow = { segment_id: string; stage: string; outcome: string; created_at: Date };

export const COMPANION_DELIVERY_OBSERVATION_TTL_HOURS = 24;

/**
 * 把段粒度回执压成一份交付观察。
 *
 * 返回 null 表示"这一轮不需要带这个背景"——两种情况：这一轮之前根本没有朗读，
 * 或者上一句完完整整播完了。
 */
export function projectDeliveryObservation(args: {
  rows: OutcomeRow[];
  workspaceId: string;
  userId: string;
  conversationId: string;
  previousRunId: string;
  currentRunId: string;
  observedAt: Date;
}) {
  const prepared = new Set<string>();
  const played = new Set<string>();
  const failed = new Set<string>();
  const refused = new Set<string>();
  let lastPlaybackAt: Date | null = null;
  for (const row of args.rows) {
    if (row.stage === "synth" && row.outcome === "ok") prepared.add(row.segment_id);
    if (row.stage !== "playback") continue;
    lastPlaybackAt = row.created_at > (lastPlaybackAt ?? new Date(0)) ? row.created_at : lastPlaybackAt;
    if (row.outcome === "ok") played.add(row.segment_id);
    else if (row.outcome === "failed") failed.add(row.segment_id);
    else refused.add(row.segment_id);
  }
  // 只算合成成功过的那些段：合成失败的那段本来就没有声音可播，
  // 把它记进"没播完"会把引擎问题说成她话说了一半。
  // `rejected` 同理但更明显：那是**根本没尝试**（静音、窗口不可见、回合已取消），
  // 那一句本来就没出声——既不是"播到一半被打断"，也不是"播失败"，什么都不该带。
  const attempted = [...prepared].filter((id) => !refused.has(id));
  const unplayed = attempted.filter((id) => !played.has(id));
  if (attempted.length === 0) return null;
  if (unplayed.length === 0 && failed.size === 0) return null;
  const occurredAt = (lastPlaybackAt ?? args.observedAt).toISOString();
  return companionObservationSetV1Schema.parse({
    version: 1,
    observations: [{
      version: 1,
      sourceId: `companion_tts_outcomes:${args.previousRunId}`,
      kind: "delivery",
      producer: "device",
      scope: {
        workspaceId: args.workspaceId, userId: args.userId,
        conversationId: args.conversationId, runId: args.previousRunId,
        referencedVersion: args.previousRunId,
      },
      occurredAt,
      observedAt: args.observedAt.toISOString(),
      trust: "device_recorded",
      purpose: "current_context_clue",
      withdrawal: {
        invalidatedWhenSourceChanges: true,
        // 过期只表示"这条线索别再当新消息用"，不删任何权威行。
        expiresAt: new Date(args.observedAt.getTime()
          + COMPANION_DELIVERY_OBSERVATION_TTL_HOURS * 3_600_000).toISOString(),
      },
      payload: {
        segmentsPlayed: played.size,
        segmentsPrepared: attempted.length,
        failedSegmentCount: failed.size,
        unfinishedPlayback: unplayed.length > 0,
        lastOutcomeAt: lastPlaybackAt ? lastPlaybackAt.toISOString() : null,
      },
    }],
    // 段粒度的一条观察就够这一轮用；将来多来源时超出上限的条数在这里被数下来，
    // 而不是被静默丢掉（§12.2 要能分辨"没带上"与"本来就没有"）。
    droppedCount: 0,
  });
}

/**
 * 读「上一句被交付的那一轮」的回执并投影成一次观察。
 *
 * 权威对象是这一条会话里最后一个**已经交出正文**的伴星回合——只有那一句可能被朗读过，
 * 也只有它说得清"刚才那句话播到哪"。选它的判据是 run 行自己的时间与身份，
 * 不是"翻消息列表看到最后一条 assistant"那种模糊说法。
 *
 * 一条 SQL 走完：先定位那一轮，再带出它的回执（`companion_tts_outcomes` 的
 * `(run_id, ordinal)` 索引就是为这种取法留的）。那一轮没有回执（纯文字回复、
 * 朗读没开）时返回 null——观察不存在，而不是"存在且一切正常"。
 */
export async function loadCompanionDeliveryObservation(tx: ApiTransaction, args: {
  workspaceId: string; userId: string; conversationId: string; observedAt: Date;
}): Promise<Record<string, unknown> | null> {
  const rows = await tx.execute<OutcomeRow & { run_id: string }>(sql`
    WITH delivered AS (
      SELECT id FROM companion_turn_runs
      WHERE conversation_id = ${args.conversationId}::uuid
        AND workspace_id = ${args.workspaceId}::uuid AND user_id = ${args.userId}::uuid
        AND status = 'succeeded' AND assistant_message_id IS NOT NULL
        -- 上一句交付得比 TTL 还早时，这条观察出生即过期：不必再算，直接不带。
        AND created_at > now() - make_interval(hours => ${COMPANION_DELIVERY_OBSERVATION_TTL_HOURS})
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
    SELECT o.segment_id, o.stage, o.outcome, o.created_at, o.run_id
    FROM delivered d
    JOIN companion_tts_outcomes o ON o.run_id = d.id
      AND o.workspace_id = ${args.workspaceId}::uuid AND o.user_id = ${args.userId}::uuid
    ORDER BY o.ordinal, o.created_at
  `);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const previousRunId = String(rows[0].run_id);
  const projected = projectDeliveryObservation({
    rows,
    workspaceId: args.workspaceId, userId: args.userId,
    conversationId: args.conversationId, previousRunId,
    currentRunId: "", observedAt: args.observedAt,
  });
  return projected ? JSON.parse(JSON.stringify(projected)) : null;
}

/**
 * 缺口帮助的落库读侧（39d W4-6 刀四；PRD §5.3）。
 *
 * 判据本身在 `gap-help-policy.ts`（纯函数，不碰库）；这一份只做它需要的那点读取：
 * 把"这一轮里哪条缺口被帮过几次、帮完之后是什么结论"从库里拼成一条时间线，
 * 再交给 `shouldStopAutoAddingQuestionsV1` 决定停不停。
 *
 * 三个身份各来自不同的行（这是缺口身份的全部来源，别在别处再拼一份）：
 *
 *  - **一次帮助** = `learning_run_events` 的一行 `learning_task.hint_requested`
 *    （写侧先例 `run-service` 的 `request_hint`；读侧先例 tick 的 `hasHintExposure`）。
 *    它的 payload 里有 `taskId`——那才是"帮的是哪道题"，run 只是装它的壳。
 *  - **一次结论** = `learning_runs.result ->> 'outcome'`（七档，只在结算之后才有）。
 *  - **缺口身份** = `learning_runs.origin ->> 'objectiveId'`（哪个目标）
 *    ＋ `learning_tasks.intent`（哪一类题）——同一目标上的"回忆题"和"补修题"
 *    不是同一条缺口，分开计数才不会被两件不同的事凑出"两次帮助"。
 *
 * 时间线的排法：run 按开出先后（`created_at`）排，run 内**帮助在前、结论在后**。
 * 为什么不做逐事件的精确插值：结论落在一行 jsonb 上、没有自己的时间戳，硬排一个
 * "结论发生在两次帮助之间"的位置是编的；而"这次帮助之后产生了这个结论"这个更粗的
 * 顺序在真链路上恒成立（结论只可能在该 run 的最后一次提交之后写）。计数只关心
 * "最近一次改善之后帮了几次"，这个粒度够用。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  learningRunEvents,
  learningRuns,
  learningTasks,
} from "@ailearn/shared/db-schema/learning-runs";
import { learningRunOutcomeSchema } from "@ailearn/shared/learning-run-contracts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  gapHelpStopThresholdV1,
  shouldStopAutoAddingQuestionsV1,
  type GapHelpTimelineEntryV1,
} from "./gap-help-policy.ts";

/** 「一次帮助」的写入类型：与 `run-service` 的 `request_hint` 同一行、同一字符串。 */
export const GAP_HELP_EVENT_TYPE_V1 = "learning_task.hint_requested";

/** 一条缺口在拼装过程中的累积状态。 */
interface GapAccumulatorV1 {
  readonly objectiveId: string;
  readonly intent: string | null;
  readonly timeline: GapHelpTimelineEntryV1[];
  /** 时间线上最后一条的全局序号：同分时用它判"更晚出现"（见下面的选法）。 */
  lastIndex: number;
}

/**
 * 这一轮的缺口帮助读侧：返回计数最大那条缺口的结果。
 *
 * 选择规则（写死在注释里，免得下次有人"顺手"改成别的口径）：
 *  1. 只在**有事件落在上面**的缺口里选（有练习 run 但既没帮过、也没结论 ⇒ 没有缺口，
 *     返回 null——"还没练过"和"练了没事"必须分得开）。
 *  2. 按 `consecutiveHelpCount`（判据自己数的那个"连续帮助次数"）取最大；
 *     平手取**更晚出现**的那条（`lastIndex` 更大）——两条缺口一样多时，
 *     用户正在做的那一条才是该拿来判断的。
 *  3. `stopped` 就是选中那条的结果。这不是"漏掉了别的缺口"：计数达到阈值时，
 *     该 gap 的最近一次结论必然不是"改善"（时间线是从后往前数到改善为止的），
 *     所以计数最大的那条停了 ⟺ 任何一条停了。
 *
 * 没有练习 run 时返回 `stopped: false` / `gap: null`：这一轮还没练过，谈"停"没有主语。
 */
export async function readRoundGapHelpV1(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  roundId: string,
  objectiveId?: string | null,
): Promise<{
  stopped: boolean;
  consecutiveHelpCount: number;
  threshold: number;
  /** 触发/计数用的那条缺口；这一轮没有练习缺口时是 null。 */
  gap: { objectiveId: string; intent: string | null } | null;
}> {
  const threshold = gapHelpStopThresholdV1();
  if (objectiveId === null) {
    return { stopped: false, consecutiveHelpCount: 0, threshold, gap: null };
  }
  const runRows = await tx
    .select({
      runId: learningRuns.id,
      origin: learningRuns.origin,
      result: learningRuns.result,
    })
    .from(learningRuns)
    .where(and(
      eq(learningRuns.workspaceId, scope.workspaceId),
      eq(learningRuns.userId, scope.userId),
      // 与 `listNoteRoundPractices` 同一读法：练习的锚点在这一轮上。
      sql`${learningRuns.origin} ->> 'roundId' = ${roundId}`,
      objectiveId ? sql`${learningRuns.origin} ->> 'objectiveId' = ${objectiveId}` : undefined,
    ))
    .orderBy(asc(learningRuns.createdAt), asc(learningRuns.id));
  if (runRows.length === 0) {
    return { stopped: false, consecutiveHelpCount: 0, threshold, gap: null };
  }

  const runIds = runRows.map((row) => row.runId);
  const [taskRows, helpRows] = await Promise.all([
    tx
      .select({
        id: learningTasks.id,
        runId: learningTasks.runId,
        sequence: learningTasks.sequence,
        intent: learningTasks.intent,
      })
      .from(learningTasks)
      .where(inArray(learningTasks.runId, runIds))
      .orderBy(asc(learningTasks.sequence)),
    tx
      .select({
        runId: learningRunEvents.runId,
        payload: learningRunEvents.payload,
        sequence: learningRunEvents.sequence,
      })
      .from(learningRunEvents)
      .where(and(
        inArray(learningRunEvents.runId, runIds),
        eq(learningRunEvents.eventType, GAP_HELP_EVENT_TYPE_V1),
      ))
      .orderBy(asc(learningRunEvents.occurredAt), asc(learningRunEvents.sequence)),
  ]);

  const tasksByRun = new Map<string, { id: string; intent: string | null }[]>();
  for (const task of taskRows) {
    const list = tasksByRun.get(task.runId) ?? [];
    list.push({ id: task.id, intent: task.intent });
    tasksByRun.set(task.runId, list);
  }
  const helpsByRun = new Map<string, string[]>();
  for (const event of helpRows) {
    // payload 是 jsonb，形状不可信：只认得出 taskId 的那一行才算一次帮助。
    const taskId = (event.payload as { taskId?: unknown } | null)?.taskId;
    if (typeof taskId !== "string" || taskId.length === 0) continue;
    const list = helpsByRun.get(event.runId) ?? [];
    list.push(taskId);
    helpsByRun.set(event.runId, list);
  }

  const gaps = new Map<string, GapAccumulatorV1>();
  /** 时间线上的全局序号：只在同分平手时用（见函数头第 2 条）。 */
  let position = 0;
  /**
   * 帮助事件里认不出 `taskId` 时归到该 run 最后一道题上：那次帮助确实发生在这场里，
   * 认不出题就让这一次凭空消失，等于把"该停"算成"没到"——宁可算在这一场上。
   */
  const pushEntry = (objectiveId: string, intent: string | null, entry: GapHelpTimelineEntryV1) => {
    const key = `${objectiveId}\u0000${intent ?? ""}`;
    const acc = gaps.get(key) ?? { objectiveId, intent, timeline: [], lastIndex: -1 };
    acc.timeline.push(entry);
    acc.lastIndex = position;
    position += 1;
    gaps.set(key, acc);
  };

  for (const run of runRows) {
    const objectiveId = (run.origin as { objectiveId?: unknown } | null)?.objectiveId;
    // 没有目标就没有缺口身份（`note_round` 的 origin 必填 objectiveId，这里只是
    // 对脏行 fail closed：认不出缺口的行不参与判断，也不冒充成别人的一条）。
    if (typeof objectiveId !== "string" || objectiveId.length === 0) continue;
    const tasks = tasksByRun.get(run.runId) ?? [];
    const intentByTaskId = new Map(tasks.map((task) => [task.id, task.intent]));
    // run 的结论算在哪道题上：最后那道（sequence 最大）——结算写的正是它。
    const latestIntent = tasks.length > 0 ? (tasks[tasks.length - 1]?.intent ?? null) : null;

    for (const taskId of helpsByRun.get(run.runId) ?? []) {
      pushEntry(objectiveId, intentByTaskId.get(taskId) ?? latestIntent, { kind: "help" });
    }
    const outcome = (run.result as { outcome?: unknown } | null)?.outcome;
    if (typeof outcome === "string") {
      const parsed = learningRunOutcomeSchema.safeParse(outcome);
      // 只认得出名字的那七档：`result` 是历史形状自由的 jsonb，读侧不拿不认识的
      // 字符串去当结论（它会被判据当成"没有改善的证据"，那是替脏数据下结论）。
      if (parsed.success) pushEntry(objectiveId, latestIntent, { kind: "outcome", outcome: parsed.data });
    }
  }

  let picked: (GapAccumulatorV1 & { stopped: boolean; consecutiveHelpCount: number }) | null = null;
  for (const acc of gaps.values()) {
    const verdict = shouldStopAutoAddingQuestionsV1({ timeline: acc.timeline, threshold });
    const candidate = { ...acc, ...verdict };
    if (
      picked === null
      || candidate.consecutiveHelpCount > picked.consecutiveHelpCount
      || (candidate.consecutiveHelpCount === picked.consecutiveHelpCount && candidate.lastIndex > picked.lastIndex)
    ) {
      picked = candidate;
    }
  }
  if (!picked) return { stopped: false, consecutiveHelpCount: 0, threshold, gap: null };
  return {
    stopped: picked.stopped,
    consecutiveHelpCount: picked.consecutiveHelpCount,
    threshold,
    gap: { objectiveId: picked.objectiveId, intent: picked.intent },
  };
}

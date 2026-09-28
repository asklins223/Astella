/**
 * 星图三层展开的**读侧**（39d W8-1、W8-3；39 §11.2、§11.4、§11.5、§16.12）。
 *
 * ── 这一发为什么存在，而不是把层二／层三塞进拓扑快照 ──────────────────────
 * 拓扑快照回答"图上有哪些节点"，这一发回答"沿着一篇笔记往下读会依次看到什么"。
 * §11.5 写死了「总览只显示当前层，局部按需加载」——把学习记录塞进整张快照，等于
 * 让每一次读星图都把**每一篇**笔记的作答与反馈搬一遍，而用户当下只要了一篇。
 *
 * ── §11.2 第三行那五格，各自的事实来自哪里 ──────────────────────────────
 *  | §11.2 第三行 | 本文件读的地方                                             |
 *  | --- | --- |
 *  | 真实回答 | `learning_artifacts.payload`，只取 `status='locked'`（§12.3 不可变）|
 *  | 反馈   | `learning_assessments.rubric_results` 的 `userFacingReason`（**只带给人看的那句**）|
 *  | 日期   | `learning_artifacts.locked_at ?? created_at`（这一次作答的落库时刻）   |
 *  | 材料依据 | `learning_objective_origins_v2.evidence_snapshot_ids` → 快照描述   |
 *  | 可选卡片 | `learning_cards_v2`（lifecycle=active）——**可选项**，没有就是 `null`  |
 *
 * ── 「独立 / 借助」那一格**怎么判**（这一格最容易变成编造）──────────────────
 * §11.4「曾接触、借助完成、某次独立用过」问的是**那一次有没有人帮**。这件事库里
 * 有直接的凭据：`learning_exposures_v2`（答案揭示／证据揭示）。**不用** rubric
 * 的 `partial`／`missing` 反推——那是"讲到了没有"，不是"有没有人帮"，拿它当
 * 「借助」就是把评估器的判词改写成一句关于她本人的话（§11.4「不用模型推断比例
 * 画理解」的同一条禁令，只是发生在更小的一格上）。两档都判不出来的（既没有暴露
 * 记录也没有 canonical 事件）就**不计入任何一档**。
 */
import { semanticRelationOfV2 } from "./relation-kind.ts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ApiTransaction } from "../../db/client.ts";
import { notes } from "@ailearn/shared/db-schema/note";
import { noteLearningRounds } from "@ailearn/shared/db-schema/note-learning-rounds";
import {
  learningAssessments,
  learningArtifacts,
  learningRuns,
  canonicalLearningEventOutbox,
} from "@ailearn/shared/db-schema/learning-runs";
import {
  evidenceSnapshotsV2,
  learningCardsV2,
  learningExposuresV2,
  learningObjectiveOriginsV2,
  learningObjectiveRevisionsV2,
  learningObjectivesV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { objectiveReviewHoldsV2, reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import { artifactPayloadSchema } from "@ailearn/shared/learning-run-contracts";
import { objectiveSurfaceFreshnessV1, type ObjectivePersonalStateV3 } from "@ailearn/shared/learning-objective-surface-contracts";
import {
  buildNoteDeepeningV3,
  type NoteDeepeningObjectiveV3,
  type NoteDeepeningRecordV3,
  type NoteDeepeningRelationV3,
  type NoteDeepeningV3,
} from "@ailearn/shared/note-deepening-v3-contracts";
import type { UnderstandingEdgeProjectionV3 } from "@ailearn/shared/understanding-topology-v3-contracts";
import { visibleCardsCondition, visibleNotesCondition, visibleObjectivesCondition } from "../note/visibility.ts";

export interface NoteDeepeningContext {
  workspaceId: string;
  userId: string;
}

/** 笔记读不到（不存在／软删／权限遮蔽）。三种情况对外是同一个形状。 */
export class NoteNotReadableV3 extends Error {
  constructor() {
    super("note_not_readable");
  }
}

/**
 * 一次读里每个集合的上限，与 `topology-repository` 同一套纪律：多取一行探测截断、
 * 超限就**如实**回报，不静默少列（§11.5「截断数据明确说明」）。
 */
export const NOTE_DEEPENING_DEFAULT_LIMIT = 200;
export const NOTE_DEEPENING_MAX_LIMIT = 500;

export function resolveNoteDeepeningLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return NOTE_DEEPENING_DEFAULT_LIMIT;
  return Math.min(parsed, NOTE_DEEPENING_MAX_LIMIT);
}

/**
 * 稳定排序 + 多取一行探针。
 *
 * 排序键是**本查询自己的稳定键**（`createdAt DESC, id DESC` 之类的），所以丢掉
 * 哪些行在请求间确定；不确定的话翻两次页读数会跳，而读数是屏上唯一的事实。
 */
function bounded<T>(rows: T[], limit: number): { page: T[]; complete: boolean } {
  if (rows.length <= limit) return { page: rows, complete: true };
  return { page: rows.slice(0, limit), complete: false };
}

/** 学习记录的自然日（按 UTC 日切）。「跨时间有重复证据」问的是**跨日**，不是跨分钟。 */
function utcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * 一条作答的形态。
 *
 * **结构化作答没有"一句可念的回答"**（排序、配对、选择、真假），那一格如实是
 * `null`。写成"用户选择了 B"是让屏上多一句系统自己造的句子——§11.2「不伪造」
 * 的同一条纪律，只是发生在更小的一格上。
 */
export function answerOfDeepeningV3(payload: unknown): {
  form: NoteDeepeningRecordV3["answerForm"];
  text: string | null;
} {
  const parsed = artifactPayloadSchema.safeParse(payload);
  if (!parsed.success) return { form: "none", text: null };
  const value = parsed.data;
  if (value.kind === "text") {
    const text = value.text.trim();
    return text ? { form: "prose", text } : { form: "none", text: null };
  }
  if (value.kind === "voice") {
    const text = value.confirmedTranscript.trim();
    return text ? { form: "voice_transcript", text } : { form: "none", text: null };
  }
  return { form: "structured", text: null };
}

const FEEDBACK_VERDICTS = new Set(["covered", "partial", "missing", "contradicted", "not_assessable"]);

/**
 * 反馈只带**给人看的那一句**。
 *
 * 私有 rubric／私有标准答案一个字都不带（§13.2：history 只返回可信公开摘要）。
 * 一条 `not_assessable` 的理由若为空句，就**不列**——宁可少一条反馈，也不要在屏上
 * 写一句"没有可判的反馈"冒充评估器说过的话。
 */
export function feedbackOfDeepeningV3(rubricResults: unknown): NoteDeepeningRecordV3["feedback"] {
  if (!Array.isArray(rubricResults)) return [];
  const out: NoteDeepeningRecordV3["feedback"] = [];
  for (const item of rubricResults) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { verdict?: unknown; userFacingReason?: unknown };
    if (typeof record.verdict !== "string" || !FEEDBACK_VERDICTS.has(record.verdict)) continue;
    const reason = typeof record.userFacingReason === "string" ? record.userFacingReason.trim() : "";
    if (!reason) continue;
    out.push({
      verdict: record.verdict as NoteDeepeningRecordV3["feedback"][number]["verdict"],
      reason: reason.slice(0, 1000),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 目标个人状态。
 *
 * **与 `topology-repository` 同一份优先级**（archived > superseded > 在跑的一轮 >
 * 到期 > 已排期 > 依据已变 > 稳定 > 还没碰过）。抄第二份就会让同一颗目标在首页与
 * 星图上各说一句话——39d D3 §5.1 记过一次这种病。
 */
export function objectivePersonalStateForDeepeningV3(input: {
  readonly lifecycle: string;
  readonly hasActiveRun: boolean;
  readonly reviewDue: boolean;
  readonly scheduled: boolean;
  readonly basisUpdated: boolean;
  readonly hasCanonical: boolean;
}): ObjectivePersonalStateV3 {
  if (input.lifecycle === "archived") return "archived";
  if (input.lifecycle === "superseded") return "superseded";
  if (input.hasActiveRun) return "learning";
  if (input.reviewDue) return "due_review";
  if (input.scheduled) return "scheduled";
  if (input.basisUpdated) return "outdated";
  return input.hasCanonical ? "stable" : "unvalidated";
}



/**
 * 读一篇笔记的层二与层三。
 *
 * `snapshotEdges` 是**可选**的：关系那一层靠它把 `relates_to` 边连起来，而它
 * 本来就在 W8-2 的投影里（本人的表态已叠好）。不给就只出目标与记录，关系是空
 * 数组——**空数组**而不是编出来的边。
 */
export async function readNoteDeepeningV3(
  tx: ApiTransaction,
  ctx: NoteDeepeningContext,
  noteId: string,
  options: { limit?: number; snapshotEdges?: readonly UnderstandingEdgeProjectionV3[] } = {},
): Promise<NoteDeepeningV3> {
  const limit = resolveNoteDeepeningLimit(options.limit);

  // ── 笔记本体：读不到就 404（不返回"空的那一份"）────────────────────────
  const [note] = await tx
    .select({ id: notes.id, title: notes.title, sourceId: notes.sourceId, currentVersionId: notes.currentVersionId })
    .from(notes)
    .where(and(
      eq(notes.workspaceId, ctx.workspaceId),
      eq(notes.id, noteId),
      visibleNotesCondition(ctx.userId),
      isNull(notes.deletedAt),
    ))
    .limit(1);
  if (!note) throw new NoteNotReadableV3();

  // ── 这一篇长出来的目标（origin 才是"从这篇正文长出来"的凭据）────────────
  const originRows = await tx
    .select({
      objectiveId: learningObjectiveOriginsV2.objectiveId,
      noteVersionId: learningObjectiveOriginsV2.noteVersionId,
      evidenceSnapshotIds: learningObjectiveOriginsV2.evidenceSnapshotIds,
    })
    .from(learningObjectiveOriginsV2)
    .where(and(
      eq(learningObjectiveOriginsV2.workspaceId, ctx.workspaceId),
      eq(learningObjectiveOriginsV2.noteId, noteId),
    ))
    .orderBy(learningObjectiveOriginsV2.objectiveId);
  // 一个目标可能有多条 origin（§TP-03 multi-origin）；证据 id 取**并集**。
  const evidenceByObjective = new Map<string, Set<string>>();
  const noteAnchorsByObjective = new Map<string, Array<{ noteId: string; noteVersionId: string | null }>>();
  for (const row of originRows) {
    const set = evidenceByObjective.get(row.objectiveId) ?? new Set<string>();
    for (const id of (row.evidenceSnapshotIds ?? []) as string[]) set.add(id);
    evidenceByObjective.set(row.objectiveId, set);
    const anchors = noteAnchorsByObjective.get(row.objectiveId) ?? [];
    if (row.noteVersionId) anchors.push({ noteId, noteVersionId: row.noteVersionId });
    noteAnchorsByObjective.set(row.objectiveId, anchors);
  }
  const originCountByObjective = new Map<string, number>();
  for (const row of originRows) {
    originCountByObjective.set(row.objectiveId, (originCountByObjective.get(row.objectiveId) ?? 0) + 1);
  }
  const objectiveIds = [...new Set(originRows.map((row) => row.objectiveId))];

  const objectiveRows = objectiveIds.length > 0
    ? await tx
        .select({
          objectiveId: learningObjectivesV2.objectiveId,
          lifecycle: learningObjectivesV2.lifecycle,
          currentObjectiveRevisionId: learningObjectivesV2.currentObjectiveRevisionId,
        })
        .from(learningObjectivesV2)
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectivesV2.objectiveId, objectiveIds),
          // 别人私有、她读不到的目标不列——§16.20 只读成员的路径与可见性一致。
          visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
        ))
        .orderBy(learningObjectivesV2.objectiveId)
    : [];
  const readableObjectiveIds = objectiveRows.map((row) => row.objectiveId);

  const revisionRows = objectiveRows.length > 0
    ? await tx
        .select({
          objectiveId: learningObjectiveRevisionsV2.objectiveId,
          conceptLabel: learningObjectiveRevisionsV2.conceptLabel,
          publicSummary: learningObjectiveRevisionsV2.publicSummary,
        })
        .from(learningObjectiveRevisionsV2)
        .where(and(
          eq(learningObjectiveRevisionsV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectiveRevisionsV2.objectiveRevisionId,
            objectiveRows.map((row) => row.currentObjectiveRevisionId).filter(Boolean) as string[]),
          visibleObjectivesCondition(ctx.userId, learningObjectiveRevisionsV2.objectiveId),
        ))
    : [];
  const revisionByObjective = new Map(revisionRows.map((row) => [row.objectiveId, row]));

  // ── 每条目标的当前事实：在跑的一轮、到期回访、记忆卡、本人是否暂不安排 ──
  const [activeRunRows, scheduleRows, cardRows, holdRows] = await Promise.all([
    readableObjectiveIds.length > 0
      ? tx
          .select({ runId: learningRuns.id, phase: learningRuns.phase, createdAt: learningRuns.createdAt,
            objectiveId: sql<string>`${learningRuns.origin}->>'objectiveId'` })
          .from(learningRuns)
          .where(and(
            eq(learningRuns.workspaceId, ctx.workspaceId),
            eq(learningRuns.userId, ctx.userId),
            sql`${learningRuns.origin}->>'objectiveId' IN (${sql.join(readableObjectiveIds.map((id) => sql`${id}`), sql`, `)})`,
            inArray(learningRuns.phase, ["preparing", "active", "assessing", "checkpoint", "committing", "paused"]),
          ))
          .orderBy(desc(learningRuns.createdAt), desc(learningRuns.id))
      : Promise.resolve([] as Array<{ runId: string; phase: string; createdAt: Date; objectiveId: string }>),
    readableObjectiveIds.length > 0
      ? tx
          .select({ subjectId: reviewSchedules.subjectId, nextReviewAt: reviewSchedules.nextReviewAt })
          .from(reviewSchedules)
          .where(and(
            eq(reviewSchedules.workspaceId, ctx.workspaceId),
            eq(reviewSchedules.userId, ctx.userId),
            eq(reviewSchedules.subjectType, "card"),
            eq(reviewSchedules.status, "pending"),
            inArray(reviewSchedules.subjectId, readableObjectiveIds),
          ))
      : Promise.resolve([] as Array<{ subjectId: string; nextReviewAt: Date }>),
    readableObjectiveIds.length > 0
      ? tx
          .select({ objectiveId: learningCardsV2.objectiveId, cardId: learningCardsV2.cardId })
          .from(learningCardsV2)
          .where(and(
            eq(learningCardsV2.workspaceId, ctx.workspaceId),
            inArray(learningCardsV2.objectiveId, readableObjectiveIds),
            eq(learningCardsV2.lifecycle, "active"),
            visibleCardsCondition(ctx.userId, learningCardsV2.noteVersionId),
          ))
      : Promise.resolve([] as Array<{ objectiveId: string; cardId: string }>),
    readableObjectiveIds.length > 0
      ? tx
          .select({ objectiveId: objectiveReviewHoldsV2.objectiveId })
          .from(objectiveReviewHoldsV2)
          .where(and(
            eq(objectiveReviewHoldsV2.workspaceId, ctx.workspaceId),
            eq(objectiveReviewHoldsV2.userId, ctx.userId),
            inArray(objectiveReviewHoldsV2.objectiveId, readableObjectiveIds),
            isNull(objectiveReviewHoldsV2.releasedAt),
          ))
      : Promise.resolve([] as Array<{ objectiveId: string }>),
  ]);

  const activeRunByObjective = new Map<string, string>();
  for (const run of activeRunRows) {
    if (run.objectiveId && !activeRunByObjective.has(run.objectiveId)) {
      activeRunByObjective.set(run.objectiveId, run.runId);
    }
  }
  const scheduleByObjective = new Map(scheduleRows.map((row) => [row.subjectId, row.nextReviewAt]));
  const cardByObjective = new Map(cardRows.map((row) => [row.objectiveId, row.cardId]));
  const heldObjectiveIds = new Set(holdRows.map((row) => row.objectiveId));
  const now = new Date();

  // ── 关系：语义关系那一族（§11.3），血缘与证据链接不进这一层 ───────────
  let relations: NoteDeepeningRelationV3[] = [];
  if (options.snapshotEdges && readableObjectiveIds.length > 0) {
    const readable = new Set(readableObjectiveIds);
    const labelByObjective = new Map<string, string>(
      objectiveRows.map((row) => [
        row.objectiveId,
        revisionByObjective.get(row.objectiveId)?.conceptLabel ?? "未命名目标",
      ]),
    );
    // 另一端不在本篇里的关系也列（§11.3 明确前置可能指向另一篇）——但只列
    // **读得到**的那一端；读不到就整条不出现（没有名字的关系没法"查看理由"）。
    const otherObjectiveIds = [...new Set(
      options.snapshotEdges.flatMap((edge) => [edge.from, edge.to])
        .filter((endpoint) => endpoint.kind === "objective")
        .map((endpoint) => endpoint.id)
        .filter((id) => !readable.has(id)),
    )];
    if (otherObjectiveIds.length > 0) {
      const otherRows = await tx
        .select({ objectiveId: learningObjectivesV2.objectiveId, conceptLabel: learningObjectiveRevisionsV2.conceptLabel })
        .from(learningObjectivesV2)
        .innerJoin(learningObjectiveRevisionsV2, and(
          eq(learningObjectiveRevisionsV2.workspaceId, learningObjectivesV2.workspaceId),
          eq(learningObjectiveRevisionsV2.objectiveRevisionId, learningObjectivesV2.currentObjectiveRevisionId),
        ))
        .where(and(
          eq(learningObjectivesV2.workspaceId, ctx.workspaceId),
          inArray(learningObjectivesV2.objectiveId, otherObjectiveIds),
          visibleObjectivesCondition(ctx.userId, learningObjectivesV2.objectiveId),
        ));
      for (const row of otherRows) {
        if (row.conceptLabel) labelByObjective.set(row.objectiveId, row.conceptLabel);
      }
    }
    for (const edge of options.snapshotEdges) {
      if (edge.kind !== "relates_to") continue;
      const fromIsMine = edge.from.kind === "objective" && readable.has(edge.from.id);
      const toIsMine = edge.to.kind === "objective" && readable.has(edge.to.id);
      if (!fromIsMine && !toIsMine) continue;
      const mine = (fromIsMine ? edge.from.id : edge.to.id) as string;
      const other = (fromIsMine ? edge.to.id : edge.from.id) as string;
      if (mine === other) continue;
      const otherLabel = labelByObjective.get(other);
      if (!otherLabel) continue;
      const relation = semanticRelationOfV2(edge.reasonCodes);
      relations.push({
        edgeId: edge.edgeId,
        otherObjectiveId: other,
        otherLabel,
        relation: relation as NoteDeepeningRelationV3["relation"],
        // 拓扑那一列没给就是"还没有本人表态"＝待确认建议（§11.3），不是已确认。
        status: edge.relationStatus ?? "suggested",
        reasonCodes: edge.reasonCodes,
      });
    }
  }

  // ── 记录：locked 作答 + 它的评估（§11.2 第三行前四格）──────────────────
  const runRows = readableObjectiveIds.length > 0
    ? await tx
        .select({ runId: learningRuns.id, objectiveId: sql<string | null>`${learningRuns.origin}->>'objectiveId'` })
        .from(learningRuns)
        .where(and(
          eq(learningRuns.workspaceId, ctx.workspaceId),
          eq(learningRuns.userId, ctx.userId),
          sql`${learningRuns.origin}->>'objectiveId' IN (${sql.join(readableObjectiveIds.map((id) => sql`${id}`), sql`, `)})`,
        ))
    : [];
  const objectiveByRun = new Map(runRows.map((row) => [row.runId, row.objectiveId ?? null]));

  const artifactRows = runRows.length > 0
    ? await tx
        .select({
          artifactId: learningArtifacts.id,
          runId: learningArtifacts.runId,
          payload: learningArtifacts.payload,
          createdAt: learningArtifacts.createdAt,
          lockedAt: learningArtifacts.lockedAt,
        })
        .from(learningArtifacts)
        .where(and(
          eq(learningArtifacts.workspaceId, ctx.workspaceId),
          eq(learningArtifacts.userId, ctx.userId),
          // 只读 locked：草稿不是"她做过的回答"（§12.3 提交才定版）。
          eq(learningArtifacts.status, "locked"),
          inArray(learningArtifacts.runId, runRows.map((row) => row.runId)),
        ))
        .orderBy(desc(learningArtifacts.createdAt), desc(learningArtifacts.id))
    : [];
  const page = bounded(artifactRows, limit);

  const assessmentRows = page.page.length > 0
    ? await tx
        .select({ runId: learningAssessments.runId, rubricResults: learningAssessments.rubricResults })
        .from(learningAssessments)
        .where(and(
          eq(learningAssessments.workspaceId, ctx.workspaceId),
          eq(learningAssessments.userId, ctx.userId),
          inArray(learningAssessments.runId, [...new Set(page.page.map((row) => row.runId))]),
          inArray(learningAssessments.status, ["completed", "not_assessable"]),
        ))
    : [];
  const assessmentByRun = new Map<string, typeof assessmentRows[number]>();
  for (const row of assessmentRows) {
    if (!assessmentByRun.has(row.runId)) assessmentByRun.set(row.runId, row);
  }

  // ── 「独立 / 借助」的凭据：暴露记录（有人帮过）＋ canonical 事件（真被算过）──
  const runIds = runRows.map((row) => row.runId);
  const [exposureObjectives, canonicalRunIds] = await Promise.all([
    readableObjectiveIds.length > 0
      ? tx
          .select({ objectiveId: learningExposuresV2.objectiveId })
          .from(learningExposuresV2)
          .where(and(
            eq(learningExposuresV2.workspaceId, ctx.workspaceId),
            eq(learningExposuresV2.userId, ctx.userId),
            inArray(learningExposuresV2.objectiveId, readableObjectiveIds),
          ))
      : Promise.resolve([] as Array<{ objectiveId: string }>),
    runIds.length > 0
      ? tx
          .select({ runId: canonicalLearningEventOutbox.runId })
          .from(canonicalLearningEventOutbox)
          .where(and(
            eq(canonicalLearningEventOutbox.workspaceId, ctx.workspaceId),
            eq(canonicalLearningEventOutbox.userId, ctx.userId),
            inArray(canonicalLearningEventOutbox.runId, runIds),
            eq(canonicalLearningEventOutbox.status, "published"),
          ))
      : Promise.resolve([] as Array<{ runId: string }>),
  ]);
  const assistedObjectiveIds = new Set(exposureObjectives.map((row) => row.objectiveId));
  const canonicalRunIdSet = new Set(canonicalRunIds.map((row) => row.runId));
  // 目标那一层要的是"这颗目标被正式结算过没有"（决定 stable / unvalidated），
  // 所以这里把 run 侧的凭据折回 objective 侧——**按 origin 折**，不按"最近一次"折。
  const canonicalObjectiveIds = new Set(
    [...canonicalRunIdSet]
      .map((runId) => objectiveByRun.get(runId))
      .filter((id): id is string => typeof id === "string"),
  );

  const allEvidenceIds = [...new Set(
    [...evidenceByObjective.values()].flatMap((set) => [...set]),
  )].slice(0, 1000);
  const evidenceRows = allEvidenceIds.length > 0
    ? await tx
        .select({ id: evidenceSnapshotsV2.evidenceSnapshotId, supportDescription: evidenceSnapshotsV2.supportDescription })
        .from(evidenceSnapshotsV2)
        .where(and(
          eq(evidenceSnapshotsV2.workspaceId, ctx.workspaceId),
          inArray(evidenceSnapshotsV2.evidenceSnapshotId, allEvidenceIds),
        ))
        .orderBy(evidenceSnapshotsV2.evidenceSnapshotId)
    : [];
  const evidenceLabelById = new Map(evidenceRows.map((row) => [row.id, row.supportDescription ?? "证据片段"]));

  let independentCount = 0;
  let assistedCount = 0;
  const independentDays = new Set<string>();
  const records: NoteDeepeningRecordV3[] = [];
  for (const artifact of page.page) {
    const objectiveId = objectiveByRun.get(artifact.runId) ?? null;
    const answer = answerOfDeepeningV3(artifact.payload);
    const at = artifact.lockedAt ?? artifact.createdAt;
    // 「独立 / 借助」只从**有据可查**的那一格落：暴露记录说有答案被揭示过 ⇒ 借助；
    // canonical 事件说这一轮真被结算过、且那一条目标从没被揭示过 ⇒ 独立。
    // 两样都没有 ⇒ **不计入任何一档**（§11.4「曾接触」由 recordCount 那一档兜着，
    // 宁可少一档也不把"不知道"说成"独立用过"）。
    if (objectiveId && assistedObjectiveIds.has(objectiveId)) assistedCount += 1;
    else if (canonicalRunIdSet.has(artifact.runId)) {
      independentCount += 1;
      independentDays.add(utcDayKey(at));
    }
    const materialIds = objectiveId ? [...(evidenceByObjective.get(objectiveId) ?? [])] : [];
    records.push({
      recordId: artifact.artifactId,
      runId: artifact.runId,
      objectiveId,
      objectiveLabel: objectiveId
        ? (revisionByObjective.get(objectiveId)?.conceptLabel ?? "未命名目标")
        : null,
      answerForm: answer.form,
      answerText: answer.text,
      feedback: assessmentByRun.has(artifact.runId)
        ? feedbackOfDeepeningV3(assessmentByRun.get(artifact.runId)!.rubricResults)
        : [],
      occurredAt: at.toISOString(),
      materialBasis: materialIds
        .filter((id) => evidenceLabelById.has(id))
        .slice(0, 8)
        .map((id) => ({ evidenceSnapshotId: id, supportSummary: evidenceLabelById.get(id)! })),
      cardId: objectiveId ? cardByObjective.get(objectiveId) ?? null : null,
    });
  }

  // ── 目标列表 + 状态 ───────────────────────────────────────────────────
  const objectives: NoteDeepeningObjectiveV3[] = objectiveRows.map((row) => {
    const revision = revisionByObjective.get(row.objectiveId);
    const schedule = scheduleByObjective.get(row.objectiveId);
    const hasActiveRun = activeRunByObjective.has(row.objectiveId);
    const reviewDue = schedule !== undefined && schedule.getTime() <= now.getTime();
    // 依据适用性用**目标表面同一份**判据（与拓扑快照、笔记页共用一个函数）。
    const freshness = objectiveSurfaceFreshnessV1({
      originCount: originCountByObjective.get(row.objectiveId) ?? 0,
      noteAnchors: noteAnchorsByObjective.get(row.objectiveId) ?? [],
      currentVersionIdOf: () => note.currentVersionId ?? null,
    });
    const summary = revision?.publicSummary?.trim() || revision?.conceptLabel?.trim() || "";
    return {
      objectiveId: row.objectiveId,
      label: (revision?.conceptLabel?.trim() || "未命名目标").slice(0, 200),
      summary: (summary || "这条目标还没有公开摘要。").slice(0, 1500),
      state: objectivePersonalStateForDeepeningV3({
        lifecycle: row.lifecycle,
        hasActiveRun,
        reviewDue,
        scheduled: schedule !== undefined,
        basisUpdated: freshness === "source_outdated",
        hasCanonical: canonicalObjectiveIds.has(row.objectiveId),
      }),
      runId: activeRunByObjective.get(row.objectiveId) ?? null,
      cardId: cardByObjective.get(row.objectiveId) ?? null,
    };
  });

  // 「内容更新」是**材料**那一轴的事实，不是每条目标各说一遍。
  const basis: "holds" | "updated" | "needs_check" = objectives.some(
    (objective) => objective.state === "outdated",
  ) ? "updated" : "holds";

  // ── 未完的一轮：层二的"本轮问题"与层一的"未完旅程"是同一行 ───────────
  //
  // **可见性判据在这一发上再写一遍**，尽管函数开头已经查过同一篇笔记：那一句开头
  // 挡的是"能不能展开这一篇"，而这一句挡的是"**那一轮当时记下的问题句**会不会在
  // 她已经读不到这篇之后仍然被念出来"（§16.13「失权后不能靠旧快照继续学」）。轮次
  // 行带 `note_id`，把 notes join 进来、判据跟着走，是让那半句在**这一行**上成立，
  // 而不是靠调用顺序成立——顺序一变它就静默失效，而没有任何一条功能测试会红
  // （`note-visibility-read-sites` 那条棘轮就是为此存在的）。
  const [openRound] = await tx
    .select({ drivingQuestion: noteLearningRounds.drivingQuestion })
    .from(noteLearningRounds)
    .innerJoin(notes, and(
      eq(notes.id, noteLearningRounds.noteId),
      eq(notes.workspaceId, noteLearningRounds.workspaceId),
      visibleNotesCondition(ctx.userId),
      isNull(notes.deletedAt),
    ))
    .where(and(
      eq(noteLearningRounds.workspaceId, ctx.workspaceId),
      eq(noteLearningRounds.userId, ctx.userId),
      eq(noteLearningRounds.noteId, noteId),
      inArray(noteLearningRounds.phase, ["active", "paused"]),
    ))
    .orderBy(desc(noteLearningRounds.createdAt))
    .limit(1);

  return buildNoteDeepeningV3({
    noteId: note.id,
    noteTitle: note.title,
    // 「有正文」用**当前版本**判：一篇没有当前版本的笔记不该在星图上占一颗星，
    // 而**有**当前版本的笔记不需要任何一张卡就能被展开（§11.2、§16.12）。
    hasBody: Boolean(note.currentVersionId),
    sourceId: note.sourceId,
    openDrivingQuestion: openRound?.drivingQuestion ?? null,
    objectives,
    relations,
    records,
    recordsComplete: page.complete,
    independentCount,
    assistedCount,
    independentDayCount: independentDays.size,
    paused: heldObjectiveIds.size > 0,
    reviewDue: [...scheduleByObjective.values()].some((at) => at.getTime() <= now.getTime()),
    basis,
  });
}
